import { BybitClient } from "../client";
import { KlineResult } from "./types";
import { intervalToMinutes } from "./volatility";

// Pairs / stat-arb toolkit: rolling correlation and beta vs a benchmark
// (hedge ratios), pair log-spread z-score, and an AR(1) half-life estimate.
// Read-only, public market data only.

const DEFAULT_BENCHMARK = "BTCUSDT";
const DEFAULT_INTERVAL = "60";
const DEFAULT_LIMIT = 500;
const MIN_ALIGNED_BARS = 50;
const MIN_HALF_LIFE_POINTS = 20;
const DEFAULT_WINDOW_BARS = 168;   // recent-window stats: ~7 days of hourly bars
const Z_SIGNAL_THRESHOLD = 2;

const r4 = (v: number) => Math.round(v * 10000) / 10000;

export type SpreadSignal = "spread_rich" | "spread_cheap" | "neutral";

export interface PairAnalysisResult {
  symbol: string;
  benchmark: string;
  category: "linear" | "inverse" | "spot";
  interval: string;
  barsAligned: number;
  returns: {
    correlationFull: number | null;
    correlationRecent: number | null;
    windowBars: number;
  };
  beta: {
    full: number | null;             // OLS slope of symbol returns on benchmark returns
    recent: number | null;
    hedgeNotionalUsdPer1kUsd: number | null;  // benchmark notional hedging $1k of symbol
  };
  spread: {
    hedgeRatioLog: number | null;    // h from ln(symbol) = h·ln(benchmark) + c
    lastLogSpread: number | null;
    meanLogSpread: number | null;
    stdLogSpread: number | null;
    zScore: number | null;
    signal: SpreadSignal;
  };
  meanReversion: {
    halfLifeBars: number | null;
    halfLifeHours: number | null;
    halfLifeDays: number | null;
  };
  dataNote?: string;
}

/** Pearson correlation; null when either series is constant or n < 2. */
export function pearsonCorrelation(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n, my = sy / n;
  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  if (!(sxx > 0) || !(syy > 0)) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/** OLS of y on x; null when x is constant or n < 2. */
export function olsFit(xs: number[], ys: number[]): { slope: number; intercept: number } | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n, my = sy / n;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    sxx += dx * dx; sxy += dx * (ys[i] - my);
  }
  if (!(sxx > 0)) return null;
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx };
}

/**
 * AR(1) half-life of mean reversion: regress Δs on s_{t-1}; with slope
 * λ ∈ (-1, 0), halfLife = -ln2 / ln(1+λ) bars. Null when the spread is not
 * mean-reverting (λ >= 0), degenerate, or too short.
 */
export function halfLifeBars(spread: number[]): number | null {
  if (spread.length < MIN_HALF_LIFE_POINTS) return null;
  const prev = spread.slice(0, -1);
  const delta = spread.slice(1).map((s, i) => s - prev[i]);
  const fit = olsFit(prev, delta);
  if (!fit) return null;
  const lambda = fit.slope;
  if (!(lambda > -1 && lambda < 0)) return null;
  return -Math.LN2 / Math.log(1 + lambda);
}

interface AlignedSeries {
  closesA: number[];   // oldest-first
  closesB: number[];
  dropped: number;
}

function alignByTimestamp(listA: KlineResult["list"], listB: KlineResult["list"]): AlignedSeries {
  const mapB = new Map<string, number>();
  for (const bar of listB ?? []) mapB.set(bar[0], parseFloat(bar[4]));

  const rows: Array<{ t: number; a: number; b: number }> = [];
  for (const bar of listA ?? []) {
    const b = mapB.get(bar[0]);
    if (b === undefined) continue;
    const a = parseFloat(bar[4]);
    if (!(a > 0) || !(b > 0)) continue;
    rows.push({ t: parseInt(bar[0], 10), a, b });
  }
  rows.sort((x, y) => x.t - y.t);

  const longest = Math.max(listA?.length ?? 0, listB?.length ?? 0);
  return {
    closesA: rows.map((r) => r.a),
    closesB: rows.map((r) => r.b),
    dropped: longest - rows.length,
  };
}

function logReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) out.push(Math.log(closes[i] / closes[i - 1]));
  return out;
}

export interface PairParams {
  symbol: string;
  benchmark?: string;       // default BTCUSDT
  category?: "linear" | "inverse" | "spot";
  interval?: string;        // default 60 (1h)
  limit?: number;           // bars of history, default 500 (clamped 50-1000)
  windowBars?: number;      // recent-window size, default 168
}

export async function handleAnalyzePair(
  client: BybitClient,
  params: PairParams
): Promise<PairAnalysisResult> {
  const benchmark = params.benchmark ?? DEFAULT_BENCHMARK;
  const category = params.category ?? "linear";
  const interval = params.interval ?? DEFAULT_INTERVAL;
  const intervalMinutes = intervalToMinutes(interval); // validates the interval
  const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIMIT, MIN_ALIGNED_BARS), 1000);

  if (!params.symbol) throw new Error("analyze_pair: symbol is required");
  if (params.symbol === benchmark) {
    throw new Error("analyze_pair: symbol must be different from the benchmark");
  }
  // MCP arguments arrive untyped — a NaN here would silently fall back to a
  // server-default kline limit or a full-history window with no warning.
  for (const [label, v] of [["limit", params.limit], ["windowBars", params.windowBars]] as const) {
    if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v))) {
      throw new Error(`analyze_pair: ${label} must be a finite number (got ${JSON.stringify(v)})`);
    }
  }

  const [resA, resB] = await Promise.all([
    client.publicGet<KlineResult>("/v5/market/kline", {
      category, symbol: params.symbol, interval, limit: String(limit),
    }),
    client.publicGet<KlineResult>("/v5/market/kline", {
      category, symbol: benchmark, interval, limit: String(limit),
    }),
  ]);

  const { closesA, closesB, dropped } = alignByTimestamp(resA.list, resB.list);
  if (closesA.length < MIN_ALIGNED_BARS) {
    throw new Error(
      `analyze_pair: only ${closesA.length} bars aligned between ${params.symbol} and ${benchmark} ` +
      `(need ${MIN_ALIGNED_BARS}) — try a longer interval or check the symbols.`
    );
  }

  const rA = logReturns(closesA);
  const rB = logReturns(closesB);
  const windowBars = Math.min(Math.max(params.windowBars ?? DEFAULT_WINDOW_BARS, 10), rA.length);
  const rARecent = rA.slice(-windowBars);
  const rBRecent = rB.slice(-windowBars);

  const correlationFull = pearsonCorrelation(rB, rA);
  const correlationRecent = pearsonCorrelation(rBRecent, rARecent);
  const betaFull = olsFit(rB, rA)?.slope ?? null;
  const betaRecent = olsFit(rBRecent, rARecent)?.slope ?? null;

  // Log-price hedge ratio and spread: spread_t = ln(A) - h·ln(B).
  const lnA = closesA.map((c) => Math.log(c));
  const lnB = closesB.map((c) => Math.log(c));
  const hedgeFit = olsFit(lnB, lnA);
  let lastLogSpread: number | null = null;
  let meanLogSpread: number | null = null;
  let stdLogSpread: number | null = null;
  let zScore: number | null = null;
  let signal: SpreadSignal = "neutral";
  let halfLife: number | null = null;

  if (hedgeFit) {
    const spread = lnA.map((a, i) => a - hedgeFit.slope * lnB[i]);
    const n = spread.length;
    const mean = spread.reduce((s, v) => s + v, 0) / n;
    const ss = spread.reduce((s, v) => s + (v - mean) * (v - mean), 0);
    const std = Math.sqrt(ss / (n - 1));
    lastLogSpread = spread[n - 1];
    meanLogSpread = mean;
    // A numerically flat spread (variance at float-noise level) has no
    // meaningful z-score or half-life — the AR(1) fit would run on noise.
    if (std > 1e-12) {
      stdLogSpread = std;
      zScore = (spread[n - 1] - mean) / std;
      signal = zScore >= Z_SIGNAL_THRESHOLD ? "spread_rich"
        : zScore <= -Z_SIGNAL_THRESHOLD ? "spread_cheap"
        : "neutral";
      halfLife = halfLifeBars(spread);
    }
  }

  const notes: string[] = [];
  if (dropped > 0) {
    notes.push(`${dropped} bar(s) dropped to align the two series on shared timestamps.`);
  }
  if (closesA.length < limit) {
    notes.push(`Bybit returned ${closesA.length}/${limit} aligned bars — stats use a shorter history.`);
  }

  return {
    symbol: params.symbol,
    benchmark,
    category,
    interval,
    barsAligned: closesA.length,
    returns: {
      correlationFull: correlationFull !== null ? r4(correlationFull) : null,
      correlationRecent: correlationRecent !== null ? r4(correlationRecent) : null,
      windowBars,
    },
    beta: {
      full: betaFull !== null ? r4(betaFull) : null,
      recent: betaRecent !== null ? r4(betaRecent) : null,
      hedgeNotionalUsdPer1kUsd: betaFull !== null ? r4(betaFull * 1000) : null,
    },
    spread: {
      hedgeRatioLog: hedgeFit ? r4(hedgeFit.slope) : null,
      lastLogSpread: lastLogSpread !== null ? r4(lastLogSpread) : null,
      meanLogSpread: meanLogSpread !== null ? r4(meanLogSpread) : null,
      stdLogSpread: stdLogSpread !== null ? r4(stdLogSpread) : null,
      zScore: zScore !== null ? r4(zScore) : null,
      signal,
    },
    meanReversion: {
      halfLifeBars: halfLife !== null ? r4(halfLife) : null,
      halfLifeHours: halfLife !== null ? r4(halfLife * intervalMinutes / 60) : null,
      halfLifeDays: halfLife !== null ? r4(halfLife * intervalMinutes / 1440) : null,
    },
    ...(notes.length > 0 ? { dataNote: notes.join(" ") } : {}),
  };
}
