import { handlePlaceSpot, handleCloseSpot } from "../tools/trade-spot";
import { BybitClient } from "../client";

jest.mock("../client");
jest.mock("../tools/trade-shared");

import { ensureInstrumentInfo } from "../tools/trade-shared";
const mockEnsure = ensureInstrumentInfo as jest.Mock;

const MockClient = BybitClient as jest.MockedClass<typeof BybitClient>;
const mockInst = { tickSize: "0.01", qtyStep: "0.000001", minNotionalValue: "1" };
const mockTicker = { list: [{ lastPrice: "30000", turnover24h: "50000000" }] };
const mockWalletUsdt = {
  list: [{
    accountType: "UNIFIED", totalEquity: "200", totalMaintenanceMargin: "0",
    coin: [{ coin: "USDT", walletBalance: "200", totalPositionIM: "0", unrealisedPnl: "0", equity: "200", locked: "0" }],
  }],
};
const mockOrderResult = { orderId: "spot-order-1", orderLinkId: "mcp-spot-abc" };

describe("handlePlaceSpot", () => {
  beforeEach(() => {
    mockEnsure.mockResolvedValue(mockInst);
  });

  it("computes qty = floor(margin / price, qtyStep)", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValue(mockTicker);
    (client.signedGet as jest.Mock).mockResolvedValue(mockWalletUsdt);
    (client.signedPost as jest.Mock).mockResolvedValue(mockOrderResult);

    await handlePlaceSpot(client, { symbol: "BTCUSDT", side: "Buy", margin: 300, category: "spot" });

    const call = (client.signedPost as jest.Mock).mock.calls[0];
    // qty = 300 / 30000 = 0.01
    expect(parseFloat(call[1].qty)).toBeCloseTo(0.01, 5);
  });

  it("sets marketUnit=baseCoin for market buy orders", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValue(mockTicker);
    (client.signedGet as jest.Mock).mockResolvedValue(mockWalletUsdt);
    (client.signedPost as jest.Mock).mockResolvedValue(mockOrderResult);

    await handlePlaceSpot(client, { symbol: "BTCUSDT", side: "Buy", margin: 300, category: "spot" });

    const call = (client.signedPost as jest.Mock).mock.calls[0];
    expect(call[1].marketUnit).toBe("baseCoin");
  });

  it("does not set marketUnit for market sell orders", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValue(mockTicker);
    (client.signedGet as jest.Mock).mockResolvedValue(mockWalletUsdt);
    (client.signedPost as jest.Mock).mockResolvedValue(mockOrderResult);

    await handlePlaceSpot(client, { symbol: "BTCUSDT", side: "Sell", margin: 300, category: "spot" });

    const call = (client.signedPost as jest.Mock).mock.calls[0];
    expect(call[1].marketUnit).toBeUndefined();
  });

  it("sets isLeverage=1 for spot_margin", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValue(mockTicker);
    (client.signedGet as jest.Mock).mockResolvedValue(mockWalletUsdt);
    (client.signedPost as jest.Mock).mockResolvedValue(mockOrderResult);

    await handlePlaceSpot(client, { symbol: "BTCUSDT", side: "Buy", margin: 300, category: "spot_margin" });

    const call = (client.signedPost as jest.Mock).mock.calls[0];
    expect(call[1].isLeverage).toBe(1);
  });

  it("does not set isLeverage for plain spot", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValue(mockTicker);
    (client.signedGet as jest.Mock).mockResolvedValue(mockWalletUsdt);
    (client.signedPost as jest.Mock).mockResolvedValue(mockOrderResult);

    await handlePlaceSpot(client, { symbol: "BTCUSDT", side: "Buy", margin: 300, category: "spot" });

    const call = (client.signedPost as jest.Mock).mock.calls[0];
    expect(call[1].isLeverage).toBeUndefined();
  });

  it("uses limit price for qty calculation and sends price in body", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValue(mockTicker);
    (client.signedGet as jest.Mock).mockResolvedValue(mockWalletUsdt);
    (client.signedPost as jest.Mock).mockResolvedValue(mockOrderResult);

    await handlePlaceSpot(client, { symbol: "BTCUSDT", side: "Buy", margin: 300, category: "spot", orderType: "Limit", price: 29000 });

    const call = (client.signedPost as jest.Mock).mock.calls[0];
    expect(call[1].orderType).toBe("Limit");
    expect(call[1].price).toBe("29000");
    // qty = floor(300 / 29000, 0.000001) = 0.010344
    expect(parseFloat(call[1].qty)).toBeCloseTo(0.01034, 4);
  });

  it("returns DryRunResult without submitting when dry_run=true", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValue(mockTicker);
    (client.signedGet as jest.Mock).mockResolvedValue(mockWalletUsdt);

    const result = await handlePlaceSpot(client, { symbol: "BTCUSDT", side: "Buy", margin: 300, category: "spot", dry_run: true });

    expect((result as any).dryRun).toBe(true);
    expect(client.signedPost).not.toHaveBeenCalled();
  });

  it("throws when sl is provided for spot", async () => {
    const client = new MockClient("k", "s", "u");
    await expect(
      handlePlaceSpot(client, { symbol: "BTCUSDT", side: "Buy", margin: 300, category: "spot", sl: 29000 } as any)
    ).rejects.toMatchObject({ message: expect.stringContaining("not supported for spot") });
  });

  it("throws when Limit order has no price", async () => {
    const client = new MockClient("k", "s", "u");
    await expect(
      handlePlaceSpot(client, { symbol: "BTCUSDT", side: "Buy", margin: 300, category: "spot", orderType: "Limit" })
    ).rejects.toMatchObject({ message: expect.stringContaining("price is required") });
  });
});

const mockBtcWallet = {
  list: [{
    accountType: "UNIFIED", totalEquity: "1", totalMaintenanceMargin: "0",
    coin: [{ coin: "BTC", walletBalance: "0.5", totalPositionIM: "0", unrealisedPnl: "0", equity: "0.5", locked: "0" }],
  }],
};

describe("handleCloseSpot", () => {
  beforeEach(() => {
    mockEnsure.mockResolvedValue(mockInst);
  });

  it("fetches base coin balance (BTCUSDT → BTC) and sells full amount", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedGet as jest.Mock).mockResolvedValue(mockBtcWallet);
    (client.signedPost as jest.Mock).mockResolvedValue(mockOrderResult);

    const result = await handleCloseSpot(client, { symbol: "BTCUSDT" });

    const getCall = (client.signedGet as jest.Mock).mock.calls[0];
    expect(getCall[1].coin).toBe("BTC");
    const postCall = (client.signedPost as jest.Mock).mock.calls[0];
    expect(postCall[1].side).toBe("Sell");
    expect(postCall[1].category).toBe("spot");
    expect(result.closedQty).toBe("0.500000");
  });

  it("closes partial amount via percent", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedGet as jest.Mock).mockResolvedValue(mockBtcWallet);
    (client.signedPost as jest.Mock).mockResolvedValue(mockOrderResult);

    const result = await handleCloseSpot(client, { symbol: "BTCUSDT", percent: 50 });

    expect(parseFloat(result.closedQty)).toBeCloseTo(0.25, 5);
  });

  it("uses explicit qty when provided", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedGet as jest.Mock).mockResolvedValue(mockBtcWallet);
    (client.signedPost as jest.Mock).mockResolvedValue(mockOrderResult);

    const result = await handleCloseSpot(client, { symbol: "BTCUSDT", qty: 0.1 });

    expect(parseFloat(result.closedQty)).toBeCloseTo(0.1, 5);
  });

  it("throws when explicit qty exceeds available balance", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedGet as jest.Mock).mockResolvedValue(mockBtcWallet);

    await expect(
      handleCloseSpot(client, { symbol: "BTCUSDT", qty: 1.0 })
    ).rejects.toMatchObject({ message: expect.stringContaining("exceeds available") });
  });

  it("throws when no balance found", async () => {
    const emptyWallet = {
      list: [{
        accountType: "UNIFIED", totalEquity: "0", totalMaintenanceMargin: "0",
        coin: [{ coin: "BTC", walletBalance: "0", totalPositionIM: "0", unrealisedPnl: "0", equity: "0", locked: "0" }],
      }],
    };
    const client = new MockClient("k", "s", "u");
    (client.signedGet as jest.Mock).mockResolvedValue(emptyWallet);

    await expect(
      handleCloseSpot(client, { symbol: "BTCUSDT" })
    ).rejects.toMatchObject({ message: expect.stringContaining("No BTC balance") });
  });
});
