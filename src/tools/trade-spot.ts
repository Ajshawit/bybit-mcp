import crypto from "crypto";
import { BybitClient } from "../client";
import { floorToStep } from "../util";
import { ensureInstrumentInfo, fetchFillSnapshot } from "./trade-shared";
import { assertConfirm } from "./confirm";
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
  triggerPrice?: number;
  triggerBy?: "LastPrice" | "MarkPrice" | "IndexPrice";
  triggerDirection?: 1 | 2;
  notes?: string;
  dry_run?: boolean;
  confirm?: string;
}

function resolveTriggerDirection(
  explicit: 1 | 2 | undefined,
  triggerPrice: number,
  marketPrice: number,
): 1 | 2 {
  if (explicit === 1 || explicit === 2) return explicit;
  return triggerPrice >= marketPrice ? 1 : 2;
}

// Mirrors the perp helper. See trade-perp.ts for the rationale.
const TRIGGER_NEAR_MARKET_EPSILON = 0.001;

function nearMarketWarning(triggerPrice: number, marketPrice: number): string | null {
  if (marketPrice <= 0) return null;
  const drift = Math.abs(triggerPrice - marketPrice) / marketPrice;
  if (drift >= TRIGGER_NEAR_MARKET_EPSILON) return null;
  return `triggerPrice ${triggerPrice} is within ${(TRIGGER_NEAR_MARKET_EPSILON * 100).toFixed(1)}% of current price ${marketPrice} — the order will likely fire immediately or be rejected as already-triggered. Use a wider trigger or place a regular order.`;
}

export async function handlePlaceSpot(
  client: BybitClient,
  params: PlaceSpotParams
): Promise<PlaceTradeResult | DryRunResult> {
  const {
    symbol, side, margin, category,
    orderType = "Market", price: limitPrice,
    sl, tp, trailingStop,
    triggerPrice, triggerBy = "LastPrice", triggerDirection: explicitDirection,
    notes, dry_run = false, confirm,
  } = params;

  // assertConfirm fires before any other shape validation so a missing
  // confirm always reports the gate error first.
  assertConfirm(confirm, dry_run, "place_trade");

  // This guard subsumes the "no trailing on conditional" check that the perp
  // handler has to make explicitly: spot rejects ANY trailingStop here, so a
  // conditional-spot order can never combine with one. If spot ever gains
  // real trailing-stop support, re-add a dedicated triggerPrice+trailingStop
  // throw alongside it (mirroring trade-perp.ts).
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

  const rawQtyNum = margin / execPrice;
  const qty = floorToStep(rawQtyNum, inst.qtyStep);

  if (dry_run) {
    const warnings: string[] = [];
    if (margin > freeUsdt) {
      warnings.push(
        `Insufficient USDT balance: need ${margin}, have ${freeUsdt.toFixed(2)} (shortfall: ${(margin - freeUsdt).toFixed(2)})`
      );
    }
    const pct = (margin / freeUsdt) * 100;
    if (pct > 20 && margin <= freeUsdt) {
      warnings.push(`Order uses ${pct.toFixed(0)}% of free USDT balance (${freeUsdt.toFixed(2)} USDT)`);
    }
    if (triggerPrice != null) {
      const w = nearMarketWarning(triggerPrice, marketPrice);
      if (w) warnings.push(w);
    }
    const triggerFields = triggerPrice != null ? {
      triggerPrice: String(triggerPrice),
      triggerBy,
      triggerDirection: resolveTriggerDirection(explicitDirection, triggerPrice, marketPrice),
    } : {};
    return {
      dryRun: true, category, symbol, side, orderType,
      computedQty: qty, executionPrice: String(execPrice),
      notional: margin.toFixed(2), marginCoin: "USDT",
      marginRequired: String(margin), walletBalanceAvailable: freeUsdt.toFixed(2),
      warnings, wouldSubmit: margin <= freeUsdt && parseFloat(qty) > 0,
      serverTimestamp: new Date().toISOString(),
      qtyRoundedDown: parseFloat(qty) < rawQtyNum,
      qtyStep: inst.qtyStep,
      ...triggerFields,
    };
  }

  if (margin > freeUsdt) {
    throw new Error(
      `Insufficient USDT balance: need ${margin}, have ${freeUsdt.toFixed(2)} (shortfall: ${(margin - freeUsdt).toFixed(2)})`
    );
  }

  const orderBody: Record<string, unknown> = {
    category: "spot", symbol, side, orderType, qty,
  };
  if (triggerPrice != null) {
    orderBody.orderFilter = "StopOrder";
    orderBody.triggerPrice = String(triggerPrice);
    orderBody.triggerBy = triggerBy;
    orderBody.triggerDirection = resolveTriggerDirection(explicitDirection, triggerPrice, marketPrice);
  }
  if (orderType === "Limit") {
    orderBody.price = String(limitPrice);
  } else if (side === "Buy") {
    // marketUnit:"baseCoin" tells Bybit the `qty` for a spot market Buy is in
    // base coin (not quote USDT). We keep this on stop-market Buys too so the
    // dry-run computedQty matches what fills at trigger time, instead of the
    // exchange interpreting qty as USDT and buying a different amount of base
    // coin. Whether Bybit honours marketUnit on orderFilter=StopOrder is not
    // documented; if it 400s on a live submission, switch stop-market Buys to
    // stop-Limit (same triggerPrice with limitPrice = triggerPrice + slippage).
    orderBody.marketUnit = "baseCoin";
  }
  if (category === "spot_margin") orderBody.isLeverage = 1;

  const orderRes = await client.signedPost<OrderCreateResult>("/v5/order/create", orderBody);

  const fill = await fetchFillSnapshot(client, "spot", symbol, orderRes.orderId, execPrice);

  const result: PlaceTradeResult = {
    orderId: orderRes.orderId,
    orderLinkId: orderRes.orderLinkId,
    symbol,
    filledQty: qty,
    avgFillPrice: fill.avgFillPrice,
    fillStatus: fill.fillStatus,
    cumExecQty: fill.cumExecQty,
    serverTimestamp: new Date().toISOString(),
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
  confirm?: string;
}

export async function handleCloseSpot(
  client: BybitClient,
  params: CloseSpotParams
): Promise<SpotCloseResult> {
  const { symbol, percent = 100, qty: explicitQty, notes, confirm } = params;

  assertConfirm(confirm, false, "close_position");
  // Only supports USDT-quoted spot symbols (e.g. BTCUSDT → BTC). Non-USDT quotes are out of scope.
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
    symbol,
    closedQty: closeQty,
    remainingBalance: remaining,
    serverTimestamp: new Date().toISOString(),
    notes,
  };
}
