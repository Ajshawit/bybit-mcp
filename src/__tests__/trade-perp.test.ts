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

import { ensureInstrumentInfo, detectPositionIdx, fetchFillSnapshot } from "../tools/trade-shared";
const mockEnsure = ensureInstrumentInfo as jest.Mock;
const mockDetect = detectPositionIdx as jest.Mock;
const mockFetchFill = fetchFillSnapshot as jest.Mock;

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
    mockFetchFill.mockResolvedValue({ avgFillPrice: 30000, fillStatus: "Filled", cumExecQty: "0.01" });
    positionModeCache["store"].clear();
  });

  it("computes linear qty = floor(margin * leverage / price, qtyStep)", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValue(mockTicker);
    (client.signedGet as jest.Mock).mockResolvedValue(mockWalletUsdt);
    (client.signedPost as jest.Mock)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(mockOrderResult);

    await handlePlacePerp(client, { symbol: "BTCUSDT", side: "Buy", margin: 30, leverage: 10, sl: 29000, confirm: "CONFIRM" });

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

    await handlePlacePerp(client, { symbol: "BTCUSD", side: "Buy", margin: 0.01, leverage: 10, sl: 29000, category: "inverse", confirm: "CONFIRM" });

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

    await handlePlacePerp(client, { symbol: "BTCUSD", side: "Buy", margin: 0.01, leverage: 5, sl: 29000, category: "inverse", confirm: "CONFIRM" });

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

    await handlePlacePerp(client, { symbol: "BTCUSDT", side: "Buy", margin: 30, leverage: 10, sl: 29000, orderType: "Limit", price: 29500, confirm: "CONFIRM" });

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
      handlePlacePerp(client, { symbol: "BTCUSDT", side: "Buy", margin: 30, leverage: 10, sl: 29000, orderType: "Limit", confirm: "CONFIRM" })
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

    const result = await handlePlacePerp(client, { symbol: "BTCUSDT", side: "Buy", margin: 10, leverage: 5, sl: 29000, confirm: "CONFIRM" });

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
      handlePlacePerp(client, { symbol: "BTCUSDT", side: "Buy", margin: 10, leverage: 5, sl: 29000, confirm: "CONFIRM" })
    ).rejects.toMatchObject({ message: expect.stringContaining("auto-retry could not resolve") });
  });

  it("dry_run effectiveLeverage and notional reflect floored qty, not raw", async () => {
    // mockInst qtyStep=0.001, price=30000. margin=10, leverage=5.
    // rawQty = 50/30000 = 0.001666..., floored to 0.001.
    // actualNotional = 0.001 * 30000 = 30 (not 50)
    // effectiveLeverage = 30 / 10 = 3.0 (not 5)
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValue(mockTicker);
    (client.signedGet as jest.Mock).mockResolvedValue(mockWalletUsdt);

    const result = await handlePlacePerp(client, { symbol: "BTCUSDT", side: "Buy", margin: 10, leverage: 5, sl: 29000, dry_run: true }) as any;

    expect(result.computedQty).toBe("0.001");
    expect(parseFloat(result.notional)).toBeCloseTo(30, 2);
    expect(result.effectiveLeverage).toBeCloseTo(3, 2);
  });

  it("dry_run sets qtyRoundedDown=true and qtyStep when floorToStep truncates qty", async () => {
    // mockInst qtyStep=0.001, price=30000. margin=20, leverage=5.
    // rawQty = 100/30000 = 0.003333..., floored to 0.003 → rounded down
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValue(mockTicker);
    (client.signedGet as jest.Mock).mockResolvedValue(mockWalletUsdt);

    const result = await handlePlacePerp(client, { symbol: "BTCUSDT", side: "Buy", margin: 20, leverage: 5, sl: 29000, dry_run: true }) as any;

    expect(result.qtyRoundedDown).toBe(true);
    expect(result.qtyStep).toBe("0.001");
    expect(parseFloat(result.computedQty)).toBeLessThan(100 / 30000);
  });

  it("dry_run sets qtyRoundedDown=false when qty lands exactly on step boundary", async () => {
    // margin=30, leverage=10, price=30000: rawQty = 300/30000 = 0.01 exactly (multiple of 0.001)
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValue(mockTicker);
    (client.signedGet as jest.Mock).mockResolvedValue(mockWalletUsdt);

    const result = await handlePlacePerp(client, { symbol: "BTCUSDT", side: "Buy", margin: 30, leverage: 10, sl: 29000, dry_run: true }) as any;

    expect(result.qtyRoundedDown).toBe(false);
    expect(result.qtyStep).toBe("0.001");
  });

  it("dry_run wouldSubmit=false when floored qty drops notional below minNotional", async () => {
    const highMinNotional = { tickSize: "0.5", qtyStep: "0.01", minNotionalValue: "100" };
    mockEnsure.mockResolvedValue(highMinNotional);
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValue(mockTicker);
    (client.signedGet as jest.Mock).mockResolvedValue(mockWalletUsdt);

    // rawQty = 1*5/30000 = 0.000166..., floored to 0.00 → notional 0 < minNotional 100
    const result = await handlePlacePerp(client, { symbol: "BTCUSDT", side: "Buy", margin: 1, leverage: 5, sl: 29000, dry_run: true }) as any;

    expect(result.wouldSubmit).toBe(false);
    expect(result.warnings.some((w: string) => /Notional too low/.test(w))).toBe(true);
  });

  it("populates avgFillPrice from fetched fill snapshot, not the request reference price", async () => {
    mockFetchFill.mockResolvedValue({ avgFillPrice: 30450.5, fillStatus: "Filled", cumExecQty: "0.01" });
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValue(mockTicker);  // lastPrice=30000
    (client.signedGet as jest.Mock).mockResolvedValue(mockWalletUsdt);
    (client.signedPost as jest.Mock)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(mockOrderResult);

    const result = await handlePlacePerp(client, { symbol: "BTCUSDT", side: "Buy", margin: 30, leverage: 10, sl: 29000, confirm: "CONFIRM" }) as any;

    expect(result.avgFillPrice).toBe(30450.5);
    expect(result.fillStatus).toBe("Filled");
    expect(result.cumExecQty).toBe("0.01");
  });

  it("limit order returns fillStatus=New and reference price when not yet filled", async () => {
    mockFetchFill.mockResolvedValue({ avgFillPrice: 29500, fillStatus: "New", cumExecQty: "0" });
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValue(mockTicker);
    (client.signedGet as jest.Mock).mockResolvedValue(mockWalletUsdt);
    (client.signedPost as jest.Mock)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(mockOrderResult);

    const result = await handlePlacePerp(client, { symbol: "BTCUSDT", side: "Buy", margin: 30, leverage: 10, sl: 29000, orderType: "Limit", price: 29500, confirm: "CONFIRM" }) as any;

    expect(result.fillStatus).toBe("New");
    expect(result.cumExecQty).toBe("0");
    expect(result.avgFillPrice).toBe(29500);
  });

  it("returns partialSuccess=true if trading-stop fails after order succeeds", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValue(mockTicker);
    (client.signedGet as jest.Mock).mockResolvedValue(mockWalletUsdt);
    (client.signedPost as jest.Mock)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(mockOrderResult)
      .mockRejectedValueOnce(new Error("trading-stop failed"));

    const result = await handlePlacePerp(client, { symbol: "BTCUSDT", side: "Buy", margin: 10, leverage: 5, sl: 29000, trailingStop: 500, confirm: "CONFIRM" });

    expect((result as any).partialSuccess).toBe(true);
  });
});

describe("handlePlacePerp / conditional (trigger orders)", () => {
  beforeEach(() => {
    mockEnsure.mockResolvedValue(mockInst);
    mockDetect.mockResolvedValue(1);
    mockFetchFill.mockResolvedValue({ avgFillPrice: 32000, fillStatus: "Untriggered", cumExecQty: "0" });
  });

  it("Buy stop above market: auto-derives triggerDirection=1 (rises)", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValue(mockTicker); // lastPrice 30000
    (client.signedGet as jest.Mock).mockResolvedValue(mockWalletUsdt);
    (client.signedPost as jest.Mock)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(mockOrderResult);

    await handlePlacePerp(client, {
      symbol: "BTCUSDT", side: "Buy", margin: 30, leverage: 10, sl: 29000,
      triggerPrice: 32000, confirm: "CONFIRM",
    });

    const orderCall = (client.signedPost as jest.Mock).mock.calls[1];
    expect(orderCall[1].triggerPrice).toBe("32000");
    expect(orderCall[1].triggerDirection).toBe(1);
    expect(orderCall[1].triggerBy).toBe("LastPrice");
  });

  it("Sell stop below market: auto-derives triggerDirection=2 (falls)", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValue(mockTicker); // lastPrice 30000
    (client.signedGet as jest.Mock).mockResolvedValue(mockWalletUsdt);
    (client.signedPost as jest.Mock)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(mockOrderResult);

    await handlePlacePerp(client, {
      symbol: "BTCUSDT", side: "Sell", margin: 30, leverage: 10, sl: 31000,
      triggerPrice: 28000, confirm: "CONFIRM",
    });

    const orderCall = (client.signedPost as jest.Mock).mock.calls[1];
    expect(orderCall[1].triggerPrice).toBe("28000");
    expect(orderCall[1].triggerDirection).toBe(2);
  });

  it("explicit triggerDirection overrides auto-derivation", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValue(mockTicker);
    (client.signedGet as jest.Mock).mockResolvedValue(mockWalletUsdt);
    (client.signedPost as jest.Mock)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(mockOrderResult);

    // triggerPrice < market would auto-derive direction=2; override to 1.
    await handlePlacePerp(client, {
      symbol: "BTCUSDT", side: "Buy", margin: 30, leverage: 10, sl: 29000,
      triggerPrice: 28000, triggerDirection: 1, confirm: "CONFIRM",
    });

    const orderCall = (client.signedPost as jest.Mock).mock.calls[1];
    expect(orderCall[1].triggerDirection).toBe(1);
  });

  it("propagates custom triggerBy (MarkPrice)", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValue(mockTicker);
    (client.signedGet as jest.Mock).mockResolvedValue(mockWalletUsdt);
    (client.signedPost as jest.Mock)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(mockOrderResult);

    await handlePlacePerp(client, {
      symbol: "BTCUSDT", side: "Buy", margin: 30, leverage: 10, sl: 29000,
      triggerPrice: 32000, triggerBy: "MarkPrice", confirm: "CONFIRM",
    });

    const orderCall = (client.signedPost as jest.Mock).mock.calls[1];
    expect(orderCall[1].triggerBy).toBe("MarkPrice");
  });

  it("Limit + triggerPrice creates a stop-limit (both price and triggerPrice present)", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValue(mockTicker);
    (client.signedGet as jest.Mock).mockResolvedValue(mockWalletUsdt);
    (client.signedPost as jest.Mock)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(mockOrderResult);

    await handlePlacePerp(client, {
      symbol: "BTCUSDT", side: "Buy", margin: 30, leverage: 10, sl: 29000,
      orderType: "Limit", price: 32100, triggerPrice: 32000,
      confirm: "CONFIRM",
    });

    const orderCall = (client.signedPost as jest.Mock).mock.calls[1];
    expect(orderCall[1].orderType).toBe("Limit");
    expect(orderCall[1].price).toBe("32100");
    expect(orderCall[1].triggerPrice).toBe("32000");
  });

  it("rejects trailingStop on a conditional order (same rationale as Limit)", async () => {
    const client = new MockClient("k", "s", "u");
    await expect(
      handlePlacePerp(client, {
        symbol: "BTCUSDT", side: "Buy", margin: 30, leverage: 10, sl: 29000,
        triggerPrice: 32000, trailingStop: 500,
        confirm: "CONFIRM",
      })
    ).rejects.toMatchObject({ message: expect.stringContaining("Trailing stops cannot be set") });
  });

  it("dry_run surfaces triggerPrice, triggerBy, triggerDirection in the preview", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValue(mockTicker);
    (client.signedGet as jest.Mock).mockResolvedValue(mockWalletUsdt);

    const result = await handlePlacePerp(client, {
      symbol: "BTCUSDT", side: "Buy", margin: 30, leverage: 10, sl: 29000,
      triggerPrice: 32000, dry_run: true,
    }) as any;

    expect(result.dryRun).toBe(true);
    expect(result.triggerPrice).toBe("32000");
    expect(result.triggerBy).toBe("LastPrice");
    expect(result.triggerDirection).toBe(1);
  });

  it("dry_run warns when triggerPrice is within 0.1% of market (would fire immediately)", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValue(mockTicker); // 30000
    (client.signedGet as jest.Mock).mockResolvedValue(mockWalletUsdt);

    // 30015 is 0.05% above 30000 — inside the 0.1% epsilon.
    const result = await handlePlacePerp(client, {
      symbol: "BTCUSDT", side: "Buy", margin: 30, leverage: 10, sl: 29000,
      triggerPrice: 30015, dry_run: true,
    }) as any;

    expect(result.warnings.some((w: string) => /within 0\.1% of current price/.test(w))).toBe(true);
  });

  it("dry_run does NOT warn when triggerPrice is comfortably outside the epsilon", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValue(mockTicker); // 30000
    (client.signedGet as jest.Mock).mockResolvedValue(mockWalletUsdt);

    const result = await handlePlacePerp(client, {
      symbol: "BTCUSDT", side: "Buy", margin: 30, leverage: 10, sl: 29000,
      triggerPrice: 32000, dry_run: true,
    }) as any;

    expect(result.warnings.some((w: string) => /within 0\.1% of current price/.test(w))).toBe(false);
  });

  it("omits trigger fields from order body when triggerPrice not provided", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValue(mockTicker);
    (client.signedGet as jest.Mock).mockResolvedValue(mockWalletUsdt);
    (client.signedPost as jest.Mock)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(mockOrderResult);

    await handlePlacePerp(client, {
      symbol: "BTCUSDT", side: "Buy", margin: 30, leverage: 10, sl: 29000,
      confirm: "CONFIRM",
    });

    const orderCall = (client.signedPost as jest.Mock).mock.calls[1];
    expect(orderCall[1].triggerPrice).toBeUndefined();
    expect(orderCall[1].triggerDirection).toBeUndefined();
    expect(orderCall[1].triggerBy).toBeUndefined();
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

    await handleClosePerp(client, { symbol: "BTCUSDT", side: "Buy", confirm: "CONFIRM" });

    const call = (client.signedPost as jest.Mock).mock.calls[0];
    expect(call[1].reduceOnly).toBe(true);
    expect(parseFloat(call[1].qty)).toBeCloseTo(0.01, 3);
    expect(call[1].side).toBe("Sell");
  });

  it("closes partial position at given percent", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedGet as jest.Mock).mockResolvedValue(mockPositionList);
    (client.signedPost as jest.Mock).mockResolvedValue({ orderId: "close2", orderLinkId: "mcp-close2" });

    await handleClosePerp(client, { symbol: "BTCUSDT", side: "Buy", percent: 50, confirm: "CONFIRM" });

    const call = (client.signedPost as jest.Mock).mock.calls[0];
    expect(parseFloat(call[1].qty)).toBeCloseTo(0.005, 3);
  });

  it("uses explicit qty when provided instead of percent", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedGet as jest.Mock).mockResolvedValue(mockPositionList);
    (client.signedPost as jest.Mock).mockResolvedValue({ orderId: "close3", orderLinkId: "mcp-close3" });

    await handleClosePerp(client, { symbol: "BTCUSDT", side: "Buy", qty: 0.005, confirm: "CONFIRM" });

    const call = (client.signedPost as jest.Mock).mock.calls[0];
    expect(parseFloat(call[1].qty)).toBeCloseTo(0.005, 3);
  });

  it("passes category to position/list and order/create", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedGet as jest.Mock).mockResolvedValue(mockPositionList);
    (client.signedPost as jest.Mock).mockResolvedValue(mockOrderResult);

    await handleClosePerp(client, { symbol: "BTCUSDT", side: "Buy", category: "linear", confirm: "CONFIRM" });

    const getCall = (client.signedGet as jest.Mock).mock.calls[0];
    expect(getCall[1].category).toBe("linear");
    const postCall = (client.signedPost as jest.Mock).mock.calls[0];
    expect(postCall[1].category).toBe("linear");
  });
});

describe("handleClosePerp / limit (reduce-only)", () => {
  beforeEach(() => {
    mockEnsure.mockResolvedValue(mockInst);
    mockDetect.mockResolvedValue(1);
  });

  it("sends Limit order with price and keeps reduceOnly:true", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedGet as jest.Mock).mockResolvedValue(mockPositionList);
    (client.signedPost as jest.Mock).mockResolvedValue({ orderId: "lc1", orderLinkId: "mcp-lc1" });

    await handleClosePerp(client, {
      symbol: "BTCUSDT", side: "Buy",
      orderType: "Limit", price: 31000,
      qty: 0.005,
      confirm: "CONFIRM",
    });

    const call = (client.signedPost as jest.Mock).mock.calls[0];
    expect(call[1].orderType).toBe("Limit");
    expect(call[1].price).toBe("31000");
    expect(call[1].reduceOnly).toBe(true);
    expect(call[1].side).toBe("Sell");
  });

  it("throws when orderType is Limit but price is missing", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedGet as jest.Mock).mockResolvedValue(mockPositionList);

    await expect(
      handleClosePerp(client, {
        symbol: "BTCUSDT", side: "Buy",
        orderType: "Limit",
        confirm: "CONFIRM",
      })
    ).rejects.toMatchObject({ message: expect.stringContaining("price is required") });
  });

  it("Limit close with percent floors qty against qtyStep and keeps reduceOnly:true", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedGet as jest.Mock).mockResolvedValue(mockPositionList); // size 0.01
    (client.signedPost as jest.Mock).mockResolvedValue({ orderId: "lc-pct", orderLinkId: "mcp-lc-pct" });

    await handleClosePerp(client, {
      symbol: "BTCUSDT", side: "Buy",
      orderType: "Limit", price: 31000,
      percent: 33,
      confirm: "CONFIRM",
    });

    const call = (client.signedPost as jest.Mock).mock.calls[0];
    // 0.01 * 0.33 = 0.0033 → floored to qtyStep 0.001 = 0.003
    expect(parseFloat(call[1].qty)).toBeCloseTo(0.003, 4);
    expect(call[1].orderType).toBe("Limit");
    expect(call[1].price).toBe("31000");
    expect(call[1].reduceOnly).toBe(true);
  });

  it("Market remains the default when orderType is omitted", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedGet as jest.Mock).mockResolvedValue(mockPositionList);
    (client.signedPost as jest.Mock).mockResolvedValue({ orderId: "mk1", orderLinkId: "mcp-mk1" });

    await handleClosePerp(client, { symbol: "BTCUSDT", side: "Buy", confirm: "CONFIRM" });

    const call = (client.signedPost as jest.Mock).mock.calls[0];
    expect(call[1].orderType).toBe("Market");
    expect(call[1].price).toBeUndefined();
  });

  it("rejects Limit close on a short (Sell-side position) with Buy close at Limit price", async () => {
    // A short position closes with a Buy. We just verify side flip works for Limit too.
    const client = new MockClient("k", "s", "u");
    (client.signedGet as jest.Mock).mockResolvedValue({ list: [{ size: "0.01", positionIdx: 2 }] });
    mockDetect.mockResolvedValueOnce(2);
    (client.signedPost as jest.Mock).mockResolvedValue({ orderId: "lc2", orderLinkId: "mcp-lc2" });

    await handleClosePerp(client, {
      symbol: "BTCUSDT", side: "Sell",
      orderType: "Limit", price: 29000,
      qty: 0.005,
      confirm: "CONFIRM",
    });

    const call = (client.signedPost as jest.Mock).mock.calls[0];
    expect(call[1].side).toBe("Buy");
    expect(call[1].orderType).toBe("Limit");
    expect(call[1].price).toBe("29000");
    expect(call[1].reduceOnly).toBe(true);
  });
});

describe("handleManagePosition", () => {
  beforeEach(() => {
    mockDetect.mockResolvedValue(1);
  });

  it("calls trading-stop with correct fields and category", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedPost as jest.Mock).mockResolvedValue({});

    await handleManagePosition(client, { symbol: "BTCUSDT", side: "Buy", updates: { sl: 29500, tp: 33000 }, confirm: "CONFIRM" });

    const call = (client.signedPost as jest.Mock).mock.calls[0];
    expect(call[0]).toBe("/v5/position/trading-stop");
    expect(call[1].stopLoss).toBe("29500");
    expect(call[1].takeProfit).toBe("33000");
    expect(call[1].category).toBe("linear");
  });

  it("passes '0' string to cancel existing SL", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedPost as jest.Mock).mockResolvedValue({});

    await handleManagePosition(client, { symbol: "BTCUSDT", side: "Buy", updates: { sl: 0 }, confirm: "CONFIRM" });

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
