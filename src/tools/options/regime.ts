import { BybitClient } from "../../client";
import { OptionTickersResult, parseOptionSymbol } from "./types";
import { IVSampleStore, expiryBucket } from "./scan";

export interface OptionsRegimeSignal {
  atmIv30d: number;
  ivPercentile30d: number | null;
  putCallSkew: number;
  termStructure: "contango" | "backwardation" | "flat";
  sampleAvailable: boolean;
}

export interface OptionsRegimeResult {
  signals: Record<string, OptionsRegimeSignal>;
}

const ATM_PCT = 0.10;     // ±10% of spot for ATM IV lookups
const SKEW_OTM = 0.10;   // target 10% OTM for skew: put at spot*0.9, call at spot*1.1

// Unique expiries from the chain, sorted ascending, DTE >= 0
function sortedExpiries(
  tickers: OptionTickersResult["list"],
  now: number
): Date[] {
  const seen = new Map<number, Date>();
  for (const t of tickers) {
    try {
      const p = parseOptionSymbol(t.symbol);
      const dte = (p.expiry.getTime() - now) / 86400000;
      if (dte >= 0) seen.set(p.expiry.getTime(), p.expiry);
    } catch { continue; }
  }
  return Array.from(seen.values()).sort((a, b) => a.getTime() - b.getTime());
}

// Nearest-to-spot call IV for a given expiry
function atmIvForExpiry(
  tickers: OptionTickersResult["list"],
  spot: number,
  expiry: Date
): number | null {
  let best: { iv: number; dist: number } | null = null;
  const expiryMs = expiry.getTime();
  for (const t of tickers) {
    let parsed;
    try { parsed = parseOptionSymbol(t.symbol); } catch { continue; }
    if (parsed.type !== "call") continue;
    if (parsed.expiry.getTime() !== expiryMs) continue;
    const pct = Math.abs(parsed.strike - spot) / spot;
    if (pct > ATM_PCT) continue;
    const iv = parseFloat(t.markIv);
    if (isNaN(iv) || iv <= 0) continue;
    const dist = Math.abs(parsed.strike - spot);
    if (!best || dist < best.dist) best = { iv, dist };
  }
  return best?.iv ?? null;
}

// ATM IV for the expiry closest to targetDays
function atmIv30d(
  tickers: OptionTickersResult["list"],
  spot: number,
  expiries: Date[],
  targetDays: number,
  now: number
): number {
  if (expiries.length === 0) return 0;
  const target = now + targetDays * 86400000;
  const nearest = expiries.reduce((a, b) =>
    Math.abs(a.getTime() - target) <= Math.abs(b.getTime() - target) ? a : b
  );
  return atmIvForExpiry(tickers, spot, nearest) ?? 0;
}

// 10% OTM put minus 10% OTM call — use nearest liquid expiry
function computeSkew(
  tickers: OptionTickersResult["list"],
  spot: number,
  expiries: Date[]
): number {
  const putTarget = spot * (1 - SKEW_OTM);
  const callTarget = spot * (1 + SKEW_OTM);

  for (const expiry of expiries) {
    const ms = expiry.getTime();
    let bestPut: { iv: number; dist: number } | null = null;
    let bestCall: { iv: number; dist: number } | null = null;

    for (const t of tickers) {
      let parsed;
      try { parsed = parseOptionSymbol(t.symbol); } catch { continue; }
      if (parsed.expiry.getTime() !== ms) continue;
      const iv = parseFloat(t.markIv);
      if (isNaN(iv) || iv <= 0) continue;

      if (parsed.type === "put") {
        const dist = Math.abs(parsed.strike - putTarget);
        if (!bestPut || dist < bestPut.dist) bestPut = { iv, dist };
      } else {
        const dist = Math.abs(parsed.strike - callTarget);
        if (!bestCall || dist < bestCall.dist) bestCall = { iv, dist };
      }
    }

    if (bestPut && bestCall) return bestPut.iv - bestCall.iv;
  }
  return 0;
}

// Compare ATM IV of nearest vs farthest expiry, relative 5% threshold
function computeTermStructure(
  tickers: OptionTickersResult["list"],
  spot: number,
  expiries: Date[]
): OptionsRegimeSignal["termStructure"] {
  if (expiries.length < 2) return "flat";

  const nearIv = atmIvForExpiry(tickers, spot, expiries[0]);
  const farIv = atmIvForExpiry(tickers, spot, expiries[expiries.length - 1]);

  if (nearIv == null || farIv == null) return "flat";

  const diff = farIv - nearIv;
  const threshold = nearIv * 0.05;

  if (diff > threshold) return "contango";
  if (diff < -threshold) return "backwardation";
  return "flat";
}

export async function handleGetOptionsRegime(
  client: BybitClient,
  ivStore: IVSampleStore,
  params: { underlying?: Array<"BTC" | "ETH" | "SOL"> }
): Promise<OptionsRegimeResult> {
  const underlyings = params.underlying ?? (["BTC", "ETH", "SOL"] as const);
  const now = Date.now();

  const [chains, spotPrices] = await Promise.all([
    Promise.all(
      underlyings.map((u) =>
        client.publicGet<OptionTickersResult>("/v5/market/tickers", {
          category: "option",
          baseCoin: u,
        })
      )
    ),
    Promise.all(
      underlyings.map((u) =>
        client.publicGet<{ list: Array<{ lastPrice: string }> }>("/v5/market/tickers", {
          category: "linear",
          symbol: `${u}USDT`,
        }).then((r) => parseFloat(r.list[0]?.lastPrice ?? "0")).catch(() => 0)
      )
    ),
  ]);

  const signals: Record<string, OptionsRegimeSignal> = {};

  for (let i = 0; i < underlyings.length; i++) {
    const underlying = underlyings[i];
    const list = chains[i].list;
    if (list.length === 0) continue;

    const spot = spotPrices[i];
    const expiries = sortedExpiries(list, now);

    const iv30d = atmIv30d(list, spot, expiries, 30, now);
    const putCallSkew = computeSkew(list, spot, expiries);
    const termStructure = computeTermStructure(list, spot, expiries);

    for (const t of list) {
      const iv = parseFloat(t.markIv);
      if (!isNaN(iv) && iv > 0) {
        ivStore.record(underlying, expiryBucket(t.symbol), iv, new Date());
      }
    }

    // IV percentile: find the near-30d expiry bucket
    const target30d = now + 30 * 86400000;
    const nearest30d = expiries.length > 0
      ? expiries.reduce((a, b) =>
          Math.abs(a.getTime() - target30d) <= Math.abs(b.getTime() - target30d) ? a : b
        )
      : null;
    const nearBucket = nearest30d
      ? (() => {
          const match = list.find((t) => {
            try {
              const p = parseOptionSymbol(t.symbol);
              return p.expiry.getTime() === nearest30d.getTime() && p.type === "call";
            } catch { return false; }
          });
          return match ? expiryBucket(match.symbol) : "unknown";
        })()
      : "unknown";

    const sampleAvailable = ivStore.warmupRemaining(underlying, nearBucket) === null;
    const ivPercentile30d = sampleAvailable && iv30d > 0
      ? ivStore.getPercentile(underlying, nearBucket, iv30d)
      : null;

    signals[underlying] = {
      atmIv30d: iv30d,
      ivPercentile30d,
      putCallSkew,
      termStructure,
      sampleAvailable,
    };
  }

  return { signals };
}
