import {
  handleAnalyzePair,
  pearsonCorrelation,
  olsFit,
  halfLifeBars,
} from "../tools/pairs";
import { BybitClient } from "../client";

jest.mock("../client");
const MockClient = BybitClient as jest.MockedClass<typeof BybitClient>;

const T0 = 1700000000000;
const HOUR = 3600000;

// Kline tuples newest-first (Bybit native order) from oldest-first closes,
// with timestamps anchored to the ORIGINAL index so two series stay alignable
// even when one skips bars.
function tuples(closes: number[], skipIdx: number[] = []): string[][] {
  const skip = new Set(skipIdx);
  const out: string[][] = [];
  for (let i = 0; i < closes.length; i++) {
    if (skip.has(i)) continue;
    const open = i > 0 ? closes[i - 1] : closes[i];
    out.push([
      String(T0 + i * HOUR),
      String(open), String(Math.max(open, closes[i])), String(Math.min(open, closes[i])), String(closes[i]),
      "100", "3000000",
    ]);
  }
  return out.reverse();
}

function mockKlines(client: BybitClient, bySymbol: Record<string, string[][]>): void {
  (client.publicGet as jest.Mock).mockImplementation(async (path: string, params: Record<string, string>) => {
    if (path === "/v5/market/kline" && bySymbol[params.symbol]) {
      return { list: bySymbol[params.symbol] };
    }
    throw new Error(`Unexpected publicGet: ${path} ${JSON.stringify(params)}`);
  });
}

// Deterministic wiggly benchmark series (always > 0).
const BENCH = Array.from({ length: 100 }, (_, i) => 100 + 10 * Math.sin(i * 1.7) + 0.1 * i);

describe("pearsonCorrelation", () => {
  it("is 1 for a perfectly linear positive relationship", () => {
    const xs = [1, 2, 3, 4, 5];
    expect(pearsonCorrelation(xs, xs.map((x) => 3 * x + 2))).toBeCloseTo(1, 10);
  });

  it("is -1 for a perfectly inverted relationship", () => {
    const xs = [1, 2, 3, 4, 5];
    expect(pearsonCorrelation(xs, xs.map((x) => -2 * x + 7))).toBeCloseTo(-1, 10);
  });

  it("is null for constant series or fewer than 2 points", () => {
    expect(pearsonCorrelation([1, 1, 1], [1, 2, 3])).toBeNull();
    expect(pearsonCorrelation([1], [2])).toBeNull();
  });
});

describe("olsFit", () => {
  it("recovers slope and intercept of an exact line", () => {
    const xs = [0, 1, 2, 3, 4];
    const fit = olsFit(xs, xs.map((x) => 2 * x + 1))!;
    expect(fit.slope).toBeCloseTo(2, 10);
    expect(fit.intercept).toBeCloseTo(1, 10);
  });

  it("returns null when x has no variance", () => {
    expect(olsFit([5, 5, 5], [1, 2, 3])).toBeNull();
  });
});

describe("halfLifeBars", () => {
  it("is exactly 1 bar for an AR(1) with phi = 0.5", () => {
    const spread = Array.from({ length: 25 }, (_, t) => Math.pow(0.5, t));
    expect(halfLifeBars(spread)).toBeCloseTo(1, 6);
  });

  it("matches the closed form for phi = 0.9", () => {
    const spread = Array.from({ length: 60 }, (_, t) => Math.pow(0.9, t));
    expect(halfLifeBars(spread)).toBeCloseTo(-Math.LN2 / Math.log(0.9), 4);
  });

  it("is null for a non-mean-reverting (trending) spread", () => {
    const spread = Array.from({ length: 30 }, (_, t) => t);
    expect(halfLifeBars(spread)).toBeNull();
  });

  it("is null for a constant spread or too few points", () => {
    expect(halfLifeBars(Array.from({ length: 30 }, () => 0))).toBeNull();
    expect(halfLifeBars([1, 0.5, 0.25])).toBeNull();
  });
});

describe("handleAnalyzePair", () => {
  it("reports perfect correlation, beta 2, and a flat spread for lnA = 2·lnB", async () => {
    // A = B²/100 → log returns of A are exactly 2× those of B.
    const a = BENCH.map((b) => (b * b) / 100);
    const client = new MockClient("k", "s", "u");
    mockKlines(client, { ETHUSDT: tuples(a), BTCUSDT: tuples(BENCH) });

    const result = await handleAnalyzePair(client, { symbol: "ETHUSDT" });

    expect(result.symbol).toBe("ETHUSDT");
    expect(result.benchmark).toBe("BTCUSDT");
    expect(result.barsAligned).toBe(100);
    expect(result.returns.correlationFull).toBeCloseTo(1, 6);
    expect(result.returns.correlationRecent).toBeCloseTo(1, 6);
    expect(result.beta.full).toBeCloseTo(2, 6);
    expect(result.beta.hedgeNotionalUsdPer1kUsd).toBeCloseTo(2000, 0);
    expect(result.spread.hedgeRatioLog).toBeCloseTo(2, 6);
    // Spread is constant → no variance → no z-score, no half-life.
    expect(result.spread.zScore).toBeNull();
    expect(result.meanReversion.halfLifeBars).toBeNull();
  });

  it("flags a rich spread when the symbol blows out against the benchmark", async () => {
    const a = [...BENCH];
    a[99] = BENCH[99] * 1.35; // final bar: symbol +35% vs benchmark
    const client = new MockClient("k", "s", "u");
    mockKlines(client, { ETHUSDT: tuples(a), BTCUSDT: tuples(BENCH) });

    const result = await handleAnalyzePair(client, { symbol: "ETHUSDT" });

    expect(result.spread.zScore).not.toBeNull();
    expect(result.spread.zScore!).toBeGreaterThan(2);
    expect(result.spread.signal).toBe("spread_rich");
  });

  it("aligns on shared timestamps when one series skips bars", async () => {
    const a = BENCH.map((b) => (b * b) / 100);
    const client = new MockClient("k", "s", "u");
    mockKlines(client, {
      ETHUSDT: tuples(a),
      BTCUSDT: tuples(BENCH, [40, 41]), // benchmark missing two bars
    });

    const result = await handleAnalyzePair(client, { symbol: "ETHUSDT" });

    expect(result.barsAligned).toBe(98);
    expect(result.dataNote).toContain("align");
    expect(result.returns.correlationFull).toBeCloseTo(1, 6);
  });

  it("computes half-life on a mean-reverting spread", async () => {
    // lnA = lnB + e where e is a decaying AR(1) — spread mean-reverts.
    const e = Array.from({ length: 100 }, (_, t) => 0.2 * Math.pow(0.9, t));
    const a = BENCH.map((b, i) => b * Math.exp(e[i]));
    const client = new MockClient("k", "s", "u");
    mockKlines(client, { ETHUSDT: tuples(a), BTCUSDT: tuples(BENCH) });

    const result = await handleAnalyzePair(client, { symbol: "ETHUSDT", interval: "60" });

    expect(result.meanReversion.halfLifeBars).not.toBeNull();
    // Half-life of a phi=0.9 process ≈ 6.58 bars; the OLS hedge fit adds
    // noise, so accept a loose band.
    expect(result.meanReversion.halfLifeBars!).toBeGreaterThan(3);
    expect(result.meanReversion.halfLifeBars!).toBeLessThan(12);
    expect(result.meanReversion.halfLifeHours).toBeCloseTo(result.meanReversion.halfLifeBars!, 5);
  });

  it("rejects non-numeric limit and windowBars", async () => {
    const client = new MockClient("k", "s", "u");
    mockKlines(client, { ETHUSDT: tuples(BENCH), BTCUSDT: tuples(BENCH) });
    await expect(handleAnalyzePair(client, { symbol: "ETHUSDT", limit: "500" as unknown as number }))
      .rejects.toThrow("limit must be a finite number");
    await expect(handleAnalyzePair(client, { symbol: "ETHUSDT", windowBars: NaN }))
      .rejects.toThrow("windowBars must be a finite number");
  });

  it("rejects analyzing a symbol against itself", async () => {
    const client = new MockClient("k", "s", "u");
    mockKlines(client, { BTCUSDT: tuples(BENCH) });
    await expect(handleAnalyzePair(client, { symbol: "BTCUSDT" }))
      .rejects.toThrow("different from the benchmark");
  });

  it("throws when fewer than 50 bars align", async () => {
    const client = new MockClient("k", "s", "u");
    mockKlines(client, {
      ETHUSDT: tuples(BENCH.slice(0, 30)),
      BTCUSDT: tuples(BENCH.slice(0, 30)),
    });
    await expect(handleAnalyzePair(client, { symbol: "ETHUSDT" }))
      .rejects.toThrow("aligned");
  });
});
