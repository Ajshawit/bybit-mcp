import { ensureInstrumentInfo, detectPositionIdx } from "../tools/trade-shared";
import { BybitClient } from "../client";
import { instrumentsCache, positionModeCache } from "../cache";

jest.mock("../client");
const MockClient = BybitClient as jest.MockedClass<typeof BybitClient>;

const mockInstResult = {
  list: [{
    symbol: "BTCUSDT",
    lotSizeFilter: { qtyStep: "0.001", minOrderQty: "0.001" },
    priceFilter: { tickSize: "0.5" },
    minNotionalValue: "5",
  }],
};

const mockSpotInstResult = {
  list: [{
    symbol: "BTCUSDT",
    lotSizeFilter: { basePrecision: "0.000001", minOrderQty: "0.000001" },
    priceFilter: { tickSize: "0.01" },
    minNotionalValue: "1",
  }],
};

describe("ensureInstrumentInfo", () => {
  beforeEach(() => {
    // Clear cache between tests
    instrumentsCache["store"].clear();
  });

  it("returns cached value without API call", async () => {
    instrumentsCache.set("linear:BTCUSDT", { tickSize: "0.5", qtyStep: "0.001", minNotionalValue: "5" });
    const client = new MockClient("k", "s", "u");

    const result = await ensureInstrumentInfo(client, "linear", "BTCUSDT");

    expect(result.qtyStep).toBe("0.001");
    expect(client.publicGet).not.toHaveBeenCalled();
  });

  it("fetches from API on cache miss and stores result under category:symbol key", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValue(mockInstResult);

    const result = await ensureInstrumentInfo(client, "linear", "BTCUSDT");

    expect(result.qtyStep).toBe("0.001");
    expect(result.tickSize).toBe("0.5");
    expect(client.publicGet).toHaveBeenCalledWith(
      "/v5/market/instruments-info",
      { category: "linear", symbol: "BTCUSDT" }
    );
    expect(instrumentsCache.get("linear:BTCUSDT")).toBeDefined();
  });

  it("uses basePrecision as qtyStep for spot instruments", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValue(mockSpotInstResult);

    const result = await ensureInstrumentInfo(client, "spot", "BTCUSDT");

    expect(result.qtyStep).toBe("0.000001");
  });

  it("uses separate cache entries for same symbol different categories", async () => {
    const client = new MockClient("k", "s", "u");
    instrumentsCache.set("linear:BTCUSDT", { tickSize: "0.5", qtyStep: "0.001", minNotionalValue: "5" });
    instrumentsCache.set("spot:BTCUSDT", { tickSize: "0.01", qtyStep: "0.000001", minNotionalValue: "1" });

    const linear = await ensureInstrumentInfo(client, "linear", "BTCUSDT");
    const spot = await ensureInstrumentInfo(client, "spot", "BTCUSDT");

    expect(linear.qtyStep).toBe("0.001");
    expect(spot.qtyStep).toBe("0.000001");
    expect(client.publicGet).not.toHaveBeenCalled();
  });
});

describe("detectPositionIdx", () => {
  beforeEach(() => {
    positionModeCache["store"].clear();
  });

  it("returns cached value without API call", async () => {
    positionModeCache.set("linear", "BTCUSDT", "Buy", 1);
    const client = new MockClient("k", "s", "u");

    const result = await detectPositionIdx(client, "linear", "BTCUSDT", "Buy");

    expect(result).toBe(1);
    expect(client.signedGet).not.toHaveBeenCalled();
  });

  it("returns 0 when no open positions (one-way default)", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedGet as jest.Mock).mockResolvedValue({ list: [] });

    const result = await detectPositionIdx(client, "linear", "BTCUSDT", "Buy");

    expect(result).toBe(0);
  });

  it("returns 1 for Buy when hedge-mode positions exist", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedGet as jest.Mock).mockResolvedValue({
      list: [{ positionIdx: 1, size: "0.01" }, { positionIdx: 2, size: "0" }],
    });

    const result = await detectPositionIdx(client, "linear", "BTCUSDT", "Buy");

    expect(result).toBe(1);
  });

  it("returns 2 for Sell when hedge-mode positions exist", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedGet as jest.Mock).mockResolvedValue({
      list: [{ positionIdx: 1, size: "0" }, { positionIdx: 2, size: "0.01" }],
    });

    const result = await detectPositionIdx(client, "linear", "BTCUSDT", "Sell");

    expect(result).toBe(2);
  });

  it("caches detection result for subsequent calls", async () => {
    const client = new MockClient("k", "s", "u");
    (client.signedGet as jest.Mock).mockResolvedValue({ list: [] });

    await detectPositionIdx(client, "linear", "BTCUSDT", "Buy");
    await detectPositionIdx(client, "linear", "BTCUSDT", "Buy");

    expect(client.signedGet).toHaveBeenCalledTimes(1);
  });
});
