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

export interface OIDivergenceResult {
  symbol: string;
  price: number;
  price24hPct: number;
  price4hPct: number;
  oi24hPct: number;
  oi4hPct: number;
  oiValueUsd: number;
  volume24hUsd: number;
  reading: "short_covering" | "new_shorts";
}

export interface CrowdedPositioningResult {
  symbol: string;
  price: number;
  fundingRate: number;
  fundingRateAnnualized: number;
  funding8hAgo: number | null;
  funding24hAgo: number | null;
  rangePosition: number;
  price24hPct: number;
  volume24hUsd: number;
  reading: "crowded_long" | "crowded_short";
}

export interface VolumeSpikeResult {
  symbol: string;
  price: number;
  hourChangePct: number;
  currentHourVolumeUsd: number;
  avg24hHourlyVolumeUsd: number;
  spikeRatio: number;
  price24hPct: number;
  reading: "impulse_up" | "impulse_down" | "churn";
}

export interface MarketDataResult {
  ticker: MarketTicker;
  klines: Record<string, MarketKlineBar[]>;
  fundingHistory: Array<{ rate: number; timestamp: number }>;
  orderbook: { bids: [number, number][]; asks: [number, number][] };
}

export interface OhlcResult {
  symbol: string;
  category: "linear" | "inverse" | "spot";
  interval: string;
  lastPrice: number;      // candles[0].close, or 0 if empty
  candles: MarketKlineBar[];  // newest-first (Bybit native order)
  timestamp: string;
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
    client.publicGet<OIHistoryResult>("/v5/market/open-interest", {
      category: "linear",
      symbol,
      intervalTime: "4h",
      limit: "7",
    }).catch(() => null), // soft-fail: OI history is optional
  ]);

  const tickersRes = allResults[0] as TickersResult;
  const klineResults = allResults.slice(1, 1 + klineIntervals.length) as KlineResult[];
  const fundingRes = allResults[1 + klineIntervals.length] as FundingHistoryResult;
  const obRes = allResults[2 + klineIntervals.length] as OrderbookEntry;
  const oiRes = allResults[3 + klineIntervals.length] as OIHistoryResult | null;
  const oiList = oiRes?.list ?? [];

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
    oi4hAgo: oiList[1] ? parseFloat(oiList[1].openInterest) : null,
    oi24hAgo: oiList[6] ? parseFloat(oiList[6].openInterest) : null,
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

export async function handleGetOhlc(
  client: BybitClient,
  symbol: string,
  category: "linear" | "inverse" | "spot" = "linear",
  interval: string = "60",
  limit: number = 100
): Promise<OhlcResult> {
  const res = await client.publicGet<KlineResult>("/v5/market/kline", {
    category,
    symbol,
    interval,
    limit: String(limit),
  });

  const candles: MarketKlineBar[] = (res.list ?? []).map(
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

  return {
    symbol,
    category,
    interval,
    lastPrice: candles.length > 0 ? candles[0].close : 0,
    candles,
    timestamp: new Date().toISOString(),
  };
}

export interface MarketRegimeResult {
  timeframe: "intraday" | "swing" | "macro";
  btcPrice: number;
  sma20: number;
  sma50: number;
  btcTrend: "bull" | "bear" | "choppy";
  medianFunding: number;
  fundingSentiment: "long_heavy" | "short_heavy" | "neutral";
  regime: "risk_on" | "risk_off" | "choppy";
  topFundingSymbols: Array<{
    symbol: string;
    fundingRate: number;
    side: "long_pays_short" | "short_pays_long";
  }>;
  timestamp: string;
}

const TIMEFRAME_INTERVAL: Record<"intraday" | "swing" | "macro", string> = {
  intraday: "60",
  swing: "240",
  macro: "D",
};

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

export async function handleGetMarketRegime(
  client: BybitClient,
  timeframe: "intraday" | "swing" | "macro" = "swing"
): Promise<MarketRegimeResult> {
  const interval = TIMEFRAME_INTERVAL[timeframe];

  const [klineRes, tickersRes] = await Promise.all([
    client.publicGet<KlineResult>("/v5/market/kline", {
      category: "linear",
      symbol: "BTCUSDT",
      interval,
      limit: "50",
    }),
    client.publicGet<TickersResult>("/v5/market/tickers", { category: "linear" }),
  ]);

  const bars = klineRes.list ?? [];
  if (bars.length < 50) {
    throw new Error(
      `Insufficient BTC kline data for SMA computation (got ${bars.length} bars, need 50)`
    );
  }

  // Reverse from newest-first to oldest-first for MA computation
  const closes = bars.map((b) => parseFloat(b[4])).reverse();
  const sma50 = closes.reduce((s, v) => s + v, 0) / 50;
  const sma20 = closes.slice(-20).reduce((s, v) => s + v, 0) / 20;
  const btcPrice = closes[closes.length - 1];

  const btcTrend: "bull" | "bear" | "choppy" =
    btcPrice > sma20 && sma20 > sma50 ? "bull"
    : btcPrice < sma20 && sma20 < sma50 ? "bear"
    : "choppy";

  const tickers = tickersRes.list ?? [];
  const validTickers = tickers
    .map((t) => ({ t, rate: parseFloat(t.fundingRate) }))
    .filter(({ rate }) => !isNaN(rate));

  const top20FundingRates = validTickers
    .sort((a, b) => parseFloat(b.t.turnover24h) - parseFloat(a.t.turnover24h))
    .slice(0, 20)
    .map(({ rate }) => rate);

  const medianFunding = median(top20FundingRates);

  const fundingSentiment: "long_heavy" | "short_heavy" | "neutral" =
    medianFunding > 0.0005 ? "long_heavy"
    : medianFunding < -0.0005 ? "short_heavy"
    : "neutral";

  const regime: "risk_on" | "risk_off" | "choppy" =
    btcTrend === "bull" && fundingSentiment !== "short_heavy" ? "risk_on"
    : btcTrend === "bear" && fundingSentiment !== "long_heavy" ? "risk_off"
    : "choppy";

  const MIN_VOLUME = 10_000_000;
  const topFundingSymbols = validTickers
    .filter(({ t }) => parseFloat(t.turnover24h) >= MIN_VOLUME)
    .sort((a, b) => Math.abs(b.rate) - Math.abs(a.rate))
    .slice(0, 5)
    .map(({ t, rate }) => ({
      symbol: t.symbol,
      fundingRate: rate,
      side: rate > 0 ? "long_pays_short" as const : "short_pays_long" as const,
    }));

  return {
    timeframe,
    btcPrice,
    sma20,
    sma50,
    btcTrend,
    medianFunding,
    fundingSentiment,
    regime,
    topFundingSymbols,
    timestamp: new Date().toISOString(),
  };
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

async function scanOiDivergence(
  client: BybitClient,
  minVolume: number,
  limit: number
): Promise<OIDivergenceResult[]> {
  const tickersRes = await client.publicGet<TickersResult>("/v5/market/tickers", { category: "linear" });

  const candidates = tickersRes.list.filter((t) => {
    const vol = parseFloat(t.turnover24h);
    const price24h = parseFloat(t.price24hPcnt) * 100;
    return vol >= minVolume && Math.abs(price24h) > 3;
  });

  const results = await concurrentMap(candidates, 10, async (t) => {
    try {
      const oiRes = await client.publicGet<OIHistoryResult>("/v5/market/open-interest", {
        category: "linear",
        symbol: t.symbol,
        intervalTime: "4h",
        limit: "7",
      });

      const ois = oiRes.list;
      if (ois.length < 7) return null;

      const oiNow = parseFloat(ois[0].openInterest);
      const oi4hAgo = parseFloat(ois[1].openInterest);
      const oi24hAgo = parseFloat(ois[6].openInterest);

      const oi4hPct = (oiNow - oi4hAgo) / oi4hAgo * 100;
      const oi24hPct = (oiNow - oi24hAgo) / oi24hAgo * 100;
      const price24hPct = parseFloat(t.price24hPcnt) * 100;

      if (Math.abs(oi24hPct) <= 2) return null;

      const priceUp = price24hPct > 0;
      const oiDown = oi24hPct < 0;
      const priceDown = price24hPct < 0;
      const oiUp = oi24hPct > 0;

      let reading: "short_covering" | "new_shorts" | null = null;
      if (priceUp && oiDown) reading = "short_covering";
      else if (priceDown && oiUp) reading = "new_shorts";
      else return null;

      const klineRes = await client.publicGet<KlineResult>("/v5/market/kline", {
        category: "linear",
        symbol: t.symbol,
        interval: "240",
        limit: "2",
      });
      const price4hPct = klineRes.list.length >= 2
        ? (parseFloat(klineRes.list[0][4]) - parseFloat(klineRes.list[1][4])) / parseFloat(klineRes.list[1][4]) * 100
        : 0;

      return {
        symbol: t.symbol,
        price: parseFloat(t.lastPrice),
        price24hPct,
        price4hPct,
        oi24hPct,
        oi4hPct,
        oiValueUsd: parseFloat(t.openInterestValue),
        volume24hUsd: parseFloat(t.turnover24h),
        reading,
      } as OIDivergenceResult;
    } catch {
      return null;
    }
  });

  return results
    .filter((r): r is OIDivergenceResult => r !== null)
    .slice(0, limit);
}

async function scanCrowdedPositioning(
  client: BybitClient,
  minVolume: number,
  limit: number
): Promise<CrowdedPositioningResult[]> {
  const FUNDING_THRESHOLD = 0.0005;

  const tickersRes = await client.publicGet<TickersResult>("/v5/market/tickers", { category: "linear" });

  const candidates = tickersRes.list.filter((t) => {
    const vol = parseFloat(t.turnover24h);
    const funding = parseFloat(t.fundingRate);
    if (vol < minVolume) return false;
    if (Math.abs(funding) <= FUNDING_THRESHOLD) return false;

    const price = parseFloat(t.lastPrice);
    const high = parseFloat(t.highPrice24h);
    const low = parseFloat(t.lowPrice24h);
    if (high === low) return false;

    const rangePos = (price - low) / (high - low);
    const isCrowdedLong = funding > FUNDING_THRESHOLD && rangePos >= 0.8;
    const isCrowdedShort = funding < -FUNDING_THRESHOLD && rangePos <= 0.2;
    return isCrowdedLong || isCrowdedShort;
  }).slice(0, 20);

  const results = await concurrentMap(candidates, 10, async (t) => {
    try {
      const fundingRes = await client.publicGet<FundingHistoryResult>("/v5/market/funding/history", {
        category: "linear",
        symbol: t.symbol,
        limit: "4",
      });

      const fl = fundingRes.list ?? [];
      const funding = parseFloat(t.fundingRate);
      const price = parseFloat(t.lastPrice);
      const high = parseFloat(t.highPrice24h);
      const low = parseFloat(t.lowPrice24h);
      const rangePos = (price - low) / (high - low);
      const reading: "crowded_long" | "crowded_short" = funding > 0 ? "crowded_long" : "crowded_short";

      return {
        symbol: t.symbol,
        price,
        fundingRate: funding,
        fundingRateAnnualized: funding * 3 * 365 * 100,
        funding8hAgo: fl[1] ? parseFloat(fl[1].fundingRate) : null,
        funding24hAgo: fl[3] ? parseFloat(fl[3].fundingRate) : null,
        rangePosition: rangePos,
        price24hPct: parseFloat(t.price24hPcnt) * 100,
        volume24hUsd: parseFloat(t.turnover24h),
        reading,
      } as CrowdedPositioningResult;
    } catch {
      return null;
    }
  });

  return results
    .filter((r): r is CrowdedPositioningResult => r !== null)
    .slice(0, limit);
}

async function scanVolumeSpike(
  client: BybitClient,
  minVolume: number,
  limit: number
): Promise<VolumeSpikeResult[]> {
  const tickersRes = await client.publicGet<TickersResult>("/v5/market/tickers", { category: "linear" });

  const universe = tickersRes.list
    .filter((t) => parseFloat(t.turnover24h) >= minVolume)
    .sort((a, b) => parseFloat(b.turnover24h) - parseFloat(a.turnover24h))
    .slice(0, 100);

  const results = await concurrentMap(universe, 10, async (t) => {
    try {
      const klineRes = await client.publicGet<KlineResult>("/v5/market/kline", {
        category: "linear",
        symbol: t.symbol,
        interval: "60",
        limit: "26",
      });

      const candles = klineRes.list;
      if (candles.length < 26) return null;

      const lastCompleted = candles[1];
      const priorCandles = candles.slice(2, 26);

      const currentHourVol = parseFloat(lastCompleted[6]);
      const avgPriorVol = priorCandles.reduce((sum, c) => sum + parseFloat(c[6]), 0) / priorCandles.length;

      if (avgPriorVol === 0) return null;
      const spikeRatio = currentHourVol / avgPriorVol;
      if (spikeRatio <= 3) return null;

      const open = parseFloat(lastCompleted[1]);
      const close = parseFloat(lastCompleted[4]);
      const hourChangePct = (close - open) / open * 100;

      const reading: "impulse_up" | "impulse_down" | "churn" =
        hourChangePct > 0.5 ? "impulse_up"
        : hourChangePct < -0.5 ? "impulse_down"
        : "churn";

      return {
        symbol: t.symbol,
        price: parseFloat(t.lastPrice),
        hourChangePct,
        currentHourVolumeUsd: currentHourVol,
        avg24hHourlyVolumeUsd: avgPriorVol,
        spikeRatio,
        price24hPct: parseFloat(t.price24hPcnt) * 100,
        reading,
      } as VolumeSpikeResult;
    } catch {
      return null;
    }
  });

  return results
    .filter((r): r is VolumeSpikeResult => r !== null)
    .slice(0, limit);
}
