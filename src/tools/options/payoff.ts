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

// Tolerance for treating a net tail slope as zero (float noise from qty sums).
const SLOPE_EPS = 1e-9;

// The expiry payoff of an option combo is piecewise linear in the underlying
// price: kinks at the strikes, straight lines outside them. So the summary is
// computed ANALYTICALLY — extremes can only occur at S=0, at a strike, or in
// the tails (whose slopes are the net signed call/put quantities) — instead of
// sampling a price grid. The old grid-slope inference only looked at the top
// of a ±30% window, so naked short puts and any short leg with a strike
// outside the window passed the RFQ risk gate as "covered" (June 2026 audit,
// CRITICAL). The sampled pricePoints below are for display only.
export function handleGetOptionPayoff(params: PayoffParams): PayoffResult {
  const { legs, currentSpot, steps = 15 } = params;

  if (!legs || legs.length === 0) {
    throw new Error("payoff requires at least one leg");
  }
  for (const leg of legs) {
    // A zero/negative/NaN qty would silently flip or erase a leg's direction
    // and defeat every tail check below — reject at the boundary.
    if (!Number.isFinite(leg.qty) || leg.qty <= 0) {
      throw new Error(`Invalid leg qty ${leg.qty} for ${leg.symbol} — qty must be a positive finite number.`);
    }
    if (!Number.isFinite(leg.premium) || leg.premium < 0) {
      throw new Error(`Invalid leg premium ${leg.premium} for ${leg.symbol} — premium must be a non-negative finite number.`);
    }
  }

  const parsed = legs.map((leg) => ({ leg, parsed: parseOptionSymbol(leg.symbol) }));
  const underlying = parsed[0].parsed.underlying;
  const mixed = parsed.find(({ parsed: p }) => p.underlying !== underlying);
  if (mixed) {
    throw new Error(
      `All legs must share one underlying for a single price axis; got ${underlying} and ${mixed.parsed.underlying}.`
    );
  }

  const pnlAt = (S: number): number =>
    parsed.reduce((acc, { leg, parsed: p }) => {
      const multiplier = OPTION_MULTIPLIERS[p.underlying] ?? 1;
      const intrinsic = p.type === "call"
        ? Math.max(S - p.strike, 0)
        : Math.max(p.strike - S, 0);
      const legPnl = leg.side === "Buy"
        ? (intrinsic - leg.premium) * leg.qty * multiplier
        : (leg.premium - intrinsic) * leg.qty * multiplier;
      return acc + legPnl;
    }, 0);

  const strikes = [...new Set(parsed.map(({ parsed: p }) => p.strike))].sort((a, b) => a - b);
  const lastStrike = strikes[strikes.length - 1];

  // Tail slopes: above every strike all calls are ITM; below every strike all
  // puts are ITM. d(PnL)/dS per leg: long call +qty, short call -qty (above);
  // long put -qty, short put +qty (below).
  let slopeAbove = 0;
  let slopeBelow = 0;
  for (const { leg, parsed: p } of parsed) {
    const multiplier = OPTION_MULTIPLIERS[p.underlying] ?? 1;
    const signedQty = (leg.side === "Buy" ? 1 : -1) * leg.qty * multiplier;
    if (p.type === "call") slopeAbove += signedQty;
    else slopeBelow -= signedQty;
  }
  const uncoveredTailAbove = slopeAbove < -SLOPE_EPS;
  const uncoveredTailBelow = slopeBelow > SLOPE_EPS;

  const candidatePnls = [0, ...strikes].map(pnlAt);
  const maxLoss: number | "unlimited" = uncoveredTailAbove ? "unlimited" : Math.min(...candidatePnls);
  const maxProfit: number | "unlimited" = slopeAbove > SLOPE_EPS ? "unlimited" : Math.max(...candidatePnls);

  // Exact breakevens: zero crossings of each linear segment [0,k1],…,[kn,∞).
  const breakevens: number[] = [];
  const segmentEnds = [0, ...strikes];
  for (let i = 1; i < segmentEnds.length; i++) {
    const a = segmentEnds[i - 1];
    const b = segmentEnds[i];
    const fa = pnlAt(a);
    const fb = pnlAt(b);
    if ((fa < 0 && fb >= 0) || (fa > 0 && fb <= 0)) {
      breakevens.push(a + (-fa / (fb - fa)) * (b - a));
    }
  }
  if (Math.abs(slopeAbove) > SLOPE_EPS) {
    const fLast = pnlAt(lastStrike);
    const crossing = lastStrike - fLast / slopeAbove;
    if (crossing > lastStrike + SLOPE_EPS) breakevens.push(crossing);
  }
  const uniqueBreakevens = [...new Set(breakevens.map((b) => Math.round(b * 1e8) / 1e8))]
    .sort((a, b) => a - b);

  // Display grid: the default range widens to cover every strike so far-OTM
  // legs are visible, and the strikes themselves are injected so the diagram
  // shows the kinks instead of interpolating across them.
  const min = params.underlyingPriceRange?.min ?? Math.min(currentSpot * 0.7, strikes[0] * 0.9);
  const max = params.underlyingPriceRange?.max ?? Math.max(currentSpot * 1.3, lastStrike * 1.1);
  const actualSteps = Math.max(steps, 1);
  const gridPrices = actualSteps === 1
    ? [min]
    : Array.from({ length: actualSteps }, (_, i) => min + (i / (actualSteps - 1)) * (max - min));
  const allPrices = [...new Set([...gridPrices, ...strikes.filter((k) => k > min && k < max)])]
    .sort((a, b) => a - b);
  const pricePoints: OptionPayoffPoint[] = allPrices.map((p) => ({ underlyingPrice: p, pnl: pnlAt(p) }));

  return {
    underlying,
    pricePoints,
    summary: {
      maxLoss,
      maxProfit,
      breakevens: uniqueBreakevens,
      ...(uncoveredTailAbove ? { uncoveredTailAbove: true } : {}),
      ...(uncoveredTailBelow ? { uncoveredTailBelow: true } : {}),
    },
  };
}
