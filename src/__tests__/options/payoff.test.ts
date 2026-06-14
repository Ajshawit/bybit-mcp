import { handleGetOptionPayoff } from "../../tools/options/payoff";

const BTC_CALL_LEGS = [{
  symbol: "BTC-25APR26-50000-C-USDT",
  side: "Buy" as const,
  qty: 1,
  premium: 2000,  // $2000 per contract
}];

describe("handleGetOptionPayoff", () => {
  it("long call PnL at spot > strike = (spot - strike - premium) * qty * multiplier", () => {
    const result = handleGetOptionPayoff({
      legs: BTC_CALL_LEGS,
      currentSpot: 50000,
      underlyingPriceRange: { min: 60000, max: 60000 },
      steps: 1,
    });
    // At spot=60000: intrinsic = 10000, pnl = (10000 - 2000) * 1 * 1 = 8000
    expect(result.pricePoints[0].pnl).toBeCloseTo(8000);
  });

  it("long call PnL at spot < strike = -premium * qty * multiplier", () => {
    const result = handleGetOptionPayoff({
      legs: BTC_CALL_LEGS,
      currentSpot: 50000,
      underlyingPriceRange: { min: 40000, max: 40000 },
      steps: 1,
    });
    // At spot=40000: intrinsic = 0, pnl = -2000 * 1 * 1 = -2000
    expect(result.pricePoints[0].pnl).toBeCloseTo(-2000);
  });

  it("long put PnL at spot < strike", () => {
    const result = handleGetOptionPayoff({
      legs: [{ symbol: "BTC-25APR26-50000-P-USDT", side: "Buy", qty: 1, premium: 1500 }],
      currentSpot: 50000,
      underlyingPriceRange: { min: 40000, max: 40000 },
      steps: 1,
    });
    // At spot=40000: intrinsic = 10000, pnl = (10000 - 1500) * 1 * 1 = 8500
    expect(result.pricePoints[0].pnl).toBeCloseTo(8500);
  });

  it("long call breakeven = strike + premium", () => {
    const result = handleGetOptionPayoff({
      legs: BTC_CALL_LEGS,
      currentSpot: 50000,
      underlyingPriceRange: { min: 48000, max: 55000 },
      steps: 100,
    });
    expect(result.summary.breakevens.length).toBeGreaterThan(0);
    expect(Math.abs(result.summary.breakevens[0] - 52000)).toBeLessThan(100);
  });

  it("long call max loss = premium paid", () => {
    const result = handleGetOptionPayoff({
      legs: BTC_CALL_LEGS,
      currentSpot: 50000,
      underlyingPriceRange: { min: 30000, max: 70000 },
      steps: 50,
    });
    expect(result.summary.maxLoss).toBeCloseTo(-2000, 0);
  });

  it("long call maxProfit is 'unlimited' with no uncovered tail", () => {
    const result = handleGetOptionPayoff({
      legs: BTC_CALL_LEGS,
      currentSpot: 50000,
      underlyingPriceRange: { min: 30000, max: 70000 },
      steps: 50,
    });
    expect(result.summary.maxProfit).toBe("unlimited");
    expect(result.summary.uncoveredTailAbove).toBeUndefined();
    expect(result.summary.uncoveredTailBelow).toBeUndefined();
  });

  it("short call maxProfit = premium, maxLoss 'unlimited' with uncovered tail above", () => {
    const result = handleGetOptionPayoff({
      legs: [{ symbol: "BTC-25APR26-50000-C-USDT", side: "Sell", qty: 1, premium: 2000 }],
      currentSpot: 50000,
      underlyingPriceRange: { min: 30000, max: 70000 },
      steps: 50,
    });
    expect(result.summary.maxProfit).toBeCloseTo(2000, 0);
    expect(result.summary.maxLoss).toBe("unlimited");
    expect(result.summary.uncoveredTailAbove).toBe(true);
  });

  it("ETH uses multiplier=1 (1 contract = 1 ETH)", () => {
    const result = handleGetOptionPayoff({
      legs: [{ symbol: "ETH-30MAY26-2000-C-USDT", side: "Buy", qty: 1, premium: 100 }],
      currentSpot: 2000,
      underlyingPriceRange: { min: 3000, max: 3000 },
      steps: 1,
    });
    // At spot=3000: intrinsic=1000, pnl=(1000-100)*1*1 = 900
    expect(result.pricePoints[0].pnl).toBeCloseTo(900);
  });

  it("uses default ±30% range from currentSpot when range not provided", () => {
    const result = handleGetOptionPayoff({
      legs: BTC_CALL_LEGS,
      currentSpot: 50000,
    });
    expect(result.pricePoints[0].underlyingPrice).toBeCloseTo(35000, -2);
    expect(result.pricePoints[result.pricePoints.length - 1].underlyingPrice).toBeCloseTo(65000, -2);
    expect(result.pricePoints.length).toBe(15);
  });

  it("result includes underlying field parsed from leg symbol", () => {
    const result = handleGetOptionPayoff({ legs: BTC_CALL_LEGS, currentSpot: 50000 });
    expect(result.underlying).toBe("BTC");
  });
});

// The summary is computed analytically from the piecewise-linear expiry
// payoff (kinks at strikes, tail slopes from net signed qty) — no grid
// sampling, so there are no ±range blind spots. These pin the cases the
// old grid-slope inference got wrong.
describe("analytic tail detection and exact summary", () => {
  it("naked short put: uncoveredTailBelow, exact maxLoss at S=0", () => {
    const r = handleGetOptionPayoff({
      legs: [{ symbol: "BTC-25APR26-80000-P-USDT", side: "Sell", qty: 1, premium: 5000 }],
      currentSpot: 80000,
    });
    expect(r.summary.uncoveredTailBelow).toBe(true);
    expect(r.summary.maxLoss).toBeCloseTo(-75000, 0); // strike - premium, at S=0
    expect(r.summary.maxProfit).toBeCloseTo(5000, 0);
    expect(r.summary.breakevens[0]).toBeCloseTo(75000, 0);
  });

  it("far-OTM naked short call (strike outside ±30% of spot) is still flagged", () => {
    const r = handleGetOptionPayoff({
      legs: [{ symbol: "BTC-25APR26-108000-C-USDT", side: "Sell", qty: 1, premium: 200 }],
      currentSpot: 80000,
    });
    expect(r.summary.uncoveredTailAbove).toBe(true);
    expect(r.summary.maxLoss).toBe("unlimited");
  });

  it("risk-defined call vertical: no tails, exact bounds and breakeven", () => {
    const r = handleGetOptionPayoff({
      legs: [
        { symbol: "BTC-25APR26-80000-C-USDT", side: "Buy", qty: 1, premium: 5000 },
        { symbol: "BTC-25APR26-90000-C-USDT", side: "Sell", qty: 1, premium: 2000 },
      ],
      currentSpot: 80000,
    });
    expect(r.summary.uncoveredTailAbove).toBeUndefined();
    expect(r.summary.uncoveredTailBelow).toBeUndefined();
    expect(r.summary.maxLoss).toBeCloseTo(-3000, 0);
    expect(r.summary.maxProfit).toBeCloseTo(7000, 0);
    expect(r.summary.breakevens[0]).toBeCloseTo(83000, 0);
  });

  it("butterfly: maxLoss is the exact net debit (kinks, not grid samples)", () => {
    const r = handleGetOptionPayoff({
      legs: [
        { symbol: "BTC-25APR26-70000-C-USDT", side: "Buy", qty: 1, premium: 12000 },
        { symbol: "BTC-25APR26-80000-C-USDT", side: "Sell", qty: 2, premium: 6000 },
        { symbol: "BTC-25APR26-90000-C-USDT", side: "Buy", qty: 1, premium: 3000 },
      ],
      currentSpot: 80000,
    });
    expect(r.summary.maxLoss).toBeCloseTo(-3000, 0);
    expect(r.summary.maxProfit).toBeCloseTo(7000, 0);
    expect(r.summary.uncoveredTailAbove).toBeUndefined();
    const bes = r.summary.breakevens.map((b) => Math.round(b)).sort((a, b) => a - b);
    expect(bes).toEqual([73000, 87000]);
  });

  it("long put maxProfit is exact at S=0, not grid-clipped", () => {
    const r = handleGetOptionPayoff({
      legs: [{ symbol: "BTC-25APR26-80000-P-USDT", side: "Buy", qty: 1, premium: 5000 }],
      currentSpot: 80000,
    });
    expect(r.summary.maxProfit).toBeCloseTo(75000, 0);
  });

  it("rejects mixed underlyings on one price axis", () => {
    expect(() =>
      handleGetOptionPayoff({
        legs: [
          { symbol: "BTC-25APR26-80000-C-USDT", side: "Buy", qty: 1, premium: 100 },
          { symbol: "ETH-25APR26-2500-C-USDT", side: "Buy", qty: 1, premium: 10 },
        ],
        currentSpot: 80000,
      })
    ).toThrow(/underlying/);
  });

  it("rejects zero, negative, and non-finite qty", () => {
    for (const qty of [0, -1, NaN]) {
      expect(() =>
        handleGetOptionPayoff({
          legs: [{ symbol: "BTC-25APR26-80000-C-USDT", side: "Buy", qty, premium: 100 }],
          currentSpot: 80000,
        })
      ).toThrow(/qty/);
    }
  });

  it("default grid widens to cover strikes outside ±30% of spot", () => {
    const r = handleGetOptionPayoff({
      legs: [{ symbol: "BTC-25APR26-120000-C-USDT", side: "Buy", qty: 1, premium: 100 }],
      currentSpot: 80000,
    });
    const last = r.pricePoints[r.pricePoints.length - 1].underlyingPrice;
    expect(last).toBeGreaterThanOrEqual(120000);
  });
});
