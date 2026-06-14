import { handleGetClosedTrades, handleCancelOrder, handleListOpenOrders } from "../tools/orders";
import { BybitClient } from "../client";

jest.mock("../client");
const MockClient = BybitClient as jest.MockedClass<typeof BybitClient>;

describe("handleListOpenOrders", () => {
  it("defaults settleCoin=USDT for an unfiltered linear query (Bybit requires a filter)", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedGet as jest.Mock).mockResolvedValue({ list: [], category: "linear" });

    await handleListOpenOrders(client, {});

    const call = (client.signedGet as jest.Mock).mock.calls[0];
    expect(call[1].settleCoin).toBe("USDT");
  });

  it("does not add settleCoin when a symbol filter is provided", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedGet as jest.Mock).mockResolvedValue({ list: [], category: "linear" });

    await handleListOpenOrders(client, { symbol: "BTCUSDT" });

    const call = (client.signedGet as jest.Mock).mock.calls[0];
    expect(call[1].settleCoin).toBeUndefined();
    expect(call[1].symbol).toBe("BTCUSDT");
  });
});

describe("handleCancelOrder", () => {
  it("throws when confirm is missing — gate fires before any signed POST", async () => {
    const client = new MockClient("k", "s", "u");
    await expect(
      handleCancelOrder(client, { symbol: "BTCUSDT", orderId: "abc123" })
    ).rejects.toThrow(/cancel_order requires confirm="CONFIRM"/);
    expect(client.signedPost).not.toHaveBeenCalled();
  });

  it("throws when confirm is wrong case", async () => {
    const client = new MockClient("k", "s", "u");
    await expect(
      handleCancelOrder(client, { symbol: "BTCUSDT", orderId: "abc123", confirm: "confirm" })
    ).rejects.toThrow(/case-sensitive/);
    expect(client.signedPost).not.toHaveBeenCalled();
  });

  it("submits cancel when confirm=CONFIRM and returns canonical shape", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedPost as jest.Mock).mockResolvedValue({ orderId: "abc123", orderLinkId: "mcp-x" });

    const res = await handleCancelOrder(client, {
      symbol: "BTCUSDT", orderId: "abc123", confirm: "CONFIRM",
    });

    expect(client.signedPost).toHaveBeenCalledWith(
      "/v5/order/cancel",
      expect.objectContaining({ category: "linear", symbol: "BTCUSDT", orderId: "abc123" }),
    );
    expect(res).toMatchObject({
      cancelled: true, orderId: "abc123", orderLinkId: "mcp-x", symbol: "BTCUSDT",
    });
  });

  it("dry_run returns a preview without confirm and without submitting", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedPost as jest.Mock).mockResolvedValue({ orderId: "abc123", orderLinkId: "mcp-x" });

    const res = await handleCancelOrder(client, {
      symbol: "BTCUSDT", orderId: "abc123", dry_run: true,
    });

    expect((res as { dryRun?: boolean }).dryRun).toBe(true);
    expect(client.signedPost).not.toHaveBeenCalled();
  });

  it("passes an explicit orderFilter through to Bybit", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedPost as jest.Mock).mockResolvedValue({ orderId: "abc123", orderLinkId: "mcp-x" });

    await handleCancelOrder(client, {
      symbol: "BTCUSDT", orderId: "abc123", category: "spot", orderFilter: "StopOrder", confirm: "CONFIRM",
    });

    expect(client.signedPost).toHaveBeenCalledWith(
      "/v5/order/cancel",
      expect.objectContaining({ category: "spot", orderFilter: "StopOrder" }),
    );
  });

  // Spot conditional orders are created with orderFilter=StopOrder; a cancel
  // without that filter looks in the wrong order book and fails, leaving the
  // trigger armed. The handler must retry spot cancels with StopOrder.
  it("retries a failed spot cancel with orderFilter=StopOrder", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedPost as jest.Mock)
      .mockRejectedValueOnce(new Error("Bybit error 170213: Order does not exist."))
      .mockResolvedValueOnce({ orderId: "stop-1", orderLinkId: "mcp-y" });

    const res = await handleCancelOrder(client, {
      symbol: "BTCUSDT", orderId: "stop-1", category: "spot", confirm: "CONFIRM",
    });

    expect(client.signedPost).toHaveBeenCalledTimes(2);
    const retryCall = (client.signedPost as jest.Mock).mock.calls[1];
    expect(retryCall[1].orderFilter).toBe("StopOrder");
    expect(res).toMatchObject({ cancelled: true, orderId: "stop-1" });
  });

  it("does not retry non-spot cancels and surfaces the original error", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedPost as jest.Mock).mockRejectedValue(new Error("Bybit error 110001: order not exists"));

    await expect(
      handleCancelOrder(client, { symbol: "BTCUSDT", orderId: "x", category: "linear", confirm: "CONFIRM" })
    ).rejects.toThrow("110001");
    expect(client.signedPost).toHaveBeenCalledTimes(1);
  });
});

describe("handleGetClosedTrades", () => {
  const sampleClosedPnl = {
    list: [
      {
        symbol: "BTCUSDT",
        side: "Buy" as const,           // closing-order side: Buy → position was SHORT
        closedPnl: "12.3456",
        avgEntryPrice: "80000",
        avgExitPrice: "79861.5",
        qty: "0.002",
        closedSize: "0.002",
        cumEntryValue: "160",
        cumExitValue: "159.723",
        leverage: "5",
        createdTime: "1700000000000",   // opened
        updatedTime: "1700003600000",   // closed (1h later)
        orderType: "Market",
        execType: "Trade",
      },
      {
        symbol: "ETHUSDT",
        side: "Sell" as const,          // closing-order side: Sell → position was LONG
        closedPnl: "-5.0",
        avgEntryPrice: "3000",
        avgExitPrice: "2950",
        qty: "0.1",
        closedSize: "0.1",
        cumEntryValue: "300",
        cumExitValue: "295",
        leverage: "10",
        createdTime: "1700000000000",
        updatedTime: "1700001800000",   // 30min hold
        orderType: "Market",
        execType: "Trade",
      },
    ],
    category: "linear",
  };

  it("translates closing-order side back to position direction", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedGet as jest.Mock).mockResolvedValue(sampleClosedPnl);

    const result = await handleGetClosedTrades(client, {});

    expect(result.trades[0].positionSide).toBe("SHORT");  // Buy close → SHORT
    expect(result.trades[1].positionSide).toBe("LONG");   // Sell close → LONG
  });

  it("computes pnlPct from closedPnl/cumEntryValue", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedGet as jest.Mock).mockResolvedValue(sampleClosedPnl);

    const result = await handleGetClosedTrades(client, {});

    expect(result.trades[0].pnlPct).toBeCloseTo(7.72, 1); // 12.3456/160 * 100
    expect(result.trades[1].pnlPct).toBeCloseTo(-1.67, 1); // -5/300 * 100
  });

  it("computes hold duration in seconds from createdTime/updatedTime", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedGet as jest.Mock).mockResolvedValue(sampleClosedPnl);

    const result = await handleGetClosedTrades(client, {});

    expect(result.trades[0].holdSeconds).toBe(3600);
    expect(result.trades[1].holdSeconds).toBe(1800);
  });

  it("returns aggregate totalPnl across all trades", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedGet as jest.Mock).mockResolvedValue(sampleClosedPnl);

    const result = await handleGetClosedTrades(client, {});

    expect(result.totalPnl).toBeCloseTo(7.3456, 4);
    expect(result.count).toBe(2);
  });

  it("passes symbol, category, limit and time filters to Bybit", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedGet as jest.Mock).mockResolvedValue({ list: [], category: "linear" });

    await handleGetClosedTrades(client, {
      symbol: "BTCUSDT", category: "linear",
      limit: 25, startTime: 1700000000000, endTime: 1700100000000,
    });

    const call = (client.signedGet as jest.Mock).mock.calls[0];
    expect(call[0]).toBe("/v5/position/closed-pnl");
    expect(call[1].symbol).toBe("BTCUSDT");
    expect(call[1].category).toBe("linear");
    expect(call[1].limit).toBe("25");
    expect(call[1].startTime).toBe("1700000000000");
    expect(call[1].endTime).toBe("1700100000000");
  });

  it("clamps limit to [1, 100]", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedGet as jest.Mock).mockResolvedValue({ list: [], category: "linear" });

    await handleGetClosedTrades(client, { limit: 500 });
    expect((client.signedGet as jest.Mock).mock.calls[0][1].limit).toBe("100");

    await handleGetClosedTrades(client, { limit: 0 });
    expect((client.signedGet as jest.Mock).mock.calls[1][1].limit).toBe("1");
  });

  it("defaults to linear category and limit 50", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedGet as jest.Mock).mockResolvedValue({ list: [], category: "linear" });

    await handleGetClosedTrades(client, {});

    const call = (client.signedGet as jest.Mock).mock.calls[0];
    expect(call[1].category).toBe("linear");
    expect(call[1].limit).toBe("50");
  });

  it("returns empty result without error when Bybit returns empty list", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedGet as jest.Mock).mockResolvedValue({ list: [], category: "linear" });

    const result = await handleGetClosedTrades(client, {});
    expect(result.trades).toEqual([]);
    expect(result.count).toBe(0);
    expect(result.totalPnl).toBe(0);
  });
});
