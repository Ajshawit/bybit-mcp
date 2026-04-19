import { handleGetMarketData, handleScanMarket, handleGetOhlc } from "../tools/market";
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
      .mockResolvedValueOnce(mockOrderbook) // orderbook
      .mockResolvedValueOnce({ list: [] }); // OI history (new)

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

describe("scan_market oi_divergence", () => {
  function makeTickerList(overrides: Partial<{
    symbol: string; price24hPcnt: string; turnover24h: string;
    lastPrice: string; openInterestValue: string;
    highPrice24h: string; lowPrice24h: string;
  }>[]) {
    return {
      list: overrides.map((o) => ({
        symbol: "XUSDT", lastPrice: "1.0", price24hPcnt: "0.05",
        fundingRate: "0.0001", nextFundingTime: "0", openInterest: "1000000",
        openInterestValue: "1000000", volume24h: "1000000", turnover24h: "50000000",
        highPrice24h: "1.1", lowPrice24h: "0.9", prevPrice24h: "0.95",
        bid1Price: "0.999", ask1Price: "1.001",
        ...o,
      })),
    };
  }

  const shortCoveringOI = {
    list: [
      { openInterest: "950000", timestamp: "1700000000" },
      { openInterest: "970000", timestamp: "1699985600" },
      { openInterest: "980000", timestamp: "1699971200" },
      { openInterest: "990000", timestamp: "1699956800" },
      { openInterest: "995000", timestamp: "1699942400" },
      { openInterest: "998000", timestamp: "1699928000" },
      { openInterest: "1000000", timestamp: "1699913600" },
    ],
  };

  it("returns short_covering when price up and OI down > 2%", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock)
      .mockResolvedValueOnce(makeTickerList([{
        symbol: "XUSDT", price24hPcnt: "0.05", turnover24h: "50000000",
      }]))
      .mockResolvedValueOnce(shortCoveringOI)
      .mockResolvedValueOnce({ list: [["0","1.0","1.0","1.0","1.02","0","0"], ["0","1.0","1.0","1.0","1.00","0","0"]] }); // kline for 4h price

    const results = await handleScanMarket(client, "oi_divergence", 10_000_000, 15) as any[];
    expect(results).toHaveLength(1);
    expect(results[0].reading).toBe("short_covering");
    expect(results[0].symbol).toBe("XUSDT");
  });

  it("filters symbols below minVolume", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock)
      .mockResolvedValueOnce(makeTickerList([{
        symbol: "XUSDT", price24hPcnt: "0.05", turnover24h: "5000000",
      }]));

    const results = await handleScanMarket(client, "oi_divergence", 10_000_000, 15) as any[];
    expect(results).toHaveLength(0);
  });

  it("does not surface price_up+OI_up (new longs)", async () => {
    const newLongsOI = {
      list: [
        { openInterest: "1050000", timestamp: "1700000000" },
        { openInterest: "1010000", timestamp: "1699985600" },
        { openInterest: "990000",  timestamp: "1699971200" },
        { openInterest: "980000",  timestamp: "1699956800" },
        { openInterest: "970000",  timestamp: "1699942400" },
        { openInterest: "960000",  timestamp: "1699928000" },
        { openInterest: "950000",  timestamp: "1699913600" },
      ],
    };
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock)
      .mockResolvedValueOnce(makeTickerList([{ symbol: "XUSDT", price24hPcnt: "0.05", turnover24h: "50000000" }]))
      .mockResolvedValueOnce(newLongsOI)
      .mockResolvedValueOnce({ list: [["0","1.0","1.0","1.0","1.02","0","0"], ["0","1.0","1.0","1.0","1.00","0","0"]] });

    const results = await handleScanMarket(client, "oi_divergence", 10_000_000, 15) as any[];
    expect(results).toHaveLength(0);
  });
});

describe("scan_market crowded_positioning", () => {
  const crowdedLongTicker = {
    symbol: "YUSDT",
    lastPrice: "1.0",
    price24hPcnt: "0.02",
    fundingRate: "0.0006",
    nextFundingTime: "0",
    openInterest: "500000",
    openInterestValue: "500000",
    volume24h: "500000",
    turnover24h: "50000000",
    highPrice24h: "1.05",
    lowPrice24h: "0.85",  // range=0.20, rangePos=(1.0-0.85)/0.20=0.75 — NOT in top 20%
    prevPrice24h: "0.90",
    bid1Price: "0.999",
    ask1Price: "1.001",
  };

  const fundingHistory = {
    list: [
      { symbol: "YUSDT", fundingRate: "0.0006", fundingRateTimestamp: "1700000000000" },
      { symbol: "YUSDT", fundingRate: "0.0005", fundingRateTimestamp: "1699971200000" },
      { symbol: "YUSDT", fundingRate: "0.0004", fundingRateTimestamp: "1699942400000" },
      { symbol: "YUSDT", fundingRate: "0.0003", fundingRateTimestamp: "1699913600000" },
    ],
  };

  it("returns crowded_long for high positive funding in upper range", async () => {
    // Need price in top 20%: use high=1.05, low=0.85, price=1.03 → rangePos=(1.03-0.85)/0.20=0.90
    const ticker = { ...crowdedLongTicker, lastPrice: "1.03" };
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock)
      .mockResolvedValueOnce({ list: [ticker] })
      .mockResolvedValueOnce(fundingHistory);

    const results = await handleScanMarket(client, "crowded_positioning", 10_000_000, 15) as any[];
    expect(results).toHaveLength(1);
    expect(results[0].reading).toBe("crowded_long");
    expect(results[0].rangePosition).toBeGreaterThan(0.8);
  });

  it("does not match when funding extreme but price not in extreme range", async () => {
    // price=1.0, high=1.05, low=0.85, rangePos=0.75 — not in top 20%
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValueOnce({ list: [crowdedLongTicker] });

    const results = await handleScanMarket(client, "crowded_positioning", 10_000_000, 15) as any[];
    expect(results).toHaveLength(0);
  });
});

describe("scan_market volume_spike", () => {
  function buildKlineList(currentHourTurnover: number, priorTurnovers: number[], currentOpen: number, currentClose: number) {
    // candles[0] = forming (skip), candles[1] = last completed, candles[2..] = prior
    const forming = ["0", String(currentOpen), "0", "0", String(currentClose), "0", String(currentHourTurnover)];
    const last = ["0", String(currentOpen), "0", "0", String(currentClose), "0", String(currentHourTurnover)];
    const priors = priorTurnovers.map((v) => ["0", "1.0", "0", "0", "1.0", "0", String(v)]);
    return { list: [forming, last, ...priors] };
  }

  const baseTicker = {
    symbol: "ZUSDT", lastPrice: "1.02", price24hPcnt: "0.02",
    fundingRate: "0", nextFundingTime: "0", openInterest: "0",
    openInterestValue: "0", volume24h: "1000000", turnover24h: "50000000",
    highPrice24h: "1.05", lowPrice24h: "0.98", prevPrice24h: "1.0",
    bid1Price: "1.019", ask1Price: "1.021",
  };

  it("returns impulse_up when spikeRatio > 3 and candle moves up > 0.5%", async () => {
    // spikeRatio = 1_000_000 / 100_000 = 10
    const klines = buildKlineList(1_000_000, Array(24).fill(100_000), 1.0, 1.02); // 2% up
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock)
      .mockResolvedValueOnce({ list: [baseTicker] })
      .mockResolvedValueOnce(klines);

    const results = await handleScanMarket(client, "volume_spike", 10_000_000, 15) as any[];
    expect(results).toHaveLength(1);
    expect(results[0].reading).toBe("impulse_up");
    expect(results[0].spikeRatio).toBeGreaterThan(3);
  });

  it("classifies churn when volume spike but price flat", async () => {
    // price move 0.2% — between -0.5% and 0.5% = churn
    const klines = buildKlineList(1_000_000, Array(24).fill(100_000), 1.0, 1.002);
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock)
      .mockResolvedValueOnce({ list: [{ ...baseTicker, lastPrice: "1.002" }] })
      .mockResolvedValueOnce(klines);

    const results = await handleScanMarket(client, "volume_spike", 10_000_000, 15) as any[];
    expect(results[0].reading).toBe("churn");
  });

  it("does not return symbols with spikeRatio <= 3", async () => {
    // spikeRatio = 200_000 / 100_000 = 2 — below threshold
    const klines = buildKlineList(200_000, Array(24).fill(100_000), 1.0, 1.02);
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock)
      .mockResolvedValueOnce({ list: [baseTicker] })
      .mockResolvedValueOnce(klines);

    const results = await handleScanMarket(client, "volume_spike", 10_000_000, 15) as any[];
    expect(results).toHaveLength(0);
  });
});

describe("handleGetOhlc", () => {
  const mockKlineResponse = {
    list: [
      ["1700010000000", "30100", "30200", "29900", "30050", "100", "3005000"],
      ["1700006400000", "29900", "30100", "29800", "30100", "120", "3612000"],
    ],
  };

  it("maps kline tuples to MarketKlineBar[] correctly", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValueOnce(mockKlineResponse);

    const result = await handleGetOhlc(client, "BTCUSDT");

    expect(result.candles).toHaveLength(2);
    expect(result.candles[0]).toEqual({
      time: 1700010000000,
      open: 30100,
      high: 30200,
      low: 29900,
      close: 30050,
      volume: 100,
      turnover: 3005000,
    });
  });

  it("passes category, interval, limit to the API call", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValueOnce(mockKlineResponse);

    await handleGetOhlc(client, "BTCUSD", "inverse", "240", 50);

    expect(client.publicGet).toHaveBeenCalledWith("/v5/market/kline", {
      category: "inverse",
      symbol: "BTCUSD",
      interval: "240",
      limit: "50",
    });
  });

  it("uses defaults: category=linear, interval=60, limit=100", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValueOnce(mockKlineResponse);

    await handleGetOhlc(client, "BTCUSDT");

    expect(client.publicGet).toHaveBeenCalledWith("/v5/market/kline", {
      category: "linear",
      symbol: "BTCUSDT",
      interval: "60",
      limit: "100",
    });
  });

  it("returns empty candles and lastPrice=0 when API returns empty list", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValueOnce({ list: [] });

    const result = await handleGetOhlc(client, "BTCUSDT");

    expect(result.candles).toEqual([]);
    expect(result.lastPrice).toBe(0);
  });

  it("sets lastPrice to candles[0].close", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValueOnce(mockKlineResponse);

    const result = await handleGetOhlc(client, "BTCUSDT");

    expect(result.lastPrice).toBe(30050);
  });

  it("result includes symbol, category, interval metadata", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValueOnce(mockKlineResponse);

    const result = await handleGetOhlc(client, "ETHUSDT", "spot", "D", 200);

    expect(result.symbol).toBe("ETHUSDT");
    expect(result.category).toBe("spot");
    expect(result.interval).toBe("D");
  });

  it("result includes a timestamp ISO string", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValueOnce(mockKlineResponse);

    const result = await handleGetOhlc(client, "BTCUSDT");

    expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
