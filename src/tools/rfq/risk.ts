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

// Normalize `side` defensively. The schema advertises lowercase "buy"/"sell",
// but MCP enum validation is advisory and every other tool in this server
// uses capitalized "Buy"/"Sell" — a wrong-case value must NOT silently slip
// past the naked-short check. Fail closed: unknown side throws, never guesses.
function normalizeSide(side: string): "buy" | "sell" {
  const s = String(side).toLowerCase();
  if (s !== "buy" && s !== "sell") {
    throw new Error(`Invalid leg side "${side}"; expected "buy" or "sell".`);
  }
  return s;
}

export function assessComboRisk(params: AssessComboRiskParams): ComboRiskResult {
  const { currentSpot } = params;
  const reasons: string[] = [];

  // Normalize once up front so every downstream check sees a canonical side.
  const legs = params.legs.map((l) => ({ ...l, side: normalizeSide(l.side) }));

  const allOptions = legs.every((l) => l.category === "option");
  const everyOptionPriced = legs.every((l) => l.price !== undefined && l.price > 0);

  // --- Unmodelable cases: fail safe, never fabricate a number ---
  const badQty = legs.find((l) => !Number.isFinite(l.qty) || l.qty <= 0);
  if (badQty) {
    reasons.push(
      `Leg ${badQty.symbol} has invalid qty ${badQty.qty}; cannot assess risk. Treated as uncovered.`
    );
    return failSafeUnmodeled(reasons);
  }
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

  // --- Modelable: reuse payoff.ts (analytic — exact kinks and tail slopes) ---
  let payoff;
  try {
    payoff = handleGetOptionPayoff({
      legs: legs.map((l) => ({
        symbol: l.symbol,
        side: l.side === "buy" ? "Buy" : "Sell",
        qty: l.qty,
        premium: l.price as number,
      })),
      currentSpot,
    });
  } catch (err: unknown) {
    // e.g. mixed underlyings (no single price axis) or a malformed symbol.
    const msg = err instanceof Error ? err.message : String(err);
    reasons.push(`Payoff engine refused the combo (${msg}). Treated as uncovered.`);
    return failSafeUnmodeled(reasons);
  }
  const { maxLoss, maxProfit, breakevens, uncoveredTailAbove, uncoveredTailBelow } = payoff.summary;

  // Net-short tail beyond the outermost strike on EITHER side means the combo
  // is not risk-defined. Computed analytically, so naked short puts and legs
  // with strikes outside any price window are caught — the old grid-slope
  // check missed both (June 2026 audit, CRITICAL). Long-only combos and
  // risk-defined spreads have flat or non-negative tails and pass.
  const uncovered = uncoveredTailAbove === true || uncoveredTailBelow === true;

  if (uncoveredTailAbove) {
    reasons.push("Net-short call tail: loss unbounded above the highest strike — no numeric max-loss exists.");
  }
  if (uncoveredTailBelow) {
    reasons.push("Net-short put tail: loss grows all the way to price 0 below the lowest strike.");
  }

  const allowed = !uncovered || overrideEnabled();
  if (uncovered && !allowed) {
    reasons.push(
      "Blocked by default. Set RFQ_ALLOW_UNCOVERED=true (or OPTIONS_ALLOW_NAKED_SHORT=true) to permit uncovered net-short combos."
    );
  }

  return {
    modeled: true,
    // Exact when numeric (evaluated at S=0 and every strike); null when the
    // loss is unbounded — a fake bound on a money gate is worse than "unknown".
    maxLossUsd: maxLoss === "unlimited" ? null : maxLoss,
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
