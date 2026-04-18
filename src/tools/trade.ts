import crypto from "crypto";
import { BybitClient } from "../client";
import { instrumentsCache } from "../cache";
import { floorToStep } from "../util";
import {
  TickersResult,
  WalletBalanceResult,
  OrderCreateResult,
  InstrumentInfoResult,
} from "./types";

export interface PlaceTradeParams {
  symbol: string;
  side: "Buy" | "Sell";
  marginUsdt: number;
  leverage: number;
  sl: number;
  tp?: number;
  trailingStop?: number;
  trailingActivatePrice?: number;
  notes?: string;
}

export interface PlaceTradeResult {
  orderId: string;
  orderLinkId: string;
  filledQty: string;
  avgFillPrice: number;
  notes?: string;
  sizeWarning?: string;
  partialSuccess?: boolean;
  trailingStopError?: string;
}

async function ensureInstrumentInfo(client: BybitClient, symbol: string) {
  let info = instrumentsCache.get(symbol);
  if (info) return info;

  const res = await client.publicGet<InstrumentInfoResult>("/v5/market/instruments-info", {
    category: "linear",
    symbol,
  });
  const inst = res.list[0];
  info = {
    tickSize: inst.priceFilter.tickSize,
    qtyStep: inst.lotSizeFilter.qtyStep,
    minNotionalValue: inst.minNotionalValue,
  };
  instrumentsCache.set(symbol, info);
  return info;
}

export async function handlePlaceTrade(
  client: BybitClient,
  params: PlaceTradeParams
): Promise<PlaceTradeResult> {
  const { symbol, side, marginUsdt, leverage, sl, tp, trailingStop, trailingActivatePrice, notes } = params;

  const [inst, tickerRes, walletRes] = await Promise.all([
    ensureInstrumentInfo(client, symbol),
    client.publicGet<TickersResult>("/v5/market/tickers", { category: "linear", symbol }),
    client.signedGet<WalletBalanceResult>("/v5/account/wallet-balance", {
      accountType: "UNIFIED",
      coin: "USDT",
    }),
  ]);

  const price = parseFloat(tickerRes.list[0].lastPrice);
  const usdtCoin = walletRes.list[0].coin.find((c) => c.coin === "USDT")!;
  const freeCapital = parseFloat(usdtCoin.walletBalance) - parseFloat(usdtCoin.totalPositionIM);

  if (marginUsdt > freeCapital) {
    throw new Error(
      `Insufficient free capital: need ${marginUsdt} USDT, have ${freeCapital.toFixed(2)} USDT (shortfall: ${(marginUsdt - freeCapital).toFixed(2)} USDT)`
    );
  }

  const qty = floorToStep((marginUsdt * leverage) / price, inst.qtyStep);
  const notional = parseFloat(qty) * price;
  if (notional < parseFloat(inst.minNotionalValue)) {
    throw new Error(
      `Notional too low: ${notional.toFixed(2)} USDT, minimum is ${inst.minNotionalValue} USDT`
    );
  }

  await client.signedPost("/v5/position/set-leverage", {
    category: "linear",
    symbol,
    buyLeverage: String(leverage),
    sellLeverage: String(leverage),
  });

  const positionIdx = side === "Buy" ? 1 : 2;
  const nonce = crypto.randomBytes(3).toString("hex");
  const orderLinkId = `mcp-${Date.now()}-${nonce}`;

  const orderBody: Record<string, unknown> = {
    category: "linear",
    symbol,
    side,
    orderType: "Market",
    qty,
    positionIdx,
    stopLoss: String(sl),
    orderLinkId,
  };
  if (tp != null) orderBody.takeProfit = String(tp);

  const orderRes = await client.signedPost<OrderCreateResult>("/v5/order/create", orderBody);

  const result: PlaceTradeResult = {
    orderId: orderRes.orderId,
    orderLinkId: orderRes.orderLinkId,
    filledQty: qty,
    avgFillPrice: price,
    notes,
  };

  const pct = (marginUsdt / freeCapital) * 100;
  if (pct > 20) {
    result.sizeWarning = `Order uses ${pct.toFixed(0)}% of free capital (${freeCapital.toFixed(2)} USDT)`;
  }

  if (trailingStop != null) {
    try {
      const trailingBody: Record<string, unknown> = {
        category: "linear",
        symbol,
        side,
        positionIdx,
        trailingStop: String(trailingStop),
      };
      if (trailingActivatePrice != null) {
        trailingBody.activePrice = String(trailingActivatePrice);
      }
      await client.signedPost("/v5/position/trading-stop", trailingBody);
    } catch (e: unknown) {
      result.partialSuccess = true;
      result.trailingStopError = e instanceof Error ? e.message : String(e);
    }
  }

  return result;
}

export interface ClosePositionParams {
  symbol: string;
  side: "Buy" | "Sell";
  percent?: number;
}

export interface ClosePositionResult {
  orderId: string;
  orderLinkId: string;
  closedQty: string;
  remainingSize: number;
}

export async function handleClosePosition(
  client: BybitClient,
  params: ClosePositionParams
): Promise<ClosePositionResult> {
  const { symbol, side, percent = 100 } = params;
  const positionIdx = side === "Buy" ? 1 : 2;
  const inst = await ensureInstrumentInfo(client, symbol);

  const posRes = await client.signedGet<{ list: Array<{ size: string; positionIdx: number; unrealisedPnl: string }>; category: string }>(
    "/v5/position/list",
    { category: "linear", symbol }
  );

  const pos = posRes.list.find((p) => p.positionIdx === positionIdx && parseFloat(p.size) > 0);
  if (!pos) {
    throw new Error(`No open ${side} position found for ${symbol}`);
  }

  const closeQty = floorToStep(parseFloat(pos.size) * percent / 100, inst.qtyStep);
  const remaining = parseFloat(pos.size) - parseFloat(closeQty);
  const closeSide = side === "Buy" ? "Sell" : "Buy";
  const nonce = crypto.randomBytes(3).toString("hex");

  const orderRes = await client.signedPost<OrderCreateResult>("/v5/order/create", {
    category: "linear",
    symbol,
    side: closeSide,
    orderType: "Market",
    qty: closeQty,
    positionIdx,
    reduceOnly: true,
    orderLinkId: `mcp-${Date.now()}-${nonce}`,
  });

  return {
    orderId: orderRes.orderId,
    orderLinkId: orderRes.orderLinkId,
    closedQty: closeQty,
    remainingSize: remaining,
  };
}

export interface ManagePositionParams {
  symbol: string;
  side: "Buy" | "Sell";
  updates: {
    sl?: number;
    tp?: number;
    trailingStop?: number;
    trailingActivatePrice?: number;
  };
}

export async function handleManagePosition(
  client: BybitClient,
  params: ManagePositionParams
): Promise<{ updated: boolean }> {
  const { symbol, side, updates } = params;
  const positionIdx = side === "Buy" ? 1 : 2;

  const body: Record<string, unknown> = {
    category: "linear",
    symbol,
    positionIdx,
  };

  if (updates.sl != null) body.stopLoss = String(updates.sl);
  if (updates.tp != null) body.takeProfit = String(updates.tp);
  if (updates.trailingStop != null) body.trailingStop = String(updates.trailingStop);
  if (updates.trailingActivatePrice != null) body.activePrice = String(updates.trailingActivatePrice);

  await client.signedPost("/v5/position/trading-stop", body);
  return { updated: true };
}
