export const OPTION_MULTIPLIERS: Record<string, number> = {
  BTC: 1,
  ETH: 1,  // 1 contract = 1 ETH; confirmed via instruments-info lotSizeFilter
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
  // Bybit does not zero-pad days for the 1st–9th (e.g. ETH-3JAN23-1250-P),
  // so the day segment is 1 or 2 digits.
  const expiryMatch = /^(\d{1,2})([A-Z]{3})(\d{2})$/.exec(expiryStr.toUpperCase());
  if (!expiryMatch || !(expiryMatch[2] in MONTHS)) {
    throw new Error(`Invalid option symbol format. Expected ASSET-EXPIRY-STRIKE-C|P-USDT, got: ${symbol}`);
  }
  const day = parseInt(expiryMatch[1], 10);
  const year = 2000 + parseInt(expiryMatch[3], 10);

  return {
    underlying,
    expiry: new Date(Date.UTC(year, MONTHS[expiryMatch[2]], day, 8, 0, 0)),
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
  premiumFlow: number;     // positive = outflow (premium paid by long), negative = inflow (credit received by short)
  currentValue: number;
  unrealisedPnl: number;
  unrealisedPnlPct: number;
  realisedPnl: number;     // cumulative realised P&L (entry fees, partial closes)
  totalPnl: number;        // unrealisedPnl + realisedPnl
  greeks: { delta: number; gamma: number; theta: number; vega: number };
  daysToExpiry: number;
  breakeven: number;
}

export interface BybitOptionPosition {
  symbol: string;
  side: "Buy" | "Sell" | "None";
  size: string;
  avgPrice: string;
  markPrice: string;
  cumRealisedPnl?: string;
  delta?: string;
  gamma?: string;
  theta?: string;
  vega?: string;
}

export interface OptionPositionListResult {
  list: BybitOptionPosition[];
}

export interface OptionPayoffPoint {
  underlyingPrice: number;
  pnl: number;
}

export interface OptionPayoffSummary {
  // "unlimited" maxLoss = net short calls (loss unbounded as S→∞). A numeric
  // maxLoss is EXACT: evaluated analytically at S=0 and every strike.
  maxLoss: number | "unlimited";
  maxProfit: number | "unlimited";
  breakevens: number[];
  // Net short tail beyond the outermost strike: loss unbounded above
  // (net short calls) / growing all the way to S=0 (net short puts).
  uncoveredTailAbove?: boolean;
  uncoveredTailBelow?: boolean;
}
