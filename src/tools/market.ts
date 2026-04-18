import { BybitClient } from "../client";
import {
  TickersResult,
  KlineResult,
  FundingHistoryResult,
  OrderbookEntry,
  OIHistoryResult,
} from "./types";
import { concurrentMap } from "../util";

export interface MarketTicker {
  symbol: string;
  price: number;
  price24hPct: number;
  fundingRate: number;
  funding8hAgo: number | null;
  funding24hAgo: number | null;
  oi: number;
  oiValueUsd: number;
  oi4hAgo: number | null;
  oi24hAgo: number | null;
  volume24hUsd: number;
  bid: number;
  ask: number;
}

export interface MarketKlineBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  turnover: number;
}

export interface MarketDataResult {
  ticker: MarketTicker;
  klines: Record<string, MarketKlineBar[]>;
  fundingHistory: Array<{ rate: number; timestamp: number }>;
  orderbook: { bids: [number, number][]; asks: [number, number][] };
}

export async function handleGetMarketData(
  client: BybitClient,
  symbol: string,
  klineIntervals = ["60", "240"],
  klineLimit = 24,
  fundingHistoryLimit = 16
): Promise<MarketDataResult> {
  const allResults = await Promise.all([
    client.publicGet<TickersResult>("/v5/market/tickers", { category: "linear", symbol }),
    ...klineIntervals.map((interval) =>
      client.publicGet<KlineResult>("/v5/market/kline", {
        category: "linear",
        symbol,
        interval,
        limit: String(klineLimit),
      })
    ),
    client.publicGet<FundingHistoryResult>("/v5/market/funding/history", {
      category: "linear",
      symbol,
      limit: String(fundingHistoryLimit),
    }),
    client.publicGet<OrderbookEntry>("/v5/market/orderbook", {
      category: "linear",
      symbol,
      limit: "20",
    }),
  ]);

  const tickersRes = allResults[0] as TickersResult;
  const klineResults = allResults.slice(1, 1 + klineIntervals.length) as KlineResult[];
  const fundingRes = allResults[1 + klineIntervals.length] as FundingHistoryResult;
  const obRes = allResults[2 + klineIntervals.length] as OrderbookEntry;

  const t = tickersRes.list?.[0];
  const fundingList = fundingRes.list ?? [];

  const ticker: MarketTicker = {
    symbol: t?.symbol ?? symbol,
    price: t ? parseFloat(t.lastPrice) : 0,
    price24hPct: t ? parseFloat(t.price24hPcnt) * 100 : 0,
    fundingRate: t ? parseFloat(t.fundingRate) : 0,
    funding8hAgo: fundingList[1] ? parseFloat(fundingList[1].fundingRate) : null,
    funding24hAgo: fundingList[3] ? parseFloat(fundingList[3].fundingRate) : null,
    oi: t ? parseFloat(t.openInterest) : 0,
    oiValueUsd: t ? parseFloat(t.openInterestValue) : 0,
    oi4hAgo: null,
    oi24hAgo: null,
    volume24hUsd: t ? parseFloat(t.turnover24h) : 0,
    bid: t ? parseFloat(t.bid1Price) : 0,
    ask: t ? parseFloat(t.ask1Price) : 0,
  };

  const klines: Record<string, MarketKlineBar[]> = {};
  klineIntervals.forEach((interval, i) => {
    klines[interval] = (klineResults[i]?.list ?? []).map(
      ([time, open, high, low, close, volume, turnover]) => ({
        time: parseInt(time),
        open: parseFloat(open),
        high: parseFloat(high),
        low: parseFloat(low),
        close: parseFloat(close),
        volume: parseFloat(volume),
        turnover: parseFloat(turnover),
      })
    );
  });

  const fundingHistory = fundingList.map((f) => ({
    rate: parseFloat(f.fundingRate),
    timestamp: parseInt(f.fundingRateTimestamp),
  }));

  const orderbook = {
    bids: (obRes.b ?? []).map(([p, s]) => [parseFloat(p), parseFloat(s)] as [number, number]),
    asks: (obRes.a ?? []).map(([p, s]) => [parseFloat(p), parseFloat(s)] as [number, number]),
  };

  return { ticker, klines, fundingHistory, orderbook };
}

export type ScanFilter = "oi_divergence" | "crowded_positioning" | "volume_spike";

export async function handleScanMarket(
  client: BybitClient,
  filter: ScanFilter,
  minVolume24hUsd = 10_000_000,
  limit = 15
): Promise<unknown[]> {
  switch (filter) {
    case "oi_divergence":
      return scanOiDivergence(client, minVolume24hUsd, limit);
    case "crowded_positioning":
      return scanCrowdedPositioning(client, minVolume24hUsd, limit);
    case "volume_spike":
      return scanVolumeSpike(client, minVolume24hUsd, limit);
  }
}

async function scanOiDivergence(client: BybitClient, minVolume: number, limit: number): Promise<unknown[]> {
  void client; void minVolume; void limit;
  return [];
}

async function scanCrowdedPositioning(client: BybitClient, minVolume: number, limit: number): Promise<unknown[]> {
  void client; void minVolume; void limit;
  return [];
}

async function scanVolumeSpike(client: BybitClient, minVolume: number, limit: number): Promise<unknown[]> {
  void client; void minVolume; void limit;
  return [];
}
