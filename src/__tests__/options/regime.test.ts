import { handleGetOptionsRegime } from "../../tools/options/regime";
import { IVSampleStore } from "../../tools/options/scan";
import { BybitClient } from "../../client";

jest.mock("../../client");
const MockClient = BybitClient as jest.MockedClass<typeof BybitClient>;

const MONTH_ABBR = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];

function futureExpiry(daysFromNow: number): string {
  const d = new Date(Date.now() + daysFromNow * 86400000);
  const day = String(d.getUTCDate()).padStart(2, "0");
  const month = MONTH_ABBR[d.getUTCMonth()];
  const year = String(d.getUTCFullYear()).slice(-2);
  return `${day}${month}${year}`;
}

// NEAR = ~60 days out, FAR = ~150 days out — always in the future
const NEAR = futureExpiry(60);
const FAR = futureExpiry(150);

const makeTicker = (symbol: string, iv: string) => ({
  symbol,
  lastPrice: "1000",
  bid1Price: "990",
  ask1Price: "1010",
  markPrice: "1000",
  markIv: iv,
  openInterest: "100",
  volume24h: "20",
  delta: "0.5",
  gamma: "0.0001",
  theta: "-50",
  vega: "100",
});

// spot = 95000
// ATM calls/puts at strike 95000 (same IV by put-call parity)
// OTM put at 85000 (~10.5% below), OTM call at 105000 (~10.5% above)
// near ATM call IV = 0.60, far ATM call IV = 0.65 → contango (diff=0.05, threshold=0.03)
// 10% OTM targets: put @ 85500, call @ 104500
//   → nearest put: 85000 (IV 0.70), nearest call: 105000 (IV 0.58) → skew = 0.12
const mockBtcChain = {
  list: [
    makeTicker(`BTC-${NEAR}-95000-C-USDT`, "0.60"),
    makeTicker(`BTC-${NEAR}-95000-P-USDT`, "0.60"),
    makeTicker(`BTC-${NEAR}-85000-P-USDT`, "0.70"),  // OTM put (-10.5%)
    makeTicker(`BTC-${NEAR}-105000-C-USDT`, "0.58"), // OTM call (+10.5%)
    makeTicker(`BTC-${FAR}-95000-C-USDT`, "0.65"),   // far expiry for term structure
    makeTicker(`BTC-${FAR}-95000-P-USDT`, "0.65"),
  ],
  category: "option",
};

const mockSpotTicker = { list: [{ lastPrice: "95000" }] };

function mockPublicGet(data: object) {
  return jest.fn((_path: string, params: Record<string, string>) =>
    Promise.resolve(params.category === "linear" ? mockSpotTicker : data)
  );
}

describe("handleGetOptionsRegime", () => {
  it("returns signals for requested underlyings", async () => {
    const client = new MockClient("k", "s", "u");
    const store = new IVSampleStore();
    (client.publicGet as jest.Mock).mockImplementation(mockPublicGet(mockBtcChain));

    const result = await handleGetOptionsRegime(client, store, { underlying: ["BTC"] });

    expect(result.signals["BTC"]).toBeDefined();
    expect(result.signals["ETH"]).toBeUndefined();
  });

  it("identifies contango when near expiry IV < far expiry IV", async () => {
    const client = new MockClient("k", "s", "u");
    const store = new IVSampleStore();
    (client.publicGet as jest.Mock).mockImplementation(mockPublicGet(mockBtcChain));

    const result = await handleGetOptionsRegime(client, store, { underlying: ["BTC"] });
    expect(result.signals["BTC"].termStructure).toBe("contango");
  });

  it("computes putCallSkew using 10% OTM put minus 10% OTM call", async () => {
    const client = new MockClient("k", "s", "u");
    const store = new IVSampleStore();
    (client.publicGet as jest.Mock).mockImplementation(mockPublicGet(mockBtcChain));

    const result = await handleGetOptionsRegime(client, store, { underlying: ["BTC"] });
    // put at 85000 IV=0.70, call at 105000 IV=0.58 → skew ≈ 0.12
    expect(result.signals["BTC"].putCallSkew).toBeCloseTo(0.12, 2);
  });

  it("putCallSkew is non-zero even when ATM put/call have identical IV", async () => {
    // ATM put and call are both 0.60 (put-call parity) but OTM put has higher IV
    const client = new MockClient("k", "s", "u");
    const store = new IVSampleStore();
    (client.publicGet as jest.Mock).mockImplementation(mockPublicGet(mockBtcChain));

    const result = await handleGetOptionsRegime(client, store, { underlying: ["BTC"] });
    expect(result.signals["BTC"].putCallSkew).not.toBe(0);
  });

  it("sampleAvailable=false before warmup", async () => {
    const client = new MockClient("k", "s", "u");
    const store = new IVSampleStore();
    (client.publicGet as jest.Mock).mockImplementation(mockPublicGet(mockBtcChain));

    const result = await handleGetOptionsRegime(client, store, { underlying: ["BTC"] });
    expect(result.signals["BTC"].sampleAvailable).toBe(false);
    expect(result.signals["BTC"].ivPercentile30d).toBeNull();
  });

  it("queries all three underlyings by default", async () => {
    const client = new MockClient("k", "s", "u");
    const store = new IVSampleStore();
    (client.publicGet as jest.Mock).mockImplementation(mockPublicGet(mockBtcChain));

    await handleGetOptionsRegime(client, store, {});

    const calls = (client.publicGet as jest.Mock).mock.calls;
    const baseCoinCalls = calls.filter(([, p]: [string, Record<string, string>]) => p.baseCoin);
    const coins = baseCoinCalls.map(([, p]: [string, Record<string, string>]) => p.baseCoin);
    expect(coins).toContain("BTC");
    expect(coins).toContain("ETH");
    expect(coins).toContain("SOL");
  });

  it("returns flat termStructure when only one expiry is available", async () => {
    const singleExpiry = {
      list: [
        makeTicker(`BTC-${NEAR}-95000-C-USDT`, "0.60"),
        makeTicker(`BTC-${NEAR}-95000-P-USDT`, "0.60"),
      ],
      category: "option",
    };
    const client = new MockClient("k", "s", "u");
    const store = new IVSampleStore();
    (client.publicGet as jest.Mock).mockImplementation(mockPublicGet(singleExpiry));

    const result = await handleGetOptionsRegime(client, store, { underlying: ["BTC"] });
    expect(result.signals["BTC"].termStructure).toBe("flat");
  });
});
