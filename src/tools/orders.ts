import { BybitClient } from "../client";

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
  params: { symbol: string; orderId: string; category?: OrderCategory }
): Promise<{ cancelled: boolean; orderId: string; orderLinkId: string; symbol: string; serverTimestamp: string }> {
  const { symbol, orderId, category = "linear" } = params;
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

export async function handleCancelAllOrders(
  client: BybitClient,
  params: { symbol?: string; category?: OrderCategory }
): Promise<{ cancelledCount: number; cancelled: BybitCancelledItem[]; serverTimestamp: string }> {
  const { symbol, category = "linear" } = params;
  const body: Record<string, string> = { category };
  if (symbol) body.symbol = symbol;

  const res = await client.signedPost<{ list: BybitCancelledItem[] }>("/v5/order/cancel-all", body);
  return {
    cancelledCount: res.list.length,
    cancelled: res.list,
    serverTimestamp: new Date().toISOString(),
  };
}
