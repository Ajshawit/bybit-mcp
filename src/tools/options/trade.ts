import crypto from "crypto";
import { BybitClient } from "../../client";
import { parseOptionSymbol, OPTION_MULTIPLIERS, OptionPayoffSummary, OptionTickersResult } from "./types";
import { WalletBalanceResult, OrderCreateResult } from "../types";
import { handleGetOptionPayoff } from "./payoff";

export interface PlaceOptionTradeParams {
  symbol: string;
  side: "Buy" | "Sell";
  qty: number;
  orderType: "Market" | "Limit";
  price?: number;
  notes?: string;
  dry_run?: boolean;
}

export interface PlaceOptionTradeResult {
  dryRun?: false;
  orderId: string;
  orderLinkId: string;
  symbol: string;
  side: "Buy" | "Sell";
  qty: number;
  estimatedPremium: number;
  greeks: { delta: number; gamma: number; theta: number; vega: number };
  notes?: string;
  serverTimestamp: string;
}

export interface OptionDryRunResult {
  dryRun: true;
  symbol: string;
  side: "Buy" | "Sell";
  qty: number;
  estimatedFillPrice: number;
  estimatedPremium: number;
  greeks: { delta: number; gamma: number; theta: number; vega: number };
  payoffSummary: OptionPayoffSummary;
  daysToExpiry: number;
  thetaPerDay: number;
  warnings: string[];
  wouldSubmit: boolean;
  serverTimestamp: string;
}

export interface CloseOptionPositionParams {
  symbol: string;
  qty?: number;
  orderType: "Market" | "Limit";
  price?: number;
  notes?: string;
  dry_run?: boolean;
}

export interface CloseOptionResult {
  dryRun?: false;
  orderId: string;
  orderLinkId: string;
  symbol: string;
  closedQty: number;
  remainingQty: number;
  notes?: string;
  serverTimestamp: string;
}

export interface OptionCloseDryRunResult {
  dryRun: true;
  symbol: string;
  currentSide: "Long" | "Short";
  currentQty: number;
  closeQty: number;
  estimatedFillPrice: number;
  estimatedPremium: number;
  estimatedPnl: number;
  warnings: string[];
  wouldSubmit: boolean;
  serverTimestamp: string;
}

interface PositionResult {
  list: Array<{
    symbol: string;
    side: "Buy" | "Sell" | "None";
    size: string;
    avgPrice: string;
  }>;
}


export async function handlePlaceOptionTrade(
  client: BybitClient,
  params: PlaceOptionTradeParams
): Promise<PlaceOptionTradeResult | OptionDryRunResult> {
  const { symbol, side, qty, orderType, price, notes, dry_run } = params;

  if (orderType === "Limit" && price == null) {
    throw new Error("price is required for Limit orders");
  }

  const parsed = parseOptionSymbol(symbol);
  if (parsed.expiry <= new Date()) {
    throw new Error(`Contract ${symbol} has expired`);
  }

  const tickerRes = await client.publicGet<OptionTickersResult>("/v5/market/tickers", {
    category: "option",
    symbol,
  });
  const t = tickerRes.list[0];
  if (!t) throw new Error(`No ticker data found for ${symbol}`);

  const ask1Price = parseFloat(t.ask1Price);
  const bid1Price = parseFloat(t.bid1Price);
  const underlyingPrice = parseFloat(t.underlyingPrice ?? "0");
  const greeks = {
    delta: parseFloat(t.delta),
    gamma: parseFloat(t.gamma),
    theta: parseFloat(t.theta),
    vega: parseFloat(t.vega),
  };
  const multiplier = OPTION_MULTIPLIERS[parsed.underlying] ?? 1;
  const estimatedFillPrice = side === "Buy" ? ask1Price : bid1Price;
  const estimatedPremium = qty * estimatedFillPrice * multiplier;

  if (side === "Sell" && process.env.OPTIONS_ALLOW_NAKED_SHORT !== "true") {
    const posRes = await client.signedGet<PositionResult>("/v5/position/list", {
      category: "option",
      symbol,
    });
    const existingPos = posRes.list.find((p) => p.side === "Buy" && parseFloat(p.size) > 0);
    const existingLongQty = existingPos ? parseFloat(existingPos.size) : 0;
    if (qty > existingLongQty) {
      throw new Error(
        "Naked short options are disabled by default. Set OPTIONS_ALLOW_NAKED_SHORT=true to enable. Naked short options carry unlimited or very large maximum loss."
      );
    }
  }

  if (side === "Buy") {
    const walletRes = await client.signedGet<WalletBalanceResult>("/v5/account/wallet-balance", {
      accountType: "UNIFIED",
    });
    const account = walletRes.list[0];
    const usdcCoin = account?.coin.find((c) => c.coin === "USDC");
    const usdcBalance = parseFloat(usdcCoin?.walletBalance ?? "0");

    if (usdcBalance < estimatedPremium) {
      throw new Error(
        `Insufficient USDC: need ${estimatedPremium} USDC, have ${usdcBalance}. Bybit option premium is charged in USDC — USDT is not used.`
      );
    }

    const capPct = process.env.OPTIONS_MAX_PREMIUM_PCT_BALANCE
      ? parseFloat(process.env.OPTIONS_MAX_PREMIUM_PCT_BALANCE)
      : null;
    if (capPct != null && estimatedPremium > (capPct / 100) * usdcBalance) {
      throw new Error(
        `Premium ${estimatedPremium} USDC exceeds ${capPct}% of USDC balance (${usdcBalance} USDC available).`
      );
    }
  }

  if (dry_run) {
    const daysToExpiry = Math.max(0, Math.ceil((parsed.expiry.getTime() - Date.now()) / 86400000));
    const thetaPerDay = qty * Math.abs(greeks.theta) * multiplier;
    const payoffResult = handleGetOptionPayoff({
      legs: [{ symbol, side, qty, premium: estimatedFillPrice }],
      currentSpot: underlyingPrice,
    });
    const warnings: string[] = [];
    if (underlyingPrice === 0) {
      warnings.push("underlyingPrice unavailable from ticker; payoff summary may be inaccurate");
    }
    if (ask1Price > 0 && (ask1Price - bid1Price) / ask1Price > 0.1) {
      warnings.push(`Wide bid-ask spread: bid ${bid1Price}, ask ${ask1Price}`);
    }
    if (daysToExpiry <= 7) {
      warnings.push(`Near expiry: ${daysToExpiry} days to expiration`);
    }
    return {
      dryRun: true,
      symbol, side, qty, estimatedFillPrice, estimatedPremium, greeks,
      payoffSummary: payoffResult.summary,
      daysToExpiry, thetaPerDay,
      warnings, wouldSubmit: true,
      serverTimestamp: new Date().toISOString(),
    };
  }

  const nonce = crypto.randomBytes(3).toString("hex");
  const orderLinkId = `mcp-${Date.now()}-${nonce}`;
  const orderBody: Record<string, unknown> = {
    category: "option",
    symbol, side, orderType,
    qty: String(qty),
    orderLinkId,
  };
  if (orderType === "Limit" && price != null) {
    orderBody.price = String(price);
  }

  const orderRes = await client.signedPost<OrderCreateResult>("/v5/order/create", orderBody);

  return {
    orderId: orderRes.orderId,
    orderLinkId: orderRes.orderLinkId,
    symbol, side, qty,
    estimatedPremium, greeks,
    notes,
    serverTimestamp: new Date().toISOString(),
  };
}

export async function handleCloseOptionPosition(
  client: BybitClient,
  params: CloseOptionPositionParams
): Promise<CloseOptionResult | OptionCloseDryRunResult> {
  const { symbol, qty, orderType, price, notes, dry_run } = params;

  if (orderType === "Limit" && price == null) {
    throw new Error("price is required for Limit orders");
  }

  const posRes = await client.signedGet<PositionResult>("/v5/position/list", {
    category: "option",
    symbol,
  });
  const pos = posRes.list.find((p) => p.side !== "None" && parseFloat(p.size) > 0);
  if (!pos) {
    throw new Error(`No open option position found for ${symbol}`);
  }
  const currentSide: "Long" | "Short" = pos.side === "Buy" ? "Long" : "Short";
  const posSize = parseFloat(pos.size);
  const closeQty = qty ?? posSize;
  if (closeQty > posSize) {
    throw new Error(`Close qty ${closeQty} exceeds position size ${posSize}`);
  }

  const tickerRes = await client.publicGet<OptionTickersResult>("/v5/market/tickers", {
    category: "option",
    symbol,
  });
  const t = tickerRes.list[0];
  if (!t) throw new Error(`No ticker data found for ${symbol}`);
  const bid1Price = parseFloat(t.bid1Price);
  const ask1Price = parseFloat(t.ask1Price);
  const estimatedFillPrice = currentSide === "Long" ? bid1Price : ask1Price;

  const parsed = parseOptionSymbol(symbol);
  const multiplier = OPTION_MULTIPLIERS[parsed.underlying] ?? 1;

  if (dry_run) {
    const entryPremium = parseFloat(pos.avgPrice) * closeQty * multiplier;
    const estimatedPremium = estimatedFillPrice * closeQty * multiplier;
    const estimatedPnl = currentSide === "Long"
      ? estimatedPremium - entryPremium
      : entryPremium - estimatedPremium;
    const warnings: string[] = [];
    if (ask1Price > 0 && (ask1Price - bid1Price) / ask1Price > 0.1) {
      warnings.push(`Wide bid-ask spread: bid ${bid1Price}, ask ${ask1Price}`);
    }
    return {
      dryRun: true,
      symbol, currentSide, currentQty: posSize, closeQty,
      estimatedFillPrice, estimatedPremium, estimatedPnl,
      warnings, wouldSubmit: true,
      serverTimestamp: new Date().toISOString(),
    };
  }

  const closeSide = currentSide === "Long" ? "Sell" : "Buy";
  const nonce = crypto.randomBytes(3).toString("hex");
  const orderBody: Record<string, unknown> = {
    category: "option",
    symbol, side: closeSide, orderType,
    qty: String(closeQty),
    reduceOnly: true,
    orderLinkId: `mcp-${Date.now()}-${nonce}`,
  };
  if (orderType === "Limit" && price != null) {
    orderBody.price = String(price);
  }

  const orderRes = await client.signedPost<OrderCreateResult>("/v5/order/create", orderBody);

  return {
    orderId: orderRes.orderId,
    orderLinkId: orderRes.orderLinkId,
    symbol,
    closedQty: closeQty,
    remainingQty: posSize - closeQty,
    notes,
    serverTimestamp: new Date().toISOString(),
  };
}
