import {
  handleGetOptionChain,
  CompactOptionChainResult,
  FullOptionChainResult,
} from "../../tools/options/chain";
import { BybitClient } from "../../client";

jest.mock("../../client");
const MockClient = BybitClient as jest.MockedClass<typeof BybitClient>;

const NOW = new Date("2026-04-19T12:00:00Z").getTime();

const mockOptionTicker = (symbol: string, bid: string, ask: string, iv: string, oi: string) => ({
  symbol,
  lastPrice: ask,
  bid1Price: bid,
  ask1Price: ask,
  markPrice: ((parseFloat(bid) + parseFloat(ask)) / 2).toString(),
  markIv: iv,
  openInterest: oi,
  volume24h: "10",
  delta: "0.5",
  gamma: "0.0001",
  theta: "-50",
  vega: "100",
  underlyingPrice: "95000",
});

const mockChainResponse = {
  list: [
    mockOptionTicker("BTC-25APR26-80000-C-USDT", "1100", "1200", "0.65", "100"),
    mockOptionTicker("BTC-25APR26-100000-C-USDT", "200", "250", "0.70", "50"),
    mockOptionTicker("BTC-25APR26-80000-P-USDT", "900", "1000", "0.68", "5"),  // low OI
  ],
  category: "option",
};

const mockSpotResponse = (symbol = "BTCUSDT", lastPrice = "95000") => ({
  list: [{ symbol, lastPrice, price24hPcnt: "0.01",
    fundingRate: "0", nextFundingTime: "0", openInterest: "0", openInterestValue: "0",
    volume24h: "0", turnover24h: "0", highPrice24h: "0", lowPrice24h: "0",
    prevPrice24h: "0", bid1Price: "0", ask1Price: "0" }],
  category: "spot",
});

const clientWith = (chainResponse: object, spotResponse: object = mockSpotResponse()) => {
  const client = new MockClient("k", "s", "u");
  (client.publicGet as jest.Mock)
    .mockResolvedValueOnce(chainResponse)
    .mockResolvedValueOnce(spotResponse);
  return client;
};

describe("handleGetOptionChain", () => {
  beforeEach(() => jest.spyOn(Date, "now").mockReturnValue(NOW));
  afterEach(() => jest.restoreAllMocks());

  it("fetches option chain and spot price in parallel", async () => {
    const client = clientWith(mockChainResponse);
    await handleGetOptionChain(client, { underlying: "BTC" });

    const calls = (client.publicGet as jest.Mock).mock.calls;
    expect(calls[0][1]).toMatchObject({ category: "option", baseCoin: "BTC" });
    expect(calls[1][1]).toMatchObject({ category: "spot", symbol: "BTCUSDT" });
  });

  it("returns spot price, counts, format string, and serverTimestamp", async () => {
    const client = clientWith(mockChainResponse);
    const result = await handleGetOptionChain(client, { underlying: "BTC" }) as CompactOptionChainResult;

    expect(result.underlying).toBe("BTC");
    expect(result.spot).toBe(95000);
    expect(result.returned).toBe(2);   // low-OI put filtered out
    expect(result.matched).toBe(2);
    expect(result.contractsFormat).toBe(
      'contracts: [strike, "C"|"P", bid, ask, iv, openInterest]; symbol = {UNDERLYING}-{expiryToken}-{strike}-{C|P}-USDT'
    );
    expect(result.serverTimestamp).toBe(new Date(NOW).toISOString());
  });

  it("groups compact contracts by expiry with tuple field order [strike, C|P, bid, ask, iv, oi]", async () => {
    const client = clientWith(mockChainResponse);
    const result = await handleGetOptionChain(client, { underlying: "BTC" }) as CompactOptionChainResult;

    expect(result.expiries).toHaveLength(1);
    const expiry = result.expiries[0];
    expect(expiry.expiryToken).toBe("25APR26");
    expect(expiry.expiryDate).toBe("2026-04-25");
    expect(expiry.daysToExpiry).toBe(6); // 08:00 UTC expiry, 5.83 days from NOW rounds to 6
    expect(expiry.contracts).toEqual([
      [80000, "C", 1100, 1200, 0.65, 100],
      [100000, "C", 200, 250, 0.7, 50],
    ]);
  });

  it("filters out contracts below minOpenInterest (default 10)", async () => {
    const client = clientWith(mockChainResponse);
    const result = await handleGetOptionChain(client, { underlying: "BTC" }) as CompactOptionChainResult;

    expect(result.matched).toBe(2);
    const strikes80k = result.expiries[0].contracts.filter((c) => c[0] === 80000);
    expect(strikes80k).toEqual([[80000, "C", 1100, 1200, 0.65, 100]]); // no put tuple
  });

  it("filters by type when provided", async () => {
    const chainWithLiquidPut = {
      list: [
        mockOptionTicker("BTC-25APR26-80000-C-USDT", "1100", "1200", "0.65", "100"),
        mockOptionTicker("BTC-25APR26-80000-P-USDT", "900", "1000", "0.68", "40"),
      ],
      category: "option",
    };
    const client = clientWith(chainWithLiquidPut);
    const result = await handleGetOptionChain(client, { underlying: "BTC", type: "put" }) as CompactOptionChainResult;

    const allTuples = result.expiries.flatMap((e) => e.contracts);
    expect(allTuples).toHaveLength(1);
    expect(allTuples.every((c) => c[1] === "P")).toBe(true);
  });

  it("sorts expiries by daysToExpiry ascending and contracts by strike ascending (C before P at same strike)", async () => {
    const multiExpiryResponse = {
      list: [
        mockOptionTicker("BTC-25APR26-100000-C-USDT", "200", "250", "0.70", "50"),
        mockOptionTicker("BTC-25APR26-80000-P-USDT", "900", "1000", "0.68", "40"),
        mockOptionTicker("BTC-25APR26-80000-C-USDT", "1100", "1200", "0.65", "100"),
        mockOptionTicker("BTC-20APR26-90000-C-USDT", "500", "550", "0.67", "30"), // nearer expiry
      ],
      category: "option",
    };
    const client = clientWith(multiExpiryResponse);
    const result = await handleGetOptionChain(client, { underlying: "BTC" }) as CompactOptionChainResult;

    expect(result.expiries.map((e) => e.expiryToken)).toEqual(["20APR26", "25APR26"]);
    expect(result.expiries[0].daysToExpiry).toBeLessThan(result.expiries[1].daysToExpiry);
    // Strike ascending; call before put at the same strike (deterministic)
    expect(result.expiries[1].contracts.map((c) => [c[0], c[1]])).toEqual([
      [80000, "C"],
      [80000, "P"],
      [100000, "C"],
    ]);
  });

  it("preserves single-digit-day expiryToken exactly as in the symbol (4JUL26, not 04JUL26)", async () => {
    const chain = {
      list: [mockOptionTicker("BTC-4JUL26-90000-C-USDT", "500", "550", "0.60", "25")],
      category: "option",
    };
    const client = clientWith(chain);
    const result = await handleGetOptionChain(
      client,
      { underlying: "BTC", maxDaysToExpiry: 120 }
    ) as CompactOptionChainResult;

    expect(result.expiries).toHaveLength(1);
    expect(result.expiries[0].expiryToken).toBe("4JUL26");
    expect(result.expiries[0].expiryDate).toBe("2026-07-04");
  });

  it("handles sub-cent decimal strikes (DOGE) in tuples and symbols", async () => {
    const chain = {
      list: [
        mockOptionTicker("DOGE-4JUL26-0.18-C-USDT", "0.005", "0.006", "0.90", "5000"),
        mockOptionTicker("DOGE-4JUL26-0.18-P-USDT", "0.004", "0.005", "0.92", "4000"),
      ],
      category: "option",
    };
    const client = clientWith(chain, mockSpotResponse("DOGEUSDT", "0.17"));
    const result = await handleGetOptionChain(
      client,
      { underlying: "DOGE", minOpenInterest: 0, maxDaysToExpiry: 120 }
    ) as CompactOptionChainResult;

    expect(result.spot).toBe(0.17);
    expect(result.expiries[0].expiryToken).toBe("4JUL26");
    expect(result.expiries[0].contracts).toEqual([
      [0.18, "C", 0.005, 0.006, 0.9, 5000],
      [0.18, "P", 0.004, 0.005, 0.92, 4000],
    ]);
  });

  describe("limit", () => {
    const bigChain = (count: number) => ({
      // strikes 80000, 80100, ... with OI descending 1000, 999, ...
      list: Array.from({ length: count }, (_, i) =>
        mockOptionTicker(`BTC-25APR26-${80000 + i * 100}-C-USDT`, "100", "110", "0.6", String(1000 - i))
      ),
      category: "option",
    });

    it("caps results at the default limit of 50, keeping top openInterest, with matched > returned", async () => {
      const client = clientWith(bigChain(60));
      const result = await handleGetOptionChain(client, { underlying: "BTC" }) as CompactOptionChainResult;

      expect(result.matched).toBe(60);
      expect(result.returned).toBe(50);
      const tuples = result.expiries.flatMap((e) => e.contracts);
      expect(tuples).toHaveLength(50);
      // Top 50 by OI = OI 1000..951 = strikes 80000..84900; strike 84900 kept, 85000+ dropped
      expect(tuples.map((c) => c[0])).toContain(84900);
      expect(tuples.map((c) => c[0])).not.toContain(85000);
      // Output stays strike-sorted even though the cap sorted by OI internally
      const strikes = tuples.map((c) => c[0]);
      expect(strikes).toEqual([...strikes].sort((a, b) => a - b));
    });

    it("respects an explicit limit and keeps the highest-openInterest contracts", async () => {
      const chain = {
        list: [
          mockOptionTicker("BTC-25APR26-80000-C-USDT", "1100", "1200", "0.65", "100"),
          mockOptionTicker("BTC-25APR26-90000-C-USDT", "600", "650", "0.66", "500"),
          mockOptionTicker("BTC-25APR26-100000-C-USDT", "200", "250", "0.70", "50"),
        ],
        category: "option",
      };
      const client = clientWith(chain);
      const result = await handleGetOptionChain(client, { underlying: "BTC", limit: 2 }) as CompactOptionChainResult;

      expect(result.matched).toBe(3);
      expect(result.returned).toBe(2);
      // OI 500 and 100 kept (strikes 90000, 80000); OI 50 dropped
      expect(result.expiries[0].contracts.map((c) => c[0])).toEqual([80000, 90000]);
    });

    it("does not truncate when matches are within the limit (returned === matched)", async () => {
      const client = clientWith(mockChainResponse);
      const result = await handleGetOptionChain(client, { underlying: "BTC", limit: 10 }) as CompactOptionChainResult;

      expect(result.matched).toBe(2);
      expect(result.returned).toBe(2);
    });

    it("applies the limit on the compact=false path too", async () => {
      const client = clientWith(bigChain(60));
      const result = await handleGetOptionChain(
        client,
        { underlying: "BTC", compact: false, limit: 5 }
      ) as FullOptionChainResult;

      expect(result.matched).toBe(60);
      expect(result.returned).toBe(5);
      expect(result.contracts).toHaveLength(5);
      // Highest-OI strikes are the lowest 5 strikes here
      expect(result.contracts.map((c) => c.strike)).toEqual([80000, 80100, 80200, 80300, 80400]);
    });
  });

  describe("compact=false", () => {
    it("returns full per-contract fields (flat contracts, no expiry grouping)", async () => {
      const client = clientWith(mockChainResponse);
      const result = await handleGetOptionChain(
        client,
        { underlying: "BTC", compact: false }
      ) as FullOptionChainResult;

      expect((result as unknown as CompactOptionChainResult).expiries).toBeUndefined();
      expect(result.returned).toBe(2);
      expect(result.matched).toBe(2);
      const contract = result.contracts.find((c) => c.symbol === "BTC-25APR26-80000-C-USDT")!;
      expect(contract).toMatchObject({
        symbol: "BTC-25APR26-80000-C-USDT",
        strike: 80000,
        expiry: "2026-04-25T08:00:00.000Z",
        daysToExpiry: 6,
        type: "call",
        bid: 1100,
        ask: 1200,
        mark: 1150,
        lastPrice: 1200,
        iv: 0.65,
        openInterest: 100,
        volume24h: 10,
        moneyness: "ITM", // strike 80000 < spot 95000
      });
    });

    it("computes moneyness correctly (OTM call when strike > spot)", async () => {
      const client = clientWith(mockChainResponse);
      const result = await handleGetOptionChain(
        client,
        { underlying: "BTC", compact: false }
      ) as FullOptionChainResult;

      const otm = result.contracts.find((c) => c.strike === 100000)!;
      expect(otm.moneyness).toBe("OTM");
    });

    it("sorts by daysToExpiry ascending then strike ascending", async () => {
      const multiExpiryResponse = {
        list: [
          mockOptionTicker("BTC-25APR26-100000-C-USDT", "200", "250", "0.70", "50"),
          mockOptionTicker("BTC-25APR26-80000-C-USDT", "1100", "1200", "0.65", "100"),
          mockOptionTicker("BTC-20APR26-90000-C-USDT", "500", "550", "0.67", "30"),
        ],
        category: "option",
      };
      const client = clientWith(multiExpiryResponse);
      const result = await handleGetOptionChain(
        client,
        { underlying: "BTC", compact: false }
      ) as FullOptionChainResult;

      expect(result.contracts[0].symbol).toBe("BTC-20APR26-90000-C-USDT");
      expect(result.contracts[1].strike).toBe(80000);
      expect(result.contracts[2].strike).toBe(100000);
    });
  });
});
