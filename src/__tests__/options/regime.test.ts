import { handleGetOptionsRegime } from "../../tools/options/regime";
import { IVSampleStore } from "../../tools/options/scan";
import { BybitClient } from "../../client";

jest.mock("../../client");
const MockClient = BybitClient as jest.MockedClass<typeof BybitClient>;

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
  underlyingPrice: "95000",
});

const mockBtcChain = {
  list: [
    makeTicker("BTC-25APR26-95000-C-USDT", "0.60"),
    makeTicker("BTC-25APR26-95000-P-USDT", "0.70"),
    makeTicker("BTC-30JUN26-95000-C-USDT", "0.65"),
  ],
  category: "option",
};

const mockSpotTicker = { list: [{ lastPrice: "95000" }] };

function mockPublicGet(data: object) {
  return jest.fn((_path: string, params: Record<string, string>) =>
    Promise.resolve(params.category === "spot" ? mockSpotTicker : data)
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

  it("identifies contango when near IV < far IV", async () => {
    const client = new MockClient("k", "s", "u");
    const store = new IVSampleStore();
    (client.publicGet as jest.Mock).mockImplementation(mockPublicGet(mockBtcChain));

    const result = await handleGetOptionsRegime(client, store, { underlying: ["BTC"] });
    expect(result.signals["BTC"].termStructure).toBe("contango");
  });

  it("computes putCallSkew as put IV minus call IV at same expiry", async () => {
    const client = new MockClient("k", "s", "u");
    const store = new IVSampleStore();
    (client.publicGet as jest.Mock).mockImplementation(mockPublicGet(mockBtcChain));

    const result = await handleGetOptionsRegime(client, store, { underlying: ["BTC"] });
    expect(Math.abs(result.signals["BTC"].putCallSkew - 0.10)).toBeLessThan(0.01);
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
});
