import crypto from "crypto";
import { BybitClient, BybitError } from "../client";
import { positionModeCache } from "../cache";
import { floorToStep } from "../util";
import { ensureInstrumentInfo, detectPositionIdx, PerpCategory } from "./trade-shared";
import {
  TickersResult, WalletBalanceResult, OrderCreateResult,
  PlaceTradeResult, ClosePositionResult, DryRunResult,
} from "./types";

export interface PlacePerpParams {
  symbol: string;
  side: "Buy" | "Sell";
  margin: number;
  category?: PerpCategory;
  orderType?: "Market" | "Limit";
  price?: number;
  leverage: number;
  sl: number;
  tp?: number;
  trailingStop?: number;
  trailingActivatePrice?: number;
  notes?: string;
  dry_run?: boolean;
}

// Assumes standard inverse perp symbols end in "USD" (e.g. BTCUSD → BTC).
// Non-standard suffixes (e.g. quarterly BTCUSDH25) are out of scope.
function parseBaseCoin(symbol: string): string {
  return symbol.replace(/USD$/, "");
}

export async function handlePlacePerp(
  client: BybitClient,
  params: PlacePerpParams
): Promise<PlaceTradeResult | DryRunResult> {
  const {
    symbol, side, margin, category = "linear",
    orderType = "Market", price: limitPrice,
    leverage, sl, tp, trailingStop, trailingActivatePrice,
    notes, dry_run = false,
  } = params;

  if (orderType === "Limit" && limitPrice == null) {
    throw new Error("price is required for limit orders");
  }

  const marginCoin = category === "inverse" ? parseBaseCoin(symbol) : "USDT";

  const [inst, tickerRes, walletRes] = await Promise.all([
    ensureInstrumentInfo(client, category, symbol),
    client.publicGet<TickersResult>("/v5/market/tickers", { category, symbol }),
    client.signedGet<WalletBalanceResult>("/v5/account/wallet-balance", {
      accountType: "UNIFIED",
      coin: marginCoin,
    }),
  ]);

  const marketPrice = parseFloat(tickerRes.list[0].lastPrice);
  const execPrice = orderType === "Limit" ? limitPrice! : marketPrice;

  const coin = walletRes.list[0].coin.find((c) => c.coin === marginCoin);
  if (!coin) throw new Error(`${marginCoin} coin not found in wallet balance response`);
  const freeBalance = parseFloat(coin.walletBalance) - parseFloat(coin.totalPositionIM);

  const rawQty = category === "inverse"
    ? margin * leverage * execPrice
    : (margin * leverage) / execPrice;
  const qty = floorToStep(rawQty, inst.qtyStep);

  const notional = category === "inverse" ? rawQty : rawQty * execPrice;
  const minNotional = parseFloat(inst.minNotionalValue);

  if (dry_run) {
    const mmr = 0.005;
    const estimatedLiqPrice = side === "Buy"
      ? execPrice * (1 - 1 / leverage + mmr)
      : execPrice * (1 + 1 / leverage - mmr);
    const warnings: string[] = [];
    if (margin > freeBalance) {
      warnings.push(
        `Insufficient free capital: need ${margin} ${marginCoin}, have ${freeBalance.toFixed(4)} ${marginCoin} (shortfall: ${(margin - freeBalance).toFixed(4)} ${marginCoin})`
      );
    }
    if (minNotional > 0 && notional < minNotional) {
      warnings.push(`Notional too low: ${notional.toFixed(2)} USD, minimum is ${inst.minNotionalValue} USD`);
    }
    const pct = (margin / freeBalance) * 100;
    if (pct > 20 && margin <= freeBalance) warnings.push(`Order uses ${pct.toFixed(0)}% of free ${marginCoin} balance (${freeBalance.toFixed(4)} ${marginCoin})`);
    return {
      dryRun: true, category, symbol, side, orderType,
      computedQty: qty, executionPrice: String(execPrice),
      notional: notional.toFixed(2), effectiveLeverage: leverage,
      estimatedLiqPrice: estimatedLiqPrice.toFixed(2), liqPriceApproximate: true,
      marginCoin, marginRequired: String(margin),
      walletBalanceAvailable: freeBalance.toFixed(4), warnings,
      wouldSubmit: margin <= freeBalance
        && parseFloat(qty) > 0
        && (minNotional === 0 || notional >= minNotional),
      serverTimestamp: new Date().toISOString(),
    };
  }

  if (margin > freeBalance) {
    throw new Error(
      `Insufficient free capital: need ${margin} ${marginCoin}, have ${freeBalance.toFixed(4)} ${marginCoin} (shortfall: ${(margin - freeBalance).toFixed(4)} ${marginCoin})`
    );
  }
  if (minNotional > 0 && notional < minNotional) {
    throw new Error(`Notional too low: ${notional.toFixed(2)} USD, minimum is ${inst.minNotionalValue} USD`);
  }

  await client.signedPost("/v5/position/set-leverage", {
    category, symbol,
    buyLeverage: String(leverage),
    sellLeverage: String(leverage),
  });

  let positionIdx = await detectPositionIdx(client, category, symbol, side);
  const nonce = crypto.randomBytes(3).toString("hex");
  const orderLinkId = `mcp-${Date.now()}-${nonce}`;

  const orderBody: Record<string, unknown> = {
    category, symbol, side, orderType, qty, positionIdx,
    stopLoss: String(sl), orderLinkId,
  };
  if (orderType === "Limit") orderBody.price = String(limitPrice);
  if (tp != null) orderBody.takeProfit = String(tp);

  let orderRes: OrderCreateResult;
  try {
    orderRes = await client.signedPost<OrderCreateResult>("/v5/order/create", orderBody);
  } catch (err: unknown) {
    if (err instanceof BybitError && err.retCode === 10001 && positionIdx === 0) {
      const hedgeIdx: 0 | 1 | 2 = side === "Buy" ? 1 : 2;
      orderBody.positionIdx = hedgeIdx;
      try {
        orderRes = await client.signedPost<OrderCreateResult>("/v5/order/create", orderBody);
        positionModeCache.set(category, symbol, side, hedgeIdx);
        positionIdx = hedgeIdx;
      } catch (retryErr: unknown) {
        throw new Error("Position mode mismatch that auto-retry could not resolve. Check your account's position mode setting on Bybit.");
      }
    } else {
      throw err;
    }
  }

  const result: PlaceTradeResult = {
    orderId: orderRes!.orderId,
    orderLinkId: orderRes!.orderLinkId,
    symbol,
    filledQty: qty,
    avgFillPrice: execPrice,
    serverTimestamp: new Date().toISOString(),
    notes,
  };

  const pct = (margin / freeBalance) * 100;
  if (pct > 20) {
    result.sizeWarning = `Order uses ${pct.toFixed(0)}% of free ${marginCoin} balance (${freeBalance.toFixed(4)} ${marginCoin})`;
  }

  if (trailingStop != null) {
    try {
      const trailingBody: Record<string, unknown> = {
        category, symbol, side, positionIdx,
        trailingStop: String(trailingStop),
      };
      if (trailingActivatePrice != null) trailingBody.activePrice = String(trailingActivatePrice);
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
  category?: PerpCategory;
  percent?: number;
  qty?: number;
  notes?: string;
}

export async function handleClosePerp(
  client: BybitClient,
  params: ClosePositionParams
): Promise<ClosePositionResult> {
  const { symbol, side, category = "linear", percent = 100, qty: explicitQty, notes } = params;

  const [positionIdxInit, inst] = await Promise.all([
    detectPositionIdx(client, category, symbol, side),
    ensureInstrumentInfo(client, category, symbol),
  ]);
  let positionIdx = positionIdxInit;

  const posRes = await client.signedGet<{ list: Array<{ size: string; positionIdx: number }> }>(
    "/v5/position/list",
    { category, symbol }
  );

  const pos = posRes.list.find((p) => p.positionIdx === positionIdx && parseFloat(p.size) > 0);
  if (!pos) throw new Error(`No open ${side} position found for ${symbol}`);

  const closeQty = explicitQty != null
    ? floorToStep(explicitQty, inst.qtyStep)
    : floorToStep(parseFloat(pos.size) * percent / 100, inst.qtyStep);

  const remaining = parseFloat(pos.size) - parseFloat(closeQty);
  const closeSide = side === "Buy" ? "Sell" : "Buy";
  const nonce = crypto.randomBytes(3).toString("hex");

  const orderBody: Record<string, unknown> = {
    category, symbol, side: closeSide, orderType: "Market",
    qty: closeQty, positionIdx, reduceOnly: true,
    orderLinkId: `mcp-${Date.now()}-${nonce}`,
  };

  let orderRes: OrderCreateResult;
  try {
    orderRes = await client.signedPost<OrderCreateResult>("/v5/order/create", orderBody);
  } catch (err: unknown) {
    if (err instanceof BybitError && err.retCode === 10001 && positionIdx === 0) {
      const hedgeIdx: 0 | 1 | 2 = side === "Buy" ? 1 : 2;
      orderBody.positionIdx = hedgeIdx;
      try {
        orderRes = await client.signedPost<OrderCreateResult>("/v5/order/create", orderBody);
        positionModeCache.set(category, symbol, side, hedgeIdx);
        positionIdx = hedgeIdx;
      } catch {
        throw new Error("Position mode mismatch that auto-retry could not resolve. Check your account's position mode setting on Bybit.");
      }
    } else {
      throw err;
    }
  }

  return {
    orderId: orderRes!.orderId,
    orderLinkId: orderRes!.orderLinkId,
    symbol,
    closedQty: closeQty,
    remainingSize: remaining,
    serverTimestamp: new Date().toISOString(),
    notes,
  };
}

export interface ManagePositionParams {
  symbol: string;
  side: "Buy" | "Sell";
  category?: PerpCategory | "spot" | "spot_margin";
  updates: {
    sl?: number;
    tp?: number;
    trailingStop?: number;
    trailingActivatePrice?: number;
  };
  notes?: string;
}

export async function handleManagePosition(
  client: BybitClient,
  params: ManagePositionParams
): Promise<{ updated: boolean; symbol: string; serverTimestamp: string; notes?: string }> {
  const { symbol, side, category = "linear", updates, notes } = params;

  if (category === "spot" || category === "spot_margin") {
    throw new Error("manage_position is not supported for spot — spot has no persistent position");
  }

  const positionIdx = await detectPositionIdx(client, category, symbol, side);

  const body: Record<string, unknown> = { category, symbol, positionIdx };
  if (updates.sl != null) body.stopLoss = String(updates.sl);
  if (updates.tp != null) body.takeProfit = String(updates.tp);
  if (updates.trailingStop != null) body.trailingStop = String(updates.trailingStop);
  if (updates.trailingActivatePrice != null) body.activePrice = String(updates.trailingActivatePrice);

  await client.signedPost("/v5/position/trading-stop", body);
  return { updated: true, symbol, serverTimestamp: new Date().toISOString(), notes };
}
