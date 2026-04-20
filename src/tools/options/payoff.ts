import { parseOptionSymbol, OPTION_MULTIPLIERS, OptionPayoffPoint, OptionPayoffSummary } from "./types";

export interface PayoffParams {
  legs: Array<{
    symbol: string;
    side: "Buy" | "Sell";
    qty: number;
    premium: number;
  }>;
  currentSpot: number;
  underlyingPriceRange?: { min: number; max: number };
  steps?: number;
}

export interface PayoffResult {
  underlying: string;
  pricePoints: OptionPayoffPoint[];
  summary: OptionPayoffSummary;
}

export function handleGetOptionPayoff(params: PayoffParams): PayoffResult {
  const { legs, currentSpot, steps = 50 } = params;
  const min = params.underlyingPriceRange?.min ?? currentSpot * 0.7;
  const max = params.underlyingPriceRange?.max ?? currentSpot * 1.3;

  const parsed = legs.map((leg) => ({ leg, parsed: parseOptionSymbol(leg.symbol) }));
  const underlying = parsed[0].parsed.underlying;

  const actualSteps = Math.max(steps, 1);
  const pricePoints: OptionPayoffPoint[] = [];

  for (let i = 0; i < actualSteps; i++) {
    const underlyingPrice = actualSteps === 1 ? min : min + (i / (actualSteps - 1)) * (max - min);
    let totalPnl = 0;

    for (const { leg, parsed: p } of parsed) {
      const multiplier = OPTION_MULTIPLIERS[p.underlying] ?? 1;
      const intrinsic = p.type === "call"
        ? Math.max(underlyingPrice - p.strike, 0)
        : Math.max(p.strike - underlyingPrice, 0);
      const legPnl = leg.side === "Buy"
        ? (intrinsic - leg.premium) * leg.qty * multiplier
        : (leg.premium - intrinsic) * leg.qty * multiplier;
      totalPnl += legPnl;
    }

    pricePoints.push({ underlyingPrice, pnl: totalPnl });
  }

  const pnls = pricePoints.map((p) => p.pnl);
  const maxLoss = Math.min(...pnls);
  const maxPnlInRange = Math.max(...pnls);

  const trendingUpAtTop = pricePoints.length >= 2 &&
    pricePoints[pricePoints.length - 1].pnl > pricePoints[pricePoints.length - 2].pnl;
  // Detect unbounded loss: PnL still decreasing at upper boundary (short call)
  const trendingDownAtTop = pricePoints.length >= 2 &&
    pricePoints[pricePoints.length - 1].pnl < pricePoints[pricePoints.length - 2].pnl;

  const maxProfit: number | "unlimited" = trendingUpAtTop ? "unlimited" : maxPnlInRange;
  const cappedAtRange = trendingUpAtTop || trendingDownAtTop || undefined;

  // Single-leg: use closed-form breakeven to avoid interpolation error
  // Multi-leg: interpolate across price points (no closed form in general)
  let breakevens: number[];
  if (parsed.length === 1) {
    const { leg, parsed: p } = parsed[0];
    breakevens = [p.type === "call" ? p.strike + leg.premium : p.strike - leg.premium];
  } else {
    breakevens = [];
    for (let i = 1; i < pricePoints.length; i++) {
      const prev = pricePoints[i - 1];
      const curr = pricePoints[i];
      if ((prev.pnl < 0 && curr.pnl >= 0) || (prev.pnl > 0 && curr.pnl <= 0)) {
        const t = -prev.pnl / (curr.pnl - prev.pnl);
        breakevens.push(prev.underlyingPrice + t * (curr.underlyingPrice - prev.underlyingPrice));
      }
    }
  }

  return {
    underlying,
    pricePoints,
    summary: { maxLoss, maxProfit, breakevens, ...(cappedAtRange ? { cappedAtRange: true } : {}) },
  };
}
