import { handleGetAccountStatus } from "../tools/account";
import { BybitClient } from "../client";

jest.mock("../client");
const MockClient = BybitClient as jest.MockedClass<typeof BybitClient>;

const mockWalletBalance = {
  list: [{
    accountType: "UNIFIED",
    totalEquity: "500.00",
    totalMaintenanceMargin: "10.00",
    coin: [{
      coin: "USDT",
      walletBalance: "200.00",
      totalPositionIM: "50.00",
      unrealisedPnl: "5.00",
      equity: "205.00",
      locked: "0",
    }],
  }],
};

const mockPositions = {
  list: [{
    symbol: "BTCUSDT",
    side: "Buy" as const,
    size: "0.01",
    avgPrice: "30000",
    markPrice: "31000",
    unrealisedPnl: "10",
    stopLoss: "29000",
    takeProfit: "33000",
    trailingStop: "0",
    liquidationPrice: "25000",
    positionIdx: 1 as const,
    leverage: "10",
    positionIM: "30",
  }],
  category: "linear",
};

describe("handleGetAccountStatus", () => {
  it("computes freeCapital as walletBalance - totalPositionIM", async () => {
    const client = new MockClient("key", "secret", "url");
    (client.signedGet as jest.Mock)
      .mockResolvedValueOnce(mockWalletBalance)
      .mockResolvedValueOnce(mockPositions);

    const result = await handleGetAccountStatus(client);

    expect(result.freeCapital).toBe(150); // 200 - 50
    expect(result.marginInUse).toBe(50);
    expect(result.unrealisedPnl).toBe(5);
  });

  it("includes active positions only (size > 0)", async () => {
    const emptyPositions = {
      list: [{ ...mockPositions.list[0], size: "0" }],
      category: "linear",
    };
    const client = new MockClient("key", "secret", "url");
    (client.signedGet as jest.Mock)
      .mockResolvedValueOnce(mockWalletBalance)
      .mockResolvedValueOnce(emptyPositions);

    const result = await handleGetAccountStatus(client);
    expect(result.positions).toHaveLength(0);
  });

  it("computes uPnlPct relative to entry", async () => {
    const client = new MockClient("key", "secret", "url");
    (client.signedGet as jest.Mock)
      .mockResolvedValueOnce(mockWalletBalance)
      .mockResolvedValueOnce(mockPositions);

    const result = await handleGetAccountStatus(client);
    const pos = result.positions[0];
    // (31000-30000)/30000*100 = 3.333...
    expect(pos.uPnlPct).toBeCloseTo(3.33, 1);
  });
});
