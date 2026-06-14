import { handleGetPortfolioRisk } from "../tools/portfolio";
import { blackScholesPrice } from "../tools/options/blackscholes";
import { BybitClient } from "../client";

jest.mock("../client");
const MockClient = BybitClient as jest.MockedClass<typeof BybitClient>;

function linearPosition(overrides: Record<string, unknown> = {}) {
  return {
    symbol: "BTCUSDT", side: "Buy", size: "0.5", avgPrice: "29000", markPrice: "30000",
    unrealisedPnl: "500", stopLoss: "", takeProfit: "", trailingStop: "0",
    liquidationPrice: "", positionIdx: 0, leverage: "3", positionIM: "100",
    ...overrides,
  };
}

// Routes signedGet by path/category so Promise.all ordering doesn't matter.
function mockSignedRoutes(client: BybitClient, routes: {
  wallet?: unknown; linear?: unknown; inverse?: unknown; option?: unknown;
  walletRejects?: boolean;
}) {
  (client.signedGet as jest.Mock).mockImplementation((path: string, params: Record<string, string>) => {
    if (path.includes("wallet-balance")) {
      return routes.walletRejects
        ? Promise.reject(new Error("auth"))
        : Promise.resolve(routes.wallet ?? { list: [{ totalEquity: "10000", coin: [] }] });
    }
    if (path.includes("position/list")) {
      if (params.category === "linear") return Promise.resolve(routes.linear ?? { list: [] });
      if (params.category === "inverse") return Promise.resolve(routes.inverse ?? { list: [] });
      if (params.category === "option") return Promise.resolve(routes.option ?? { list: [] });
    }
    return Promise.reject(new Error(`unexpected signedGet ${path}`));
  });
}

const OPTION_SYMBOL = "BTC-25APR30-30000-C-USDT"; // far-future expiry
const optionPosition = {
  symbol: OPTION_SYMBOL, side: "Buy", size: "2", avgPrice: "1000", markPrice: "1200",
  delta: "1.2", gamma: "0.0001", theta: "-15", vega: "40",
};
const optionChain = {
  list: [{
    symbol: OPTION_SYMBOL, markIv: "0.5", underlyingPrice: "30000",
    lastPrice: "1200", bid1Price: "1190", ask1Price: "1210", markPrice: "1200",
    openInterest: "100", volume24h: "10", delta: "0.6", gamma: "0", theta: "0", vega: "0",
  }],
};

describe("blackScholesPrice", () => {
  it("matches the known ATM value (S=K=100, T=1, sigma=0.2, r=0)", () => {
    expect(blackScholesPrice("call", 100, 100, 1, 0.2)).toBeCloseTo(7.9656, 3);
    // r=0 ATM: put = call by parity
    expect(blackScholesPrice("put", 100, 100, 1, 0.2)).toBeCloseTo(7.9656, 3);
  });

  it("obeys put-call parity off the money (r=0: C - P = S - K)", () => {
    const call = blackScholesPrice("call", 110, 100, 0.5, 0.4);
    const put = blackScholesPrice("put", 110, 100, 0.5, 0.4);
    expect(call - put).toBeCloseTo(10, 6);
  });

  it("collapses to intrinsic value at expiry", () => {
    expect(blackScholesPrice("call", 110, 100, 0, 0.5)).toBe(10);
    expect(blackScholesPrice("put", 90, 100, 0, 0.5)).toBe(10);
    expect(blackScholesPrice("call", 90, 100, 0, 0.5)).toBe(0);
  });
});

describe("handleGetPortfolioRisk — perp only", () => {
  it("aggregates linear perp delta and builds a spot-only scenario grid", async () => {
    const client = new MockClient("k", "s", "u");
    mockSignedRoutes(client, { linear: { list: [linearPosition()] } });

    const result = await handleGetPortfolioRisk(client, false);

    expect(result.equityUsd).toBe(10000);
    expect(result.byUnderlying).toHaveLength(1);
    const btc = result.byUnderlying[0];
    expect(btc.underlying).toBe("BTC");
    expect(btc.perpDeltaUsd).toBe(15000); // 0.5 * 30000
    expect(btc.netDeltaUsd).toBe(15000);

    expect(result.totals.netDeltaUsd).toBe(15000);
    expect(result.totals.leverageRatio).toBe(1.5);
    expect(result.totals.concentrationPct).toBe(100);

    // No options → IV axis collapses to [0].
    expect(result.scenarios.ivShocksPts).toEqual([0]);
    const up10 = result.scenarios.grid.find((c) => c.spotShockPct === 10)!;
    expect(up10.pnlUsd).toBeCloseTo(1500, 2);
    expect(up10.pnlPctOfEquity).toBeCloseTo(15, 2);
    expect(result.scenarios.worstCase!.spotShockPct).toBe(-20);
    expect(result.scenarios.worstCase!.pnlUsd).toBeCloseTo(-3000, 2);
  });

  it("nets longs against shorts across underlyings", async () => {
    const client = new MockClient("k", "s", "u");
    mockSignedRoutes(client, {
      linear: {
        list: [
          linearPosition(),
          linearPosition({ symbol: "ETHUSDT", side: "Sell", size: "5", markPrice: "2000" }),
        ],
      },
    });

    const result = await handleGetPortfolioRisk(client, false);

    expect(result.totals.netDeltaUsd).toBe(5000);    // +15000 - 10000
    expect(result.totals.grossDeltaUsd).toBe(25000);
    expect(result.totals.concentrationPct).toBe(60); // 15000 / 25000
    const flat = result.scenarios.grid.find((c) => c.spotShockPct === 0)!;
    expect(flat.pnlUsd).toBe(0);
  });

  it("includes inverse perps as USD-notional delta with a warning", async () => {
    const client = new MockClient("k", "s", "u");
    mockSignedRoutes(client, {
      inverse: { list: [linearPosition({ symbol: "BTCUSD", side: "Sell", size: "30000", markPrice: "30000" })] },
    });

    const result = await handleGetPortfolioRisk(client, false);

    expect(result.byUnderlying[0].underlying).toBe("BTC");
    expect(result.byUnderlying[0].perpDeltaUsd).toBe(-30000);
    expect(result.byUnderlying[0].perpDeltaUnits).toBeCloseTo(-1, 4);
    expect(result.warnings.some((w) => w.includes("Inverse perp delta"))).toBe(true);
  });

  it("reports a flat portfolio with zeroed totals", async () => {
    const client = new MockClient("k", "s", "u");
    mockSignedRoutes(client, {});

    const result = await handleGetPortfolioRisk(client, false);

    expect(result.byUnderlying).toHaveLength(0);
    expect(result.totals.netDeltaUsd).toBe(0);
    expect(result.warnings.some((w) => w.includes("No open positions"))).toBe(true);
    expect(result.scenarios.grid.every((c) => c.pnlUsd === 0)).toBe(true);
  });

  it("degrades gracefully when equity is unavailable", async () => {
    const client = new MockClient("k", "s", "u");
    mockSignedRoutes(client, { walletRejects: true, linear: { list: [linearPosition()] } });

    const result = await handleGetPortfolioRisk(client, false);

    expect(result.equityUsd).toBeNull();
    expect(result.totals.leverageRatio).toBeNull();
    expect(result.scenarios.grid[0].pnlPctOfEquity).toBeNull();
    expect(result.warnings.some((w) => w.includes("Equity unavailable"))).toBe(true);
  });
});

describe("handleGetPortfolioRisk — with options", () => {
  it("merges perp and option exposure under one underlying and reprices via Black-Scholes", async () => {
    const client = new MockClient("k", "s", "u");
    mockSignedRoutes(client, {
      linear: { list: [linearPosition()] },
      option: { list: [optionPosition] },
    });
    (client.publicGet as jest.Mock).mockResolvedValue(optionChain);

    const result = await handleGetPortfolioRisk(client, true);

    expect(result.byUnderlying).toHaveLength(1);
    const btc = result.byUnderlying[0];
    expect(btc.perpDeltaUsd).toBe(15000);
    expect(btc.optionDeltaUsd).toBeCloseTo(1.2 * 30000, 2); // Bybit position delta × spot
    expect(btc.netDeltaUsd).toBeCloseTo(15000 + 36000, 2);
    expect(btc.vegaUsdPer1IvPt).toBe(40);
    expect(btc.thetaUsdPerDay).toBe(-15);

    // IV axis active, zero-shock cell exactly 0 (model-anchored repricing).
    expect(result.scenarios.ivShocksPts).toEqual([-10, 0, 10]);
    const zero = result.scenarios.grid.find((c) => c.spotShockPct === 0 && c.ivShockPts === 0)!;
    expect(zero.pnlUsd).toBe(0);

    // Long call: +IV is a gain, spot crash is the worst cell.
    const ivUp = result.scenarios.grid.find((c) => c.spotShockPct === 0 && c.ivShockPts === 10)!;
    expect(ivUp.pnlUsd).toBeGreaterThan(0);
    expect(result.scenarios.worstCase!.spotShockPct).toBe(-20);

    // Option chain fetched once, for BTC.
    expect(client.publicGet).toHaveBeenCalledWith("/v5/market/tickers", {
      category: "option", baseCoin: "BTC",
    });
  });

  it("falls back to the greeks Taylor expansion when markIv is missing", async () => {
    const client = new MockClient("k", "s", "u");
    mockSignedRoutes(client, { option: { list: [optionPosition] } });
    // Chain has spot but no IV for our symbol.
    (client.publicGet as jest.Mock).mockResolvedValue({
      list: [{ ...optionChain.list[0], symbol: "BTC-25APR30-40000-C-USDT", markIv: "" }],
    });

    const result = await handleGetPortfolioRisk(client, true);

    expect(result.warnings.some((w) => w.includes("No markIv found") && w.includes(OPTION_SYMBOL))).toBe(true);
    // Taylor: dS=0, dIV=+10pts → pnl = vega * 10 = 400.
    const ivUp = result.scenarios.grid.find((c) => c.spotShockPct === 0 && c.ivShockPts === 10)!;
    expect(ivUp.pnlUsd).toBeCloseTo(400, 2);
  });

  it("warns and degrades when the whole chain fetch fails", async () => {
    const client = new MockClient("k", "s", "u");
    mockSignedRoutes(client, { option: { list: [optionPosition] } });
    (client.publicGet as jest.Mock).mockRejectedValue(new Error("chain down"));

    const result = await handleGetPortfolioRisk(client, true);

    expect(result.warnings.some((w) => w.includes("Option chain fetch failed for BTC"))).toBe(true);
    // No spot → vega-only scenario contribution.
    const ivUp = result.scenarios.grid.find((c) => c.spotShockPct === 0 && c.ivShockPts === 10)!;
    expect(ivUp.pnlUsd).toBeCloseTo(400, 2);
  });

  it("skips unparseable option symbols without dying", async () => {
    const client = new MockClient("k", "s", "u");
    mockSignedRoutes(client, {
      option: { list: [{ ...optionPosition, symbol: "GARBAGE" }] },
    });

    const result = await handleGetPortfolioRisk(client, true);

    expect(result.warnings.some((w) => w.includes("unparseable symbol"))).toBe(true);
    expect(result.byUnderlying).toHaveLength(0);
  });
});

describe("handleGetPortfolioRisk — shock validation", () => {
  it("rejects oversized or non-numeric shock arrays", async () => {
    const client = new MockClient("k", "s", "u");
    await expect(handleGetPortfolioRisk(client, false, {
      spotShocksPct: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    })).rejects.toThrow("at most 9");
    await expect(handleGetPortfolioRisk(client, false, {
      spotShocksPct: [5, NaN],
    })).rejects.toThrow("non-numeric");
  });

  it("auto-includes the zero anchor and sorts shocks", async () => {
    const client = new MockClient("k", "s", "u");
    mockSignedRoutes(client, { linear: { list: [linearPosition()] } });

    const result = await handleGetPortfolioRisk(client, false, { spotShocksPct: [15, -15] });
    expect(result.scenarios.spotShocksPct).toEqual([-15, 0, 15]);
  });
});
