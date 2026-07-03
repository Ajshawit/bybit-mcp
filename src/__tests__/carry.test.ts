import {
  handleGetCarryAnalytics,
  annualizedFundingPct,
  predictedFundingFromPremium,
  BasisResult,
  CarryScanResult,
} from "../tools/carry";
import { BybitClient } from "../client";

jest.mock("../client");
const MockClient = BybitClient as jest.MockedClass<typeof BybitClient>;

const H8 = 8 * 3600000;

function linearTicker(overrides: Record<string, string> = {}) {
  return {
    symbol: "BTCUSDT",
    lastPrice: "30100",
    markPrice: "30100",
    indexPrice: "30000",
    price24hPcnt: "0.02",
    fundingRate: "0.0001",
    nextFundingTime: String(Date.now() + H8),
    openInterestValue: "300000000",
    turnover24h: "150000000",
    ...overrides,
  };
}

function fundingHistory(rates: number[], intervalMs = H8) {
  const t0 = Date.now();
  return {
    list: rates.map((r, i) => ({
      symbol: "BTCUSDT",
      fundingRate: String(r),
      fundingRateTimestamp: String(t0 - i * intervalMs),
    })),
  };
}

describe("annualizedFundingPct", () => {
  it("matches 3 epochs/day for 8h funding", () => {
    // 0.01% per 8h → 0.0001 * 3 * 365 * 100 = 10.95%/yr
    expect(annualizedFundingPct(0.0001, 480)).toBeCloseTo(10.95, 6);
  });

  it("matches 24 epochs/day for 1h funding", () => {
    expect(annualizedFundingPct(-0.001, 60)).toBeCloseTo(-876, 6);
  });
});

describe("predictedFundingFromPremium", () => {
  it("pins to the interest rate when the premium is near zero (clamp not binding)", () => {
    // F = P + clamp(I - P) = I when |I - P| <= 0.05%
    expect(predictedFundingFromPremium(0.0002, 480)).toBeCloseTo(0.0001, 10);
    expect(predictedFundingFromPremium(-0.0003, 480)).toBeCloseTo(0.0001, 10);
  });

  it("tracks the premium when the clamp binds", () => {
    // P = 0.002, I = 0.0001 → I - P = -0.0019 clamps to -0.0005 → F = 0.0015
    expect(predictedFundingFromPremium(0.002, 480)).toBeCloseTo(0.0015, 10);
  });

  it("scales the interest component with the funding interval", () => {
    // 1h interval: I = 0.0001/8 → with zero premium F = I
    expect(predictedFundingFromPremium(0, 60)).toBeCloseTo(0.0001 / 8, 12);
  });
});

describe("handleGetCarryAnalytics action=basis", () => {
  it("computes mark-index basis, funding annualization, and prediction", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock)
      .mockResolvedValueOnce({ list: [linearTicker()] })           // linear ticker
      .mockResolvedValueOnce(fundingHistory([0.0001, 0.0002, 0.0003])) // funding history
      .mockResolvedValueOnce({ list: [{ ...linearTicker(), lastPrice: "30000" }] }) // spot
      .mockResolvedValueOnce({ list: [["1700000000000", "0.0002", "0.0002", "0.0002", "0.0002"]] }); // premium kline

    const result = await handleGetCarryAnalytics(client, { action: "basis", symbol: "BTCUSDT" }) as BasisResult;

    expect(result.action).toBe("basis");
    // (30100 - 30000) / 30000 * 100 = 0.3333%
    expect(result.perp.markIndexBasisPct).toBeCloseTo(0.3333, 3);
    expect(result.perp.fundingAnnualizedPct).toBeCloseTo(10.95, 2);
    expect(result.perp.fundingIntervalHours).toBe(8);
    // realized: mean of 0.0001/0.0002/0.0003 = 0.0002 → 21.9%/yr
    expect(result.realizedFunding!.epochs).toBe(3);
    expect(result.realizedFunding!.annualizedPct).toBeCloseTo(21.9, 1);
    // premium avg 0.0002 → clamp doesn't bind → predicted = I = 0.0001
    expect(result.predictedFunding!.rate).toBeCloseTo(0.0001, 8);
    // perp last 30100 vs spot 30000
    expect(result.spot!.perpSpotBasisPct).toBeCloseTo(0.3333, 3);
    expect(result.datedFuture).toBeNull();
  });

  it("soft-fails spot and premium-index fetches", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock)
      .mockResolvedValueOnce({ list: [linearTicker()] })
      .mockResolvedValueOnce(fundingHistory([0.0001, 0.0001]))
      .mockRejectedValueOnce(new Error("no spot market"))
      .mockRejectedValueOnce(new Error("no premium kline"));

    const result = await handleGetCarryAnalytics(client, { action: "basis", symbol: "TSLAPUSDT" }) as BasisResult;

    expect(result.spot).toBeNull();
    expect(result.predictedFunding).toBeNull();
    expect(result.perp.fundingRate).toBe(0.0001);
  });

  it("annualizes dated-futures basis against days to delivery", async () => {
    const deliveryMs = Date.now() + 73 * 86400000; // 73 days → 365/73 = 5x
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock)
      .mockResolvedValueOnce({
        list: [linearTicker({ markPrice: "30600", indexPrice: "30000", deliveryTime: String(deliveryMs) })],
      })
      .mockResolvedValueOnce(fundingHistory([]))
      .mockResolvedValueOnce({ list: [] })
      .mockResolvedValueOnce({ list: [] });

    const result = await handleGetCarryAnalytics(client, { action: "basis", symbol: "BTCUSDT-26DEC25" }) as BasisResult;

    expect(result.datedFuture).not.toBeNull();
    expect(result.datedFuture!.daysToDelivery).toBeCloseTo(73, 0);
    // (30600/30000 - 1) * 5 * 100 = 10%
    expect(result.datedFuture!.annualizedBasisPct).toBeCloseTo(10, 0);
  });

  it("throws when the symbol has no linear ticker", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock)
      .mockResolvedValueOnce({ list: [] })
      .mockResolvedValueOnce(fundingHistory([]))
      .mockResolvedValueOnce({ list: [] });

    await expect(handleGetCarryAnalytics(client, { action: "basis", symbol: "NOPEUSDT" }))
      .rejects.toThrow("No linear ticker found");
  });

  it("requires symbol for action=basis", async () => {
    const client = new MockClient("k", "s", "u");
    await expect(handleGetCarryAnalytics(client, { action: "basis" }))
      .rejects.toThrow("symbol is required");
  });
});

describe("handleGetCarryAnalytics action=scan", () => {
  const tickers = {
    list: [
      { ...linearTicker(), symbol: "AAAUSDT", fundingRate: "0.0005", turnover24h: "50000000" },
      { ...linearTicker(), symbol: "BBBUSDT", fundingRate: "-0.001", turnover24h: "20000000" },
      { ...linearTicker(), symbol: "TINYUSDT", fundingRate: "0.01", turnover24h: "1000" }, // filtered: volume
      { ...linearTicker(), symbol: "ZEROUSDT", fundingRate: "0", turnover24h: "90000000" }, // filtered: no carry
    ],
  };
  const instruments = {
    list: [
      { symbol: "AAAUSDT", fundingInterval: 480 },
      { symbol: "BBBUSDT", fundingInterval: 60 },
    ],
  };

  it("ranks both carry sides using per-symbol funding intervals", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock)
      .mockResolvedValueOnce(tickers)
      .mockResolvedValueOnce(instruments);

    const result = await handleGetCarryAnalytics(client, { action: "scan" }) as CarryScanResult;

    expect(result.shortPerpCollects).toHaveLength(1);
    expect(result.shortPerpCollects[0].symbol).toBe("AAAUSDT");
    // 0.0005 * 3 * 365 * 100 = 54.75
    expect(result.shortPerpCollects[0].fundingAnnualizedPct).toBeCloseTo(54.75, 2);
    expect(result.shortPerpCollects[0].fundingIntervalHours).toBe(8);

    expect(result.longPerpCollects).toHaveLength(1);
    expect(result.longPerpCollects[0].symbol).toBe("BBBUSDT");
    // -0.001 * 24 * 365 * 100 = -876
    expect(result.longPerpCollects[0].fundingAnnualizedPct).toBeCloseTo(-876, 1);
    expect(result.longPerpCollects[0].fundingIntervalHours).toBe(1);
    // No degraded condition — the static explanatory prose is gone entirely.
    expect(result.note).toBeUndefined();
  });

  it("falls back to 8h intervals with a note when instruments-info fails", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock)
      .mockResolvedValueOnce(tickers)
      .mockRejectedValueOnce(new Error("boom"));

    const result = await handleGetCarryAnalytics(client, { action: "scan" }) as CarryScanResult;

    expect(result.note).toContain("assumed 8h");
    expect(result.longPerpCollects[0].fundingIntervalHours).toBe(8);
  });

  it("respects the limit parameter", async () => {
    const many = {
      list: Array.from({ length: 30 }, (_, i) => ({
        ...linearTicker(),
        symbol: `S${i}USDT`,
        fundingRate: String(0.0001 * (i + 1)),
        turnover24h: "50000000",
      })),
    };
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock)
      .mockResolvedValueOnce(many)
      .mockResolvedValueOnce({ list: [] });

    const result = await handleGetCarryAnalytics(client, { action: "scan", limit: 5 }) as CarryScanResult;

    expect(result.shortPerpCollects).toHaveLength(5);
    // Sorted by annualized carry descending.
    expect(result.shortPerpCollects[0].symbol).toBe("S29USDT");
  });
});
