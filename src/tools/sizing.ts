import { BybitClient } from "../client";
import { TickersResult, KlineResult, WalletBalanceResult } from "./types";
import { ensureInstrumentInfo } from "./trade-shared";
import { floorToStep, parseFiniteOrThrow } from "../util";
import { closeToCloseVol } from "./volatility";
import { handleGetClosedTrades } from "./orders";

// Position sizing calculator — pure advisory math, no orders are placed.
// Three methods: risk_per_trade (risk budget / stop distance), vol_target
// (position vol contribution on equity), kelly (fractional Kelly from
// win/loss stats). All methods respect the instrument qty step and report
// a liquidation-distance constraint when a stop is supplied.

export type SizingMethod = "risk_per_trade" | "vol_target" | "kelly";
export type SizingCategory = "linear" | "inverse" | "spot";
export type SizingSide = "Buy" | "Sell";

const MMR = 0.005;                 // same maintenance-margin approximation as place_trade dry runs
const LIQ_BUFFER_FRAC = 0.1;       // maxSafeLeverage leaves 10% of the stop distance beyond the stop
const MIN_KELLY_TRADES = 10;
const VOL_INTERVAL = "60";
const VOL_LIMIT = 169;             // ~7 days of hourly bars
const VOL_BARS_PER_YEAR = 365 * 24;
const MIN_VOL_BARS = 10;
const SHORT_VOL_HISTORY_BARS = 48;

const r2 = (v: number) => Math.round(v * 100) / 100;
const r4 = (v: number) => Math.round(v * 10000) / 10000;

export interface SizingParams {
  symbol: string;
  method: SizingMethod;
  category?: SizingCategory;     // default linear
  side?: SizingSide;             // default Buy
  entryPrice?: number;           // default: current last price
  stopPrice?: number;            // required for risk_per_trade and kelly
  riskUsd?: number;              // risk_per_trade: absolute USD risk budget
  riskPctEquity?: number;        // risk_per_trade: % of equity (default 1 when neither is given)
  targetAnnualVolPct?: number;   // vol_target: position's annualized vol contribution as % of equity
  kellyFraction?: number;        // kelly: fraction of full Kelly to apply (default 0.25)
  winRate?: number;              // kelly: explicit stats override (0-1); all three or none
  avgWinUsd?: number;
  avgLossUsd?: number;           // positive number
  leverage?: number;             // enables margin + liquidation estimates
  equityUsd?: number;            // override; default: wallet totalEquity
}

export interface KellySizing {
  winRate: number;
  avgWinUsd: number;
  avgLossUsd: number;
  payoffRatio: number;
  fullKelly: number;
  fractionApplied: number;
  riskFractionOfEquity: number;
  tradesAnalyzed?: number;
  source: "params" | "history";
}

export interface VolTargetSizing {
  targetAnnualVolPct: number;
  assetAnnualVol: number;        // annualized decimal (0.45 = 45%)
  interval: string;
  barsUsed: number;
}

export interface LiquidationConstraint {
  estimatedLiqPrice?: number;
  liqPriceApproximate: true;
  stopBeforeLiq?: boolean;
  maxSafeLeverage: number | null;  // null = unconstrained / cannot be protected
  bufferPct: number;
}

export interface PositionSizeResult {
  symbol: string;
  category: SizingCategory;
  method: SizingMethod;
  side: SizingSide;
  currentPrice: number | null;
  entryPrice: number;
  stopPrice?: number;
  equityUsd: number;
  equitySource: "wallet" | "override";
  qty: string;                   // stepped to the instrument qtyStep, ready for place_trade
  qtyStep: string;
  qtyUnit: "base" | "usd_contracts";
  notionalUsd: number;
  riskUsd?: number;              // at the rounded qty (stop-based methods)
  riskPctOfEquity?: number;
  stopDistancePct?: number;
  leverage?: number;
  marginRequiredUsd?: number;
  marginNote?: string;
  kelly?: KellySizing;
  volTarget?: VolTargetSizing;
  liquidation?: LiquidationConstraint;
  warnings: string[];
}

/**
 * Quantity whose loss at the stop is worth `riskUsd`.
 * linear/spot: base units. inverse: USD contracts (coin loss valued at the
 * stop price, where the loss is actually realized).
 */
export function riskPerTradeQty(
  riskUsd: number,
  entryPrice: number,
  stopPrice: number,
  category: SizingCategory
): number {
  const dist = Math.abs(entryPrice - stopPrice);
  if (!(dist > 0)) throw new Error("calculate_position_size: stop distance is zero");
  if (category === "inverse") return (riskUsd * entryPrice) / dist;
  return riskUsd / dist;
}

/**
 * Full Kelly fraction f* = p - (1-p)/R with R = avgWin/avgLoss.
 * Returns null on degenerate inputs; may be negative (no edge).
 */
export function kellyFromStats(
  winRate: number,
  avgWinUsd: number,
  avgLossUsd: number
): number | null {
  if (!(winRate >= 0) || !(winRate <= 1)) return null;
  if (!(avgWinUsd > 0) || !(avgLossUsd > 0)) return null;
  const payoffRatio = avgWinUsd / avgLossUsd;
  return winRate - (1 - winRate) / payoffRatio;
}

/** Same approximation place_trade dry runs use (isolated margin, mmr 0.5%). */
export function estimateLiqPrice(
  entryPrice: number,
  leverage: number,
  side: SizingSide,
  category: SizingCategory,
  mmr = MMR
): number {
  if (category === "inverse") {
    return side === "Buy"
      ? entryPrice * leverage / (leverage + 1 - mmr * leverage)
      : entryPrice * leverage / (leverage - 1 + mmr * leverage);
  }
  return side === "Buy"
    ? entryPrice * (1 - 1 / leverage + mmr)
    : entryPrice * (1 + 1 / leverage - mmr);
}

/**
 * Highest leverage at which the estimated liquidation price still sits
 * beyond the stop by `bufferFrac` of the stop distance. Null when no
 * leverage can satisfy the constraint (or it is unconstrained).
 */
export function maxLeverageForStop(
  entryPrice: number,
  stopPrice: number,
  side: SizingSide,
  category: SizingCategory,
  mmr = MMR,
  bufferFrac = LIQ_BUFFER_FRAC
): number | null {
  const dist = Math.abs(entryPrice - stopPrice);
  if (!(dist > 0)) return null;
  const stopEff = side === "Buy" ? stopPrice - bufferFrac * dist : stopPrice + bufferFrac * dist;
  if (!(stopEff > 0)) return null;

  let lev: number;
  if (category === "inverse") {
    const denom = side === "Buy"
      ? entryPrice - stopEff * (1 - mmr)
      : stopEff * (1 + mmr) - entryPrice;
    if (!(denom > 0)) return null;
    lev = stopEff / denom;
  } else {
    const denom = side === "Buy"
      ? (entryPrice - stopEff) / entryPrice + mmr
      : (stopEff - entryPrice) / entryPrice - mmr;
    if (!(denom > 0)) return null;
    lev = 1 / denom;
  }
  return lev >= 1 ? lev : null;
}

function validateStop(entryPrice: number, stopPrice: number, side: SizingSide): void {
  if (side === "Buy" && !(stopPrice < entryPrice)) {
    throw new Error(
      `calculate_position_size: stop (${stopPrice}) must be below entry (${entryPrice}) for a long`
    );
  }
  if (side === "Sell" && !(stopPrice > entryPrice)) {
    throw new Error(
      `calculate_position_size: stop (${stopPrice}) must be above entry (${entryPrice}) for a short`
    );
  }
}

async function fetchEquityUsd(client: BybitClient): Promise<number> {
  const res = await client.signedGet<WalletBalanceResult>("/v5/account/wallet-balance", {
    accountType: "UNIFIED",
  });
  return parseFiniteOrThrow(res.list?.[0]?.totalEquity, "wallet totalEquity");
}

async function fetchAnnualVol(
  client: BybitClient,
  category: string,
  symbol: string
): Promise<{ vol: number | null; barsUsed: number }> {
  const res = await client.publicGet<KlineResult>("/v5/market/kline", {
    category, symbol, interval: VOL_INTERVAL, limit: String(VOL_LIMIT),
  });
  // Bybit returns newest-first; the estimator wants oldest-first.
  const bars = (res.list ?? [])
    .map(([, open, high, low, close]) => ({
      open: parseFloat(open), high: parseFloat(high),
      low: parseFloat(low), close: parseFloat(close),
    }))
    .reverse();
  if (bars.length < MIN_VOL_BARS) return { vol: null, barsUsed: bars.length };
  return { vol: closeToCloseVol(bars, VOL_BARS_PER_YEAR), barsUsed: bars.length };
}

interface KellyStats {
  winRate: number;
  avgWinUsd: number;
  avgLossUsd: number;
  tradesAnalyzed?: number;
  source: "params" | "history";
}

async function resolveKellyStats(
  client: BybitClient,
  params: SizingParams,
  category: SizingCategory,
  warnings: string[]
): Promise<KellyStats | null> {
  const explicit = [params.winRate, params.avgWinUsd, params.avgLossUsd];
  const providedCount = explicit.filter((v) => v !== undefined).length;
  if (providedCount > 0 && providedCount < 3) {
    throw new Error(
      "calculate_position_size: provide winRate, avgWinUsd, and avgLossUsd together (or none to use closed-trade history)"
    );
  }
  if (providedCount === 3) {
    return {
      winRate: params.winRate!, avgWinUsd: params.avgWinUsd!, avgLossUsd: params.avgLossUsd!,
      source: "params",
    };
  }

  if (category === "spot") {
    throw new Error(
      "calculate_position_size: spot has no closed-PnL history — provide winRate/avgWinUsd/avgLossUsd explicitly for kelly"
    );
  }
  const history = await handleGetClosedTrades(client, { category, limit: 100 });
  const wins = history.trades.filter((t) => t.closedPnl > 0).map((t) => t.closedPnl);
  const losses = history.trades.filter((t) => t.closedPnl < 0).map((t) => -t.closedPnl);
  const tradesAnalyzed = wins.length + losses.length;
  if (tradesAnalyzed < MIN_KELLY_TRADES) {
    warnings.push(
      `Kelly sizing needs at least ${MIN_KELLY_TRADES} closed trades with nonzero PnL — found ${tradesAnalyzed} in the recent history (Bybit retains ~7 days by default).`
    );
    return null;
  }
  if (losses.length === 0) {
    warnings.push(
      `Recent history has no losing trades (${tradesAnalyzed} trades) — Kelly stats are unreliable; refusing to size. Provide explicit stats to override.`
    );
    return null;
  }
  const avg = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;
  return {
    winRate: wins.length / tradesAnalyzed,
    avgWinUsd: wins.length > 0 ? avg(wins) : 0,
    avgLossUsd: avg(losses),
    tradesAnalyzed,
    source: "history",
  };
}

export async function handleCalculatePositionSize(
  client: BybitClient,
  params: SizingParams
): Promise<PositionSizeResult> {
  const category = params.category ?? "linear";
  const side = params.side ?? "Buy";
  const method = params.method;
  const warnings: string[] = [];

  if (!params.symbol) throw new Error("calculate_position_size: symbol is required");
  if (method !== "risk_per_trade" && method !== "vol_target" && method !== "kelly") {
    throw new Error("calculate_position_size: method must be risk_per_trade, vol_target, or kelly");
  }
  if (category === "spot" && side === "Sell") {
    throw new Error("calculate_position_size: spot supports Buy sizing only (you cannot short spot)");
  }
  // MCP arguments arrive as untyped JSON — a string where a number is
  // expected would flow through the math as NaN and produce garbage sizes.
  const numericInputs: Array<[string, unknown]> = [
    ["entryPrice", params.entryPrice], ["stopPrice", params.stopPrice],
    ["riskUsd", params.riskUsd], ["riskPctEquity", params.riskPctEquity],
    ["targetAnnualVolPct", params.targetAnnualVolPct], ["kellyFraction", params.kellyFraction],
    ["winRate", params.winRate], ["avgWinUsd", params.avgWinUsd], ["avgLossUsd", params.avgLossUsd],
    ["leverage", params.leverage], ["equityUsd", params.equityUsd],
  ];
  for (const [label, v] of numericInputs) {
    if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v))) {
      throw new Error(`calculate_position_size: ${label} must be a finite number (got ${JSON.stringify(v)})`);
    }
  }
  if (params.riskUsd !== undefined && params.riskPctEquity !== undefined) {
    throw new Error("calculate_position_size: provide either riskUsd or riskPctEquity, not both");
  }
  if (method === "vol_target" && !(params.targetAnnualVolPct !== undefined && params.targetAnnualVolPct > 0)) {
    throw new Error("calculate_position_size: targetAnnualVolPct (> 0) is required for vol_target");
  }
  const needsStop = method === "risk_per_trade" || method === "kelly";
  if (needsStop && !(params.stopPrice !== undefined && params.stopPrice > 0)) {
    throw new Error(`calculate_position_size: stopPrice is required for ${method}`);
  }
  const kellyFraction = params.kellyFraction ?? 0.25;
  if (method === "kelly" && !(kellyFraction > 0 && kellyFraction <= 1)) {
    throw new Error("calculate_position_size: kellyFraction must be in (0, 1]");
  }
  if (params.leverage !== undefined && !(params.leverage >= 1)) {
    throw new Error("calculate_position_size: leverage must be >= 1");
  }
  if (params.equityUsd !== undefined && !(params.equityUsd > 0)) {
    throw new Error("calculate_position_size: equityUsd must be > 0");
  }

  const tickerCategory = category === "spot" ? "spot" : category;
  const [inst, tickerRes, equityUsd] = await Promise.all([
    ensureInstrumentInfo(client, category, params.symbol),
    client.publicGet<TickersResult>("/v5/market/tickers", {
      category: tickerCategory, symbol: params.symbol,
    }),
    params.equityUsd !== undefined ? Promise.resolve(params.equityUsd) : fetchEquityUsd(client),
  ]);
  const equitySource: "wallet" | "override" = params.equityUsd !== undefined ? "override" : "wallet";

  const lastPriceRaw = parseFloat(tickerRes.list?.[0]?.lastPrice ?? "");
  const currentPrice = Number.isFinite(lastPriceRaw) && lastPriceRaw > 0 ? lastPriceRaw : null;
  const entryPrice = params.entryPrice ?? currentPrice ?? 0;
  if (!(entryPrice > 0)) {
    throw new Error(
      `calculate_position_size: no entryPrice given and no market price available for ${params.symbol}`
    );
  }
  if (params.stopPrice !== undefined) validateStop(entryPrice, params.stopPrice, side);

  // Method-specific sizing → raw qty (base units; USD contracts for inverse).
  let qtyRaw = 0;
  let kelly: KellySizing | undefined;
  let volTarget: VolTargetSizing | undefined;

  if (method === "risk_per_trade") {
    const riskBudgetUsd = params.riskUsd ?? equityUsd * (params.riskPctEquity ?? 1) / 100;
    qtyRaw = riskPerTradeQty(riskBudgetUsd, entryPrice, params.stopPrice!, category);
  } else if (method === "kelly") {
    const stats = await resolveKellyStats(client, params, category, warnings);
    if (stats) {
      const fullKelly = kellyFromStats(stats.winRate, stats.avgWinUsd, stats.avgLossUsd);
      if (fullKelly === null) {
        warnings.push("Kelly stats are degenerate (zero average win or loss) — position size is zero.");
      } else {
        const riskFraction = fullKelly * kellyFraction;
        kelly = {
          winRate: stats.winRate,
          avgWinUsd: stats.avgWinUsd,
          avgLossUsd: stats.avgLossUsd,
          payoffRatio: stats.avgWinUsd / stats.avgLossUsd,
          fullKelly,
          fractionApplied: kellyFraction,
          riskFractionOfEquity: riskFraction,
          ...(stats.tradesAnalyzed !== undefined ? { tradesAnalyzed: stats.tradesAnalyzed } : {}),
          source: stats.source,
        };
        if (fullKelly <= 0) {
          warnings.push(
            "Kelly fraction is non-positive — the stats show no positive edge; position size is zero."
          );
        } else {
          qtyRaw = riskPerTradeQty(equityUsd * riskFraction, entryPrice, params.stopPrice!, category);
        }
      }
    }
  } else {
    const { vol, barsUsed } = await fetchAnnualVol(client, tickerCategory, params.symbol);
    if (vol === null || !(vol > 0)) {
      warnings.push("Realized volatility is zero or unavailable — cannot vol-target a size.");
    } else {
      volTarget = {
        targetAnnualVolPct: params.targetAnnualVolPct!,
        assetAnnualVol: r4(vol),
        interval: VOL_INTERVAL,
        barsUsed,
      };
      if (barsUsed < SHORT_VOL_HISTORY_BARS) {
        warnings.push(`Realized vol estimated from only ${barsUsed} hourly bars — treat as indicative.`);
      }
      const notionalUsd = equityUsd * (params.targetAnnualVolPct! / 100) / vol;
      qtyRaw = category === "inverse" ? notionalUsd : notionalUsd / entryPrice;
    }
  }

  const qty = floorToStep(Math.max(0, qtyRaw), inst.qtyStep);
  const qtyNum = parseFloat(qty);
  if (qtyRaw > 0 && !(qtyNum > 0)) {
    warnings.push(`Computed quantity (${qtyRaw}) rounds to zero at the instrument step (${inst.qtyStep}).`);
  }

  const notionalUsd = category === "inverse" ? qtyNum : qtyNum * entryPrice;
  const minNotional = parseFloat(inst.minNotionalValue || "0");
  if (qtyNum > 0 && minNotional > 0 && notionalUsd < minNotional) {
    warnings.push(`Notional ${notionalUsd.toFixed(2)} USD is below the instrument minimum (${inst.minNotionalValue} USD).`);
  }

  // Realized risk at the rounded qty (stop-based methods only). For inverse,
  // the coin loss is valued at the stop price, where it is actually realized.
  let riskUsd: number | undefined;
  let stopDistancePct: number | undefined;
  if (params.stopPrice !== undefined) {
    const dist = Math.abs(entryPrice - params.stopPrice);
    stopDistancePct = r4(dist / entryPrice * 100);
    riskUsd = category === "inverse" ? qtyNum * dist / entryPrice : qtyNum * dist;
  }

  let marginRequiredUsd: number | undefined;
  let marginNote: string | undefined;
  if (params.leverage !== undefined && category !== "spot") {
    marginRequiredUsd = notionalUsd / params.leverage;
    if (category === "inverse") {
      const coinAmount = notionalUsd / (entryPrice * params.leverage);
      marginNote = `Inverse margin is posted in the base coin (~${coinAmount.toFixed(6)} at entry).`;
    }
    if (marginRequiredUsd > equityUsd) {
      warnings.push(
        `Margin required (~${marginRequiredUsd.toFixed(2)} USD) exceeds equity (${equityUsd.toFixed(2)} USD).`
      );
    }
  }

  let liquidation: LiquidationConstraint | undefined;
  if (category !== "spot" && params.stopPrice !== undefined) {
    const maxSafe = maxLeverageForStop(entryPrice, params.stopPrice, side, category);
    liquidation = {
      liqPriceApproximate: true,
      maxSafeLeverage: maxSafe !== null ? r2(maxSafe) : null,
      bufferPct: LIQ_BUFFER_FRAC * 100,
    };
    if (params.leverage !== undefined) {
      const liqPrice = estimateLiqPrice(entryPrice, params.leverage, side, category);
      const stopBeforeLiq = side === "Buy" ? params.stopPrice > liqPrice : params.stopPrice < liqPrice;
      liquidation = { ...liquidation, estimatedLiqPrice: liqPrice, stopBeforeLiq };
      if (!stopBeforeLiq) {
        warnings.push(
          `Estimated liquidation (~${liqPrice.toFixed(4)}) would trigger before the stop (${params.stopPrice}) at ${params.leverage}x` +
          (liquidation.maxSafeLeverage !== null ? ` — max safe leverage ≈ ${liquidation.maxSafeLeverage}x.` : ".")
        );
      }
    }
  }

  return {
    symbol: params.symbol,
    category,
    method,
    side,
    currentPrice,
    entryPrice,
    ...(params.stopPrice !== undefined ? { stopPrice: params.stopPrice } : {}),
    equityUsd,
    equitySource,
    qty,
    qtyStep: inst.qtyStep,
    qtyUnit: category === "inverse" ? "usd_contracts" : "base",
    notionalUsd,
    ...(riskUsd !== undefined ? { riskUsd, riskPctOfEquity: r4(riskUsd / equityUsd * 100) } : {}),
    ...(stopDistancePct !== undefined ? { stopDistancePct } : {}),
    ...(params.leverage !== undefined ? { leverage: params.leverage } : {}),
    ...(marginRequiredUsd !== undefined ? { marginRequiredUsd } : {}),
    ...(marginNote !== undefined ? { marginNote } : {}),
    ...(kelly ? { kelly } : {}),
    ...(volTarget ? { volTarget } : {}),
    ...(liquidation ? { liquidation } : {}),
    warnings,
  };
}
