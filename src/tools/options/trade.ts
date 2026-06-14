import crypto from "crypto";
import { BybitClient } from "../../client";
import { parseOptionSymbol, OPTION_MULTIPLIERS, OptionPayoffSummary, OptionTickersResult } from "./types";
import { parseFiniteOr } from "../../util";
import { WalletBalanceResult, OrderCreateResult } from "../types";
import { handleGetOptionPayoff } from "./payoff";
import { assertConfirm } from "../confirm";

export interface PlaceOptionTradeParams {
  symbol: string;
  side: "Buy" | "Sell";
  qty: number;
  orderType: "Market" | "Limit";
  price?: number;
  notes?: string;
  dry_run?: boolean;
  confirm?: string;
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
  confirm?: string;
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

interface OptionOpenOrdersResult {
  list: Array<{
    symbol: string;
    side: "Buy" | "Sell";
    qty: string;
    leavesQty?: string;
  }>;
}


export async function handlePlaceOptionTrade(
  client: BybitClient,
  params: PlaceOptionTradeParams
): Promise<PlaceOptionTradeResult | OptionDryRunResult> {
  const { symbol, side, qty, orderType, price, notes, dry_run, confirm } = params;

  // assertConfirm fires before any other shape validation so a missing
  // confirm always reports the gate error first.
  assertConfirm(confirm, dry_run ?? false, "place_option_trade");

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
  // An empty/zero ask parses to 0 (or NaN) and would zero out estimatedPremium,
  // silently bypassing the balance gate and premium cap below. For buys, fall
  // back to the limit price when the book is empty; refuse a Market buy outright.
  let estimatedFillPrice = side === "Buy" ? ask1Price : bid1Price;
  if (side === "Buy" && !(estimatedFillPrice > 0)) {
    if (orderType === "Limit" && price != null) {
      estimatedFillPrice = price;
    } else {
      throw new Error(
        `No ask quote available for ${symbol} — cannot estimate premium for a Market buy. Use a Limit order with an explicit price.`
      );
    }
  }
  const estimatedPremium = qty * estimatedFillPrice * multiplier;

  // Uncovered-short check. The position lookup runs for every Sell — even when
  // OPTIONS_ALLOW_NAKED_SHORT=true — so a dry-run can still surface the naked
  // portion as a warning. The flag only governs whether an uncovered short is
  // blocked, not whether it is detected.
  //
  // Coverage model (risk-defined verticals): a short option leg is covered by
  // open LONG positions of the SAME underlying, SAME expiry, and SAME option
  // type (call/put), regardless of strike. Every put-put or call-call vertical
  // sharing an expiry has a bounded max loss (debit or credit spread), so any
  // long of matching type+expiry caps the short's tail. Net available cover =
  // (sum long qty) − (sum existing short qty) across those legs, so a single
  // long can never be double-counted against two shorts (a net-short book stays
  // blocked). Different expiry (calendars) and cross-type longs do NOT count and
  // leave the short treated as naked. This lets the legs of a risk-defined
  // spread be placed one at a time (long first, then short) while a genuine
  // naked short stays blocked under OPTIONS_ALLOW_NAKED_SHORT=false.
  let uncoveredShortQty = 0;
  if (side === "Sell") {
    const posRes = await client.signedGet<PositionResult>("/v5/position/list", {
      category: "option",
      baseCoin: parsed.underlying,
    });
    let longCover = 0;
    let existingShort = 0;
    for (const p of posRes.list) {
      const size = parseFloat(p.size);
      if (!(size > 0) || (p.side !== "Buy" && p.side !== "Sell")) continue;
      let pp: ReturnType<typeof parseOptionSymbol>;
      try {
        pp = parseOptionSymbol(p.symbol);
      } catch {
        continue;
      }
      if (pp.type !== parsed.type || pp.expiry.getTime() !== parsed.expiry.getTime()) continue;
      if (p.side === "Buy") longCover += size;
      else existingShort += size;
    }
    let netLongCover = Math.max(0, longCover - existingShort);
    if (qty <= netLongCover) {
      // Looks covered by filled positions — but resting short orders will
      // claim the same cover when they fill, so count their unfilled qty
      // before trusting it. Resting BUY orders are NOT counted as cover
      // (they may never fill). Skipped when the gate would already fire.
      const ordersRes = await client.signedGet<OptionOpenOrdersResult>("/v5/order/realtime", {
        category: "option",
        baseCoin: parsed.underlying,
      });
      for (const o of ordersRes.list ?? []) {
        if (o.side !== "Sell") continue;
        let op: ReturnType<typeof parseOptionSymbol>;
        try {
          op = parseOptionSymbol(o.symbol);
        } catch {
          continue;
        }
        if (op.type !== parsed.type || op.expiry.getTime() !== parsed.expiry.getTime()) continue;
        existingShort += parseFiniteOr(o.leavesQty, parseFiniteOr(o.qty, 0));
      }
      netLongCover = Math.max(0, longCover - existingShort);
    }
    uncoveredShortQty = Math.max(0, qty - netLongCover);
    if (uncoveredShortQty > 0 && process.env.OPTIONS_ALLOW_NAKED_SHORT !== "true") {
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
    // Every symbol this server accepts is a USDT-settled option (the parser
    // requires the -USDT suffix), so the premium is charged in USDT.
    const usdtCoin = account?.coin.find((c) => c.coin === "USDT");
    const usdtBalance = parseFiniteOr(usdtCoin?.walletBalance, 0);

    if (usdtBalance < estimatedPremium) {
      throw new Error(
        `Insufficient USDT: need ${estimatedPremium} USDT, have ${usdtBalance}. Bybit USDT-settled option premium is charged in USDT.`
      );
    }

    const capEnv = process.env.OPTIONS_MAX_PREMIUM_PCT_BALANCE;
    if (capEnv != null && capEnv !== "") {
      const capPct = parseFloat(capEnv);
      if (!Number.isFinite(capPct) || capPct <= 0) {
        throw new Error(
          `OPTIONS_MAX_PREMIUM_PCT_BALANCE is set to "${capEnv}", which is not a positive number — refusing to submit with a malformed safety cap.`
        );
      }
      if (estimatedPremium > (capPct / 100) * usdtBalance) {
        throw new Error(
          `Premium ${estimatedPremium} USDT exceeds ${capPct}% of USDT balance (${usdtBalance} USDT available).`
        );
      }
    }
  }

  if (dry_run) {
    const daysToExpiry = Math.max(0, Math.round((parsed.expiry.getTime() - Date.now()) / 86400000));
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
    if (uncoveredShortQty > 0) {
      warnings.push(
        `Uncovered short: ${uncoveredShortQty} of ${qty} contract(s) are naked — unlimited or very large maximum loss. Permitted by OPTIONS_ALLOW_NAKED_SHORT=true.`
      );
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
  const { symbol, qty, orderType, price, notes, dry_run, confirm } = params;

  // assertConfirm fires before any other shape validation so a missing
  // confirm always reports the gate error first.
  assertConfirm(confirm, dry_run ?? false, "close_option_position");

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

  // Closing a long can silently convert an existing short of the same
  // type+expiry into a naked short — its cover disappears. Gate it exactly
  // like placing a new naked short unless explicitly allowed.
  if (currentSide === "Long" && process.env.OPTIONS_ALLOW_NAKED_SHORT !== "true") {
    const bookRes = await client.signedGet<PositionResult>("/v5/position/list", {
      category: "option",
      baseCoin: parsed.underlying,
    });
    let longCover = 0;
    let dependentShort = 0;
    for (const p of bookRes.list ?? []) {
      const size = parseFloat(p.size);
      if (!(size > 0) || (p.side !== "Buy" && p.side !== "Sell")) continue;
      let pp: ReturnType<typeof parseOptionSymbol>;
      try {
        pp = parseOptionSymbol(p.symbol);
      } catch {
        continue;
      }
      if (pp.type !== parsed.type || pp.expiry.getTime() !== parsed.expiry.getTime()) continue;
      if (p.side === "Buy") longCover += size;
      else dependentShort += size;
    }
    const coverAfterClose = longCover - closeQty;
    if (dependentShort > 0 && coverAfterClose < dependentShort) {
      const uncoveredQty = dependentShort - Math.max(0, coverAfterClose);
      throw new Error(
        `Closing ${closeQty} ${symbol} would leave ${uncoveredQty} short contract(s) of the same type/expiry uncovered (naked). ` +
        `Close or buy back the short leg first, or set OPTIONS_ALLOW_NAKED_SHORT=true to permit it.`
      );
    }
  }

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
