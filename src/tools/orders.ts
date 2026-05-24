import { BybitClient } from "../client";
import { assertConfirm } from "./confirm";

export type OrderCategory = "linear" | "inverse" | "spot" | "option";

interface BybitOpenOrder {
  orderId: string;
  orderLinkId: string;
  symbol: string;
  side: "Buy" | "Sell";
  orderType: string;
  price: string;
  qty: string;
  leavesQty: string;
  orderStatus: string;
  stopLoss: string;
  takeProfit: string;
  trailingStop: string;
  triggerPrice: string;
  createdTime: string;
  positionIdx: number;
}

interface BybitOpenOrdersResult {
  list: BybitOpenOrder[];
  category: string;
}

interface BybitCancelledItem {
  orderId: string;
  orderLinkId: string;
}

export interface OpenOrder {
  orderId: string;
  orderLinkId: string;
  symbol: string;
  side: "Buy" | "Sell";
  orderType: string;
  price: number;
  qty: number;
  filledQty: number;
  status: string;
  sl: number | null;
  tp: number | null;
  trailingStop: number;
  activationPrice: number | null;
  createdTime: string;
  positionIdx: number;
}

function mapOrder(o: BybitOpenOrder): OpenOrder {
  const qty = parseFloat(o.qty);
  const leavesQty = parseFloat(o.leavesQty || "0");
  return {
    orderId: o.orderId,
    orderLinkId: o.orderLinkId,
    symbol: o.symbol,
    side: o.side,
    orderType: o.orderType,
    price: parseFloat(o.price),
    qty,
    filledQty: qty - leavesQty,
    status: o.orderStatus,
    sl: o.stopLoss && o.stopLoss !== "0" ? parseFloat(o.stopLoss) : null,
    tp: o.takeProfit && o.takeProfit !== "0" ? parseFloat(o.takeProfit) : null,
    trailingStop: parseFloat(o.trailingStop || "0"),
    activationPrice: o.triggerPrice && o.triggerPrice !== "0" ? parseFloat(o.triggerPrice) : null,
    createdTime: new Date(parseInt(o.createdTime, 10)).toISOString(),
    positionIdx: o.positionIdx,
  };
}

export async function handleListOpenOrders(
  client: BybitClient,
  params: { symbol?: string; category?: OrderCategory }
): Promise<{ orders: OpenOrder[]; count: number; serverTimestamp: string }> {
  const { symbol, category = "linear" } = params;
  const query: Record<string, string> = { category, limit: "50" };
  if (symbol) query.symbol = symbol;

  const res = await client.signedGet<BybitOpenOrdersResult>("/v5/order/realtime", query);
  const orders = res.list.map(mapOrder);
  return { orders, count: orders.length, serverTimestamp: new Date().toISOString() };
}

export async function handleCancelOrder(
  client: BybitClient,
  params: { symbol: string; orderId: string; category?: OrderCategory; confirm?: string }
): Promise<{ cancelled: boolean; orderId: string; orderLinkId: string; symbol: string; serverTimestamp: string }> {
  const { symbol, orderId, category = "linear", confirm } = params;
  assertConfirm(confirm, false, "cancel_order");
  const res = await client.signedPost<BybitCancelledItem>("/v5/order/cancel", {
    category, symbol, orderId,
  });
  return {
    cancelled: true,
    orderId: res.orderId,
    orderLinkId: res.orderLinkId,
    symbol,
    serverTimestamp: new Date().toISOString(),
  };
}

export type ClosedPnlCategory = "linear" | "inverse";

interface BybitClosedPnl {
  symbol: string;
  side: "Buy" | "Sell";
  closedPnl: string;
  avgEntryPrice: string;
  avgExitPrice: string;
  qty: string;
  closedSize: string;
  cumEntryValue: string;
  cumExitValue: string;
  leverage: string;
  createdTime: string;
  updatedTime: string;
  orderType: string;
  execType: string;
}

interface BybitClosedPnlResult {
  list: BybitClosedPnl[];
  category: string;
  nextPageCursor?: string;
}

export interface ClosedTrade {
  symbol: string;
  // Bybit returns the closing-order side; the position itself was the
  // opposite. We translate so the caller sees the position direction.
  positionSide: "LONG" | "SHORT";
  closedPnl: number;
  avgEntryPrice: number;
  avgExitPrice: number;
  qty: number;
  entryValue: number;
  exitValue: number;
  leverage: number;
  openedAt: string;
  closedAt: string;
  holdSeconds: number;
  pnlPct: number;
  orderType: string;
  execType: string;
}

function mapClosedPnl(p: BybitClosedPnl): ClosedTrade {
  const positionSide: "LONG" | "SHORT" = p.side === "Sell" ? "LONG" : "SHORT";
  const closedPnl = parseFloat(p.closedPnl);
  const cumEntryValue = parseFloat(p.cumEntryValue);
  const createdMs = parseInt(p.createdTime, 10);
  const updatedMs = parseInt(p.updatedTime, 10);
  const holdSeconds = Math.max(0, Math.round((updatedMs - createdMs) / 1000));
  const pnlPct = cumEntryValue > 0 ? (closedPnl / cumEntryValue) * 100 : 0;
  return {
    symbol: p.symbol,
    positionSide,
    closedPnl: Math.round(closedPnl * 10000) / 10000,
    avgEntryPrice: parseFloat(p.avgEntryPrice),
    avgExitPrice: parseFloat(p.avgExitPrice),
    qty: parseFloat(p.closedSize || p.qty),
    entryValue: cumEntryValue,
    exitValue: parseFloat(p.cumExitValue),
    leverage: parseFloat(p.leverage || "0"),
    openedAt: Number.isFinite(createdMs) ? new Date(createdMs).toISOString() : "",
    closedAt: Number.isFinite(updatedMs) ? new Date(updatedMs).toISOString() : "",
    holdSeconds,
    pnlPct: Math.round(pnlPct * 100) / 100,
    orderType: p.orderType,
    execType: p.execType,
  };
}

export async function handleGetClosedTrades(
  client: BybitClient,
  params: {
    symbol?: string;
    category?: ClosedPnlCategory;
    limit?: number;
    startTime?: number;
    endTime?: number;
  }
): Promise<{
  trades: ClosedTrade[];
  count: number;
  totalPnl: number;
  serverTimestamp: string;
}> {
  const { symbol, category = "linear", limit = 50, startTime, endTime } = params;
  const query: Record<string, string> = { category, limit: String(Math.min(Math.max(limit, 1), 100)) };
  if (symbol) query.symbol = symbol;
  if (startTime) query.startTime = String(startTime);
  if (endTime) query.endTime = String(endTime);

  const res = await client.signedGet<BybitClosedPnlResult>("/v5/position/closed-pnl", query);
  const trades = (res.list ?? []).map(mapClosedPnl);
  const totalPnl = trades.reduce((sum, t) => sum + t.closedPnl, 0);

  return {
    trades,
    count: trades.length,
    totalPnl: Math.round(totalPnl * 10000) / 10000,
    serverTimestamp: new Date().toISOString(),
  };
}
