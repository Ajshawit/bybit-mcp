import crypto from "crypto";
import { BybitClient } from "../client";
import { floorToStep } from "../util";
import { ensureInstrumentInfo } from "./trade-shared";
import {
  TickersResult, WalletBalanceResult, OrderCreateResult,
  PlaceTradeResult, SpotCloseResult, DryRunResult,
} from "./types";

export interface PlaceSpotParams {
  symbol: string;
  side: "Buy" | "Sell";
  margin: number;
  category: "spot" | "spot_margin";
  orderType?: "Market" | "Limit";
  price?: number;
  sl?: number;
  tp?: number;
  trailingStop?: number;
  notes?: string;
  dry_run?: boolean;
}

export async function handlePlaceSpot(
  client: BybitClient,
  params: PlaceSpotParams
): Promise<PlaceTradeResult | DryRunResult> {
  const {
    symbol, side, margin, category,
    orderType = "Market", price: limitPrice,
    sl, tp, trailingStop, notes, dry_run = false,
  } = params;

  if (sl != null || tp != null || trailingStop != null) {
    throw new Error("SL/TP/trailing stop not supported for spot — no position to attach to");
  }
  if (orderType === "Limit" && limitPrice == null) {
    throw new Error("price is required for limit orders");
  }

  const [inst, tickerRes, walletRes] = await Promise.all([
    ensureInstrumentInfo(client, "spot", symbol),
    client.publicGet<TickersResult>("/v5/market/tickers", { category: "spot", symbol }),
    client.signedGet<WalletBalanceResult>("/v5/account/wallet-balance", {
      accountType: "UNIFIED",
      coin: "USDT",
    }),
  ]);

  const marketPrice = parseFloat(tickerRes.list[0].lastPrice);
  const execPrice = orderType === "Limit" ? limitPrice! : marketPrice;

  const usdtCoin = walletRes.list[0].coin.find((c) => c.coin === "USDT");
  if (!usdtCoin) throw new Error("USDT coin not found in wallet balance response");
  const freeUsdt = parseFloat(usdtCoin.walletBalance) - parseFloat(usdtCoin.totalPositionIM);

  const qty = floorToStep(margin / execPrice, inst.qtyStep);

  if (dry_run) {
    const warnings: string[] = [];
    const pct = (margin / freeUsdt) * 100;
    if (margin > freeUsdt) {
      warnings.push(`Insufficient USDT balance: need ${margin}, have ${freeUsdt.toFixed(2)} (shortfall: ${(margin - freeUsdt).toFixed(2)})`);
    } else if (pct > 20) {
      warnings.push(`Order uses ${pct.toFixed(0)}% of free USDT balance (${freeUsdt.toFixed(2)} USDT)`);
    }
    return {
      dryRun: true, category, symbol, side, orderType,
      computedQty: qty, executionPrice: String(execPrice),
      notional: margin.toFixed(2), marginCoin: "USDT",
      marginRequired: String(margin), walletBalanceAvailable: freeUsdt.toFixed(2),
      warnings, wouldSubmit: true,
    };
  }

  const orderBody: Record<string, unknown> = {
    category: "spot", symbol, side, orderType, qty,
  };
  if (orderType === "Limit") {
    orderBody.price = String(limitPrice);
  } else if (side === "Buy") {
    orderBody.marketUnit = "baseCoin";
  }
  if (category === "spot_margin") orderBody.isLeverage = 1;

  const orderRes = await client.signedPost<OrderCreateResult>("/v5/order/create", orderBody);

  const result: PlaceTradeResult = {
    orderId: orderRes.orderId,
    orderLinkId: orderRes.orderLinkId,
    filledQty: qty,
    avgFillPrice: execPrice,
    notes,
  };

  const pct = (margin / freeUsdt) * 100;
  if (pct > 20) {
    result.sizeWarning = `Order uses ${pct.toFixed(0)}% of free USDT balance (${freeUsdt.toFixed(2)} USDT)`;
  }

  return result;
}

export interface CloseSpotParams {
  symbol: string;
  percent?: number;
  qty?: number;
  notes?: string;
}

export async function handleCloseSpot(
  client: BybitClient,
  params: CloseSpotParams
): Promise<SpotCloseResult> {
  const { symbol, percent = 100, qty: explicitQty, notes } = params;
  const baseCoin = symbol.replace(/USDT$/, "");

  const [inst, walletRes] = await Promise.all([
    ensureInstrumentInfo(client, "spot", symbol),
    client.signedGet<WalletBalanceResult>("/v5/account/wallet-balance", {
      accountType: "UNIFIED",
      coin: baseCoin,
    }),
  ]);

  const coinEntry = walletRes.list[0]?.coin.find((c) => c.coin === baseCoin);
  const available = coinEntry
    ? parseFloat(coinEntry.walletBalance) - parseFloat(coinEntry.locked || "0")
    : 0;

  if (available <= 0) throw new Error(`No ${baseCoin} balance found to close`);

  let closeQty: string;
  if (explicitQty != null) {
    if (explicitQty > available) {
      throw new Error(`Requested qty ${explicitQty} exceeds available ${baseCoin} balance ${available}`);
    }
    closeQty = floorToStep(explicitQty, inst.qtyStep);
  } else {
    closeQty = floorToStep(available * percent / 100, inst.qtyStep);
  }

  const remaining = available - parseFloat(closeQty);
  const nonce = crypto.randomBytes(3).toString("hex");

  const orderRes = await client.signedPost<OrderCreateResult>("/v5/order/create", {
    category: "spot", symbol, side: "Sell", orderType: "Market",
    qty: closeQty, orderLinkId: `mcp-${Date.now()}-${nonce}`,
  });

  return {
    orderId: orderRes.orderId,
    orderLinkId: orderRes.orderLinkId,
    closedQty: closeQty,
    remainingBalance: remaining,
    notes,
  };
}
