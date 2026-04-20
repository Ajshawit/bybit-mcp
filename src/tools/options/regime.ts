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

const ATM_PCT_THRESHOLD = 0.05;
const TARGET_DAYS_NEAR = 30;
const TARGET_DAYS_FAR = 60;

function findAtmIv(
  tickers: OptionTickersResult["list"],
  spot: number,
  type: "call" | "put",
  targetDays: number,
  now: number
): number | null {
  let best: { iv: number; distDays: number; distPct: number } | null = null;

  for (const t of tickers) {
    let parsed;
    try { parsed = parseOptionSymbol(t.symbol); } catch { continue; }
    if (parsed.type !== type) continue;

    const dte = (parsed.expiry.getTime() - now) / 86400000;
    if (dte < 0) continue;

    const pctFromSpot = Math.abs(parsed.strike - spot) / spot;
    if (pctFromSpot > ATM_PCT_THRESHOLD) continue;

    const distDays = Math.abs(dte - targetDays);
    const iv = parseFloat(t.markIv);
    if (isNaN(iv)) continue;

    if (!best || distDays < best.distDays || (distDays === best.distDays && pctFromSpot < best.distPct)) {
      best = { iv, distDays, distPct: pctFromSpot };
    }
  }

  return best?.iv ?? null;
}

export async function handleGetOptionsRegime(
  client: BybitClient,
  ivStore: IVSampleStore,
  params: { underlying?: Array<"BTC" | "ETH" | "SOL"> }
): Promise<OptionsRegimeResult> {
  const underlyings = params.underlying ?? (["BTC", "ETH", "SOL"] as const);
  const now = Date.now();

  const chains = await Promise.all(
    underlyings.map((u) =>
      client.publicGet<OptionTickersResult>("/v5/market/tickers", {
        category: "option",
        baseCoin: u,
      })
    )
  );

  const signals: Record<string, OptionsRegimeSignal> = {};

  for (let i = 0; i < underlyings.length; i++) {
    const underlying = underlyings[i];
    const list = chains[i].list;
    if (list.length === 0) continue;

    const spot = parseFloat(list.find((t) => t.underlyingPrice)?.underlyingPrice ?? "0");

    const nearCallIv = findAtmIv(list, spot, "call", TARGET_DAYS_NEAR, now);
    const nearPutIv = findAtmIv(list, spot, "put", TARGET_DAYS_NEAR, now);
    const farCallIv = findAtmIv(list, spot, "call", TARGET_DAYS_FAR, now);

    const atmIv30d = nearCallIv ?? 0;
    const putCallSkew = nearCallIv != null && nearPutIv != null
      ? nearPutIv - nearCallIv
      : 0;

    const termStructure: OptionsRegimeSignal["termStructure"] =
      nearCallIv == null || farCallIv == null ? "flat"
      : Math.abs(farCallIv - nearCallIv) < 0.02 ? "flat"
      : farCallIv > nearCallIv ? "contango"
      : "backwardation";

    for (const t of list) {
      const iv = parseFloat(t.markIv);
      if (!isNaN(iv) && iv > 0) {
        ivStore.record(underlying, expiryBucket(t.symbol), iv, new Date());
      }
    }

    const nearTicker = list.find((t) => {
      try {
        const p = parseOptionSymbol(t.symbol);
        const dte = (p.expiry.getTime() - now) / 86400000;
        return p.type === "call" && Math.abs(p.strike - spot) / spot < ATM_PCT_THRESHOLD && dte >= 0;
      } catch { return false; }
    });
    const nearBucket = nearTicker ? expiryBucket(nearTicker.symbol) : "unknown";
    const sampleAvailable = ivStore.warmupRemaining(underlying, nearBucket) === null;
    const ivPercentile30d = sampleAvailable && atmIv30d > 0
      ? ivStore.getPercentile(underlying, nearBucket, atmIv30d)
      : null;

    signals[underlying] = {
      atmIv30d,
      ivPercentile30d,
      putCallSkew,
      termStructure,
      sampleAvailable,
    };
  }

  return { signals };
}
