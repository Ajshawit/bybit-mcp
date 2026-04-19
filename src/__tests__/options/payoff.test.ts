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

  it("long call maxProfit is 'unlimited' (trending up at upper boundary)", () => {
    const result = handleGetOptionPayoff({
      legs: BTC_CALL_LEGS,
      currentSpot: 50000,
      underlyingPriceRange: { min: 30000, max: 70000 },
      steps: 50,
    });
    expect(result.summary.maxProfit).toBe("unlimited");
    expect(result.summary.cappedAtRange).toBe(true);
  });

  it("short call maxProfit = premium, cappedAtRange for maxLoss", () => {
    const result = handleGetOptionPayoff({
      legs: [{ symbol: "BTC-25APR26-50000-C-USDT", side: "Sell", qty: 1, premium: 2000 }],
      currentSpot: 50000,
      underlyingPriceRange: { min: 30000, max: 70000 },
      steps: 50,
    });
    expect(result.summary.maxProfit).toBeCloseTo(2000, 0);
    expect(result.summary.cappedAtRange).toBe(true);
  });

  it("ETH uses 0.1 multiplier", () => {
    const result = handleGetOptionPayoff({
      legs: [{ symbol: "ETH-30MAY26-2000-C-USDT", side: "Buy", qty: 1, premium: 100 }],
      currentSpot: 2000,
      underlyingPriceRange: { min: 3000, max: 3000 },
      steps: 1,
    });
    // At spot=3000: intrinsic=1000, pnl=(1000-100)*1*0.1 = 90
    expect(result.pricePoints[0].pnl).toBeCloseTo(90);
  });

  it("uses default ±30% range from currentSpot when range not provided", () => {
    const result = handleGetOptionPayoff({
      legs: BTC_CALL_LEGS,
      currentSpot: 50000,
    });
    expect(result.pricePoints[0].underlyingPrice).toBeCloseTo(35000, -2);
    expect(result.pricePoints[result.pricePoints.length - 1].underlyingPrice).toBeCloseTo(65000, -2);
    expect(result.pricePoints.length).toBe(50);
  });

  it("result includes underlying field parsed from leg symbol", () => {
    const result = handleGetOptionPayoff({ legs: BTC_CALL_LEGS, currentSpot: 50000 });
    expect(result.underlying).toBe("BTC");
  });
});
