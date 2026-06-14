import { BybitClient } from "../client";
import { instrumentsCache, positionModeCache } from "../cache";
import { InstrumentInfoResult, OrderRealtimeResult } from "./types";

export type PerpCategory = "linear" | "inverse";
export type TradeCategory = "linear" | "inverse" | "spot" | "spot_margin";

export interface FillSnapshot {
  avgFillPrice: number;
  fillStatus: string;
  cumExecQty: string;
  // True when avgFillPrice is the pre-trade reference price (lookup failed or
  // nothing executed yet), not a real fill — callers surface this explicitly.
  isFallback?: boolean;
}

// Best-effort lookup of actual fill price after create. Bybit's order/create
// returns only orderId; the executed VWAP lives on order/realtime. If the call
// fails (e.g. transient error), we return the reference price so the trade
// response stays informative — callers should consult fillStatus to decide
// whether avgFillPrice is real or a fallback.
export async function fetchFillSnapshot(
  client: BybitClient,
  category: string,
  symbol: string,
  orderId: string,
  fallbackPrice: number
): Promise<FillSnapshot> {
  try {
    const res = await client.signedGet<OrderRealtimeResult>("/v5/order/realtime", {
      category, symbol, orderId,
    });
    const o = res.list[0];
    if (!o) return { avgFillPrice: fallbackPrice, fillStatus: "Unknown", cumExecQty: "0", isFallback: true };
    const cumExecQty = o.cumExecQty || "0";
    const executed = parseFloat(cumExecQty) > 0;
    const avgFillPrice = executed ? parseFloat(o.avgPrice) : fallbackPrice;
    return { avgFillPrice, fillStatus: o.orderStatus || "Unknown", cumExecQty, ...(executed ? {} : { isFallback: true }) };
  } catch {
    return { avgFillPrice: fallbackPrice, fillStatus: "Unknown", cumExecQty: "0", isFallback: true };
  }
}

export async function ensureInstrumentInfo(
  client: BybitClient,
  category: string,
  symbol: string
) {
  const key = `${category}:${symbol}`;
  let info = instrumentsCache.get(key);
  if (info) return info;

  const res = await client.publicGet<InstrumentInfoResult>("/v5/market/instruments-info", {
    category,
    symbol,
  });
  const inst = res.list?.[0];
  if (!inst) {
    throw new Error(`No instrument info returned for ${category}:${symbol} — check the symbol/category pairing.`);
  }
  info = {
    tickSize: inst.priceFilter.tickSize,
    qtyStep: inst.lotSizeFilter.qtyStep ?? inst.lotSizeFilter.basePrecision ?? "0.001",
    minNotionalValue: inst.minNotionalValue ?? "0",
  };
  instrumentsCache.set(key, info);
  return info;
}

export async function detectPositionIdx(
  client: BybitClient,
  category: PerpCategory,
  symbol: string,
  side: "Buy" | "Sell"
): Promise<0 | 1 | 2> {
  const cached = positionModeCache.get(category, symbol, side);
  if (cached !== undefined) return cached;

  const res = await client.signedGet<{ list: Array<{ positionIdx: 0 | 1 | 2; size: string }> }>(
    "/v5/position/list",
    { category, symbol }
  );

  const idx: 0 | 1 | 2 = res.list.some((p) => p.positionIdx === 1 || p.positionIdx === 2)
    ? side === "Buy" ? 1 : 2
    : 0;

  positionModeCache.set(category, symbol, side, idx);
  return idx;
}
