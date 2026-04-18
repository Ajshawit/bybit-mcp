import crypto from "crypto";

export function buildAuthHeaders(
  apiKey: string,
  secret: string,
  timestamp: string,
  recvWindow: string,
  payload: string
): Record<string, string> {
  const paramStr = `${timestamp}${apiKey}${recvWindow}${payload}`;
  const sign = crypto.createHmac("sha256", secret).update(paramStr).digest("hex");
  return {
    "X-BAPI-API-KEY": apiKey,
    "X-BAPI-TIMESTAMP": timestamp,
    "X-BAPI-SIGN": sign,
    "X-BAPI-RECV-WINDOW": recvWindow,
  };
}
