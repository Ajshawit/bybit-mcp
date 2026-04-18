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
});
