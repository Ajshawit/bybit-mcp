import {
  handleGetPerformanceStats,
  computePerformanceStats,
} from "../tools/performance";
import { ClosedTrade } from "../tools/orders";
import { BybitClient } from "../client";

jest.mock("../client");
const MockClient = BybitClient as jest.MockedClass<typeof BybitClient>;

function trade(overrides: Partial<ClosedTrade>): ClosedTrade {
  return {
    symbol: "BTCUSDT",
    positionSide: "LONG",
    closedPnl: 0,
    avgEntryPrice: 100,
    avgExitPrice: 100,
    qty: 1,
    entryValue: 100,
    exitValue: 100,
    leverage: 5,
    openedAt: "2026-01-01T00:00:00.000Z",
    closedAt: "2026-01-01T01:00:00.000Z",
    holdSeconds: 3600,
    pnlPct: 0,
    orderType: "Market",
    execType: "Trade",
    ...overrides,
  };
}

// Fixture (chronological): cum PnL 30 → 10 → 0 → 50 → 30.
// Daily sums: Jan1 +10, Jan2 -10, Jan3 +30.
const FIXTURE: ClosedTrade[] = [
  trade({ symbol: "BTCUSDT", positionSide: "LONG", closedPnl: 30, closedAt: "2026-01-01T08:00:00.000Z" }),
  trade({ symbol: "BTCUSDT", positionSide: "SHORT", closedPnl: -20, closedAt: "2026-01-01T16:00:00.000Z" }),
  trade({ symbol: "ETHUSDT", positionSide: "LONG", closedPnl: -10, closedAt: "2026-01-02T12:00:00.000Z" }),
  trade({ symbol: "ETHUSDT", positionSide: "LONG", closedPnl: 50, closedAt: "2026-01-03T09:00:00.000Z" }),
  trade({ symbol: "BTCUSDT", positionSide: "SHORT", closedPnl: -20, closedAt: "2026-01-03T15:00:00.000Z" }),
];

describe("computePerformanceStats", () => {
  it("computes win/loss totals, profit factor, and expectancy", () => {
    const s = computePerformanceStats(FIXTURE);

    expect(s.tradesAnalyzed).toBe(5);
    expect(s.wins).toBe(2);
    expect(s.losses).toBe(3);
    expect(s.breakevens).toBe(0);
    expect(s.winRate).toBeCloseTo(0.4, 8);
    expect(s.totalPnlUsd).toBeCloseTo(30, 8);
    expect(s.grossProfitUsd).toBeCloseTo(80, 8);
    expect(s.grossLossUsd).toBeCloseTo(50, 8);
    expect(s.profitFactor).toBeCloseTo(1.6, 8);
    expect(s.expectancyUsd).toBeCloseTo(6, 8);
    expect(s.avgWinUsd).toBeCloseTo(40, 8);
    expect(s.avgLossUsd).toBeCloseTo(50 / 3, 4);
    expect(s.payoffRatio).toBeCloseTo(40 / (50 / 3), 4);
    expect(s.largestWinUsd).toBeCloseTo(50, 8);
    expect(s.largestLossUsd).toBeCloseTo(-20, 8);
  });

  it("computes annualized Sharpe and Sortino on daily PnL", () => {
    const s = computePerformanceStats(FIXTURE);

    // Daily PnL [10, -10, 30]: mean 10, sample std 20 → Sharpe 0.5·√365.
    expect(s.dailyPnl.days).toBe(3);
    expect(s.dailyPnl.meanUsd).toBeCloseTo(10, 8);
    expect(s.dailyPnl.stdUsd).toBeCloseTo(20, 8);
    expect(s.dailyPnl.sharpeAnnualizedUsdPnl).toBeCloseTo(0.5 * Math.sqrt(365), 3);
    // Downside deviation vs 0, sample denominator (n-1): sqrt(100/2).
    expect(s.dailyPnl.sortinoAnnualizedUsdPnl).toBeCloseTo((10 / Math.sqrt(100 / 2)) * Math.sqrt(365), 3);
  });

  it("computes max drawdown on the cumulative PnL curve", () => {
    const s = computePerformanceStats(FIXTURE);

    expect(s.maxDrawdown.maxDrawdownUsd).toBeCloseTo(30, 8);
    expect(s.maxDrawdown.peakCumPnlUsd).toBeCloseTo(30, 8);
    expect(s.maxDrawdown.troughCumPnlUsd).toBeCloseTo(0, 8);
  });

  it("attributes per symbol sorted by total PnL", () => {
    const s = computePerformanceStats(FIXTURE);

    expect(s.perSymbol).toHaveLength(2);
    expect(s.perSymbol[0]).toMatchObject({ symbol: "ETHUSDT", trades: 2, wins: 1, totalPnlUsd: 40 });
    expect(s.perSymbol[0].winRate).toBeCloseTo(0.5, 8);
    expect(s.perSymbol[1]).toMatchObject({ symbol: "BTCUSDT", trades: 3, wins: 1, totalPnlUsd: -10 });
  });

  it("splits long vs short", () => {
    const s = computePerformanceStats(FIXTURE);

    expect(s.longShort.long).toMatchObject({ trades: 3, wins: 2, totalPnlUsd: 70 });
    expect(s.longShort.long.winRate).toBeCloseTo(2 / 3, 3);
    expect(s.longShort.short).toMatchObject({ trades: 2, wins: 0, totalPnlUsd: -40 });
    expect(s.longShort.short.winRate).toBe(0);
  });

  it("reports hold-time stats in hours", () => {
    const s = computePerformanceStats(FIXTURE);
    expect(s.holdTime.avgHours).toBeCloseTo(1, 8);
    expect(s.holdTime.medianHours).toBeCloseTo(1, 8);
  });

  it("handles an empty trade list without dividing by zero", () => {
    const s = computePerformanceStats([]);

    expect(s.tradesAnalyzed).toBe(0);
    expect(s.winRate).toBeNull();
    expect(s.profitFactor).toBeNull();
    expect(s.expectancyUsd).toBeNull();
    expect(s.dailyPnl.sharpeAnnualizedUsdPnl).toBeNull();
    expect(s.maxDrawdown.maxDrawdownUsd).toBe(0);
    expect(s.perSymbol).toEqual([]);
  });

  it("returns null Sharpe for a single trading day and null Sortino with no down days", () => {
    const s = computePerformanceStats([
      trade({ closedPnl: 10, closedAt: "2026-01-01T08:00:00.000Z" }),
      trade({ closedPnl: 20, closedAt: "2026-01-01T09:00:00.000Z" }),
    ]);
    expect(s.dailyPnl.days).toBe(1);
    expect(s.dailyPnl.sharpeAnnualizedUsdPnl).toBeNull();
    expect(s.dailyPnl.sortinoAnnualizedUsdPnl).toBeNull();
  });

  it("drops trades with unparseable timestamps from all stats and reports the count", () => {
    const s = computePerformanceStats([
      trade({ closedPnl: 10, closedAt: "2026-01-01T08:00:00.000Z" }),
      trade({ closedPnl: 999, closedAt: "" }), // malformed Bybit timestamp
    ]);
    expect(s.tradesAnalyzed).toBe(1);
    expect(s.totalPnlUsd).toBeCloseTo(10, 8);
    expect(s.tradesDroppedInvalidTimestamp).toBe(1);
  });

  it("counts profit-factor as null when there are no losses", () => {
    const s = computePerformanceStats([
      trade({ closedPnl: 10, closedAt: "2026-01-01T08:00:00.000Z" }),
      trade({ closedPnl: 20, closedAt: "2026-01-02T09:00:00.000Z" }),
    ]);
    expect(s.profitFactor).toBeNull();
    expect(s.winRate).toBe(1);
  });
});

function rawPnlRecord(symbol: string, closedPnl: string, updatedMs: number): Record<string, string> {
  return {
    symbol, side: "Sell", closedPnl,
    avgEntryPrice: "100", avgExitPrice: "101", qty: "1", closedSize: "1",
    cumEntryValue: "100", cumExitValue: "101", leverage: "5",
    createdTime: String(updatedMs - 3600000), updatedTime: String(updatedMs),
    orderType: "Market", execType: "Trade",
  };
}

describe("handleGetPerformanceStats", () => {
  it("fetches one window for short periods and flattens the stats", async () => {
    const now = Date.now();
    const client = new MockClient("k", "s", "u");
    (client.signedGet as jest.Mock).mockResolvedValue({
      list: [
        rawPnlRecord("BTCUSDT", "100", now - 3600000),
        rawPnlRecord("BTCUSDT", "-40", now - 7200000),
      ],
    });

    const result = await handleGetPerformanceStats(client, { daysBack: 5 });

    expect(client.signedGet).toHaveBeenCalledTimes(1);
    const [path, query] = (client.signedGet as jest.Mock).mock.calls[0];
    expect(path).toBe("/v5/position/closed-pnl");
    expect(query.category).toBe("linear");
    expect(query.limit).toBe("100");
    expect(parseInt(query.endTime, 10) - parseInt(query.startTime, 10)).toBeLessThanOrEqual(5 * 86400000);

    expect(result.tradesAnalyzed).toBe(2);
    expect(result.stats.totalPnlUsd).toBeCloseTo(60, 8);
    expect(result.stats.winRate).toBeCloseTo(0.5, 8);
    expect(result.period.daysBack).toBe(5);
    expect(result.truncated).toBe(false);
  });

  it("chunks long periods into windows of at most 7 days", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedGet as jest.Mock).mockResolvedValue({ list: [] });

    await handleGetPerformanceStats(client, { daysBack: 20 });

    const calls = (client.signedGet as jest.Mock).mock.calls;
    expect(calls).toHaveLength(3);
    for (const [, query] of calls) {
      const span = parseInt(query.endTime, 10) - parseInt(query.startTime, 10);
      expect(span).toBeLessThanOrEqual(7 * 86400000);
    }
    // Windows must be contiguous and non-overlapping (newest first).
    for (let i = 1; i < calls.length; i++) {
      const prevStart = parseInt(calls[i - 1][1].startTime, 10);
      const curEnd = parseInt(calls[i][1].endTime, 10);
      expect(curEnd).toBe(prevStart - 1);
    }
  });

  it("follows pagination cursors within a window", async () => {
    const now = Date.now();
    const client = new MockClient("k", "s", "u");
    (client.signedGet as jest.Mock)
      .mockResolvedValueOnce({
        list: [rawPnlRecord("BTCUSDT", "10", now - 1000)],
        nextPageCursor: "page2",
      })
      .mockResolvedValueOnce({
        list: [rawPnlRecord("BTCUSDT", "20", now - 2000)],
        nextPageCursor: "",
      });

    const result = await handleGetPerformanceStats(client, { daysBack: 3 });

    expect(client.signedGet).toHaveBeenCalledTimes(2);
    const second = (client.signedGet as jest.Mock).mock.calls[1][1];
    expect(second.cursor).toBe("page2");
    expect(result.tradesAnalyzed).toBe(2);
  });

  it("passes the symbol filter through and validates daysBack", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedGet as jest.Mock).mockResolvedValue({ list: [] });

    await handleGetPerformanceStats(client, { symbol: "ETHUSDT", daysBack: 2 });
    expect((client.signedGet as jest.Mock).mock.calls[0][1].symbol).toBe("ETHUSDT");

    await expect(handleGetPerformanceStats(client, { daysBack: 0 })).rejects.toThrow("daysBack");
    await expect(handleGetPerformanceStats(client, { daysBack: 400 })).rejects.toThrow("daysBack");
  });

  it("stops fetching and flags truncation at the trade cap", async () => {
    const now = Date.now();
    const bigPage = {
      list: Array.from({ length: 100 }, (_, i) => rawPnlRecord("BTCUSDT", "1", now - i * 1000)),
      nextPageCursor: "more",
    };
    const client = new MockClient("k", "s", "u");
    (client.signedGet as jest.Mock).mockResolvedValue(bigPage);

    const result = await handleGetPerformanceStats(client, { daysBack: 30 });

    expect(result.truncated).toBe(true);
    expect(result.tradesAnalyzed).toBe(1000);
    expect(result.dataNote).toContain("1000");
    // 10 pages of 100 hit the cap; no further windows are fetched.
    expect(client.signedGet).toHaveBeenCalledTimes(10);
  });

  it("notes an empty window instead of erroring", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedGet as jest.Mock).mockResolvedValue({ list: [] });

    const result = await handleGetPerformanceStats(client, {});

    expect(result.tradesAnalyzed).toBe(0);
    expect(result.dataNote).toContain("No closed trades");
  });
});
