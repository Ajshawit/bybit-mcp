import { IVSampleStore, handleScanOptions } from "../../tools/options/scan";
import { BybitClient } from "../../client";

jest.mock("../../client");
const MockClient = BybitClient as jest.MockedClass<typeof BybitClient>;

describe("IVSampleStore", () => {
  it("returns null percentile when fewer than 20 samples", () => {
    const store = new IVSampleStore();
    for (let i = 0; i < 19; i++) {
      store.record("BTC", "APR26", 0.5 + i * 0.01, new Date());
    }
    expect(store.getPercentile("BTC", "APR26", 0.6)).toBeNull();
  });

  it("returns percentile after 20+ samples", () => {
    const store = new IVSampleStore();
    for (let i = 0; i < 20; i++) {
      store.record("BTC", "APR26", i * 0.05, new Date()); // 0, 0.05, 0.1 ... 0.95
    }
    // iv=0.95 is the highest — should be near 100th percentile
    const pct = store.getPercentile("BTC", "APR26", 0.95);
    expect(pct).not.toBeNull();
    expect(pct!).toBeGreaterThan(90);
  });

  it("returns low percentile for low IV", () => {
    const store = new IVSampleStore();
    for (let i = 0; i < 20; i++) {
      store.record("BTC", "APR26", i * 0.05, new Date());
    }
    const pct = store.getPercentile("BTC", "APR26", 0.0);
    expect(pct!).toBeLessThan(10);
  });

  it("warmupRemaining returns null when warmed up", () => {
    const store = new IVSampleStore();
    for (let i = 0; i < 20; i++) {
      store.record("BTC", "APR26", 0.5, new Date());
    }
    expect(store.warmupRemaining("BTC", "APR26")).toBeNull();
  });

  it("warmupRemaining returns string when not warmed up", () => {
    const store = new IVSampleStore();
    store.record("BTC", "APR26", 0.5, new Date());
    expect(store.warmupRemaining("BTC", "APR26")).toBeTruthy();
  });
});

const makeOptionTicker = (symbol: string, iv: string, oi = "100") => ({
  symbol,
  lastPrice: "1000",
  bid1Price: "990",
  ask1Price: "1010",
  markPrice: "1000",
  markIv: iv,
  openInterest: oi,
  volume24h: "20",
  delta: "0.5",
  gamma: "0.0001",
  theta: "-50",
  vega: "100",
  underlyingPrice: "95000",
});

describe("handleScanOptions", () => {
  it("returns percentileAvailable=false before warmup", async () => {
    const client = new MockClient("k", "s", "u");
    const store = new IVSampleStore();
    (client.publicGet as jest.Mock).mockResolvedValue({
      list: [makeOptionTicker("BTC-25APR26-80000-C-USDT", "0.65")],
      category: "option",
    });

    const result = await handleScanOptions(client, store, {
      underlying: "BTC",
      filter: "high_iv",
    });

    expect(result.percentileAvailable).toBe(false);
    expect(result.warmupRemaining).toBeTruthy();
  });

  it("returns percentileAvailable=true after warmup", async () => {
    const client = new MockClient("k", "s", "u");
    const store = new IVSampleStore();

    // Warm up the store for BTC APR26 bucket
    for (let i = 0; i < 25; i++) {
      store.record("BTC", "APR26", 0.3 + i * 0.02, new Date());
    }

    (client.publicGet as jest.Mock).mockResolvedValue({
      list: [makeOptionTicker("BTC-25APR26-80000-C-USDT", "0.75")],
      category: "option",
    });

    const result = await handleScanOptions(client, store, {
      underlying: "BTC",
      filter: "high_iv",
    });

    expect(result.percentileAvailable).toBe(true);
  });

  it("returns correct filter and underlying in result", async () => {
    const client = new MockClient("k", "s", "u");
    const store = new IVSampleStore();
    (client.publicGet as jest.Mock).mockResolvedValue({ list: [], category: "option" });

    const result = await handleScanOptions(client, store, {
      underlying: "ETH",
      filter: "low_iv",
    });

    expect(result.underlying).toBe("ETH");
    expect(result.filter).toBe("low_iv");
    expect(Array.isArray(result.contracts)).toBe(true);
  });
});
