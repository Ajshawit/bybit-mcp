import { BybitClient } from "../client";
import { FundingHistoryResult, TickersResult } from "./types";

// Basis & funding-carry analytics: perp premium vs index, realized funding
// carry, predicted next funding from the premium index, dated-futures
// annualized basis, and a cross-market carry scan.

// Bybit's funding formula: F = P_avg + clamp(I - P_avg, ±0.05%), where I is
// the interest-rate component (0.01% per 8h, scaled to the symbol's funding
// interval). When the premium is small the clamp doesn't bind and funding
// pins to I.
const INTEREST_PER_8H = 0.0001;
const FUNDING_CLAMP = 0.0005;
const DEFAULT_FUNDING_INTERVAL_MIN = 480;

const r2 = (v: number) => Math.round(v * 100) / 100;
const r4 = (v: number) => Math.round(v * 10000) / 10000;
const ri = (v: number) => Math.round(v);

/** Annualized funding in percent for a per-interval rate. */
export function annualizedFundingPct(rate: number, intervalMinutes: number): number {
  const epochsPerYear = (525600 / intervalMinutes);
  return rate * epochsPerYear * 100;
}

/** Bybit-formula estimate of the next funding print from the average premium. */
export function predictedFundingFromPremium(premiumAvg: number, intervalMinutes: number): number {
  const interest = INTEREST_PER_8H * (intervalMinutes / 480);
  const clamped = Math.min(Math.max(interest - premiumAvg, -FUNDING_CLAMP), FUNDING_CLAMP);
  return premiumAvg + clamped;
}

// Ticker fields beyond the shared BybitTicker type that this tool needs.
interface CarryTicker {
  symbol: string;
  lastPrice: string;
  markPrice?: string;
  indexPrice?: string;
  price24hPcnt: string;
  fundingRate: string;
  nextFundingTime: string;
  openInterestValue: string;
  turnover24h: string;
  deliveryTime?: string;
}

interface CarryTickersResult {
  list: CarryTicker[];
}

interface InstrumentsFundingResult {
  list: Array<{ symbol: string; fundingInterval?: number }>;
  nextPageCursor?: string;
}

// Premium index kline tuples: [startMs, open, high, low, close]
interface PremiumIndexKlineResult {
  list: string[][];
}

export interface BasisResult {
  action: "basis";
  symbol: string;
  perp: {
    lastPrice: number;
    markPrice: number | null;
    indexPrice: number | null;
    markIndexBasisPct: number | null;  // perp premium over index
    fundingRate: number;
    fundingAnnualizedPct: number;
    fundingIntervalHours: number;
    nextFundingTime: string | null;
  };
  realizedFunding: {
    epochs: number;
    meanRate: number;
    annualizedPct: number;             // what the carry actually paid recently
    minRate: number;
    maxRate: number;
  } | null;
  predictedFunding: {
    rate: number;
    annualizedPct: number;
    premiumAvg: number;
  } | null;
  spot: {
    price: number;
    perpSpotBasisPct: number;
  } | null;
  datedFuture: {
    deliveryTime: string;
    daysToDelivery: number;
    annualizedBasisPct: number | null; // (mark/index - 1) * 365/DTE
  } | null;
}

export interface CarryScanRow {
  symbol: string;
  fundingRate: number;
  fundingIntervalHours: number;
  fundingAnnualizedPct: number;
  price24hPct: number;
  volume24hUsd: number;
  oiValueUsd: number;
}

export interface CarryScanResult {
  action: "scan";
  shortPerpCollects: CarryScanRow[];  // positive funding: short perp + long spot earns
  longPerpCollects: CarryScanRow[];   // negative funding: long perp earns
  note?: string;  // only set when a runtime condition degrades the scan (e.g. missing funding intervals)
}

export async function handleGetCarryAnalytics(
  client: BybitClient,
  params: {
    action: "basis" | "scan";
    symbol?: string;
    minVolume24hUsd?: number;
    limit?: number;
  }
): Promise<BasisResult | CarryScanResult> {
  if (params.action === "basis") {
    if (!params.symbol) throw new Error("symbol is required for action 'basis'");
    return basisForSymbol(client, params.symbol);
  }
  // Clamp: MCP schema bounds are advisory only.
  const limit = Math.min(Math.max(params.limit ?? 10, 1), 100);
  return carryScan(client, params.minVolume24hUsd ?? 10_000_000, limit);
}

async function basisForSymbol(client: BybitClient, symbol: string): Promise<BasisResult> {
  const [tickerRes, fundingRes, spotRes] = await Promise.all([
    client.publicGet<CarryTickersResult>("/v5/market/tickers", { category: "linear", symbol }),
    client.publicGet<FundingHistoryResult>("/v5/market/funding/history", {
      category: "linear", symbol, limit: "30",
    }).catch(() => null),
    client.publicGet<CarryTickersResult>("/v5/market/tickers", { category: "spot", symbol })
      .catch(() => null),
  ]);

  const t = tickerRes.list?.[0];
  if (!t) throw new Error(`No linear ticker found for ${symbol}`);

  const lastPrice = parseFloat(t.lastPrice);
  const markPrice = t.markPrice ? parseFloat(t.markPrice) : NaN;
  const indexPrice = t.indexPrice ? parseFloat(t.indexPrice) : NaN;
  const fundingRate = parseFloat(t.fundingRate);

  // Funding interval from history timestamps — it varies per symbol
  // (1h/2h/4h/8h) and the ticker doesn't carry it.
  const fl = fundingRes?.list ?? [];
  const intervalMs = fl.length >= 2
    ? Math.abs(parseInt(fl[0].fundingRateTimestamp, 10) - parseInt(fl[1].fundingRateTimestamp, 10))
    : DEFAULT_FUNDING_INTERVAL_MIN * 60000;
  const intervalMinutes = intervalMs > 0 ? intervalMs / 60000 : DEFAULT_FUNDING_INTERVAL_MIN;

  const rates = fl.map((f) => parseFloat(f.fundingRate)).filter((r) => Number.isFinite(r));
  const realizedFunding = rates.length > 0
    ? (() => {
        const mean = rates.reduce((s, v) => s + v, 0) / rates.length;
        return {
          epochs: rates.length,
          meanRate: mean,
          annualizedPct: r2(annualizedFundingPct(mean, intervalMinutes)),
          minRate: Math.min(...rates),
          maxRate: Math.max(...rates),
        };
      })()
    : null;

  // Predicted next funding from the premium index over the last interval.
  let predictedFunding: BasisResult["predictedFunding"] = null;
  try {
    const bars = Math.min(Math.max(Math.ceil(intervalMinutes / 5), 1), 200);
    const premRes = await client.publicGet<PremiumIndexKlineResult>(
      "/v5/market/premium-index-price-kline",
      { category: "linear", symbol, interval: "5", limit: String(bars) }
    );
    const closes = (premRes.list ?? [])
      .map((row) => parseFloat(row[4]))
      .filter((v) => Number.isFinite(v));
    if (closes.length > 0) {
      const premiumAvg = closes.reduce((s, v) => s + v, 0) / closes.length;
      const rate = predictedFundingFromPremium(premiumAvg, intervalMinutes);
      predictedFunding = {
        rate,
        annualizedPct: r2(annualizedFundingPct(rate, intervalMinutes)),
        premiumAvg,
      };
    }
  } catch {
    predictedFunding = null;
  }

  const spotTicker = spotRes?.list?.[0];
  const spotPrice = spotTicker ? parseFloat(spotTicker.lastPrice) : NaN;
  const spot = Number.isFinite(spotPrice) && spotPrice > 0
    ? { price: spotPrice, perpSpotBasisPct: r4((lastPrice - spotPrice) / spotPrice * 100) }
    : null;

  // Dated futures (deliveryTime > 0): annualize the mark-vs-index basis.
  const deliveryMs = t.deliveryTime ? parseInt(t.deliveryTime, 10) : 0;
  let datedFuture: BasisResult["datedFuture"] = null;
  if (Number.isFinite(deliveryMs) && deliveryMs > Date.now()) {
    const daysToDelivery = (deliveryMs - Date.now()) / 86400000;
    const annualizedBasisPct =
      Number.isFinite(markPrice) && Number.isFinite(indexPrice) && indexPrice > 0 && daysToDelivery > 0
        ? r2((markPrice / indexPrice - 1) * (365 / daysToDelivery) * 100)
        : null;
    datedFuture = {
      deliveryTime: new Date(deliveryMs).toISOString(),
      daysToDelivery: r2(daysToDelivery),
      annualizedBasisPct,
    };
  }

  const nextFundingMs = t.nextFundingTime ? parseInt(t.nextFundingTime, 10) : NaN;

  return {
    action: "basis",
    symbol,
    perp: {
      lastPrice,
      markPrice: Number.isFinite(markPrice) ? markPrice : null,
      indexPrice: Number.isFinite(indexPrice) ? indexPrice : null,
      markIndexBasisPct:
        Number.isFinite(markPrice) && Number.isFinite(indexPrice) && indexPrice > 0
          ? r4((markPrice - indexPrice) / indexPrice * 100)
          : null,
      fundingRate,
      fundingAnnualizedPct: r2(annualizedFundingPct(fundingRate, intervalMinutes)),
      fundingIntervalHours: r2(intervalMinutes / 60),
      nextFundingTime: Number.isFinite(nextFundingMs) && nextFundingMs > 0
        ? new Date(nextFundingMs).toISOString()
        : null,
    },
    realizedFunding,
    predictedFunding,
    spot,
    datedFuture,
  };
}

async function carryScan(
  client: BybitClient,
  minVolume: number,
  limit: number
): Promise<CarryScanResult> {
  const [tickersRes, instrumentsRes] = await Promise.all([
    client.publicGet<TickersResult>("/v5/market/tickers", { category: "linear" }),
    client.publicGet<InstrumentsFundingResult>("/v5/market/instruments-info", {
      category: "linear", limit: "1000",
    }).catch(() => null),
  ]);

  const intervalBySymbol = new Map<string, number>();
  for (const inst of instrumentsRes?.list ?? []) {
    if (typeof inst.fundingInterval === "number" && inst.fundingInterval > 0) {
      intervalBySymbol.set(inst.symbol, inst.fundingInterval);
    }
  }

  const rows: CarryScanRow[] = (tickersRes.list ?? [])
    .map((t) => {
      const fundingRate = parseFloat(t.fundingRate);
      const volume = parseFloat(t.turnover24h);
      if (!Number.isFinite(fundingRate) || fundingRate === 0) return null;
      if (!(volume >= minVolume)) return null;
      const intervalMinutes = intervalBySymbol.get(t.symbol) ?? DEFAULT_FUNDING_INTERVAL_MIN;
      return {
        symbol: t.symbol,
        fundingRate,
        fundingIntervalHours: r2(intervalMinutes / 60),
        fundingAnnualizedPct: r2(annualizedFundingPct(fundingRate, intervalMinutes)),
        price24hPct: r2(parseFloat(t.price24hPcnt) * 100),
        volume24hUsd: ri(volume),
        oiValueUsd: ri(parseFloat(t.openInterestValue)),
      };
    })
    .filter((r): r is CarryScanRow => r !== null);

  const shortPerpCollects = rows
    .filter((r) => r.fundingRate > 0)
    .sort((a, b) => b.fundingAnnualizedPct - a.fundingAnnualizedPct)
    .slice(0, limit);
  const longPerpCollects = rows
    .filter((r) => r.fundingRate < 0)
    .sort((a, b) => a.fundingAnnualizedPct - b.fundingAnnualizedPct)
    .slice(0, limit);

  const note = instrumentsRes
    ? undefined
    : "Funding intervals unavailable — assumed 8h for all symbols.";

  return {
    action: "scan",
    shortPerpCollects,
    longPerpCollects,
    ...(note ? { note } : {}),
  };
}
