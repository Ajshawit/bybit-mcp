export interface Greeks {
  delta: number;
  gamma: number;
  /** Daily theta: negative for long options (time decay cost per day) */
  theta: number;
  /** Vega per 1% change in IV */
  vega: number;
}

function normcdf(x: number): number {
  const a1 = 0.319381530, a2 = -0.356563782, a3 = 1.781477937;
  const a4 = -1.821255978, a5 = 1.330274429;
  const k = 1 / (1 + 0.2316419 * Math.abs(x));
  const poly = k * (a1 + k * (a2 + k * (a3 + k * (a4 + k * a5))));
  const pdf = Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
  const result = 1 - pdf * poly;
  return x >= 0 ? result : 1 - result;
}

function normpdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * Black-Scholes Greeks with r=0 (crypto convention).
 * Theta is daily (annualised / 365), negative for long positions.
 * Vega is per 1% change in IV (annualised vega / 100).
 */
export function blackScholesGreeks(
  type: "call" | "put",
  spot: number,
  strike: number,
  timeToExpiryYears: number,
  iv: number
): Greeks {
  if (timeToExpiryYears <= 0) {
    const intrinsic = type === "call"
      ? Math.max(spot - strike, 0)
      : Math.max(strike - spot, 0);
    return { delta: intrinsic > 0 ? (type === "call" ? 1 : -1) : 0, gamma: 0, theta: 0, vega: 0 };
  }

  const sqrtT = Math.sqrt(timeToExpiryYears);
  const d1 = (Math.log(spot / strike) + 0.5 * iv * iv * timeToExpiryYears) / (iv * sqrtT);

  const nd1 = normpdf(d1);
  const gamma = nd1 / (spot * iv * sqrtT);
  const thetaAnnual = -(spot * nd1 * iv) / (2 * sqrtT);
  const theta = thetaAnnual / 365;
  const vega = spot * nd1 * sqrtT / 100;

  if (type === "call") {
    return { delta: normcdf(d1), gamma, theta, vega };
  } else {
    return { delta: normcdf(d1) - 1, gamma, theta, vega };
  }
}
