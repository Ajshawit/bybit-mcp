import { handlePlaceTrade, handleClosePosition, handleManagePosition } from "../tools/trade";
import { BybitClient, BybitError } from "../client";
import { instrumentsCache } from "../cache";

jest.mock("../client");
const MockClient = BybitClient as jest.MockedClass<typeof BybitClient>;

const mockInstrumentInfo = { tickSize: "0.5", qtyStep: "0.001", minNotionalValue: "5" };
const mockTicker = { list: [{ lastPrice: "30000", turnover24h: "200000000" }] };
const mockWallet = {
  list: [{
    accountType: "UNIFIED",
    totalEquity: "200",
    totalMaintenanceMargin: "5",
    coin: [{ coin: "USDT", walletBalance: "200", totalPositionIM: "50", unrealisedPnl: "0", equity: "200", locked: "0" }],
  }],
};
const mockOrderResult = { orderId: "order123", orderLinkId: "mcp-test-abc" };

describe("handlePlaceTrade", () => {
  beforeEach(() => {
    instrumentsCache.set("BTCUSDT", mockInstrumentInfo);
  });

  it("computes qty = floor(margin * leverage / price, qtyStep)", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValue(mockTicker);
    (client.signedGet as jest.Mock).mockResolvedValue(mockWallet);
    (client.signedPost as jest.Mock)
      .mockResolvedValueOnce({}) // set-leverage
      .mockResolvedValueOnce(mockOrderResult); // order/create

    await handlePlaceTrade(client, {
      symbol: "BTCUSDT", side: "Buy", marginUsdt: 30, leverage: 10, sl: 29000,
    });

    const orderCall = (client.signedPost as jest.Mock).mock.calls[1];
    expect(orderCall[0]).toBe("/v5/order/create");
    // qty = 30 * 10 / 30000 = 0.01 → floorToStep(0.01, "0.001") = "0.010"
    expect(parseFloat(orderCall[1].qty)).toBeCloseTo(0.01, 3);
  });

  it("returns sizeWarning when margin > 20% of freeCapital", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValue(mockTicker);
    (client.signedGet as jest.Mock).mockResolvedValue(mockWallet);
    (client.signedPost as jest.Mock)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(mockOrderResult);

    // freeCapital = 200 - 50 = 150. margin=50 = 33%, > 20%
    const result = await handlePlaceTrade(client, {
      symbol: "BTCUSDT", side: "Buy", marginUsdt: 50, leverage: 10, sl: 29000,
    });

    expect(result.sizeWarning).toBeDefined();
    expect(result.sizeWarning).toContain("33");
  });

  it("uses positionIdx=1 for Buy, positionIdx=2 for Sell", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValue(mockTicker);
    (client.signedGet as jest.Mock).mockResolvedValue(mockWallet);
    (client.signedPost as jest.Mock)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(mockOrderResult);

    await handlePlaceTrade(client, { symbol: "BTCUSDT", side: "Buy", marginUsdt: 10, leverage: 5, sl: 29000 });
    const buyCall = (client.signedPost as jest.Mock).mock.calls[1];
    expect(buyCall[1].positionIdx).toBe(1);

    (client.signedPost as jest.Mock).mockClear();
    (client.publicGet as jest.Mock).mockResolvedValue(mockTicker);
    (client.signedGet as jest.Mock).mockResolvedValue(mockWallet);
    (client.signedPost as jest.Mock)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(mockOrderResult);

    await handlePlaceTrade(client, { symbol: "BTCUSDT", side: "Sell", marginUsdt: 10, leverage: 5, sl: 31000 });
    const sellCall = (client.signedPost as jest.Mock).mock.calls[1];
    expect(sellCall[1].positionIdx).toBe(2);
  });

  it("throws when freeCapital < marginUsdt", async () => {
    const tightWallet = {
      list: [{
        accountType: "UNIFIED",
        totalEquity: "20",
        totalMaintenanceMargin: "5",
        coin: [{ coin: "USDT", walletBalance: "20", totalPositionIM: "15", unrealisedPnl: "0", equity: "20", locked: "0" }],
      }],
    };
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValue(mockTicker);
    (client.signedGet as jest.Mock).mockResolvedValue(tightWallet);

    await expect(
      handlePlaceTrade(client, { symbol: "BTCUSDT", side: "Buy", marginUsdt: 100, leverage: 10, sl: 29000 })
    ).rejects.toMatchObject({ message: expect.stringContaining("Insufficient") });
  });

  it("returns partialSuccess=true if trading-stop fails after order succeeds", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValue(mockTicker);
    (client.signedGet as jest.Mock).mockResolvedValue(mockWallet);
    (client.signedPost as jest.Mock)
      .mockResolvedValueOnce({}) // set-leverage
      .mockResolvedValueOnce(mockOrderResult) // order/create — succeeds
      .mockRejectedValueOnce(new BybitError(10001, "param error")); // trading-stop fails

    const result = await handlePlaceTrade(client, {
      symbol: "BTCUSDT", side: "Buy", marginUsdt: 10, leverage: 5, sl: 29000,
      trailingStop: 500, trailingActivatePrice: 31000,
    });

    expect(result.partialSuccess).toBe(true);
    expect(result.orderId).toBe("order123");
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

describe("handleClosePosition", () => {
  beforeEach(() => {
    instrumentsCache.set("BTCUSDT", mockInstrumentInfo);
  });

  it("sends market reduceOnly order for full position", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedGet as jest.Mock).mockResolvedValue(mockPositionList);
    (client.signedPost as jest.Mock).mockResolvedValue({ orderId: "close1", orderLinkId: "mcp-close" });

    await handleClosePosition(client, { symbol: "BTCUSDT", side: "Buy" });

    const call = (client.signedPost as jest.Mock).mock.calls[0];
    expect(call[1].reduceOnly).toBe(true);
    expect(parseFloat(call[1].qty)).toBeCloseTo(0.01, 3);
    expect(call[1].positionIdx).toBe(1);
    expect(call[1].side).toBe("Sell"); // closing a Buy position requires a Sell order
  });

  it("closes partial position at given percent", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedGet as jest.Mock).mockResolvedValue(mockPositionList);
    (client.signedPost as jest.Mock).mockResolvedValue({ orderId: "close2", orderLinkId: "mcp-close2" });

    await handleClosePosition(client, { symbol: "BTCUSDT", side: "Buy", percent: 50 });

    const call = (client.signedPost as jest.Mock).mock.calls[0];
    expect(parseFloat(call[1].qty)).toBeCloseTo(0.005, 3);
  });

  it("uses positionIdx=2 for Sell side", async () => {
    const shortPosition = {
      list: [{ ...mockPositionList.list[0], side: "Sell" as const, positionIdx: 2 as const }],
      category: "linear",
    };
    const client = new MockClient("k", "s", "u");
    (client.signedGet as jest.Mock).mockResolvedValue(shortPosition);
    (client.signedPost as jest.Mock).mockResolvedValue({ orderId: "close3", orderLinkId: "mcp-close3" });

    await handleClosePosition(client, { symbol: "BTCUSDT", side: "Sell" });

    const call = (client.signedPost as jest.Mock).mock.calls[0];
    expect(call[1].positionIdx).toBe(2);
    expect(call[1].side).toBe("Buy"); // closing a Sell position requires a Buy order
  });
});

describe("handleManagePosition", () => {
  it("calls trading-stop with correct fields", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedPost as jest.Mock).mockResolvedValue({});

    await handleManagePosition(client, {
      symbol: "BTCUSDT", side: "Buy",
      updates: { sl: 29500, tp: 33000 },
    });

    const call = (client.signedPost as jest.Mock).mock.calls[0];
    expect(call[0]).toBe("/v5/position/trading-stop");
    expect(call[1].stopLoss).toBe("29500");
    expect(call[1].takeProfit).toBe("33000");
    expect(call[1].positionIdx).toBe(1);
  });

  it("passes '0' string to cancel existing SL", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedPost as jest.Mock).mockResolvedValue({});

    await handleManagePosition(client, {
      symbol: "BTCUSDT", side: "Buy",
      updates: { sl: 0 },
    });

    const call = (client.signedPost as jest.Mock).mock.calls[0];
    expect(call[1].stopLoss).toBe("0");
  });
});
