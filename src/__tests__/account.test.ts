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

// BTC has a real usdValue above the dust threshold; DUST is below it and
// should be filtered; UNKNOWNVAL has no usdValue at all (unavailable, not
// dust) and must be retained even though we can't price it.
const mockWalletBalanceWithDust = {
  list: [{
    accountType: "UNIFIED",
    totalEquity: "500.00",
    totalMaintenanceMargin: "10.00",
    coin: [
      { coin: "USDT", walletBalance: "200.00", totalPositionIM: "50.00", unrealisedPnl: "5.00", equity: "205.00", locked: "0" },
      { coin: "BTC", walletBalance: "0.5", totalPositionIM: "0", unrealisedPnl: "0", equity: "0.5", locked: "0", usdValue: "25000" },
      { coin: "DUST", walletBalance: "0.0001", totalPositionIM: "0", unrealisedPnl: "0", equity: "0.0001", locked: "0", usdValue: "0.02" },
      { coin: "UNKNOWNVAL", walletBalance: "10", totalPositionIM: "0", unrealisedPnl: "0", equity: "10", locked: "0" },
    ],
  }],
};

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

  it("queries inverse positions without a settleCoin filter (inverse settles in base coin)", async () => {
    const client = new MockClient("key", "secret", "url");
    (client.signedGet as jest.Mock)
      .mockResolvedValueOnce(mockWalletBalance)
      .mockResolvedValueOnce(mockLinearPositions)
      .mockResolvedValueOnce(emptyPositions);

    await handleGetAccountStatus(client);

    const inverseCall = (client.signedGet as jest.Mock).mock.calls[2];
    expect(inverseCall[1]).toEqual({ category: "inverse" });
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

  it("returns accountInfo with uid and accountType when query-api succeeds", async () => {
    const client = new MockClient("key", "secret", "url");
    (client.signedGet as jest.Mock)
      .mockResolvedValueOnce(mockWalletBalance)    // wallet balance
      .mockResolvedValueOnce(emptyPositions)         // linear positions
      .mockResolvedValueOnce(emptyPositions)         // inverse positions
      .mockResolvedValueOnce({ uid: "12345678", accountType: "UNIFIED" }); // query-api (options slot uses Promise.resolve, no signedGet call)

    const result = await handleGetAccountStatus(client);

    expect(result.accountInfo).toBeDefined();
    expect(result.accountInfo!.uid).toBe("12345678");
    expect(result.accountInfo!.accountType).toBe("UNIFIED");
  });

  it("omits accountInfo when query-api resolves to an empty object", async () => {
    const client = new MockClient("key", "secret", "url");
    (client.signedGet as jest.Mock)
      .mockResolvedValueOnce(mockWalletBalance)
      .mockResolvedValueOnce(emptyPositions)
      .mockResolvedValueOnce(emptyPositions)
      .mockResolvedValueOnce({}); // query-api succeeded but returned no uid/accountType

    const result = await handleGetAccountStatus(client);

    expect(result.accountInfo).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(result, "accountInfo")).toBe(false);
  });

  it("filters dust spot holdings below the USD threshold and reports the count", async () => {
    const client = new MockClient("key", "secret", "url");
    (client.signedGet as jest.Mock)
      .mockResolvedValueOnce(mockWalletBalanceWithDust)
      .mockResolvedValueOnce(mockLinearPositions)
      .mockResolvedValueOnce(emptyPositions);

    const result = await handleGetAccountStatus(client);

    const coins = result.spot_holdings.map((h) => h.coin);
    expect(coins).not.toContain("DUST");
    expect(coins).toContain("BTC");
    expect(result.spotDustFiltered).toBe(1);
  });

  it("retains a spot holding with unavailable usdValue even though it's small", async () => {
    const client = new MockClient("key", "secret", "url");
    (client.signedGet as jest.Mock)
      .mockResolvedValueOnce(mockWalletBalanceWithDust)
      .mockResolvedValueOnce(mockLinearPositions)
      .mockResolvedValueOnce(emptyPositions);

    const result = await handleGetAccountStatus(client);

    const unknown = result.spot_holdings.find((h) => h.coin === "UNKNOWNVAL");
    expect(unknown).toBeDefined();
    expect(unknown!.usdValueAvailable).toBe(false);
  });

  it("omits spotDustFiltered when nothing was filtered", async () => {
    const client = new MockClient("key", "secret", "url");
    (client.signedGet as jest.Mock)
      .mockResolvedValueOnce(mockWalletBalance)
      .mockResolvedValueOnce(mockLinearPositions)
      .mockResolvedValueOnce(emptyPositions);

    const result = await handleGetAccountStatus(client);

    expect(result.spotDustFiltered).toBeUndefined();
  });

  // One unparseable option symbol must never take down the whole account
  // snapshot — the operator would lose visibility of every position.
  it("survives an unparseable option symbol and keeps the other positions", async () => {
    const optionPositions = {
      list: [
        { symbol: "BTC-25APR28-80000-C-USDT", side: "Buy" as const, size: "1", avgPrice: "1000", markPrice: "1100" },
        { symbol: "BTC-WEIRD-FORMAT", side: "Buy" as const, size: "2", avgPrice: "500", markPrice: "550" },
      ],
    };
    const client = new MockClient("key", "secret", "url");
    (client.signedGet as jest.Mock)
      .mockResolvedValueOnce(mockWalletBalance)
      .mockResolvedValueOnce(mockLinearPositions)
      .mockResolvedValueOnce(emptyPositions)
      .mockResolvedValueOnce(optionPositions)
      .mockResolvedValueOnce({ uid: "12345678", accountType: "UNIFIED" });

    const result = await handleGetAccountStatus(client, true);

    expect(result.positions).toHaveLength(1);
    expect(result.option_positions).toHaveLength(1);
    expect(result.option_positions[0].symbol).toBe("BTC-25APR28-80000-C-USDT");
  });
});
