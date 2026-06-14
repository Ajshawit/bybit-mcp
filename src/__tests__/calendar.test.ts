import { handleGetEventCalendar } from "../tools/calendar";
import { BybitClient } from "../client";

jest.mock("../client");
const MockClient = BybitClient as jest.MockedClass<typeof BybitClient>;

const FUTURE_MS = Date.now() + 8 * 3600000;
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

// Bybit-format option symbol expiring ~`days` from now (clock-independent).
function optionSymbolDaysAhead(days: number, strike: number, type: "C" | "P"): string {
  const d = new Date(Date.now() + days * 86400000);
  const yy = String(d.getUTCFullYear()).slice(2);
  return `BTC-${d.getUTCDate()}${MONTHS[d.getUTCMonth()]}${yy}-${strike}-${type}-USDT`;
}

function ticker(symbol: string, overrides: Record<string, string> = {}) {
  return {
    symbol,
    lastPrice: "30000",
    price24hPcnt: "0.01",
    fundingRate: "0.0001",
    nextFundingTime: String(FUTURE_MS),
    openInterest: "1000",
    openInterestValue: "30000000",
    volume24h: "100",
    turnover24h: "3000000",
    highPrice24h: "31000",
    lowPrice24h: "29000",
    prevPrice24h: "29500",
    bid1Price: "29999",
    ask1Price: "30001",
    ...overrides,
  };
}

// Route publicGet by path + params so Promise.all ordering doesn't matter.
function mockPublicRoutes(client: BybitClient, opts: {
  optionChains?: Record<string, unknown>;
  instruments?: unknown;
  failTickers?: Set<string>;
}) {
  (client.publicGet as jest.Mock).mockImplementation((path: string, params: Record<string, string>) => {
    if (path.includes("instruments-info")) {
      return opts.instruments === undefined
        ? Promise.resolve({ list: [] })
        : opts.instruments === null
          ? Promise.reject(new Error("instruments down"))
          : Promise.resolve(opts.instruments);
    }
    if (path.includes("tickers")) {
      if (params.category === "option") {
        const chain = opts.optionChains?.[params.baseCoin];
        return chain === null
          ? Promise.reject(new Error("chain down"))
          : Promise.resolve(chain ?? { list: [] });
      }
      if (opts.failTickers?.has(params.symbol)) return Promise.reject(new Error("no ticker"));
      return Promise.resolve({ list: [ticker(params.symbol)] });
    }
    return Promise.reject(new Error(`unexpected publicGet ${path}`));
  });
}

describe("handleGetEventCalendar", () => {
  it("uses explicit symbols without touching positions", async () => {
    const client = new MockClient("k", "s", "u");
    mockPublicRoutes(client, {});

    const result = await handleGetEventCalendar(client, false, { symbols: ["BTCUSDT", "SOLUSDT"] });

    expect(client.signedGet).not.toHaveBeenCalled();
    expect(result.funding).toHaveLength(2);
    expect(result.funding[0].nextFundingTime).toBe(new Date(FUTURE_MS).toISOString());
    expect(result.funding[0].secondsToNextFunding).toBeGreaterThan(0);
    expect(result.optionsNote).toContain("Options module disabled");
    expect(result.optionExpiries).toBeUndefined();
    expect(result.nyse).toBeDefined();
  });

  it("derives funding symbols from open positions (category-aware)", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedGet as jest.Mock).mockImplementation((path: string, params: Record<string, string>) => {
      if (params.category === "linear") {
        return Promise.resolve({ list: [{ symbol: "ETHUSDT", size: "5" }, { symbol: "FLAT", size: "0" }] });
      }
      return Promise.resolve({ list: [{ symbol: "BTCUSD", size: "1000" }] });
    });
    mockPublicRoutes(client, {});

    const result = await handleGetEventCalendar(client, false);

    expect(result.funding.map((f) => f.symbol).sort()).toEqual(["BTCUSD", "ETHUSDT"]);
    expect(result.funding.find((f) => f.symbol === "BTCUSD")!.category).toBe("inverse");
    expect(result.fundingNote).toContain("derived from open positions");
  });

  it("falls back to majors with no positions and notes skipped symbols", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedGet as jest.Mock).mockResolvedValue({ list: [] });
    mockPublicRoutes(client, { failTickers: new Set(["ETHUSDT"]) });

    const result = await handleGetEventCalendar(client, false);

    expect(result.fundingNote).toContain("No open positions");
    expect(result.fundingNote).toContain("No ticker for: ETHUSDT");
    expect(result.funding.map((f) => f.symbol)).toEqual(["BTCUSDT"]);
  });

  it("groups option expiries with OI notional and respects daysAhead", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedGet as jest.Mock).mockResolvedValue({ list: [] });
    const nearCall = optionSymbolDaysAhead(30, 30000, "C");
    const nearPut = optionSymbolDaysAhead(30, 28000, "P");
    const farCall = optionSymbolDaysAhead(200, 30000, "C"); // outside default 45d window
    mockPublicRoutes(client, {
      optionChains: {
        BTC: {
          list: [
            { symbol: nearCall, openInterest: "100", underlyingPrice: "30000", markIv: "0.5" },
            { symbol: nearPut, openInterest: "50", underlyingPrice: "30000", markIv: "0.5" },
            { symbol: farCall, openInterest: "10", underlyingPrice: "30000", markIv: "0.5" },
          ],
        },
        ETH: { list: [] },
        SOL: { list: [] },
      },
    });

    const result = await handleGetEventCalendar(client, true);

    expect(result.optionExpiries).toBeDefined();
    const btc = result.optionExpiries!.BTC;
    expect(btc).toHaveLength(1); // both 30d strikes share one expiry; 200d outside window
    expect(btc[0].contracts).toBe(2);
    expect(btc[0].totalOpenInterest).toBe(150);
    expect(btc[0].oiNotionalUsd).toBe(150 * 30000);
    expect(btc[0].daysToExpiry).toBeGreaterThan(25);
    expect(btc[0].daysToExpiry).toBeLessThan(35);
    expect(result.optionExpiries!.ETH).toBeUndefined(); // empty chains omitted
  });

  it("notes per-underlying option chain failures without dying", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedGet as jest.Mock).mockResolvedValue({ list: [] });
    mockPublicRoutes(client, {
      optionChains: { BTC: null, ETH: { list: [] }, SOL: { list: [] } },
    });

    const result = await handleGetEventCalendar(client, true);

    expect(result.optionsNote).toContain("Option chain fetch failed for: BTC");
  });

  it("lists dated-futures deliveries inside the window, sorted", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedGet as jest.Mock).mockResolvedValue({ list: [] });
    const in10d = Date.now() + 10 * 86400000;
    const in3d = Date.now() + 3 * 86400000;
    const in400d = Date.now() + 400 * 86400000;
    mockPublicRoutes(client, {
      instruments: {
        list: [
          { symbol: "BTCUSDT-FAR", deliveryTime: String(in400d) },
          { symbol: "BTCUSDT-10D", deliveryTime: String(in10d) },
          { symbol: "BTCUSDT-3D", deliveryTime: String(in3d) },
          { symbol: "BTCUSDT", deliveryTime: "0" }, // perp — no delivery
        ],
      },
    });

    const result = await handleGetEventCalendar(client, false, { symbols: ["BTCUSDT"] });

    expect(result.futuresDeliveries.map((d) => d.symbol)).toEqual(["BTCUSDT-3D", "BTCUSDT-10D"]);
    expect(result.futuresDeliveries[0].daysToDelivery).toBeCloseTo(3, 0);
  });

  it("soft-fails the instruments fetch with a note", async () => {
    const client = new MockClient("k", "s", "u");
    mockPublicRoutes(client, { instruments: null });

    const result = await handleGetEventCalendar(client, false, { symbols: ["BTCUSDT"] });

    expect(result.futuresDeliveries).toEqual([]);
    expect(result.deliveriesNote).toContain("Instruments fetch failed");
  });

  it("clamps daysAhead to [1, 365]", async () => {
    const client = new MockClient("k", "s", "u");
    mockPublicRoutes(client, {});

    const result = await handleGetEventCalendar(client, false, { symbols: ["BTCUSDT"], daysAhead: 9999 });
    expect(result.daysAhead).toBe(365);
  });
});
