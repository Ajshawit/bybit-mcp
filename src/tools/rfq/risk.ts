import { handleGetOptionPayoff } from "../options/payoff";
import { RiskLeg, ComboRiskResult } from "./types";

// Combo-aware safety rail for RFQ block trades.
//
// Design intent (from the investigation session): replace the single-leg
// same-symbol naked-short check with structure-aware netting via payoff
// max-loss, so risk-defined spreads are NOT wrongly blocked, while genuinely
// uncovered net-short combos still are.
//
// FAIL-SAFE PRINCIPLE: payoff.ts only models option legs (it runs
// parseOptionSymbol on every leg). It cannot price linear/spot legs. We never
// fabricate a max-loss for what we cannot model — an unmodeled combo is
// treated as uncovered and requires an explicit override to proceed. A wrong
// "looks safe" number on a money-moving feature is worse than "unknown".

const OVERRIDE_ENV = ["RFQ_ALLOW_UNCOVERED", "OPTIONS_ALLOW_NAKED_SHORT"] as const;

function overrideEnabled(): boolean {
  return OVERRIDE_ENV.some((key) => process.env[key] === "true");
}

export interface AssessComboRiskParams {
  legs: RiskLeg[];
  currentSpot?: number;
}

export function assessComboRisk(params: AssessComboRiskParams): ComboRiskResult {
  const { legs, currentSpot } = params;
  const reasons: string[] = [];

  const allOptions = legs.every((l) => l.category === "option");
  const hasShort = legs.some((l) => l.side === "sell");
  const everyOptionPriced = legs.every((l) => l.price !== undefined && l.price > 0);

  // --- Unmodelable cases: fail safe, never fabricate a number ---
  if (!allOptions) {
    reasons.push(
      "Combo contains linear/spot legs; option payoff math cannot bound its loss. Treated as uncovered."
    );
    return failSafeUnmodeled(reasons);
  }
  if (currentSpot === undefined || currentSpot <= 0) {
    reasons.push("currentSpot unavailable; cannot compute payoff. Treated as uncovered.");
    return failSafeUnmodeled(reasons);
  }
  if (!everyOptionPriced) {
    reasons.push("One or more option legs lack an estimated price; cannot compute payoff. Treated as uncovered.");
    return failSafeUnmodeled(reasons);
  }

  // --- Modelable: reuse payoff.ts unchanged ---
  const payoff = handleGetOptionPayoff({
    legs: legs.map((l) => ({
      symbol: l.symbol,
      side: l.side === "buy" ? "Buy" : "Sell",
      qty: l.qty,
      premium: l.price as number,
    })),
    currentSpot,
  });
  const { maxLoss, maxProfit, breakevens, cappedAtRange } = payoff.summary;

  // Long-only option combos have loss bounded by premium paid — always covered.
  // With any short leg, `cappedAtRange` means the payoff was still moving at
  // the ±30% boundary (e.g. naked short call/put → unbounded tail): treat as
  // uncovered. A short leg whose payoff is flat at both ends is a risk-defined
  // spread and is correctly NOT flagged.
  const uncovered = hasShort && cappedAtRange === true;

  if (uncovered) {
    reasons.push(
      "Net-short combo with loss not provably bounded (payoff still trending at ±30% range)."
    );
  }

  const allowed = !uncovered || overrideEnabled();
  if (uncovered && !allowed) {
    reasons.push(
      "Blocked by default. Set RFQ_ALLOW_UNCOVERED=true (or OPTIONS_ALLOW_NAKED_SHORT=true) to permit uncovered net-short combos."
    );
  }

  return {
    modeled: true,
    maxLossUsd: maxLoss,
    maxProfit,
    breakevens,
    uncovered,
    allowed,
    reasons,
  };
}

function failSafeUnmodeled(reasons: string[]): ComboRiskResult {
  const allowed = overrideEnabled();
  if (!allowed) {
    reasons.push(
      "Blocked by default. Set RFQ_ALLOW_UNCOVERED=true (or OPTIONS_ALLOW_NAKED_SHORT=true) to proceed without a modeled max-loss."
    );
  }
  return {
    modeled: false,
    maxLossUsd: null,
    maxProfit: null,
    breakevens: [],
    uncovered: true,
    allowed,
    reasons,
  };
}
