export const MAINNET_URL = "https://api.bybit.com";
export const TESTNET_URL = "https://api-testnet.bybit.com";

// Fail-safe network selection: only the exact string "false" selects mainnet.
// Any other value — unset, "0", "FALSE", a typo — stays on testnet.
export function resolveBaseUrl(testnetEnv: string | undefined): string {
  return testnetEnv !== "false" ? TESTNET_URL : MAINNET_URL;
}

// Strict opt-in coercion for feature flags and kill-switches: only the exact
// string "true" enables. "TRUE", "1", "yes" stay off — gates fail closed.
export function isEnvEnabled(value: string | undefined): boolean {
  return value === "true";
}
