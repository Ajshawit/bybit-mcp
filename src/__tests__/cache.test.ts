import { InstrumentsCache, instrumentsCache, PositionModeCache, positionModeCache } from "../cache";

describe("InstrumentsCache", () => {
  it("returns undefined for uncached symbol", () => {
    const cache = new InstrumentsCache();
    expect(cache.get("BTCUSDT")).toBeUndefined();
  });

  it("stores and retrieves instrument info", () => {
    const cache = new InstrumentsCache();
    const info = { tickSize: "0.5", qtyStep: "0.001", minNotionalValue: "5" };
    cache.set("BTCUSDT", info);
    expect(cache.get("BTCUSDT")).toEqual(info);
  });

  it("singleton instrumentsCache is shared across imports", () => {
    instrumentsCache.set("ETHUSDT", { tickSize: "0.01", qtyStep: "0.01", minNotionalValue: "1" });
    const { instrumentsCache: same } = require("../cache");
    expect(same.get("ETHUSDT")).toBeDefined();
  });
});

describe("PositionModeCache", () => {
  it("returns undefined for uncached entry", () => {
    const cache = new PositionModeCache();
    expect(cache.get("linear", "BTCUSDT", "Buy")).toBeUndefined();
  });

  it("stores and retrieves positionIdx", () => {
    const cache = new PositionModeCache();
    cache.set("linear", "BTCUSDT", "Buy", 1);
    expect(cache.get("linear", "BTCUSDT", "Buy")).toBe(1);
  });

  it("returns undefined after TTL expires", () => {
    const cache = new PositionModeCache();
    const realNow = Date.now;
    // Set entry at t=0
    Date.now = () => 0;
    cache.set("linear", "BTCUSDT", "Buy", 1);
    // Advance 25 hours past TTL
    Date.now = () => 25 * 60 * 60 * 1000;
    expect(cache.get("linear", "BTCUSDT", "Buy")).toBeUndefined();
    Date.now = realNow;
  });

  it("separate keys for different sides", () => {
    const cache = new PositionModeCache();
    cache.set("linear", "BTCUSDT", "Buy", 1);
    cache.set("linear", "BTCUSDT", "Sell", 2);
    expect(cache.get("linear", "BTCUSDT", "Buy")).toBe(1);
    expect(cache.get("linear", "BTCUSDT", "Sell")).toBe(2);
  });

  it("singleton positionModeCache is exported", () => {
    expect(positionModeCache).toBeInstanceOf(PositionModeCache);
  });
});
