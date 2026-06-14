import { blackScholesGreeks } from "../../tools/options/blackscholes";

describe("blackScholesGreeks", () => {
  // ATM call: S=50000, K=50000, T=30/365, IV=0.65, r=0
  // d1 ≈ 0.0932, N(d1) ≈ 0.537
  it("ATM call delta ≈ 0.537", () => {
    const g = blackScholesGreeks("call", 50000, 50000, 30 / 365, 0.65);
    expect(Math.abs(g.delta - 0.537)).toBeLessThan(0.01);
  });

  it("ATM put delta ≈ -0.463", () => {
    const g = blackScholesGreeks("put", 50000, 50000, 30 / 365, 0.65);
    expect(Math.abs(g.delta - (-0.463))).toBeLessThan(0.01);
  });

  it("call and put have same gamma at ATM", () => {
    const call = blackScholesGreeks("call", 50000, 50000, 30 / 365, 0.65);
    const put = blackScholesGreeks("put", 50000, 50000, 30 / 365, 0.65);
    expect(Math.abs(call.gamma - put.gamma)).toBeLessThan(1e-9);
  });

  it("call and put have same vega at ATM", () => {
    const call = blackScholesGreeks("call", 50000, 50000, 30 / 365, 0.65);
    const put = blackScholesGreeks("put", 50000, 50000, 30 / 365, 0.65);
    expect(Math.abs(call.vega - put.vega)).toBeLessThan(0.001);
  });

  it("theta is negative for long call (time decay costs holder)", () => {
    const g = blackScholesGreeks("call", 50000, 50000, 30 / 365, 0.65);
    expect(g.theta).toBeLessThan(0);
  });

  it("theta is negative for long put", () => {
    const g = blackScholesGreeks("put", 50000, 50000, 30 / 365, 0.65);
    expect(g.theta).toBeLessThan(0);
  });

  it("deep ITM call delta approaches 1", () => {
    const g = blackScholesGreeks("call", 50000, 30000, 30 / 365, 0.65);
    expect(g.delta).toBeGreaterThan(0.9);
  });

  it("deep OTM call delta approaches 0", () => {
    const g = blackScholesGreeks("call", 50000, 90000, 30 / 365, 0.65);
    expect(g.delta).toBeLessThan(0.1);
  });

  it("vega is positive (more IV = higher option value)", () => {
    const g = blackScholesGreeks("call", 50000, 50000, 30 / 365, 0.65);
    expect(g.vega).toBeGreaterThan(0);
  });

  // σ→0 / invalid-IV limit: deterministic intrinsic-based greeks, never NaN.
  it("iv=0 returns the intrinsic limit, not NaN", () => {
    const itm = blackScholesGreeks("call", 50000, 30000, 30 / 365, 0);
    expect(itm.delta).toBe(1);
    expect(itm.gamma).toBe(0);
    expect(itm.theta).toBe(0);
    expect(itm.vega).toBe(0);

    const otmPut = blackScholesGreeks("put", 50000, 30000, 30 / 365, 0);
    expect(otmPut.delta).toBe(0);
  });

  it("NaN iv returns finite greeks", () => {
    const g = blackScholesGreeks("call", 50000, 50000, 30 / 365, NaN);
    expect(Number.isFinite(g.delta)).toBe(true);
    expect(Number.isFinite(g.gamma)).toBe(true);
    expect(Number.isFinite(g.theta)).toBe(true);
    expect(Number.isFinite(g.vega)).toBe(true);
  });
});
