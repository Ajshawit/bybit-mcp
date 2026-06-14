import { BybitClient } from "../client";
import { OrderbookEntry } from "./types";

// Pre-trade execution cost: walk the visible book to estimate average fill
// price and slippage for a given size, plus taker/maker fees for the all-in
// cost. Answers "is this order too big for this book?" BEFORE place_trade.

// Bybit V5 orderbook depth caps per category.
const DEPTH_LIMIT: Record<"linear" | "inverse" | "spot", string> = {
  linear: "500",
  inverse: "500",
  spot: "200",
};

const DEFAULT_MAX_SLIPPAGE_BPS = 10;

const r2 = (v: number) => Math.round(v * 100) / 100;
const ri = (v: number) => Math.round(v);

export interface BookLevel {
  price: number;
  size: number;
}

export interface SweepResult {
  filledQty: number;
  avgFillPrice: number | null;
  worstFillPrice: number | null;
  levelsConsumed: number;
  exhausted: boolean;
}

/**
 * Sweep `qty` through price levels (best-first).
 * Linear/spot: size is base units, avg = notional / qty.
 * Inverse: size is USD contracts; base received per level is size/price, so
 * the average is the harmonic-style totalUsd / totalBase.
 */
export function walkBook(levels: BookLevel[], qty: number, isInverse = false): SweepResult {
  let remaining = qty;
  let filled = 0;
  let cost = 0;       // linear/spot: quote spent; inverse: base received
  let worst: number | null = null;
  let consumed = 0;

  for (const level of levels) {
    if (remaining <= 0) break;
    if (!(level.price > 0) || !(level.size > 0)) continue;
    const take = Math.min(remaining, level.size);
    if (isInverse) {
      cost += take / level.price; // base coin received for `take` USD contracts
    } else {
      cost += take * level.price;
    }
    filled += take;
    remaining -= take;
    worst = level.price;
    consumed++;
  }

  const avg = filled > 0
    ? (isInverse ? filled / cost : cost / filled)
    : null;

  return {
    filledQty: filled,
    avgFillPrice: avg,
    worstFillPrice: worst,
    levelsConsumed: consumed,
    exhausted: remaining > 0,
  };
}

/**
 * Max size executable keeping the WORST fill within `maxBps` of mid —
 * the sum of all level sizes priced inside the threshold (conservative:
 * average slippage is always better than worst).
 */
export function maxQtyWithinBps(
  levels: BookLevel[],
  mid: number,
  maxBps: number,
  side: "Buy" | "Sell"
): number {
  if (!(mid > 0)) return 0;
  const threshold = side === "Buy"
    ? mid * (1 + maxBps / 10_000)
    : mid * (1 - maxBps / 10_000);
  let qty = 0;
  for (const level of levels) {
    const within = side === "Buy" ? level.price <= threshold : level.price >= threshold;
    if (!within) break; // levels are best-first; once outside, all deeper levels are too
    qty += level.size;
  }
  return qty;
}

interface FeeRateResult {
  list: Array<{ symbol: string; takerFeeRate: string; makerFeeRate: string }>;
}

export interface ExecutionCostResult {
  symbol: string;
  category: "linear" | "inverse" | "spot";
  side: "Buy" | "Sell";
  qty: number;
  qtyUnit: string;
  book: {
    bestBid: number;
    bestAsk: number;
    midPrice: number;
    spreadBps: number;
    levelsFetched: number;
    bidDepthNotionalUsd: number;
    askDepthNotionalUsd: number;
    // > 1 = more resting bids than asks over the fetched depth
    imbalance: number | null;
  };
  sweep: {
    filledQty: number;
    fillNotionalUsd: number;
    avgFillPrice: number | null;
    worstFillPrice: number | null;
    slippageBpsVsMid: number | null;       // positive = pay up
    worstSlippageBpsVsMid: number | null;
    levelsConsumed: number;
    bookExhausted: boolean;
  };
  fees: {
    takerFeeBps: number;
    makerFeeBps: number;
    estimatedTakerFeeUsd: number | null;
  } | null;
  // slippage + taker fee; what the order really costs vs mid
  allInCostBps: number | null;
  maxExecutable: {
    withinBps: number;
    qty: number;
    notionalUsd: number;
  };
  warnings: string[];
}

export interface ExecutionCostParams {
  symbol: string;
  side: "Buy" | "Sell";
  category?: "linear" | "inverse" | "spot";
  qty?: number;          // base units (linear/spot) or USD contracts (inverse)
  notionalUsd?: number;  // alternative to qty
  maxSlippageBps?: number;
  includeFees?: boolean; // default true (needs an authed key for fee-rate)
}

export async function handleEstimateExecutionCost(
  client: BybitClient,
  params: ExecutionCostParams
): Promise<ExecutionCostResult> {
  const category = params.category ?? "linear";
  const side = params.side;
  // side picks which book side gets swept — an undefined value slipping
  // through the dispatch cast would silently sweep the wrong side.
  if (side !== "Buy" && side !== "Sell") {
    throw new Error("estimate_execution_cost: side must be 'Buy' or 'Sell'");
  }
  const maxBps = params.maxSlippageBps ?? DEFAULT_MAX_SLIPPAGE_BPS;
  const warnings: string[] = [];

  if (params.qty === undefined && params.notionalUsd === undefined) {
    throw new Error("estimate_execution_cost: provide qty or notionalUsd");
  }
  if (params.qty !== undefined && !(params.qty > 0)) {
    throw new Error("estimate_execution_cost: qty must be > 0");
  }
  if (params.notionalUsd !== undefined && !(params.notionalUsd > 0)) {
    throw new Error("estimate_execution_cost: notionalUsd must be > 0");
  }

  const [obRes, feeRes] = await Promise.all([
    client.publicGet<OrderbookEntry>("/v5/market/orderbook", {
      category,
      symbol: params.symbol,
      limit: DEPTH_LIMIT[category],
    }),
    params.includeFees !== false
      ? client.signedGet<FeeRateResult>("/v5/account/fee-rate", {
          category,
          symbol: params.symbol,
        }).catch(() => null)
      : Promise.resolve(null),
  ]);

  const bids: BookLevel[] = (obRes.b ?? []).map(([p, s]) => ({ price: parseFloat(p), size: parseFloat(s) }));
  const asks: BookLevel[] = (obRes.a ?? []).map(([p, s]) => ({ price: parseFloat(p), size: parseFloat(s) }));
  const bestBid = bids[0]?.price ?? 0;
  const bestAsk = asks[0]?.price ?? 0;
  if (!(bestBid > 0) || !(bestAsk > 0)) {
    throw new Error(`Orderbook for ${params.symbol} (${category}) is empty or one-sided — cannot estimate`);
  }
  const mid = (bestBid + bestAsk) / 2;
  const spreadBps = ((bestAsk - bestBid) / mid) * 10_000;

  // Resolve the sweep quantity. Inverse contracts ARE USD, so notionalUsd
  // maps 1:1 to contract qty.
  const isInverse = category === "inverse";
  const qty = params.qty !== undefined
    ? params.qty
    : isInverse
      ? params.notionalUsd!
      : params.notionalUsd! / mid;

  const takerSide = side === "Buy" ? asks : bids;
  const sweep = walkBook(takerSide, qty, isInverse);

  if (sweep.exhausted) {
    warnings.push(
      `Order sweeps the ENTIRE visible book (${DEPTH_LIMIT[category]} levels) and only fills ` +
      `${sweep.filledQty} of ${qty}. Real cost will exceed this estimate — split the order or reduce size.`
    );
  }

  const slippageBps = sweep.avgFillPrice !== null
    ? (side === "Buy"
        ? ((sweep.avgFillPrice - mid) / mid) * 10_000
        : ((mid - sweep.avgFillPrice) / mid) * 10_000)
    : null;
  const worstSlippageBps = sweep.worstFillPrice !== null
    ? (side === "Buy"
        ? ((sweep.worstFillPrice - mid) / mid) * 10_000
        : ((mid - sweep.worstFillPrice) / mid) * 10_000)
    : null;

  // USD notionals. Inverse: contracts are USD already.
  const fillNotionalUsd = isInverse
    ? sweep.filledQty
    : sweep.filledQty * (sweep.avgFillPrice ?? 0);
  const bidDepthNotionalUsd = isInverse
    ? bids.reduce((s, l) => s + l.size, 0)
    : bids.reduce((s, l) => s + l.price * l.size, 0);
  const askDepthNotionalUsd = isInverse
    ? asks.reduce((s, l) => s + l.size, 0)
    : asks.reduce((s, l) => s + l.price * l.size, 0);
  const imbalance = askDepthNotionalUsd > 0 ? bidDepthNotionalUsd / askDepthNotionalUsd : null;

  const feeEntry = feeRes?.list?.[0];
  const takerFeeRate = feeEntry ? parseFloat(feeEntry.takerFeeRate) : NaN;
  const makerFeeRate = feeEntry ? parseFloat(feeEntry.makerFeeRate) : NaN;
  const fees = Number.isFinite(takerFeeRate) && Number.isFinite(makerFeeRate)
    ? {
        takerFeeBps: r2(takerFeeRate * 10_000),
        makerFeeBps: r2(makerFeeRate * 10_000),
        estimatedTakerFeeUsd: fillNotionalUsd > 0 ? r2(fillNotionalUsd * takerFeeRate) : null,
      }
    : null;
  if (params.includeFees !== false && !fees) {
    warnings.push("Fee rate unavailable (endpoint failed or returned no data) — allInCostBps omits fees.");
  }

  const allInCostBps = slippageBps !== null
    ? r2(slippageBps + (fees ? fees.takerFeeBps : 0))
    : null;

  const maxQty = maxQtyWithinBps(takerSide, mid, maxBps, side);
  const maxSweep = walkBook(takerSide, maxQty, isInverse);
  const maxNotionalUsd = isInverse ? maxSweep.filledQty : maxSweep.filledQty * (maxSweep.avgFillPrice ?? 0);

  return {
    symbol: params.symbol,
    category,
    side,
    qty,
    qtyUnit: isInverse ? "USD contracts" : "base units",
    book: {
      bestBid,
      bestAsk,
      midPrice: mid,
      spreadBps: r2(spreadBps),
      levelsFetched: bids.length + asks.length,
      bidDepthNotionalUsd: ri(bidDepthNotionalUsd),
      askDepthNotionalUsd: ri(askDepthNotionalUsd),
      imbalance: imbalance !== null ? r2(imbalance) : null,
    },
    sweep: {
      filledQty: sweep.filledQty,
      fillNotionalUsd: ri(fillNotionalUsd),
      avgFillPrice: sweep.avgFillPrice,
      worstFillPrice: sweep.worstFillPrice,
      slippageBpsVsMid: slippageBps !== null ? r2(slippageBps) : null,
      worstSlippageBpsVsMid: worstSlippageBps !== null ? r2(worstSlippageBps) : null,
      levelsConsumed: sweep.levelsConsumed,
      bookExhausted: sweep.exhausted,
    },
    fees,
    allInCostBps,
    maxExecutable: {
      withinBps: maxBps,
      qty: maxSweep.filledQty,
      notionalUsd: ri(maxNotionalUsd),
    },
    warnings,
  };
}
