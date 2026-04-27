import {
  handlePlaceOptionTrade, PlaceOptionTradeResult, OptionDryRunResult,
  handleCloseOptionPosition, CloseOptionResult, OptionCloseDryRunResult,
} from "../../tools/options/trade";
import { BybitClient } from "../../client";

jest.mock("../../client");
const MockClient = BybitClient as jest.MockedClass<typeof BybitClient>;

const MONTH_ABBR = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
function futureExpiry(daysFromNow: number): string {
  const d = new Date(Date.now() + daysFromNow * 86400000);
  return `${String(d.getUTCDate()).padStart(2,"0")}${MONTH_ABBR[d.getUTCMonth()]}${String(d.getUTCFullYear()).slice(-2)}`;
}

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

  it("7b. ETH multiplier=1: insufficient USDC check uses correct premium (not 10x wrong)", async () => {
    const ETH_SYMBOL = `ETH-${futureExpiry(365)}-2400-C-USDT`;
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValueOnce({
      list: [{ symbol: ETH_SYMBOL, bid1Price: "44", ask1Price: "45", markPrice: "44.5",
               markIv: "0.8", delta: "0.45", gamma: "0.01", theta: "-1", vega: "10",
               underlyingPrice: "2400" }],
    });
    (client.signedGet as jest.Mock).mockResolvedValueOnce({
      list: [{ coin: [{ coin: "USDC", walletBalance: "9.94" }] }], // enough for 0.1 ETH but not 1 ETH
    });

    // With multiplier=1: estimatedPremium = 1 × 45 × 1 = 45 USDC > 9.94 → should throw
    await expect(
      handlePlaceOptionTrade(client, { symbol: ETH_SYMBOL, side: "Buy", qty: 1, orderType: "Market" })
    ).rejects.toThrow("Insufficient USDC: need 45");
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

const CLOSE_SYMBOL = "BTC-25APR28-80000-C-USDT";

const mockLongPosition = {
  list: [{
    symbol: CLOSE_SYMBOL,
    side: "Buy" as const,
    size: "2",
    avgPrice: "1000",
  }],
};

const mockShortPosition = {
  list: [{
    symbol: CLOSE_SYMBOL,
    side: "Sell" as const,
    size: "1",
    avgPrice: "1000",
    markPrice: "900",
  }],
};

const mockCloseOrderResult = { orderId: "close-order-1", orderLinkId: "mcp-close-abc" };

describe("handleCloseOptionPosition", () => {
  it("11. throws when no open position found", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedGet as jest.Mock).mockResolvedValueOnce({ list: [] });

    await expect(
      handleCloseOptionPosition(client, {
        symbol: CLOSE_SYMBOL,
        orderType: "Market",
      })
    ).rejects.toThrow(`No open option position found for ${CLOSE_SYMBOL}`);
  });

  it("11b. throws when only side:'None' positions found (filtered as no open position)", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedGet as jest.Mock).mockResolvedValueOnce({
      list: [{ symbol: CLOSE_SYMBOL, side: "None", size: "0", avgPrice: "0" }],
    });

    await expect(
      handleCloseOptionPosition(client, {
        symbol: CLOSE_SYMBOL,
        orderType: "Market",
      })
    ).rejects.toThrow(`No open option position found for ${CLOSE_SYMBOL}`);
  });

  it("12. close qty exceeding position size throws", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedGet as jest.Mock).mockResolvedValueOnce(mockLongPosition); // size=2

    await expect(
      handleCloseOptionPosition(client, {
        symbol: CLOSE_SYMBOL,
        qty: 5, // exceeds position size of 2
        orderType: "Market",
      })
    ).rejects.toThrow("Close qty 5 exceeds position size 2");
  });

  it("13. dry_run=true returns OptionCloseDryRunResult with correct estimatedPnl for long and serverTimestamp", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedGet as jest.Mock).mockResolvedValueOnce(mockLongPosition);
    (client.publicGet as jest.Mock).mockResolvedValueOnce(mockTicker); // bid=1100, ask=1200

    const result = await handleCloseOptionPosition(client, {
      symbol: CLOSE_SYMBOL,
      orderType: "Market",
      dry_run: true,
    });

    expect(result.dryRun).toBe(true);
    // Long closes at bid (1100). entryPremium = 1000×2×1 = 2000. estimatedPremium = 1100×2×1 = 2200.
    // estimatedPnl = 2200 − 2000 = 200
    expect((result as OptionCloseDryRunResult).estimatedPnl).toBe(200);
    expect(result.serverTimestamp).toBeDefined();
  });

  it("14. dry_run=true returns correct estimatedPnl for short", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedGet as jest.Mock).mockResolvedValueOnce(mockShortPosition);
    (client.publicGet as jest.Mock).mockResolvedValueOnce(mockTicker); // bid=1100, ask=1200

    const result = await handleCloseOptionPosition(client, {
      symbol: CLOSE_SYMBOL,
      orderType: "Market",
      dry_run: true,
    });

    expect(result.dryRun).toBe(true);
    // Short closes at ask (1200). entryPremium = 1000×1×1 = 1000. estimatedPremium = 1200×1×1 = 1200.
    // estimatedPnl = 1000 − 1200 = −200
    expect((result as OptionCloseDryRunResult).estimatedPnl).toBe(-200);
  });

  it("15. close qty defaults to full position size when qty not provided", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedGet as jest.Mock).mockResolvedValueOnce(mockLongPosition); // size=2
    (client.publicGet as jest.Mock).mockResolvedValueOnce(mockTicker);
    (client.signedPost as jest.Mock).mockResolvedValueOnce(mockCloseOrderResult);

    const result = await handleCloseOptionPosition(client, {
      symbol: CLOSE_SYMBOL,
      orderType: "Market",
    });

    expect((result as CloseOptionResult).closedQty).toBe(2);
    expect((result as CloseOptionResult).remainingQty).toBe(0);
  });

  it("16. live close submits with reduceOnly: true and opposite side", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedGet as jest.Mock).mockResolvedValueOnce(mockLongPosition); // Long → close with Sell
    (client.publicGet as jest.Mock).mockResolvedValueOnce(mockTicker);
    (client.signedPost as jest.Mock).mockResolvedValueOnce(mockCloseOrderResult);

    await handleCloseOptionPosition(client, {
      symbol: CLOSE_SYMBOL,
      orderType: "Market",
    });

    const body = (client.signedPost as jest.Mock).mock.calls[0][1];
    expect(body.reduceOnly).toBe(true);
    expect(body.side).toBe("Sell"); // Long position → Sell to close
  });

  it("17. remainingQty computed correctly for partial close", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedGet as jest.Mock).mockResolvedValueOnce(mockLongPosition); // size=2
    (client.publicGet as jest.Mock).mockResolvedValueOnce(mockTicker);
    (client.signedPost as jest.Mock).mockResolvedValueOnce(mockCloseOrderResult);

    const result = await handleCloseOptionPosition(client, {
      symbol: CLOSE_SYMBOL,
      qty: 1,
      orderType: "Market",
    });

    expect((result as CloseOptionResult).closedQty).toBe(1);
    expect((result as CloseOptionResult).remainingQty).toBe(1);
  });
});
