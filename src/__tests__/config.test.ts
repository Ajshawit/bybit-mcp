import { resolveBaseUrl, isEnvEnabled, MAINNET_URL, TESTNET_URL } from "../config";

describe("resolveBaseUrl (BYBIT_TESTNET coercion)", () => {
  it("defaults to testnet when unset", () => {
    expect(resolveBaseUrl(undefined)).toBe(TESTNET_URL);
  });

  it("selects mainnet only for the exact string 'false'", () => {
    expect(resolveBaseUrl("false")).toBe(MAINNET_URL);
  });

  it("stays on testnet for near-miss values", () => {
    for (const v of ["FALSE", "False", "0", "no", "", "true", " false", "false "]) {
      expect(resolveBaseUrl(v)).toBe(TESTNET_URL);
    }
  });
});

describe("isEnvEnabled (strict === 'true' coercion)", () => {
  it("enables only on the exact string 'true'", () => {
    expect(isEnvEnabled("true")).toBe(true);
  });

  it("stays disabled for near-miss values", () => {
    for (const v of ["TRUE", "True", "1", "yes", "", " true", undefined]) {
      expect(isEnvEnabled(v)).toBe(false);
    }
  });
});
