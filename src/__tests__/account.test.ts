import { handleGetAccountStatus } from "../tools/account";
import { BybitClient } from "../client";

jest.mock("../client");
const MockClient = BybitClient as jest.MockedClass<typeof BybitClient>;

const mockWalletBalance = {
  list: [{
    accountType: "UNIFIED",
    totalEquity: "500.00",
    totalMaintenanceMargin: "10.00",
    coin: [
      { coin: "USDT", walletBalance: "200.00", totalPositionIM: "50.00", unrealisedPnl: "5.00", equity: "205.00", locked: "0" },
      { coin: "BTC", walletBalance: "0.5", totalPositionIM: "0", unrealisedPnl: "0", equity: "0.5", locked: "0" },
      { coin: "ETH", walletBalance: "0", totalPositionIM: "0", unrealisedPnl: "0", equity: "0", locked: "0" },
    ],
  }],
};

const mockLinearPositions = {
  list: [{
    symbol: "BTCUSDT", side: "Buy" as const, size: "0.01", avgPrice: "30000",
    markPrice: "31000", unrealisedPnl: "10", stopLoss: "29000", takeProfit: "33000",
    trailingStop: "0", liquidationPrice: "25000", positionIdx: 1 as const, leverage: "10", positionIM: "30",
  }],
  category: "linear",
};

const mockInversePositions = {
  list: [{
    symbol: "BTCUSD", side: "Sell" as const, size: "1000", avgPrice: "30000",
    markPrice: "29500", unrealisedPnl: "1.67", stopLoss: "31000", takeProfit: "28000",
    trailingStop: "0", liquidationPrice: "45000", positionIdx: 2 as const, leverage: "10", positionIM: "0.1",
  }],
  category: "inverse",
};

const emptyPositions = { list: [], category: "inverse" };

describe("handleGetAccountStatus", () => {
  it("computes freeCapital as walletBalance - totalPositionIM", async () => {
    const client = new MockClient("key", "secret", "url");
    (client.signedGet as jest.Mock)
      .mockResolvedValueOnce(mockWalletBalance)
      .mockResolvedValueOnce(mockLinearPositions)
      .mockResolvedValueOnce(emptyPositions);

    const result = await handleGetAccountStatus(client);

    expect(result.freeCapital).toBe(150);
    expect(result.marginInUse).toBe(50);
    expect(result.unrealisedPnl).toBe(5);
  });

  it("returns inverse_positions when inverse positions are open", async () => {
    const client = new MockClient("key", "secret", "url");
    (client.signedGet as jest.Mock)
      .mockResolvedValueOnce(mockWalletBalance)
      .mockResolvedValueOnce(mockLinearPositions)
      .mockResolvedValueOnce(mockInversePositions);

    const result = await handleGetAccountStatus(client);

    expect(result.inverse_positions).toHaveLength(1);
    expect(result.inverse_positions[0].symbol).toBe("BTCUSD");
    expect(result.inverse_positions[0].side).toBe("SHORT");
  });

  it("always returns inverse_positions as array (empty if none)", async () => {
    const client = new MockClient("key", "secret", "url");
    (client.signedGet as jest.Mock)
      .mockResolvedValueOnce(mockWalletBalance)
      .mockResolvedValueOnce(mockLinearPositions)
      .mockResolvedValueOnce(emptyPositions);

    const result = await handleGetAccountStatus(client);

    expect(Array.isArray(result.inverse_positions)).toBe(true);
    expect(result.inverse_positions).toHaveLength(0);
  });

  it("returns spot_holdings for non-zero non-USDT coin balances", async () => {
    const client = new MockClient("key", "secret", "url");
    (client.signedGet as jest.Mock)
      .mockResolvedValueOnce(mockWalletBalance)
      .mockResolvedValueOnce(mockLinearPositions)
      .mockResolvedValueOnce(emptyPositions);

    const result = await handleGetAccountStatus(client);

    expect(result.spot_holdings).toHaveLength(1); // BTC only (ETH has 0 balance)
    expect(result.spot_holdings[0].coin).toBe("BTC");
    expect(result.spot_holdings[0].balance).toBe("0.5");
  });

  it("excludes USDT from spot_holdings", async () => {
    const client = new MockClient("key", "secret", "url");
    (client.signedGet as jest.Mock)
      .mockResolvedValueOnce(mockWalletBalance)
      .mockResolvedValueOnce(mockLinearPositions)
      .mockResolvedValueOnce(emptyPositions);

    const result = await handleGetAccountStatus(client);

    expect(result.spot_holdings.find((h: any) => h.coin === "USDT")).toBeUndefined();
  });

  it("existing positions field still contains only linear positions", async () => {
    const client = new MockClient("key", "secret", "url");
    (client.signedGet as jest.Mock)
      .mockResolvedValueOnce(mockWalletBalance)
      .mockResolvedValueOnce(mockLinearPositions)
      .mockResolvedValueOnce(mockInversePositions);

    const result = await handleGetAccountStatus(client);

    expect(result.positions).toHaveLength(1);
    expect(result.positions[0].symbol).toBe("BTCUSDT");
  });
});
