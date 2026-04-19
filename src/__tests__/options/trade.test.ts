import { handlePlaceOptionTrade, PlaceOptionTradeResult, OptionDryRunResult } from "../../tools/options/trade";
import { BybitClient } from "../../client";

jest.mock("../../client");
const MockClient = BybitClient as jest.MockedClass<typeof BybitClient>;

// BTC-25APR28-80000-C-USDT: expires April 2028 — never expires during test runs
const SYMBOL = "BTC-25APR28-80000-C-USDT";

const mockTicker = {
  list: [{
    symbol: SYMBOL,
    bid1Price: "1100",
    ask1Price: "1200",
    markPrice: "1150",
    markIv: "0.65",
    delta: "0.45",
    gamma: "0.000012",
    theta: "-48.5",
    vega: "115",
    underlyingPrice: "95000",
  }],
};

const mockWallet = {
  list: [{
    coin: [
      { coin: "USDC", walletBalance: "50000" },
      { coin: "USDT", walletBalance: "10000" },
    ],
  }],
};

const mockOrderResult = { orderId: "opt-order-1", orderLinkId: "mcp-123-abc" };

afterEach(() => {
  delete process.env.OPTIONS_ALLOW_NAKED_SHORT;
  delete process.env.OPTIONS_MAX_PREMIUM_PCT_BALANCE;
});

describe("handlePlaceOptionTrade", () => {
  it("1. dry_run=true returns OptionDryRunResult with dryRun: true, correct estimatedPremium, and serverTimestamp", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValueOnce(mockTicker);
    (client.signedGet as jest.Mock).mockResolvedValueOnce(mockWallet);

    const result = await handlePlaceOptionTrade(client, {
      symbol: SYMBOL,
      side: "Buy",
      qty: 1,
      orderType: "Market",
      dry_run: true,
    });

    expect(result.dryRun).toBe(true);
    // estimatedPremium = qty(1) × ask(1200) × multiplier(1, BTC) = 1200
    expect((result as OptionDryRunResult).estimatedPremium).toBe(1200);
    expect(result.serverTimestamp).toBeDefined();
  });

  it("2. expired contract throws", async () => {
    const client = new MockClient("k", "s", "u");

    await expect(
      handlePlaceOptionTrade(client, {
        symbol: "BTC-25APR24-80000-C-USDT", // April 2024 — always expired
        side: "Buy",
        qty: 1,
        orderType: "Market",
      })
    ).rejects.toThrow("Contract BTC-25APR24-80000-C-USDT has expired");
  });

  it("3. naked short throws when OPTIONS_ALLOW_NAKED_SHORT not set and no existing long", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValueOnce(mockTicker);
    (client.signedGet as jest.Mock).mockResolvedValueOnce({ list: [] }); // no existing long

    await expect(
      handlePlaceOptionTrade(client, {
        symbol: SYMBOL,
        side: "Sell",
        qty: 1,
        orderType: "Market",
      })
    ).rejects.toThrow("Naked short options are disabled by default.");
  });

  it("4. partial naked short throws when selling more contracts than existing long qty", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValueOnce(mockTicker);
    (client.signedGet as jest.Mock).mockResolvedValueOnce({
      list: [{ symbol: SYMBOL, side: "Buy", size: "1", avgPrice: "1000" }], // only 1 long
    });

    await expect(
      handlePlaceOptionTrade(client, {
        symbol: SYMBOL,
        side: "Sell",
        qty: 2, // trying to sell 2 when only 1 long exists
        orderType: "Market",
      })
    ).rejects.toThrow("Naked short options are disabled by default.");
  });

  it("5. naked short succeeds when OPTIONS_ALLOW_NAKED_SHORT=true", async () => {
    process.env.OPTIONS_ALLOW_NAKED_SHORT = "true";
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValueOnce(mockTicker);
    // No position check when flag is set
    (client.signedPost as jest.Mock).mockResolvedValueOnce(mockOrderResult);

    const result = await handlePlaceOptionTrade(client, {
      symbol: SYMBOL,
      side: "Sell",
      qty: 1,
      orderType: "Market",
    });

    expect((result as PlaceOptionTradeResult).orderId).toBe("opt-order-1");
  });

  it("6. naked short succeeds when existing long qty covers sell qty", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValueOnce(mockTicker);
    (client.signedGet as jest.Mock).mockResolvedValueOnce({
      list: [{ symbol: SYMBOL, side: "Buy", size: "2", avgPrice: "1000" }], // 2 longs
    });
    (client.signedPost as jest.Mock).mockResolvedValueOnce(mockOrderResult);

    const result = await handlePlaceOptionTrade(client, {
      symbol: SYMBOL,
      side: "Sell",
      qty: 2, // exactly covered by 2 existing longs
      orderType: "Market",
    });

    expect((result as PlaceOptionTradeResult).orderId).toBe("opt-order-1");
  });

  it("7. insufficient USDC throws correct message", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValueOnce(mockTicker);
    (client.signedGet as jest.Mock).mockResolvedValueOnce({
      list: [{ coin: [{ coin: "USDC", walletBalance: "100" }] }], // only 100 USDC
    });

    await expect(
      handlePlaceOptionTrade(client, {
        symbol: SYMBOL,
        side: "Buy",
        qty: 1, // needs 1200 USDC
        orderType: "Market",
      })
    ).rejects.toThrow("Insufficient USDC");
  });

  it("8. premium cap exceeded throws correct message", async () => {
    process.env.OPTIONS_MAX_PREMIUM_PCT_BALANCE = "5"; // 5% of 50000 = 2500 cap
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValueOnce(mockTicker);
    (client.signedGet as jest.Mock).mockResolvedValueOnce(mockWallet); // 50000 USDC

    await expect(
      handlePlaceOptionTrade(client, {
        symbol: SYMBOL,
        side: "Buy",
        qty: 3, // 3 × 1200 = 3600 > 2500 cap
        orderType: "Market",
      })
    ).rejects.toThrow("Premium 3600 USDC exceeds 5%");
  });

  it("9. live place submits POST /v5/order/create with category: 'option'", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValueOnce(mockTicker);
    (client.signedGet as jest.Mock).mockResolvedValueOnce(mockWallet);
    (client.signedPost as jest.Mock).mockResolvedValueOnce(mockOrderResult);

    await handlePlaceOptionTrade(client, {
      symbol: SYMBOL,
      side: "Buy",
      qty: 1,
      orderType: "Market",
    });

    expect((client.signedPost as jest.Mock).mock.calls[0][1]).toMatchObject({
      category: "option",
      symbol: SYMBOL,
      side: "Buy",
    });
  });

  it("10. limit order without price throws", async () => {
    const client = new MockClient("k", "s", "u");

    await expect(
      handlePlaceOptionTrade(client, {
        symbol: SYMBOL,
        side: "Buy",
        qty: 1,
        orderType: "Limit",
        // no price
      })
    ).rejects.toThrow("price is required for Limit orders");
  });
});
