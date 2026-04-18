import { InstrumentsCache, instrumentsCache } from "../cache";

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
