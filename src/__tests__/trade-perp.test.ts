import { handlePlacePerp, handleClosePerp, handleManagePosition } from "../tools/trade-perp";
import { BybitClient, BybitError } from "../client";
import { positionModeCache } from "../cache";

jest.mock("../client", () => {
  const actual = jest.requireActual<typeof import("../client")>("../client");
  return {
    ...actual,
    BybitClient: jest.fn().mockImplementation(() => ({
      publicGet: jest.fn(),
      signedGet: jest.fn(),
      signedPost: jest.fn(),
    })),
    BybitError: actual.BybitError,
  };
});
jest.mock("../tools/trade-shared");

import { ensureInstrumentInfo, detectPositionIdx } from "../tools/trade-shared";
const mockEnsure = ensureInstrumentInfo as jest.Mock;
const mockDetect = detectPositionIdx as jest.Mock;

const MockClient = BybitClient as jest.MockedClass<typeof BybitClient>;
const mockInst = { tickSize: "0.5", qtyStep: "0.001", minNotionalValue: "5" };
const mockTicker = { list: [{ lastPrice: "30000", turnover24h: "200000000" }] };
const mockWalletUsdt = {
  list: [{
    accountType: "UNIFIED", totalEquity: "200", totalMaintenanceMargin: "5",
    coin: [{ coin: "USDT", walletBalance: "200", totalPositionIM: "50", unrealisedPnl: "0", equity: "200", locked: "0" }],
  }],
};
const mockOrderResult = { orderId: "order123", orderLinkId: "mcp-test-abc" };

describe("handlePlacePerp", () => {
  beforeEach(() => {
    mockEnsure.mockResolvedValue(mockInst);
    mockDetect.mockResolvedValue(1);
    positionModeCache["store"].clear();
  });

  it("computes linear qty = floor(margin * leverage / price, qtyStep)", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValue(mockTicker);
    (client.signedGet as jest.Mock).mockResolvedValue(mockWalletUsdt);
    (client.signedPost as jest.Mock)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(mockOrderResult);

    await handlePlacePerp(client, { symbol: "BTCUSDT", side: "Buy", margin: 30, leverage: 10, sl: 29000 });

    const orderCall = (client.signedPost as jest.Mock).mock.calls[1];
    // qty = 30 * 10 / 30000 = 0.01
    expect(parseFloat(orderCall[1].qty)).toBeCloseTo(0.01, 3);
    expect(orderCall[1].category).toBe("linear");
  });

  it("computes inverse qty = floor(margin * leverage * price, qtyStep)", async () => {
    const mockWalletBtc = {
      list: [{
        accountType: "UNIFIED", totalEquity: "1", totalMaintenanceMargin: "0",
        coin: [{ coin: "BTC", walletBalance: "1", totalPositionIM: "0", unrealisedPnl: "0", equity: "1", locked: "0" }],
      }],
    };
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValue(mockTicker);
    (client.signedGet as jest.Mock).mockResolvedValue(mockWalletBtc);
    (client.signedPost as jest.Mock)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(mockOrderResult);

    await handlePlacePerp(client, { symbol: "BTCUSD", side: "Buy", margin: 0.01, leverage: 10, sl: 29000, category: "inverse" });

    const orderCall = (client.signedPost as jest.Mock).mock.calls[1];
    // qty = 0.01 * 10 * 30000 = 3000 contracts
    expect(parseFloat(orderCall[1].qty)).toBeCloseTo(3000, 0);
    expect(orderCall[1].category).toBe("inverse");
  });

  it("fetches BTC wallet balance for inverse, not USDT", async () => {
    const mockWalletBtc = {
      list: [{
        accountType: "UNIFIED", totalEquity: "1", totalMaintenanceMargin: "0",
        coin: [{ coin: "BTC", walletBalance: "1", totalPositionIM: "0", unrealisedPnl: "0", equity: "1", locked: "0" }],
      }],
    };
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValue(mockTicker);
    (client.signedGet as jest.Mock).mockResolvedValue(mockWalletBtc);
    (client.signedPost as jest.Mock).mockResolvedValue({}).mockResolvedValueOnce({}).mockResolvedValueOnce(mockOrderResult);

    await handlePlacePerp(client, { symbol: "BTCUSD", side: "Buy", margin: 0.01, leverage: 5, sl: 29000, category: "inverse" });

    const getCall = (client.signedGet as jest.Mock).mock.calls[0];
    expect(getCall[1].coin).toBe("BTC");
  });

  it("sends limit order with price and orderType in body", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValue(mockTicker);
    (client.signedGet as jest.Mock).mockResolvedValue(mockWalletUsdt);
    (client.signedPost as jest.Mock)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(mockOrderResult);

    await handlePlacePerp(client, { symbol: "BTCUSDT", side: "Buy", margin: 30, leverage: 10, sl: 29000, orderType: "Limit", price: 29500 });

    const orderCall = (client.signedPost as jest.Mock).mock.calls[1];
    expect(orderCall[1].orderType).toBe("Limit");
    expect(orderCall[1].price).toBe("29500");
    // qty = floor(30 * 10 / 29500, 0.001) = floor(0.01017, 0.001) = 0.010
    expect(parseFloat(orderCall[1].qty)).toBeCloseTo(0.010, 3);
  });

  it("returns DryRunResult without submitting when dry_run=true", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValue(mockTicker);
    (client.signedGet as jest.Mock).mockResolvedValue(mockWalletUsdt);

    const result = await handlePlacePerp(client, { symbol: "BTCUSDT", side: "Buy", margin: 30, leverage: 10, sl: 29000, dry_run: true });

    expect((result as any).dryRun).toBe(true);
    expect((result as any).computedQty).toBeDefined();
    expect(client.signedPost).not.toHaveBeenCalled();
  });

  it("dry_run returns warning (not error) when margin exceeds free balance", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValue(mockTicker);
    (client.signedGet as jest.Mock).mockResolvedValue(mockWalletUsdt); // free = 200 - 50 = 150

    const result = await handlePlacePerp(client, { symbol: "BTCUSDT", side: "Buy", margin: 200, leverage: 10, sl: 29000, dry_run: true });

    expect((result as any).dryRun).toBe(true);
    expect((result as any).computedQty).toBeDefined();
    expect((result as any).wouldSubmit).toBe(false);
    expect((result as any).warnings[0]).toMatch(/Insufficient free capital/);
    expect(client.signedPost).not.toHaveBeenCalled();
  });

  it("dry_run wouldSubmit: true when only a size warning fires (not a blocker)", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValue(mockTicker);
    // free = 200 - 50 = 150; margin=50 is 33% → triggers size warning but is not a blocker
    (client.signedGet as jest.Mock).mockResolvedValue(mockWalletUsdt);

    const result = await handlePlacePerp(client, { symbol: "BTCUSDT", side: "Buy", margin: 50, leverage: 10, sl: 29000, dry_run: true });

    expect((result as any).wouldSubmit).toBe(true);
    expect((result as any).warnings[0]).toMatch(/Order uses 33%/);
    expect(client.signedPost).not.toHaveBeenCalled();
  });

  it("throws when orderType=Limit but no price", async () => {
    const client = new MockClient("k", "s", "u");
    await expect(
      handlePlacePerp(client, { symbol: "BTCUSDT", side: "Buy", margin: 30, leverage: 10, sl: 29000, orderType: "Limit" })
    ).rejects.toMatchObject({ message: expect.stringContaining("price is required") });
  });

  it("retries with hedge positionIdx on 10001 when initial positionIdx=0", async () => {
    mockDetect.mockResolvedValue(0);
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValue(mockTicker);
    (client.signedGet as jest.Mock).mockResolvedValue(mockWalletUsdt);
    (client.signedPost as jest.Mock)
      .mockResolvedValueOnce({}) // set-leverage
      .mockRejectedValueOnce(new BybitError(10001, "position idx not match"))
      .mockResolvedValueOnce(mockOrderResult); // retry succeeds

    const result = await handlePlacePerp(client, { symbol: "BTCUSDT", side: "Buy", margin: 10, leverage: 5, sl: 29000 });

    expect(result).toMatchObject({ orderId: "order123" });
    const retryCall = (client.signedPost as jest.Mock).mock.calls[2];
    expect(retryCall[1].positionIdx).toBe(1);
  });

  it("throws on 10001 if retry also fails", async () => {
    mockDetect.mockResolvedValue(0);
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValue(mockTicker);
    (client.signedGet as jest.Mock).mockResolvedValue(mockWalletUsdt);
    (client.signedPost as jest.Mock)
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new BybitError(10001, "mismatch"))
      .mockRejectedValueOnce(new BybitError(10001, "mismatch"));

    await expect(
      handlePlacePerp(client, { symbol: "BTCUSDT", side: "Buy", margin: 10, leverage: 5, sl: 29000 })
    ).rejects.toMatchObject({ message: expect.stringContaining("auto-retry could not resolve") });
  });

  it("returns partialSuccess=true if trading-stop fails after order succeeds", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValue(mockTicker);
    (client.signedGet as jest.Mock).mockResolvedValue(mockWalletUsdt);
    (client.signedPost as jest.Mock)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(mockOrderResult)
      .mockRejectedValueOnce(new Error("trading-stop failed"));

    const result = await handlePlacePerp(client, { symbol: "BTCUSDT", side: "Buy", margin: 10, leverage: 5, sl: 29000, trailingStop: 500 });

    expect((result as any).partialSuccess).toBe(true);
  });
});

const mockPositionList = {
  list: [{
    symbol: "BTCUSDT", side: "Buy" as const, size: "0.01", avgPrice: "30000",
    markPrice: "31000", unrealisedPnl: "10", stopLoss: "29000",
    takeProfit: "33000", trailingStop: "0", liquidationPrice: "25000",
    positionIdx: 1 as const, leverage: "10", positionIM: "30",
  }],
  category: "linear",
};

describe("handleClosePerp", () => {
  beforeEach(() => {
    mockEnsure.mockResolvedValue(mockInst);
    mockDetect.mockResolvedValue(1);
  });

  it("sends market reduceOnly order for full position", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedGet as jest.Mock).mockResolvedValue(mockPositionList);
    (client.signedPost as jest.Mock).mockResolvedValue({ orderId: "close1", orderLinkId: "mcp-close" });

    await handleClosePerp(client, { symbol: "BTCUSDT", side: "Buy" });

    const call = (client.signedPost as jest.Mock).mock.calls[0];
    expect(call[1].reduceOnly).toBe(true);
    expect(parseFloat(call[1].qty)).toBeCloseTo(0.01, 3);
    expect(call[1].side).toBe("Sell");
  });

  it("closes partial position at given percent", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedGet as jest.Mock).mockResolvedValue(mockPositionList);
    (client.signedPost as jest.Mock).mockResolvedValue({ orderId: "close2", orderLinkId: "mcp-close2" });

    await handleClosePerp(client, { symbol: "BTCUSDT", side: "Buy", percent: 50 });

    const call = (client.signedPost as jest.Mock).mock.calls[0];
    expect(parseFloat(call[1].qty)).toBeCloseTo(0.005, 3);
  });

  it("uses explicit qty when provided instead of percent", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedGet as jest.Mock).mockResolvedValue(mockPositionList);
    (client.signedPost as jest.Mock).mockResolvedValue({ orderId: "close3", orderLinkId: "mcp-close3" });

    await handleClosePerp(client, { symbol: "BTCUSDT", side: "Buy", qty: 0.005 });

    const call = (client.signedPost as jest.Mock).mock.calls[0];
    expect(parseFloat(call[1].qty)).toBeCloseTo(0.005, 3);
  });

  it("passes category to position/list and order/create", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedGet as jest.Mock).mockResolvedValue(mockPositionList);
    (client.signedPost as jest.Mock).mockResolvedValue(mockOrderResult);

    await handleClosePerp(client, { symbol: "BTCUSDT", side: "Buy", category: "linear" });

    const getCall = (client.signedGet as jest.Mock).mock.calls[0];
    expect(getCall[1].category).toBe("linear");
    const postCall = (client.signedPost as jest.Mock).mock.calls[0];
    expect(postCall[1].category).toBe("linear");
  });
});

describe("handleManagePosition", () => {
  beforeEach(() => {
    mockDetect.mockResolvedValue(1);
  });

  it("calls trading-stop with correct fields and category", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedPost as jest.Mock).mockResolvedValue({});

    await handleManagePosition(client, { symbol: "BTCUSDT", side: "Buy", updates: { sl: 29500, tp: 33000 } });

    const call = (client.signedPost as jest.Mock).mock.calls[0];
    expect(call[0]).toBe("/v5/position/trading-stop");
    expect(call[1].stopLoss).toBe("29500");
    expect(call[1].takeProfit).toBe("33000");
    expect(call[1].category).toBe("linear");
  });

  it("passes '0' string to cancel existing SL", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedPost as jest.Mock).mockResolvedValue({});

    await handleManagePosition(client, { symbol: "BTCUSDT", side: "Buy", updates: { sl: 0 } });

    const call = (client.signedPost as jest.Mock).mock.calls[0];
    expect(call[1].stopLoss).toBe("0");
  });

  it("throws structured error for spot category", async () => {
    const client = new MockClient("k", "s", "u");
    await expect(
      handleManagePosition(client, { symbol: "BTCUSDT", side: "Buy", updates: { sl: 29000 }, category: "spot" as any })
    ).rejects.toMatchObject({ message: expect.stringContaining("not supported for spot") });
  });
});
