import {
  handleGetVolatility,
  closeToCloseVol,
  parkinsonVol,
  yangZhangVol,
  intervalToMinutes,
} from "../tools/volatility";
import { BybitClient } from "../client";

jest.mock("../client");
const MockClient = BybitClient as jest.MockedClass<typeof BybitClient>;

interface Bar { open: number; high: number; low: number; close: number }

function bar(open: number, high: number, low: number, close: number): Bar {
  return { open, high, low, close };
}

// Kline tuples newest-first (Bybit native order) from oldest-first closes.
function klinesFromCloses(closes: number[]): string[][] {
  const tuples: string[][] = [];
  for (let i = 0; i < closes.length; i++) {
    const open = i > 0 ? closes[i - 1] : closes[i];
    const high = Math.max(open, closes[i]) * 1.001;
    const low = Math.min(open, closes[i]) * 0.999;
    tuples.push([
      String(1700000000000 + i * 3600000),
      String(open), String(high), String(low), String(closes[i]),
      "100", "3000000",
    ]);
  }
  return tuples.reverse();
}

describe("intervalToMinutes", () => {
  it("maps numeric and letter intervals", () => {
    expect(intervalToMinutes("60")).toBe(60);
    expect(intervalToMinutes("240")).toBe(240);
    expect(intervalToMinutes("D")).toBe(1440);
    expect(intervalToMinutes("W")).toBe(10080);
  });

  it("throws on garbage intervals", () => {
    expect(() => intervalToMinutes("x")).toThrow("Unsupported kline interval");
    expect(() => intervalToMinutes("-5")).toThrow("Unsupported kline interval");
  });
});

describe("closeToCloseVol", () => {
  it("is 0 for a constant price series", () => {
    const bars = Array.from({ length: 10 }, () => bar(100, 100, 100, 100));
    expect(closeToCloseVol(bars, 8760)).toBe(0);
  });

  it("matches the hand-computed sample stdev of log returns", () => {
    // Returns: ln(1.1), -ln(1.1), ln(1.1), -ln(1.1) → mean 0,
    // sample var = 4*ln(1.1)^2/3, sigma = 2*ln(1.1)/sqrt(3) (barsPerYear=1).
    const closes = [100, 110, 100, 110, 100];
    const bars = closes.map((c) => bar(c, c, c, c));
    const expected = (2 * Math.log(1.1)) / Math.sqrt(3);
    expect(closeToCloseVol(bars, 1)).toBeCloseTo(expected, 10);
  });

  it("scales with sqrt of barsPerYear", () => {
    const closes = [100, 110, 100, 110, 100];
    const bars = closes.map((c) => bar(c, c, c, c));
    const v1 = closeToCloseVol(bars, 1)!;
    const v365 = closeToCloseVol(bars, 365)!;
    expect(v365).toBeCloseTo(v1 * Math.sqrt(365), 10);
  });

  it("returns null with fewer than 3 bars", () => {
    expect(closeToCloseVol([bar(100, 100, 100, 100), bar(100, 100, 100, 100)], 1)).toBeNull();
  });
});

describe("parkinsonVol", () => {
  it("is 0 when every bar has high === low", () => {
    const bars = Array.from({ length: 5 }, () => bar(100, 100, 100, 100));
    expect(parkinsonVol(bars, 8760)).toBe(0);
  });

  it("matches the closed-form value for a constant high/low ratio", () => {
    // Every bar high/low = 1.1 → var = ln(1.1)^2 / (4 ln 2),
    // sigma = ln(1.1) / (2 sqrt(ln 2)) with barsPerYear=1.
    const bars = Array.from({ length: 6 }, () => bar(105, 110, 100, 105));
    const expected = Math.log(1.1) / (2 * Math.sqrt(Math.LN2));
    expect(parkinsonVol(bars, 1)).toBeCloseTo(expected, 10);
  });

  it("skips malformed bars and returns null when too few remain", () => {
    expect(parkinsonVol([bar(0, 0, 0, 0), bar(105, 110, 100, 105)], 1)).toBeNull();
  });
});

describe("yangZhangVol", () => {
  it("is 0 for a constant price series", () => {
    const bars = Array.from({ length: 10 }, () => bar(100, 100, 100, 100));
    expect(yangZhangVol(bars, 8760)).toBe(0);
  });

  it("produces a positive vol for a moving series", () => {
    const closes = [100, 104, 99, 105, 101, 103, 98, 102];
    const bars = closes.map((c, i) => {
      const open = i > 0 ? closes[i - 1] : c;
      return bar(open, Math.max(open, c) * 1.01, Math.min(open, c) * 0.99, c);
    });
    const v = yangZhangVol(bars, 8760);
    expect(v).not.toBeNull();
    expect(v!).toBeGreaterThan(0);
  });

  it("returns null with fewer than 3 bars", () => {
    expect(yangZhangVol([bar(100, 100, 100, 100), bar(100, 100, 100, 100)], 1)).toBeNull();
  });
});

describe("handleGetVolatility", () => {
  it("returns estimators, cone rows, and a short-history note", async () => {
    const closes = Array.from({ length: 100 }, (_, i) => 30000 * (1 + 0.01 * Math.sin(i)));
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValueOnce({ list: klinesFromCloses(closes) });

    const result = await handleGetVolatility(client, false, { symbol: "BTCUSDT" });

    expect(result.symbol).toBe("BTCUSDT");
    expect(result.barsUsed).toBe(100);
    expect(result.windowBars).toBe(100); // default 168 clamped to history
    expect(result.realizedVol.closeToClose).toBeGreaterThan(0);
    expect(result.realizedVol.parkinson).toBeGreaterThan(0);
    expect(result.realizedVol.yangZhang).toBeGreaterThan(0);
    // 100 hourly bars fit the 1d (24-bar) and 3d (72-bar) horizons only.
    expect(result.volCone.map((r) => r.horizon)).toEqual(["1d", "3d"]);
    for (const row of result.volCone) {
      expect(row.min).toBeLessThanOrEqual(row.median!);
      expect(row.median).toBeLessThanOrEqual(row.max!);
      expect(row.samples).toBeGreaterThan(0);
    }
    expect(result.dataNote).toContain("100/1000 bars");
    expect(result.iv).toBeUndefined();
  });

  it("throws on insufficient kline data", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValueOnce({ list: [] });
    await expect(handleGetVolatility(client, false, { symbol: "BTCUSDT" }))
      .rejects.toThrow("Insufficient kline data");
  });

  it("attaches the IV comparison when options are enabled for a BTC/ETH/SOL perp", async () => {
    const closes = Array.from({ length: 50 }, () => 30000); // constant → RV 0
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock)
      .mockResolvedValueOnce({ list: klinesFromCloses(closes) }) // kline
      .mockResolvedValueOnce({
        list: [{
          symbol: "BTC-25APR30-30000-C-USDT",
          markIv: "0.55",
          lastPrice: "1000", bid1Price: "990", ask1Price: "1010", markPrice: "1000",
          openInterest: "100", volume24h: "10", delta: "0.5", gamma: "0", theta: "0", vega: "0",
        }],
      }) // option chain
      .mockResolvedValueOnce({ list: [{ lastPrice: "30000" }] }); // linear spot

    const result = await handleGetVolatility(client, true, { symbol: "BTCUSDT" });

    expect(result.iv).toBeDefined();
    expect(result.iv!.atmIv).toBe(0.55);
    expect(result.iv!.ivMinusRv).toBeCloseTo(0.55, 4);
    expect(result.iv!.comparedTo).toBe("closeToClose");
  });

  it("skips the IV comparison when compareIv=false", async () => {
    const closes = Array.from({ length: 50 }, () => 30000);
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValueOnce({ list: klinesFromCloses(closes) });

    const result = await handleGetVolatility(client, true, { symbol: "BTCUSDT", compareIv: false });

    expect(result.iv).toBeUndefined();
    expect(client.publicGet).toHaveBeenCalledTimes(1);
  });

  it("soft-fails the IV comparison and notes it when the chain fetch throws", async () => {
    const closes = Array.from({ length: 50 }, () => 30000);
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock)
      .mockResolvedValueOnce({ list: klinesFromCloses(closes) })
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ list: [{ lastPrice: "30000" }] });

    const result = await handleGetVolatility(client, true, { symbol: "BTCUSDT" });

    expect(result.iv).toBeUndefined();
    expect(result.dataNote).toContain("IV comparison unavailable");
  });

  it("never attempts IV comparison for non-options underlyings", async () => {
    const closes = Array.from({ length: 50 }, () => 5);
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValueOnce({ list: klinesFromCloses(closes) });

    const result = await handleGetVolatility(client, true, { symbol: "XRPUSDT" });

    expect(result.iv).toBeUndefined();
    expect(client.publicGet).toHaveBeenCalledTimes(1);
  });

  it("honours an explicit windowBars", async () => {
    const closes = Array.from({ length: 200 }, (_, i) => 100 + (i % 5));
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValueOnce({ list: klinesFromCloses(closes) });

    const result = await handleGetVolatility(client, false, { symbol: "BTCUSDT", windowBars: 48 });
    expect(result.windowBars).toBe(48);
  });
});
