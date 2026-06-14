import crypto from "crypto";
import { buildAuthHeaders } from "../auth";

describe("buildAuthHeaders", () => {
  const apiKey = "testKey123";
  const secret = "testSecret456";
  const timestamp = "1658384314791";
  const recvWindow = "5000";
  const payload = "category=linear&symbol=BTCUSDT";

  it("produces correct HMAC-SHA256 signature", () => {
    const expected = crypto
      .createHmac("sha256", secret)
      .update(`${timestamp}${apiKey}${recvWindow}${payload}`)
      .digest("hex");

    const headers = buildAuthHeaders(apiKey, secret, timestamp, recvWindow, payload);

    expect(headers["X-BAPI-API-KEY"]).toBe(apiKey);
    expect(headers["X-BAPI-TIMESTAMP"]).toBe(timestamp);
    expect(headers["X-BAPI-SIGN"]).toBe(expected);
    expect(headers["X-BAPI-RECV-WINDOW"]).toBe(recvWindow);
  });

  it("signs POST body (compact JSON, no spaces)", () => {
    const body = '{"category":"linear","symbol":"BTCUSDT","side":"Buy"}';
    const expected = crypto
      .createHmac("sha256", secret)
      .update(`${timestamp}${apiKey}${recvWindow}${body}`)
      .digest("hex");

    const headers = buildAuthHeaders(apiKey, secret, timestamp, recvWindow, body);
    expect(headers["X-BAPI-SIGN"]).toBe(expected);
  });

  // Fixed known-answer vector: the tests above re-derive the HMAC with the
  // same recipe as the implementation, so a recipe bug (wrong field order,
  // wrong algorithm) would pass both sides. This hex was computed
  // independently and pins the exact Bybit V5 signing recipe.
  it("matches an independently computed known-answer vector", () => {
    const headers = buildAuthHeaders(
      "test-key",
      "test-secret",
      "1700000000000",
      "5000",
      "category=linear"
    );
    expect(headers["X-BAPI-SIGN"]).toBe(
      "85d495c8776cb90e77dfac52d77ea79f2c7b3080ddbca3da7b132ebc23cecfbc"
    );
  });
});
