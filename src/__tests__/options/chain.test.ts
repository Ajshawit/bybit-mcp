import { handleGetOptionChain } from "../../tools/options/chain";
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

const mockSpotResponse = {
  list: [{ symbol: "BTCUSDT", lastPrice: "95000", price24hPcnt: "0.01",
    fundingRate: "0", nextFundingTime: "0", openInterest: "0", openInterestValue: "0",
    volume24h: "0", turnover24h: "0", highPrice24h: "0", lowPrice24h: "0",
    prevPrice24h: "0", bid1Price: "0", ask1Price: "0" }],
  category: "spot",
};

describe("handleGetOptionChain", () => {
  beforeEach(() => jest.spyOn(Date, "now").mockReturnValue(NOW));
  afterEach(() => jest.restoreAllMocks());

  it("fetches option chain and spot price in parallel", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock)
      .mockResolvedValueOnce(mockChainResponse)
      .mockResolvedValueOnce(mockSpotResponse);

    await handleGetOptionChain(client, { underlying: "BTC" });

    const calls = (client.publicGet as jest.Mock).mock.calls;
    expect(calls[0][1]).toMatchObject({ category: "option", baseCoin: "BTC" });
    expect(calls[1][1]).toMatchObject({ category: "spot", symbol: "BTCUSDT" });
  });

  it("maps option ticker fields correctly", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock)
      .mockResolvedValueOnce(mockChainResponse)
      .mockResolvedValueOnce(mockSpotResponse);

    const result = await handleGetOptionChain(client, { underlying: "BTC" });
    const contract = result.contracts.find((c) => c.symbol === "BTC-25APR26-80000-C-USDT")!;

    expect(contract.strike).toBe(80000);
    expect(contract.type).toBe("call");
    expect(contract.bid).toBe(1100);
    expect(contract.ask).toBe(1200);
    expect(contract.iv).toBe(0.65);
    expect(contract.openInterest).toBe(100);
  });

  it("filters out contracts below minOpenInterest (default 10)", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock)
      .mockResolvedValueOnce(mockChainResponse)
      .mockResolvedValueOnce(mockSpotResponse);

    const result = await handleGetOptionChain(client, { underlying: "BTC" });
    expect(result.contracts.find((c) => c.symbol === "BTC-25APR26-80000-P-USDT")).toBeUndefined();
  });

  it("filters by type when provided", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock)
      .mockResolvedValueOnce(mockChainResponse)
      .mockResolvedValueOnce(mockSpotResponse);

    const result = await handleGetOptionChain(client, { underlying: "BTC", type: "call" });
    expect(result.contracts.every((c) => c.type === "call")).toBe(true);
  });

  it("returns spot price in result", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock)
      .mockResolvedValueOnce(mockChainResponse)
      .mockResolvedValueOnce(mockSpotResponse);

    const result = await handleGetOptionChain(client, { underlying: "BTC" });
    expect(result.spot).toBe(95000);
  });

  it("sorts by daysToExpiry ascending then strike ascending", async () => {
    const client = new MockClient("k", "s", "u");
    // Add a closer expiry with higher strike — should sort FIRST due to nearer DTE
    const multiExpiryResponse = {
      list: [
        mockOptionTicker("BTC-25APR26-100000-C-USDT", "200", "250", "0.70", "50"), // farther expiry, higher strike
        mockOptionTicker("BTC-25APR26-80000-C-USDT", "1100", "1200", "0.65", "100"), // farther expiry, lower strike
        mockOptionTicker("BTC-20APR26-90000-C-USDT", "500", "550", "0.67", "30"), // nearer expiry — should come first
      ],
      category: "option",
    };
    (client.publicGet as jest.Mock)
      .mockResolvedValueOnce(multiExpiryResponse)
      .mockResolvedValueOnce(mockSpotResponse);

    const result = await handleGetOptionChain(client, { underlying: "BTC" });

    // The APR20 contract (nearer DTE) should be first
    expect(result.contracts[0].symbol).toBe("BTC-20APR26-90000-C-USDT");
    // The APR25 contracts should be sorted by strike: 80000 before 100000
    expect(result.contracts[1].strike).toBe(80000);
    expect(result.contracts[2].strike).toBe(100000);
  });

  it("computes moneyness correctly (OTM call when strike > spot)", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock)
      .mockResolvedValueOnce(mockChainResponse)
      .mockResolvedValueOnce(mockSpotResponse);

    const result = await handleGetOptionChain(client, { underlying: "BTC" });
    // strike 80000 < spot 95000 → ITM call
    const itm = result.contracts.find((c) => c.strike === 80000 && c.type === "call")!;
    expect(itm.moneyness).toBe("ITM");
    // strike 100000 > spot 95000 → OTM call
    const otm = result.contracts.find((c) => c.strike === 100000)!;
    expect(otm.moneyness).toBe("OTM");
  });
});
