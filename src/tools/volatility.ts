import { BybitClient } from "../client";
import { KlineResult } from "./types";
import { OptionTickersResult } from "./options/types";
import { atmIvForExpiry, sortedExpiries } from "./options/regime";

// Realized-volatility analytics: estimator suite + vol cone + optional
// IV-vs-RV comparison. All volatilities are ANNUALIZED DECIMALS (0.45 = 45%),
// matching Bybit's markIv convention.

export interface VolEstimates {
  closeToClose: number | null;
  parkinson: number | null;
  yangZhang: number | null;
}

export interface VolConeRow {
  horizon: string;          // "1d" | "3d" | ...
  horizonBars: number;
  current: number | null;   // RV over the most recent window of this horizon
  min: number | null;
  p25: number | null;
  median: number | null;
  p75: number | null;
  max: number | null;
  samples: number;          // rolling windows available
}

export interface IvComparison {
  atmIv: number;
  expiry: string;           // ISO date of the expiry used
  horizonDays: number;      // RV window length the IV was matched against
  ivMinusRv: number;        // positive = options rich vs realized
  comparedTo: "closeToClose";
}

export interface VolatilityResult {
  symbol: string;
  category: "linear" | "inverse" | "spot";
  interval: string;
  barsUsed: number;
  windowBars: number;
  realizedVol: VolEstimates;
  volCone: VolConeRow[];
  iv?: IvComparison;
  dataNote?: string;
}

interface Bar {
  open: number;
  high: number;
  low: number;
  close: number;
}

const MINUTES_PER_YEAR = 365 * 1440;
const CONE_HORIZON_DAYS = [1, 3, 7, 14, 30] as const;
const IV_UNDERLYINGS: Record<string, "BTC" | "ETH" | "SOL"> = {
  BTCUSDT: "BTC",
  ETHUSDT: "ETH",
  SOLUSDT: "SOL",
};

const r4 = (v: number) => Math.round(v * 10000) / 10000;
const r2 = (v: number) => Math.round(v * 100) / 100;

export function intervalToMinutes(interval: string): number {
  if (interval === "D") return 1440;
  if (interval === "W") return 10080;
  if (interval === "M") return 43800; // 365d/12 — keeps barsPerYear at exactly 12
  const n = parseInt(interval, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Unsupported kline interval: ${interval}`);
  }
  return n;
}

function sampleVariance(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const ss = values.reduce((s, v) => s + (v - mean) * (v - mean), 0);
  return ss / (values.length - 1);
}

/** Close-to-close annualized vol over bars (oldest-first). Needs >= 3 bars. */
export function closeToCloseVol(bars: Bar[], barsPerYear: number): number | null {
  const returns: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    if (!(bars[i].close > 0) || !(bars[i - 1].close > 0)) continue;
    returns.push(Math.log(bars[i].close / bars[i - 1].close));
  }
  const variance = sampleVariance(returns);
  return variance === null ? null : Math.sqrt(variance * barsPerYear);
}

/** Parkinson high-low annualized vol. Needs >= 2 bars with valid H/L. */
export function parkinsonVol(bars: Bar[], barsPerYear: number): number | null {
  const terms: number[] = [];
  for (const b of bars) {
    if (!(b.high > 0) || !(b.low > 0) || b.high < b.low) continue;
    const hl = Math.log(b.high / b.low);
    terms.push(hl * hl);
  }
  if (terms.length < 2) return null;
  const variance = terms.reduce((s, v) => s + v, 0) / (terms.length * 4 * Math.LN2);
  return Math.sqrt(variance * barsPerYear);
}

/**
 * Yang-Zhang annualized vol (drift-independent, handles open gaps).
 * sigma^2 = V_overnight + k*V_openClose + (1-k)*V_rogersSatchell.
 * Needs >= 3 bars (two overnight returns for a sample variance).
 */
export function yangZhangVol(bars: Bar[], barsPerYear: number): number | null {
  const overnight: number[] = [];
  const openClose: number[] = [];
  const rsTerms: number[] = [];

  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    const prevClose = bars[i - 1].close;
    if (!(b.open > 0) || !(b.close > 0) || !(b.high > 0) || !(b.low > 0) || !(prevClose > 0)) continue;
    overnight.push(Math.log(b.open / prevClose));
    openClose.push(Math.log(b.close / b.open));
    rsTerms.push(
      Math.log(b.high / b.close) * Math.log(b.high / b.open) +
      Math.log(b.low / b.close) * Math.log(b.low / b.open)
    );
  }

  const vo = sampleVariance(overnight);
  const vc = sampleVariance(openClose);
  if (vo === null || vc === null || rsTerms.length === 0) return null;
  const vrs = rsTerms.reduce((s, v) => s + v, 0) / rsTerms.length;

  const n = overnight.length;
  const k = 0.34 / (1.34 + (n + 1) / (n - 1));
  const variance = vo + k * vc + (1 - k) * vrs;
  // Cross-products can make V_RS slightly negative on degenerate bars.
  if (!(variance >= 0)) return null;
  return Math.sqrt(variance * barsPerYear);
}

// Linear-interpolated quantile over an ascending-sorted array.
function quantile(sortedAsc: number[], q: number): number {
  const pos = q * (sortedAsc.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}

function buildVolCone(bars: Bar[], intervalMinutes: number, barsPerYear: number): VolConeRow[] {
  const rows: VolConeRow[] = [];
  for (const days of CONE_HORIZON_DAYS) {
    const horizonBars = Math.round((days * 1440) / intervalMinutes);
    if (horizonBars < 3 || horizonBars > bars.length) continue;

    const vols: number[] = [];
    for (let start = 0; start + horizonBars <= bars.length; start++) {
      const v = closeToCloseVol(bars.slice(start, start + horizonBars), barsPerYear);
      if (v !== null) vols.push(v);
    }
    if (vols.length === 0) continue;

    const current = closeToCloseVol(bars.slice(bars.length - horizonBars), barsPerYear);
    const sorted = [...vols].sort((a, b) => a - b);
    rows.push({
      horizon: `${days}d`,
      horizonBars,
      current: current !== null ? r4(current) : null,
      min: r4(sorted[0]),
      p25: r4(quantile(sorted, 0.25)),
      median: r4(quantile(sorted, 0.5)),
      p75: r4(quantile(sorted, 0.75)),
      max: r4(sorted[sorted.length - 1]),
      samples: vols.length,
    });
  }
  return rows;
}

async function compareWithIv(
  client: BybitClient,
  symbol: string,
  rvCloseToClose: number,
  windowBars: number,
  intervalMinutes: number
): Promise<IvComparison | null> {
  const baseCoin = IV_UNDERLYINGS[symbol];
  if (!baseCoin) return null;

  const [chainRes, spot] = await Promise.all([
    client.publicGet<OptionTickersResult>("/v5/market/tickers", {
      category: "option",
      baseCoin,
    }),
    client.publicGet<{ list: Array<{ lastPrice: string }> }>("/v5/market/tickers", {
      category: "linear",
      symbol,
    }).then((r) => parseFloat(r.list[0]?.lastPrice ?? "0")),
  ]);
  if (!(spot > 0)) return null;

  const now = Date.now();
  const expiries = sortedExpiries(chainRes.list, now);
  if (expiries.length === 0) return null;

  // Match the IV horizon to the RV window so the spread compares like with like.
  const horizonDays = (windowBars * intervalMinutes) / 1440;
  const targetMs = now + horizonDays * 86400000;
  const nearest = expiries.reduce((a, b) =>
    Math.abs(a.getTime() - targetMs) <= Math.abs(b.getTime() - targetMs) ? a : b
  );

  const atmIv = atmIvForExpiry(chainRes.list, spot, nearest);
  if (atmIv === null) return null;

  return {
    atmIv: r4(atmIv),
    expiry: nearest.toISOString(),
    horizonDays: r2(horizonDays),
    ivMinusRv: r4(atmIv - rvCloseToClose),
    comparedTo: "closeToClose",
  };
}

export interface VolatilityParams {
  symbol: string;
  category?: "linear" | "inverse" | "spot";
  interval?: string;
  limit?: number;        // total bars of history to fetch (cone depth), max 1000
  windowBars?: number;   // estimator window; default ~7 days of bars
  compareIv?: boolean;   // default true; only applies when options are enabled
}

export async function handleGetVolatility(
  client: BybitClient,
  enableOptions: boolean,
  params: VolatilityParams
): Promise<VolatilityResult> {
  const category = params.category ?? "linear";
  const interval = params.interval ?? "60";
  const intervalMinutes = intervalToMinutes(interval);
  const limit = Math.min(Math.max(params.limit ?? 1000, 10), 1000);
  const barsPerYear = MINUTES_PER_YEAR / intervalMinutes;

  const res = await client.publicGet<KlineResult>("/v5/market/kline", {
    category,
    symbol: params.symbol,
    interval,
    limit: String(limit),
  });

  // Bybit returns newest-first; estimators want oldest-first.
  const bars: Bar[] = (res.list ?? [])
    .map(([, open, high, low, close]) => ({
      open: parseFloat(open),
      high: parseFloat(high),
      low: parseFloat(low),
      close: parseFloat(close),
    }))
    .reverse();

  if (bars.length < 3) {
    throw new Error(
      `Insufficient kline data for ${params.symbol} (got ${bars.length} bars, need at least 3)`
    );
  }

  // Default window ≈ 7 days of bars, clamped to a sane estimator range.
  const defaultWindow = Math.min(Math.max(Math.round((7 * 1440) / intervalMinutes), 24), 336);
  const requestedWindow = params.windowBars ?? defaultWindow;
  const windowBars = Math.min(Math.max(requestedWindow, 3), bars.length);
  const windowSlice = bars.slice(bars.length - windowBars);

  const c2c = closeToCloseVol(windowSlice, barsPerYear);
  const realizedVol: VolEstimates = {
    closeToClose: c2c !== null ? r4(c2c) : null,
    parkinson: (() => { const v = parkinsonVol(windowSlice, barsPerYear); return v !== null ? r4(v) : null; })(),
    yangZhang: (() => { const v = yangZhangVol(windowSlice, barsPerYear); return v !== null ? r4(v) : null; })(),
  };

  const volCone = buildVolCone(bars, intervalMinutes, barsPerYear);

  const notes: string[] = [];
  if (bars.length < limit) {
    notes.push(`Bybit returned ${bars.length}/${limit} bars — cone percentiles use a shorter history.`);
  }
  if (windowBars < requestedWindow) {
    notes.push(`windowBars clamped to available history (${windowBars}).`);
  }

  let iv: IvComparison | undefined;
  if (enableOptions && params.compareIv !== false && c2c !== null) {
    try {
      iv = (await compareWithIv(client, params.symbol, c2c, windowBars, intervalMinutes)) ?? undefined;
    } catch {
      notes.push("IV comparison unavailable (options chain fetch failed).");
    }
  }

  return {
    symbol: params.symbol,
    category,
    interval,
    barsUsed: bars.length,
    windowBars,
    realizedVol,
    volCone,
    ...(iv ? { iv } : {}),
    ...(notes.length > 0 ? { dataNote: notes.join(" ") } : {}),
  };
}
