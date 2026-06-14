import { BybitClient, BybitError } from "../client";

const mockFetch = jest.fn();
global.fetch = mockFetch;

function mockSuccess<T>(result: T) {
  mockFetch.mockResolvedValueOnce({
    json: async () => ({ retCode: 0, retMsg: "OK", result, time: Date.now() }),
  });
}

function mockError(retCode: number, retMsg: string) {
  mockFetch.mockResolvedValueOnce({
    json: async () => ({ retCode, retMsg, result: {}, time: Date.now() }),
  });
}

describe("BybitClient", () => {
  beforeEach(() => {
    mockFetch.mockClear();
    jest.useFakeTimers();
  });
  afterEach(() => jest.useRealTimers());

  it("publicGet sends GET to correct URL", async () => {
    mockSuccess({ list: [] });
    const client = new BybitClient("key", "secret", "https://api.bybit.com");
    const p = client.publicGet("/v5/market/tickers", { category: "linear" });
    jest.runAllTimers();
    await p;
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.bybit.com/v5/market/tickers?category=linear",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("signedGet includes auth headers", async () => {
    mockSuccess({ list: [] });
    const client = new BybitClient("myKey", "mySecret", "https://api.bybit.com");
    const p = client.signedGet("/v5/position/list", { category: "linear" });
    jest.runAllTimers();
    await p;
    const callArgs = mockFetch.mock.calls[0];
    const headers = callArgs[1].headers as Record<string, string>;
    expect(headers["X-BAPI-API-KEY"]).toBe("myKey");
    expect(headers["X-BAPI-SIGN"]).toBeDefined();
  });

  it("throws BybitError on non-zero retCode", async () => {
    mockError(110007, "Insufficient balance");
    const client = new BybitClient("key", "secret", "https://api.bybit.com");
    const p = client.signedGet("/v5/position/list", { category: "linear" });
    jest.runAllTimers();
    await expect(p).rejects.toMatchObject({ retCode: 110007, retMsg: "Insufficient balance" });
  });

  it("treats retCode 110043 as success", async () => {
    mockFetch.mockResolvedValueOnce({
      json: async () => ({ retCode: 110043, retMsg: "leverage not modified", result: {}, time: Date.now() }),
    });
    const client = new BybitClient("key", "secret", "https://api.bybit.com");
    const p = client.signedPost("/v5/position/set-leverage", { category: "linear" });
    jest.runAllTimers();
    const result = await p;
    expect(result).toBeDefined();
  });

  it("retries on retCode 10006 up to 3 times", async () => {
    mockError(10006, "Rate limited");
    mockError(10006, "Rate limited");
    mockSuccess({ list: [] });
    const client = new BybitClient("key", "secret", "https://api.bybit.com");
    jest.useRealTimers();
    await client.publicGet("/v5/market/tickers", {});
    expect(mockFetch).toHaveBeenCalledTimes(3);
  }, 10000);

  it("re-signs each retry with a fresh timestamp", async () => {
    mockError(10006, "Rate limited");
    mockSuccess({ list: [] });
    const client = new BybitClient("key", "secret", "https://api.bybit.com");
    jest.useRealTimers();
    const nowSpy = jest.spyOn(Date, "now");
    let t = 1700000000000;
    nowSpy.mockImplementation(() => (t += 1000));

    await client.signedPost("/v5/order/create", { category: "linear" });

    const ts0 = (mockFetch.mock.calls[0][1].headers as Record<string, string>)["X-BAPI-TIMESTAMP"];
    const ts1 = (mockFetch.mock.calls[1][1].headers as Record<string, string>)["X-BAPI-TIMESTAMP"];
    expect(ts1).not.toBe(ts0);
    nowSpy.mockRestore();
  }, 10000);

  it("maps a POST timeout to an explicit may-have-executed warning", async () => {
    const abortErr = new Error("This operation was aborted");
    abortErr.name = "TimeoutError";
    mockFetch.mockRejectedValueOnce(abortErr);
    const client = new BybitClient("key", "secret", "https://api.bybit.com");
    jest.useRealTimers();

    await expect(
      client.signedPost("/v5/order/create", { category: "linear" })
    ).rejects.toThrow(/may or may not have been processed/);
  }, 10000);

  it("redacts the API key from Bybit error messages", async () => {
    mockError(10004, "invalid signature for key mySecretKey123 origin");
    const client = new BybitClient("mySecretKey123", "secret", "https://api.bybit.com");
    const p = client.signedGet("/v5/position/list", { category: "linear" });
    jest.runAllTimers();
    await expect(p).rejects.toThrow(/\[REDACTED_API_KEY\]/);
    await expect(p).rejects.not.toThrow(/mySecretKey123/);
  });

  it("throws a clear error on an unparseable (non-JSON) response", async () => {
    mockFetch.mockResolvedValueOnce({
      status: 502,
      json: async () => { throw new Error("Unexpected token <"); },
    });
    const client = new BybitClient("key", "secret", "https://api.bybit.com");
    const p = client.publicGet("/v5/market/tickers", {});
    jest.runAllTimers();
    await expect(p).rejects.toThrow(/unparseable response \(HTTP 502\)/);
  });
});
