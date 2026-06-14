import {
  handleCalculatePositionSize,
  riskPerTradeQty,
  kellyFromStats,
  estimateLiqPrice,
  maxLeverageForStop,
} from "../tools/sizing";
import { closeToCloseVol } from "../tools/volatility";
import { BybitClient } from "../client";

jest.mock("../client");
const MockClient = BybitClient as jest.MockedClass<typeof BybitClient>;

// Kline tuples newest-first (Bybit native order) from oldest-first closes.
function klinesFromCloses(closes: number[]): string[][] {
  const tuples: string[][] = [];
  for (let i = 0; i < closes.length; i++) {
    const open = i > 0 ? closes[i - 1] : closes[i];
    tuples.push([
      String(1700000000000 + i * 3600000),
      String(open), String(Math.max(open, closes[i])), String(Math.min(open, closes[i])), String(closes[i]),
      "100", "3000000",
    ]);
  }
  return tuples.reverse();
}

interface MockApiOptions {
  lastPrice?: string;
  totalEquity?: string;
  qtyStep?: string;
  klineCloses?: number[];
  closedPnl?: Array<{ closedPnl: string }>;
}

function mockApi(client: BybitClient, opts: MockApiOptions = {}): void {
  const {
    lastPrice = "100",
    totalEquity = "10000",
    qtyStep = "0.001",
    klineCloses = [],
    closedPnl = [],
  } = opts;

  (client.publicGet as jest.Mock).mockImplementation(async (path: string, params: Record<string, string>) => {
    if (path === "/v5/market/instruments-info") {
      return {
        list: [{
          symbol: params.symbol,
          priceFilter: { tickSize: "0.1" },
          lotSizeFilter: { qtyStep, minOrderQty: qtyStep },
          minNotionalValue: "5",
        }],
      };
    }
    if (path === "/v5/market/tickers") {
      return { list: [{ symbol: params.symbol, lastPrice }] };
    }
    if (path === "/v5/market/kline") {
      return { list: klinesFromCloses(klineCloses) };
    }
    throw new Error(`Unexpected publicGet: ${path}`);
  });

  (client.signedGet as jest.Mock).mockImplementation(async (path: string) => {
    if (path === "/v5/account/wallet-balance") {
      return { list: [{ accountType: "UNIFIED", totalEquity, totalMaintenanceMargin: "0", coin: [] }] };
    }
    if (path === "/v5/position/closed-pnl") {
      return {
        list: closedPnl.map((t, i) => ({
          symbol: "BTCUSDT", side: "Sell", closedPnl: t.closedPnl,
          avgEntryPrice: "100", avgExitPrice: "101", qty: "1", closedSize: "1",
          cumEntryValue: "100", cumExitValue: "101", leverage: "5",
          createdTime: String(1700000000000 + i * 60000), updatedTime: String(1700000100000 + i * 60000),
          orderType: "Market", execType: "Trade",
        })),
      };
    }
    throw new Error(`Unexpected signedGet: ${path}`);
  });
}

describe("riskPerTradeQty", () => {
  it("computes linear qty as risk / stop distance", () => {
    expect(riskPerTradeQty(100, 100, 95, "linear")).toBe(20);
  });

  it("computes spot qty the same as linear", () => {
    expect(riskPerTradeQty(50, 200, 190, "spot")).toBe(5);
  });

  it("computes inverse contracts so the coin loss at the stop is worth the risk in USD", () => {
    // 2000 contracts long from 100, stopped at 95: loss = 2000*(1/95-1/100)
    // coin = 1.0526 coin, worth $100 at the stop.
    expect(riskPerTradeQty(100, 100, 95, "inverse")).toBeCloseTo(2000, 8);
  });

  it("throws when entry and stop coincide", () => {
    expect(() => riskPerTradeQty(100, 100, 100, "linear")).toThrow("stop distance is zero");
  });
});

describe("kellyFromStats", () => {
  it("matches the closed-form Kelly fraction", () => {
    // f* = p - (1-p)/R = 0.6 - 0.4/2 = 0.4
    expect(kellyFromStats(0.6, 200, 100)).toBeCloseTo(0.4, 10);
  });

  it("returns a negative fraction when there is no edge", () => {
    expect(kellyFromStats(0.3, 100, 100)).toBeCloseTo(-0.4, 10);
  });

  it("returns null on degenerate inputs", () => {
    expect(kellyFromStats(0.6, 200, 0)).toBeNull();
    expect(kellyFromStats(1.2, 200, 100)).toBeNull();
    expect(kellyFromStats(-0.1, 200, 100)).toBeNull();
  });
});

describe("estimateLiqPrice", () => {
  it("matches the linear long formula used by place_trade dry runs", () => {
    expect(estimateLiqPrice(100, 10, "Buy", "linear")).toBeCloseTo(100 * (1 - 0.1 + 0.005), 10);
  });

  it("matches the linear short formula", () => {
    expect(estimateLiqPrice(100, 10, "Sell", "linear")).toBeCloseTo(100 * (1 + 0.1 - 0.005), 10);
  });

  it("matches the inverse long formula", () => {
    expect(estimateLiqPrice(100, 10, "Buy", "inverse")).toBeCloseTo(100 * 10 / (10 + 1 - 0.005 * 10), 10);
  });

  it("matches the inverse short formula", () => {
    expect(estimateLiqPrice(100, 10, "Sell", "inverse")).toBeCloseTo(100 * 10 / (10 - 1 + 0.005 * 10), 10);
  });
});

describe("maxLeverageForStop", () => {
  it("solves the linear long case with zero buffer", () => {
    // liq(L) = stop → 1/L = (entry-stop)/entry + mmr → L = 1/0.055
    expect(maxLeverageForStop(100, 95, "Buy", "linear", 0.005, 0)).toBeCloseTo(1 / 0.055, 8);
  });

  it("applies the buffer beyond the stop", () => {
    // stopEff = 95 - 0.1*5 = 94.5 → L = 1/(0.055 + 0.005)
    expect(maxLeverageForStop(100, 95, "Buy", "linear", 0.005, 0.1)).toBeCloseTo(1 / 0.06, 8);
  });

  it("round-trips with estimateLiqPrice for inverse longs", () => {
    const lev = maxLeverageForStop(100, 95, "Buy", "inverse", 0.005, 0)!;
    expect(estimateLiqPrice(100, lev, "Buy", "inverse")).toBeCloseTo(95, 6);
  });

  it("round-trips with estimateLiqPrice for inverse shorts", () => {
    const lev = maxLeverageForStop(100, 105, "Sell", "inverse", 0.005, 0)!;
    expect(estimateLiqPrice(100, lev, "Sell", "inverse")).toBeCloseTo(105, 6);
  });

  it("returns null when the stop can never be protected", () => {
    // Inverse short with a stop so far away the formula denominator flips.
    expect(maxLeverageForStop(100, 0.5, "Sell", "inverse", 0.005, 0)).toBeNull();
  });
});

describe("handleCalculatePositionSize — risk_per_trade", () => {
  it("sizes from default 1% equity risk and the stop distance", async () => {
    const client = new MockClient("k", "s", "u");
    mockApi(client);

    const result = await handleCalculatePositionSize(client, {
      symbol: "BTCUSDT", method: "risk_per_trade", stopPrice: 95, leverage: 5,
    });

    expect(result.qty).toBe("20.000");
    expect(result.entryPrice).toBe(100);
    expect(result.equityUsd).toBe(10000);
    expect(result.equitySource).toBe("wallet");
    expect(result.riskUsd).toBeCloseTo(100, 8);
    expect(result.riskPctOfEquity).toBeCloseTo(1, 8);
    expect(result.stopDistancePct).toBeCloseTo(5, 8);
    expect(result.notionalUsd).toBeCloseTo(2000, 8);
    expect(result.marginRequiredUsd).toBeCloseTo(400, 8);
    expect(result.qtyUnit).toBe("base");
    expect(result.liquidation).toBeDefined();
    expect(result.liquidation!.estimatedLiqPrice).toBeCloseTo(80.5, 8);
    expect(result.liquidation!.stopBeforeLiq).toBe(true);
    expect(result.liquidation!.maxSafeLeverage).toBeCloseTo(16.67, 2);
    expect(result.warnings).toEqual([]);
  });

  it("uses explicit riskUsd and skips the wallet fetch when equityUsd is given", async () => {
    const client = new MockClient("k", "s", "u");
    mockApi(client);

    const result = await handleCalculatePositionSize(client, {
      symbol: "BTCUSDT", method: "risk_per_trade", stopPrice: 90, riskUsd: 500, equityUsd: 50000,
    });

    expect(result.qty).toBe("50.000");
    expect(result.equitySource).toBe("override");
    expect(client.signedGet).not.toHaveBeenCalled();
  });

  it("rejects supplying both riskUsd and riskPctEquity", async () => {
    const client = new MockClient("k", "s", "u");
    mockApi(client);
    await expect(handleCalculatePositionSize(client, {
      symbol: "BTCUSDT", method: "risk_per_trade", stopPrice: 95, riskUsd: 100, riskPctEquity: 2,
    })).rejects.toThrow("either riskUsd or riskPctEquity");
  });

  it("rejects a stop on the wrong side of entry", async () => {
    const client = new MockClient("k", "s", "u");
    mockApi(client);
    await expect(handleCalculatePositionSize(client, {
      symbol: "BTCUSDT", method: "risk_per_trade", stopPrice: 105,
    })).rejects.toThrow("below entry");
    await expect(handleCalculatePositionSize(client, {
      symbol: "BTCUSDT", method: "risk_per_trade", side: "Sell", stopPrice: 95,
    })).rejects.toThrow("above entry");
  });

  it("rejects spot shorts", async () => {
    const client = new MockClient("k", "s", "u");
    mockApi(client);
    await expect(handleCalculatePositionSize(client, {
      symbol: "BTCUSDT", method: "risk_per_trade", category: "spot", side: "Sell", stopPrice: 105,
    })).rejects.toThrow("spot");
  });

  it("sizes inverse positions in USD contracts", async () => {
    const client = new MockClient("k", "s", "u");
    mockApi(client, { qtyStep: "1" });

    const result = await handleCalculatePositionSize(client, {
      symbol: "BTCUSD", method: "risk_per_trade", category: "inverse", stopPrice: 95, riskUsd: 100,
    });

    expect(result.qty).toBe("2000");
    expect(result.qtyUnit).toBe("usd_contracts");
    expect(result.notionalUsd).toBeCloseTo(2000, 8);
    expect(result.riskUsd).toBeCloseTo(100, 6);
  });

  it("warns when liquidation would hit before the stop", async () => {
    const client = new MockClient("k", "s", "u");
    mockApi(client);

    const result = await handleCalculatePositionSize(client, {
      symbol: "BTCUSDT", method: "risk_per_trade", stopPrice: 95, leverage: 25,
    });

    // liq = 100*(1 - 0.04 + 0.005) = 96.5, inside the 95 stop
    expect(result.liquidation!.stopBeforeLiq).toBe(false);
    expect(result.warnings.some((w) => w.includes("before the stop"))).toBe(true);
  });
});

describe("handleCalculatePositionSize — kelly", () => {
  it("sizes from explicit stats with the default quarter-Kelly fraction", async () => {
    const client = new MockClient("k", "s", "u");
    mockApi(client);

    const result = await handleCalculatePositionSize(client, {
      symbol: "BTCUSDT", method: "kelly", stopPrice: 95,
      winRate: 0.6, avgWinUsd: 200, avgLossUsd: 100,
    });

    // fullKelly 0.4 × 0.25 = 0.1 → risk $1000 → qty 1000/5 = 200
    expect(result.qty).toBe("200.000");
    expect(result.kelly).toBeDefined();
    expect(result.kelly!.fullKelly).toBeCloseTo(0.4, 8);
    expect(result.kelly!.fractionApplied).toBe(0.25);
    expect(result.kelly!.source).toBe("params");
    expect(result.riskUsd).toBeCloseTo(1000, 6);
  });

  it("returns zero qty with a warning when the edge is negative", async () => {
    const client = new MockClient("k", "s", "u");
    mockApi(client);

    const result = await handleCalculatePositionSize(client, {
      symbol: "BTCUSDT", method: "kelly", stopPrice: 95,
      winRate: 0.3, avgWinUsd: 100, avgLossUsd: 100,
    });

    expect(parseFloat(result.qty)).toBe(0);
    expect(result.warnings.some((w) => w.includes("edge"))).toBe(true);
  });

  it("derives stats from closed-trade history when not supplied", async () => {
    const closedPnl = [
      ...Array.from({ length: 7 }, () => ({ closedPnl: "100" })),
      ...Array.from({ length: 5 }, () => ({ closedPnl: "-50" })),
    ];
    const client = new MockClient("k", "s", "u");
    mockApi(client, { closedPnl });

    const result = await handleCalculatePositionSize(client, {
      symbol: "BTCUSDT", method: "kelly", stopPrice: 95,
    });

    // p = 7/12, R = 2 → f* = 7/12 - (5/12)/2 = 0.375; ×0.25 → risk $937.50
    expect(result.kelly!.source).toBe("history");
    expect(result.kelly!.tradesAnalyzed).toBe(12);
    expect(result.kelly!.winRate).toBeCloseTo(7 / 12, 8);
    expect(result.kelly!.fullKelly).toBeCloseTo(0.375, 8);
    expect(result.riskUsd).toBeCloseTo(937.5, 4);
    expect(result.qty).toBe("187.500");
  });

  it("refuses to size from fewer than 10 historical trades", async () => {
    const client = new MockClient("k", "s", "u");
    mockApi(client, { closedPnl: Array.from({ length: 5 }, () => ({ closedPnl: "100" })) });

    const result = await handleCalculatePositionSize(client, {
      symbol: "BTCUSDT", method: "kelly", stopPrice: 95,
    });

    expect(parseFloat(result.qty)).toBe(0);
    expect(result.warnings.some((w) => w.includes("10"))).toBe(true);
  });
});

describe("handleCalculatePositionSize — vol_target", () => {
  it("sizes so the position contributes the target annualized vol on equity", async () => {
    const closes = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 100 : 110));
    const client = new MockClient("k", "s", "u");
    mockApi(client, { klineCloses: closes });

    const result = await handleCalculatePositionSize(client, {
      symbol: "BTCUSDT", method: "vol_target", targetAnnualVolPct: 20,
    });

    const bars = closes.map((c, i) => ({
      open: i > 0 ? closes[i - 1] : c,
      high: Math.max(i > 0 ? closes[i - 1] : c, c),
      low: Math.min(i > 0 ? closes[i - 1] : c, c),
      close: c,
    }));
    const expectedVol = closeToCloseVol(bars, 365 * 24)!;
    const expectedNotional = 10000 * 0.2 / expectedVol;

    expect(result.volTarget).toBeDefined();
    expect(result.volTarget!.assetAnnualVol).toBeCloseTo(expectedVol, 3);
    expect(result.notionalUsd).toBeCloseTo(expectedNotional, 0);
    expect(parseFloat(result.qty)).toBeCloseTo(expectedNotional / 100, 2);
    expect(result.warnings).toEqual([]);
  });

  it("returns zero qty when realized vol is zero", async () => {
    const client = new MockClient("k", "s", "u");
    mockApi(client, { klineCloses: Array.from({ length: 60 }, () => 100) });

    const result = await handleCalculatePositionSize(client, {
      symbol: "BTCUSDT", method: "vol_target", targetAnnualVolPct: 20,
    });

    expect(parseFloat(result.qty)).toBe(0);
    expect(result.warnings.some((w) => w.toLowerCase().includes("vol"))).toBe(true);
  });

  it("requires targetAnnualVolPct", async () => {
    const client = new MockClient("k", "s", "u");
    mockApi(client);
    await expect(handleCalculatePositionSize(client, {
      symbol: "BTCUSDT", method: "vol_target",
    })).rejects.toThrow("targetAnnualVolPct");
  });
});
