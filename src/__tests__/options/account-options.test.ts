import { handleGetAccountStatus } from "../../tools/account";
import { BybitClient } from "../../client";

jest.mock("../../client");
const MockClient = BybitClient as jest.MockedClass<typeof BybitClient>;

const mockWalletBalance = {
  list: [{
    accountType: "UNIFIED",
    totalEquity: "500.00",
    totalMaintenanceMargin: "10.00",
    coin: [
      { coin: "USDT", walletBalance: "200.00", totalPositionIM: "50.00", unrealisedPnl: "5.00", equity: "205.00", locked: "0" },
    ],
  }],
};

const emptyPositions = { list: [], category: "linear" };

const mockLongCallPos = {
  list: [{
    symbol: "BTC-25APR28-80000-C-USDT",
    side: "Buy",
    size: "2",
    avgPrice: "1000",
    markPrice: "1200",
    delta: "0.45",
    gamma: "0.000012",
    theta: "-48.5",
    vega: "115",
  }],
};

describe("handleGetAccountStatus — option_positions", () => {
  it("18. includeOptions=false makes exactly 3 signedGet calls (no option fetch)", async () => {
    const client = new MockClient("key", "secret", "url");
    (client.signedGet as jest.Mock)
      .mockResolvedValueOnce(mockWalletBalance)
      .mockResolvedValueOnce(emptyPositions)
      .mockResolvedValueOnce(emptyPositions);

    await handleGetAccountStatus(client, false);

    expect((client.signedGet as jest.Mock).mock.calls).toHaveLength(3);
  });

  it("19. includeOptions=true makes 4 signedGet calls and includes option positions", async () => {
    const client = new MockClient("key", "secret", "url");
    (client.signedGet as jest.Mock)
      .mockResolvedValueOnce(mockWalletBalance)
      .mockResolvedValueOnce(emptyPositions)
      .mockResolvedValueOnce(emptyPositions)
      .mockResolvedValueOnce(mockLongCallPos);

    const result = await handleGetAccountStatus(client, true);

    expect((client.signedGet as jest.Mock).mock.calls).toHaveLength(4);
    expect(result.option_positions).toHaveLength(1);
  });

  it("20. option_positions is empty array (not omitted) when no positions", async () => {
    const client = new MockClient("key", "secret", "url");
    (client.signedGet as jest.Mock)
      .mockResolvedValueOnce(mockWalletBalance)
      .mockResolvedValueOnce(emptyPositions)
      .mockResolvedValueOnce(emptyPositions)
      .mockResolvedValueOnce({ list: [] });

    const result = await handleGetAccountStatus(client, true);

    expect(Array.isArray(result.option_positions)).toBe(true);
    expect(result.option_positions).toHaveLength(0);
  });

  it("21. OptionPosition fields computed correctly: premiumFlow, currentValue, unrealisedPnl, breakeven, realisedPnl, totalPnl for long call", async () => {
    const client = new MockClient("key", "secret", "url");
    const mockLongCallWithRealised = {
      list: [{ ...mockLongCallPos.list[0], cumRealisedPnl: "-0.70" }],
    };
    (client.signedGet as jest.Mock)
      .mockResolvedValueOnce(mockWalletBalance)
      .mockResolvedValueOnce(emptyPositions)
      .mockResolvedValueOnce(emptyPositions)
      .mockResolvedValueOnce(mockLongCallWithRealised);

    const result = await handleGetAccountStatus(client, true);
    const pos = result.option_positions[0];

    // Long call: BTC multiplier=1, qty=2, entryPrice=1000, markPrice=1200
    // premiumFlow = 1000 × 2 × 1 = 2000 (positive = outflow)
    expect(pos.premiumFlow).toBe(2000);
    // currentValue = 1200 × 2 × 1 = 2400
    expect(pos.currentValue).toBe(2400);
    // unrealisedPnl = currentValue − premiumFlow = 2400 − 2000 = 400
    expect(pos.unrealisedPnl).toBe(400);
    // breakeven = 80000 + |2000| / (2 × 1) = 80000 + 1000 = 81000
    expect(pos.breakeven).toBe(81000);
    // realisedPnl from cumRealisedPnl
    expect(pos.realisedPnl).toBe(-0.70);
    // totalPnl = unrealisedPnl + realisedPnl = 400 + (-0.70) = 399.30
    expect(pos.totalPnl).toBeCloseTo(399.30);
  });

  it("21b. realisedPnl defaults to 0 when cumRealisedPnl absent", async () => {
    const client = new MockClient("key", "secret", "url");
    (client.signedGet as jest.Mock)
      .mockResolvedValueOnce(mockWalletBalance)
      .mockResolvedValueOnce(emptyPositions)
      .mockResolvedValueOnce(emptyPositions)
      .mockResolvedValueOnce(mockLongCallPos);

    const result = await handleGetAccountStatus(client, true);
    const pos = result.option_positions[0];

    expect(pos.realisedPnl).toBe(0);
    expect(pos.totalPnl).toBe(pos.unrealisedPnl);
  });

  it("22. premiumFlow is negative for short positions (credit received)", async () => {
    const client = new MockClient("key", "secret", "url");
    const mockShortCallPos = {
      list: [{
        symbol: "BTC-25APR28-80000-C-USDT",
        side: "Sell",
        size: "1",
        avgPrice: "1000",
        markPrice: "900",
        delta: "-0.45",
        gamma: "0.000012",
        theta: "48.5",
        vega: "115",
      }],
    };
    (client.signedGet as jest.Mock)
      .mockResolvedValueOnce(mockWalletBalance)
      .mockResolvedValueOnce(emptyPositions)
      .mockResolvedValueOnce(emptyPositions)
      .mockResolvedValueOnce(mockShortCallPos);

    const result = await handleGetAccountStatus(client, true);

    // Short: premiumFlow = -(1000 × 1 × 1) = −1000
    expect(result.option_positions[0].premiumFlow).toBe(-1000);
  });

  it("23. breakeven computed correctly for long put", async () => {
    const client = new MockClient("key", "secret", "url");
    const mockPutPos = {
      list: [{
        symbol: "BTC-25APR28-80000-P-USDT",
        side: "Buy",
        size: "1",
        avgPrice: "500",
        markPrice: "600",
        delta: "-0.45",
        gamma: "0.000012",
        theta: "-48.5",
        vega: "115",
      }],
    };
    (client.signedGet as jest.Mock)
      .mockResolvedValueOnce(mockWalletBalance)
      .mockResolvedValueOnce(emptyPositions)
      .mockResolvedValueOnce(emptyPositions)
      .mockResolvedValueOnce(mockPutPos);

    const result = await handleGetAccountStatus(client, true);

    // Long put: premiumFlow = 500 × 1 × 1 = 500
    // breakeven = 80000 − |500| / (1 × 1) = 79500
    expect(result.option_positions[0].breakeven).toBe(79500);
  });
});
