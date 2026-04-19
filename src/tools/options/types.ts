export const OPTION_MULTIPLIERS: Record<string, number> = {
  BTC: 1,
  ETH: 0.1,
  SOL: 1,
};

const MONTHS: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

export interface ParsedOptionSymbol {
  underlying: string;
  expiry: Date;
  strike: number;
  type: "call" | "put";
}

export function parseOptionSymbol(symbol: string): ParsedOptionSymbol {
  // Format: BTC-25APR26-80000-C-USDT
  const parts = symbol.split("-");
  if (parts.length !== 5 || parts[4] !== "USDT" || !["C", "P"].includes(parts[3])) {
    throw new Error(`Invalid option symbol format. Expected ASSET-EXPIRY-STRIKE-C|P-USDT, got: ${symbol}`);
  }

  const [underlying, expiryStr, strikeStr, typeChar] = parts;
  const day = parseInt(expiryStr.slice(0, 2));
  const monthStr = expiryStr.slice(2, 5).toUpperCase();
  const yearStr = expiryStr.slice(5);
  const year = 2000 + parseInt(yearStr);

  if (isNaN(day) || !(monthStr in MONTHS) || !/^\d{2}$/.test(yearStr)) {
    throw new Error(`Invalid option symbol format. Expected ASSET-EXPIRY-STRIKE-C|P-USDT, got: ${symbol}`);
  }

  return {
    underlying,
    expiry: new Date(Date.UTC(year, MONTHS[monthStr], day, 8, 0, 0)),
    strike: parseFloat(strikeStr),
    type: typeChar === "C" ? "call" : "put",
  };
}

export function computeMoneyness(
  strike: number,
  spot: number,
  type: "call" | "put"
): "ITM" | "ATM" | "OTM" {
  const pctFromSpot = Math.abs(strike - spot) / spot;
  if (pctFromSpot < 0.01) return "ATM";
  if (type === "call") return strike < spot ? "ITM" : "OTM";
  return strike > spot ? "ITM" : "OTM";
}

export interface BybitOptionTicker {
  symbol: string;
  lastPrice: string;
  bid1Price: string;
  ask1Price: string;
  markPrice: string;
  markIv: string;
  openInterest: string;
  volume24h: string;
  delta: string;
  gamma: string;
  theta: string;
  vega: string;
  underlyingPrice?: string;
}

export interface OptionTickersResult {
  list: BybitOptionTicker[];
  category: string;
}

export interface OptionContract {
  symbol: string;
  strike: number;
  expiry: string;
  daysToExpiry: number;
  type: "call" | "put";
  bid: number;
  ask: number;
  mark: number;
  lastPrice: number;
  iv: number;
  openInterest: number;
  volume24h: number;
  moneyness: "ITM" | "ATM" | "OTM";
}

export interface OptionPosition {
  symbol: string;
  underlying: string;
  side: "Long" | "Short";
  qty: number;
  entryPrice: number;
  markPrice: number;
  premiumPaid: number;     // positive = premium paid (long), negative = credit received (short)
  currentValue: number;
  unrealisedPnl: number;
  unrealisedPnlPct: number;
  greeks: { delta: number; gamma: number; theta: number; vega: number };
  daysToExpiry: number;
  breakeven: number;
}

export interface OptionPayoffPoint {
  underlyingPrice: number;
  pnl: number;
}

export interface OptionPayoffSummary {
  maxLoss: number;
  maxProfit: number | "unlimited";
  breakevens: number[];
  cappedAtRange?: boolean;
}
