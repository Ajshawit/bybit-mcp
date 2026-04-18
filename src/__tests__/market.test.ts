import { handleGetMarketData, handleScanMarket } from "../tools/market";
import { BybitClient } from "../client";

jest.mock("../client");
const MockClient = BybitClient as jest.MockedClass<typeof BybitClient>;

const mockTicker = {
  list: [{
    symbol: "BTCUSDT",
    lastPrice: "30000",
    price24hPcnt: "0.03",
    fundingRate: "0.0001",
    nextFundingTime: "1700000000000",
    openInterest: "10000",
    openInterestValue: "300000000",
    volume24h: "5000",
    turnover24h: "150000000",
    highPrice24h: "31000",
    lowPrice24h: "29000",
    prevPrice24h: "29100",
    bid1Price: "29999",
    ask1Price: "30001",
  }],
};

const mockKline = {
  list: [
    ["1700010000000", "30100", "30200", "29900", "30000", "100", "3000000"],
    ["1700006400000", "29900", "30100", "29800", "30100", "120", "3600000"],
  ],
};

const mockFunding = {
  list: [
    { symbol: "BTCUSDT", fundingRate: "0.0001", fundingRateTimestamp: "1700000000000" },
    { symbol: "BTCUSDT", fundingRate: "0.00008", fundingRateTimestamp: "1699971200000" },
  ],
};

const mockOrderbook = {
  b: [["29999", "1.5"], ["29998", "2.0"]],
  a: [["30001", "1.2"], ["30002", "0.8"]],
  s: "BTCUSDT",
};

describe("handleGetMarketData", () => {
  it("returns ticker with funding and OI data", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock)
      .mockResolvedValueOnce(mockTicker)    // tickers
      .mockResolvedValueOnce(mockKline)     // kline 60
      .mockResolvedValueOnce(mockKline)     // kline 240
      .mockResolvedValueOnce(mockFunding)   // funding history
      .mockResolvedValueOnce(mockOrderbook); // orderbook

    const result = await handleGetMarketData(client, "BTCUSDT");

    expect(result.ticker.symbol).toBe("BTCUSDT");
    expect(result.ticker.price).toBe(30000);
    expect(result.ticker.fundingRate).toBe(0.0001);
    expect(result.fundingHistory).toHaveLength(2);
    expect(result.klines["60"]).toHaveLength(2);
    expect(result.orderbook.bids).toHaveLength(2);
  });

  it("uses default intervals [60, 240] and klineLimit 24", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValue({ list: [] });

    await handleGetMarketData(client, "BTCUSDT");

    const calls = (client.publicGet as jest.Mock).mock.calls;
    const klineCalls = calls.filter(([path]: [string]) => path.includes("kline"));
    expect(klineCalls.some(([, p]: [string, Record<string, string>]) => p.interval === "60")).toBe(true);
    expect(klineCalls.some(([, p]: [string, Record<string, string>]) => p.interval === "240")).toBe(true);
    expect(klineCalls[0][1].limit).toBe("24");
  });
});
