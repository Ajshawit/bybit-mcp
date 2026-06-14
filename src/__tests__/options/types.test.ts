import { parseOptionSymbol, computeMoneyness, OPTION_MULTIPLIERS } from "../../tools/options/types";

describe("OPTION_MULTIPLIERS", () => {
  it("BTC=1, ETH=1, SOL=1", () => {
    expect(OPTION_MULTIPLIERS["BTC"]).toBe(1);
    expect(OPTION_MULTIPLIERS["ETH"]).toBe(1);  // 1 contract = 1 ETH; confirmed via Bybit instruments-info
    expect(OPTION_MULTIPLIERS["SOL"]).toBe(1);
  });
});

describe("parseOptionSymbol", () => {
  it("parses BTC call correctly", () => {
    const result = parseOptionSymbol("BTC-25APR26-80000-C-USDT");
    expect(result.underlying).toBe("BTC");
    expect(result.strike).toBe(80000);
    expect(result.type).toBe("call");
    expect(result.expiry.getUTCFullYear()).toBe(2026);
    expect(result.expiry.getUTCMonth()).toBe(3); // April = 3
    expect(result.expiry.getUTCDate()).toBe(25);
    expect(result.expiry.getUTCHours()).toBe(8); // Bybit expires at 08:00 UTC
  });

  it("parses ETH put correctly", () => {
    const result = parseOptionSymbol("ETH-30MAY26-2500-P-USDT");
    expect(result.underlying).toBe("ETH");
    expect(result.strike).toBe(2500);
    expect(result.type).toBe("put");
    expect(result.expiry.getUTCMonth()).toBe(4); // May = 4
    expect(result.expiry.getUTCDate()).toBe(30);
  });

  it("throws on malformed symbol", () => {
    expect(() => parseOptionSymbol("NOTASYMBOL")).toThrow("Invalid option symbol format");
    expect(() => parseOptionSymbol("BTC-25APR26-80000-X-USDT")).toThrow("Invalid option symbol format");
  });
});

describe("computeMoneyness", () => {
  it("ATM within 1% of spot", () => {
    expect(computeMoneyness(100, 100, "call")).toBe("ATM");
    expect(computeMoneyness(100.5, 100, "call")).toBe("ATM");
    expect(computeMoneyness(99.5, 100, "put")).toBe("ATM");
  });

  it("call ITM when strike < spot", () => {
    expect(computeMoneyness(90, 100, "call")).toBe("ITM");
  });

  it("call OTM when strike > spot", () => {
    expect(computeMoneyness(110, 100, "call")).toBe("OTM");
  });

  it("put ITM when strike > spot", () => {
    expect(computeMoneyness(110, 100, "put")).toBe("ITM");
  });

  it("put OTM when strike < spot", () => {
    expect(computeMoneyness(90, 100, "put")).toBe("OTM");
  });
});

// Bybit does not zero-pad expiry days for the 1st–9th of the month
// (e.g. ETH-3JAN23-1250-P in the official docs) — the parser must accept
// 1- and 2-digit days.
describe("parseOptionSymbol single-digit expiry days", () => {
  it("parses a single-digit day", () => {
    const r = parseOptionSymbol("BTC-3OCT25-60000-C-USDT");
    expect(r.underlying).toBe("BTC");
    expect(r.strike).toBe(60000);
    expect(r.type).toBe("call");
    expect(r.expiry.getUTCDate()).toBe(3);
    expect(r.expiry.getUTCMonth()).toBe(9); // OCT
    expect(r.expiry.getUTCFullYear()).toBe(2025);
  });

  it("still parses two-digit days", () => {
    const r = parseOptionSymbol("ETH-30MAY26-2500-P-USDT");
    expect(r.expiry.getUTCDate()).toBe(30);
  });

  it("rejects malformed expiry segments", () => {
    expect(() => parseOptionSymbol("BTC-OCT25-60000-C-USDT")).toThrow("Invalid option symbol");
    expect(() => parseOptionSymbol("BTC-123OCT25-60000-C-USDT")).toThrow("Invalid option symbol");
    expect(() => parseOptionSymbol("BTC-3XXX25-60000-C-USDT")).toThrow("Invalid option symbol");
  });
});
