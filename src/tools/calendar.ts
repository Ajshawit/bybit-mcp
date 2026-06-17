import { BybitClient } from "../client";
import { PositionListResult, TickersResult } from "./types";
import { OptionTickersResult, OPTION_UNDERLYINGS, parseOptionSymbol } from "./options/types";
import { concurrentMap, isNyseOpen, NyseStatus } from "../util";

// Event calendar: the time-based context a trading decision needs — when
// funding hits, which option expiries are loaded, which dated futures
// deliver, and whether NYSE is open (TradFi symbols only move during RTH).

const DEFAULT_DAYS_AHEAD = 45;
const MAX_FUNDING_SYMBOLS = 10;

const r2 = (v: number) => Math.round(v * 100) / 100;
const ri = (v: number) => Math.round(v);

export interface FundingEvent {
  symbol: string;
  category: "linear" | "inverse";
  fundingRate: number;
  nextFundingTime: string | null;
  secondsToNextFunding: number | null;
}

export interface ExpiryEvent {
  expiry: string;          // ISO
  daysToExpiry: number;
  contracts: number;
  totalOpenInterest: number;     // base-coin units
  oiNotionalUsd: number | null;  // OI × underlying price
}

export interface DeliveryEvent {
  symbol: string;
  deliveryTime: string;    // ISO
  daysToDelivery: number;
}

export interface EventCalendarResult {
  daysAhead: number;
  funding: FundingEvent[];
  fundingNote?: string;
  optionExpiries?: Record<string, ExpiryEvent[]>;
  optionsNote?: string;
  futuresDeliveries: DeliveryEvent[];
  deliveriesNote?: string;
  nyse: NyseStatus;
}

interface DeliveryInstrumentsResult {
  list: Array<{ symbol: string; deliveryTime?: string; contractType?: string }>;
}

async function fundingForSymbols(
  client: BybitClient,
  symbols: Array<{ symbol: string; category: "linear" | "inverse" }>
): Promise<{ events: FundingEvent[]; skipped: string[] }> {
  const skipped: string[] = [];
  const results = await concurrentMap(symbols, 5, async ({ symbol, category }) => {
    try {
      const res = await client.publicGet<TickersResult>("/v5/market/tickers", { category, symbol });
      const t = res.list?.[0];
      if (!t) {
        skipped.push(symbol);
        return null;
      }
      const nextMs = t.nextFundingTime ? parseInt(t.nextFundingTime, 10) : NaN;
      const hasNext = Number.isFinite(nextMs) && nextMs > 0;
      return {
        symbol,
        category,
        fundingRate: parseFloat(t.fundingRate),
        nextFundingTime: hasNext ? new Date(nextMs).toISOString() : null,
        secondsToNextFunding: hasNext ? Math.max(0, Math.round((nextMs - Date.now()) / 1000)) : null,
      } as FundingEvent;
    } catch {
      skipped.push(symbol);
      return null;
    }
  });
  return { events: results.filter((r): r is FundingEvent => r !== null), skipped };
}

async function optionExpiriesFor(
  client: BybitClient,
  underlying: string,
  daysAhead: number
): Promise<ExpiryEvent[]> {
  const chain = await client.publicGet<OptionTickersResult>("/v5/market/tickers", {
    category: "option",
    baseCoin: underlying,
  });

  let underlyingPrice: number | null = null;
  const byExpiry = new Map<number, { contracts: number; oi: number }>();
  const now = Date.now();

  for (const t of chain.list ?? []) {
    let parsed;
    try { parsed = parseOptionSymbol(t.symbol); } catch { continue; }
    const ms = parsed.expiry.getTime();
    const days = (ms - now) / 86400000;
    if (days < 0 || days > daysAhead) continue;

    if (underlyingPrice === null && t.underlyingPrice) {
      const up = parseFloat(t.underlyingPrice);
      if (Number.isFinite(up) && up > 0) underlyingPrice = up;
    }

    const oi = parseFloat(t.openInterest);
    const bucket = byExpiry.get(ms) ?? { contracts: 0, oi: 0 };
    byExpiry.set(ms, {
      contracts: bucket.contracts + 1,
      oi: bucket.oi + (Number.isFinite(oi) ? oi : 0),
    });
  }

  return Array.from(byExpiry.entries())
    .sort(([a], [b]) => a - b)
    .map(([ms, { contracts, oi }]) => ({
      expiry: new Date(ms).toISOString(),
      daysToExpiry: r2((ms - now) / 86400000),
      contracts,
      totalOpenInterest: r2(oi),
      oiNotionalUsd: underlyingPrice !== null ? ri(oi * underlyingPrice) : null,
    }));
}

export async function handleGetEventCalendar(
  client: BybitClient,
  enableOptions: boolean,
  params: { symbols?: string[]; daysAhead?: number } = {}
): Promise<EventCalendarResult> {
  const daysAhead = Math.min(Math.max(params.daysAhead ?? DEFAULT_DAYS_AHEAD, 1), 365);

  // Funding symbols: explicit list (assumed linear), else open-position
  // symbols (category-aware), else the majors.
  let fundingSymbols: Array<{ symbol: string; category: "linear" | "inverse" }>;
  const fundingNoteParts: string[] = [];
  if (params.symbols && params.symbols.length > 0) {
    fundingSymbols = params.symbols
      .slice(0, MAX_FUNDING_SYMBOLS)
      .map((s) => ({ symbol: s, category: "linear" as const }));
    if (params.symbols.length > MAX_FUNDING_SYMBOLS) {
      fundingNoteParts.push(`Funding limited to first ${MAX_FUNDING_SYMBOLS} symbols.`);
    }
  } else {
    const [linearRes, inverseRes] = await Promise.all([
      client.signedGet<PositionListResult>("/v5/position/list", { category: "linear", settleCoin: "USDT" })
        .catch(() => null),
      client.signedGet<PositionListResult>("/v5/position/list", { category: "inverse" })
        .catch(() => null),
    ]);
    const fromPositions: Array<{ symbol: string; category: "linear" | "inverse" }> = [];
    for (const p of linearRes?.list ?? []) {
      if (parseFloat(p.size) > 0) fromPositions.push({ symbol: p.symbol, category: "linear" });
    }
    for (const p of inverseRes?.list ?? []) {
      if (parseFloat(p.size) > 0) fromPositions.push({ symbol: p.symbol, category: "inverse" });
    }
    if (fromPositions.length > 0) {
      fundingSymbols = fromPositions.slice(0, MAX_FUNDING_SYMBOLS);
      fundingNoteParts.push("Funding symbols derived from open positions.");
    } else {
      fundingSymbols = [
        { symbol: "BTCUSDT", category: "linear" },
        { symbol: "ETHUSDT", category: "linear" },
      ];
      fundingNoteParts.push("No open positions — funding shown for BTCUSDT/ETHUSDT defaults.");
    }
  }

  const [fundingResult, deliveriesRes, ...optionResults] = await Promise.all([
    fundingForSymbols(client, fundingSymbols),
    client.publicGet<DeliveryInstrumentsResult>("/v5/market/instruments-info", {
      category: "linear",
      limit: "1000",
    }).catch(() => null),
    ...(enableOptions
      ? OPTION_UNDERLYINGS.map((u) =>
          optionExpiriesFor(client, u, daysAhead).catch(() => null)
        )
      : []),
  ]);

  if (fundingResult.skipped.length > 0) {
    fundingNoteParts.push(`No ticker for: ${fundingResult.skipped.join(", ")}.`);
  }

  // Dated futures deliveries within the window.
  const now = Date.now();
  const futuresDeliveries: DeliveryEvent[] = (deliveriesRes?.list ?? [])
    .flatMap((inst) => {
      const ms = inst.deliveryTime ? parseInt(inst.deliveryTime, 10) : NaN;
      if (!Number.isFinite(ms) || ms <= now) return [];
      const days = (ms - now) / 86400000;
      if (days > daysAhead) return [];
      return [{
        symbol: inst.symbol,
        deliveryTime: new Date(ms).toISOString(),
        daysToDelivery: r2(days),
      }];
    })
    .sort((a, b) => a.daysToDelivery - b.daysToDelivery);

  let optionExpiries: Record<string, ExpiryEvent[]> | undefined;
  let optionsNote: string | undefined;
  if (enableOptions) {
    optionExpiries = {};
    const failed: string[] = [];
    OPTION_UNDERLYINGS.forEach((u, i) => {
      const events = optionResults[i] as ExpiryEvent[] | null;
      if (events === null) failed.push(u);
      else if (events.length > 0) optionExpiries![u] = events;
    });
    if (failed.length > 0) optionsNote = `Option chain fetch failed for: ${failed.join(", ")}.`;
  } else {
    optionsNote = "Options module disabled (ENABLE_OPTIONS) — expiry schedule omitted.";
  }

  return {
    daysAhead,
    funding: fundingResult.events,
    ...(fundingNoteParts.length > 0 ? { fundingNote: fundingNoteParts.join(" ") } : {}),
    ...(optionExpiries !== undefined ? { optionExpiries } : {}),
    ...(optionsNote ? { optionsNote } : {}),
    futuresDeliveries,
    ...(deliveriesRes === null ? { deliveriesNote: "Instruments fetch failed — deliveries unavailable." } : {}),
    nyse: isNyseOpen(),
  };
}
