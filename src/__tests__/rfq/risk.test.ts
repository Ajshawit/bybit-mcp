import { assessComboRisk } from "../../tools/rfq/risk";
import { RiskLeg } from "../../tools/rfq/types";

// payoff.ts parses option symbols but does not validate expiry-vs-now, so a
// far-dated synthetic symbol is fine for deterministic payoff math.
const CALL_80K = "BTC-25APR26-80000-C-USDT";
const CALL_100K = "BTC-25APR26-100000-C-USDT";

const ENV_KEYS = ["RFQ_ALLOW_UNCOVERED", "OPTIONS_ALLOW_NAKED_SHORT"] as const;

describe("assessComboRisk", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it("models a long-only call combo as covered and allowed", () => {
    const legs: RiskLeg[] = [
      { category: "option", symbol: CALL_80K, side: "buy", qty: 1, price: 1000 },
    ];
    const res = assessComboRisk({ legs, currentSpot: 80000 });
    expect(res.modeled).toBe(true);
    expect(res.uncovered).toBe(false);
    expect(res.allowed).toBe(true);
    expect(typeof res.maxLossUsd).toBe("number");
  });

  it("flags a naked short call as uncovered and blocks it by default", () => {
    const legs: RiskLeg[] = [
      { category: "option", symbol: CALL_80K, side: "sell", qty: 1, price: 1000 },
    ];
    const res = assessComboRisk({ legs, currentSpot: 80000 });
    expect(res.modeled).toBe(true);
    expect(res.uncovered).toBe(true);
    expect(res.allowed).toBe(false);
    expect(res.reasons.join(" ")).toMatch(/Blocked by default/);
  });

  it("permits a naked short when RFQ_ALLOW_UNCOVERED=true", () => {
    process.env.RFQ_ALLOW_UNCOVERED = "true";
    const legs: RiskLeg[] = [
      { category: "option", symbol: CALL_80K, side: "sell", qty: 1, price: 1000 },
    ];
    const res = assessComboRisk({ legs, currentSpot: 80000 });
    expect(res.uncovered).toBe(true);
    expect(res.allowed).toBe(true);
  });

  it("permits a naked short when legacy OPTIONS_ALLOW_NAKED_SHORT=true", () => {
    process.env.OPTIONS_ALLOW_NAKED_SHORT = "true";
    const legs: RiskLeg[] = [
      { category: "option", symbol: CALL_80K, side: "sell", qty: 1, price: 1000 },
    ];
    const res = assessComboRisk({ legs, currentSpot: 80000 });
    expect(res.allowed).toBe(true);
  });

  it("does NOT flag a risk-defined vertical spread (the limitation fix)", () => {
    const legs: RiskLeg[] = [
      { category: "option", symbol: CALL_80K, side: "buy", qty: 1, price: 2000 },
      { category: "option", symbol: CALL_100K, side: "sell", qty: 1, price: 800 },
    ];
    const res = assessComboRisk({ legs, currentSpot: 90000 });
    expect(res.modeled).toBe(true);
    expect(res.uncovered).toBe(false);
    expect(res.allowed).toBe(true);
  });

  it("fails safe (unmodeled, uncovered, blocked) for combos with linear legs", () => {
    const legs: RiskLeg[] = [
      { category: "option", symbol: CALL_80K, side: "buy", qty: 1, price: 1000 },
      { category: "linear", symbol: "BTCUSDT", side: "sell", qty: 0.5 },
    ];
    const res = assessComboRisk({ legs, currentSpot: 80000 });
    expect(res.modeled).toBe(false);
    expect(res.maxLossUsd).toBeNull();
    expect(res.maxProfit).toBeNull();
    expect(res.uncovered).toBe(true);
    expect(res.allowed).toBe(false);
    expect(res.reasons.join(" ")).toMatch(/linear\/spot/);
  });

  it("allows an unmodeled combo only with an override flag", () => {
    process.env.RFQ_ALLOW_UNCOVERED = "true";
    const legs: RiskLeg[] = [
      { category: "spot", symbol: "BTCUSDT", side: "buy", qty: 1 },
    ];
    const res = assessComboRisk({ legs, currentSpot: 80000 });
    expect(res.modeled).toBe(false);
    expect(res.allowed).toBe(true);
  });

  it("fails safe when currentSpot is missing", () => {
    const legs: RiskLeg[] = [
      { category: "option", symbol: CALL_80K, side: "buy", qty: 1, price: 1000 },
    ];
    const res = assessComboRisk({ legs });
    expect(res.modeled).toBe(false);
    expect(res.reasons.join(" ")).toMatch(/currentSpot unavailable/);
  });

  it("normalizes capitalized sides so a naked short is still caught", () => {
    // Caller passes "Sell" (the convention every other tool in this server
    // uses). The short rail must still fire.
    const legs = [
      { category: "option", symbol: CALL_80K, side: "Sell", qty: 1, price: 1000 },
    ] as unknown as RiskLeg[];
    const res = assessComboRisk({ legs, currentSpot: 80000 });
    expect(res.uncovered).toBe(true);
    expect(res.allowed).toBe(false);
  });

  it("fails closed (throws) on an unrecognized side", () => {
    const legs = [
      { category: "option", symbol: CALL_80K, side: "long", qty: 1, price: 1000 },
    ] as unknown as RiskLeg[];
    expect(() => assessComboRisk({ legs, currentSpot: 80000 })).toThrow(/Invalid leg side/);
  });

  it("fails safe when an option leg lacks a price", () => {
    const legs: RiskLeg[] = [
      { category: "option", symbol: CALL_80K, side: "buy", qty: 1 },
    ];
    const res = assessComboRisk({ legs, currentSpot: 80000 });
    expect(res.modeled).toBe(false);
    expect(res.reasons.join(" ")).toMatch(/lack an estimated price/);
  });

  // --- Cases the grid-slope gate got wrong (June 2026 audit) ---

  it("flags a naked short PUT as uncovered (downside tail)", () => {
    const legs: RiskLeg[] = [
      { category: "option", symbol: "BTC-25APR26-80000-P-USDT", side: "sell", qty: 1, price: 5000 },
    ];
    const res = assessComboRisk({ legs, currentSpot: 80000 });
    expect(res.uncovered).toBe(true);
    expect(res.allowed).toBe(false);
    expect(res.maxLossUsd).toBeCloseTo(-75000, 0); // exact loss at S=0, never a positive number
  });

  it("flags a far-OTM naked short call whose strike is outside ±30% of spot", () => {
    const legs: RiskLeg[] = [
      { category: "option", symbol: "BTC-25APR26-108000-C-USDT", side: "sell", qty: 1, price: 200 },
    ];
    const res = assessComboRisk({ legs, currentSpot: 80000 });
    expect(res.uncovered).toBe(true);
    expect(res.allowed).toBe(false);
    expect(res.maxLossUsd).toBeNull(); // unbounded above — never report a fake bound
    expect(res.reasons.join(" ")).toMatch(/unbounded|tail/i);
  });

  it("fails safe on zero, negative, and non-finite leg qty", () => {
    for (const qty of [0, -1, NaN]) {
      const legs: RiskLeg[] = [
        { category: "option", symbol: CALL_80K, side: "buy", qty, price: 100 },
      ];
      const res = assessComboRisk({ legs, currentSpot: 80000 });
      expect(res.modeled).toBe(false);
      expect(res.allowed).toBe(false);
    }
  });

  it("fails safe on mixed underlyings instead of mixing price axes", () => {
    const legs: RiskLeg[] = [
      { category: "option", symbol: CALL_80K, side: "buy", qty: 1, price: 100 },
      { category: "option", symbol: "ETH-25APR26-2500-P-USDT", side: "sell", qty: 1, price: 50 },
    ];
    const res = assessComboRisk({ legs, currentSpot: 80000 });
    expect(res.modeled).toBe(false);
    expect(res.uncovered).toBe(true);
    expect(res.allowed).toBe(false);
  });

  it("reports the exact naked-short-put maxLoss when overridden", () => {
    process.env.RFQ_ALLOW_UNCOVERED = "true";
    const legs: RiskLeg[] = [
      { category: "option", symbol: "BTC-25APR26-80000-P-USDT", side: "sell", qty: 1, price: 5000 },
    ];
    const res = assessComboRisk({ legs, currentSpot: 80000 });
    expect(res.allowed).toBe(true);
    expect(res.maxLossUsd).toBeCloseTo(-75000, 0);
  });
});
