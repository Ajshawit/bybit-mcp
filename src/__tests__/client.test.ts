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
});
