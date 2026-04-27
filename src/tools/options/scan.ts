import { BybitClient } from "../../client";
import { OptionTickersResult, parseOptionSymbol } from "./types";

const MIN_WARMUP_SAMPLES = 20;
const MAX_SAMPLES_PER_BUCKET = 10000;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

interface Sample {
  iv: number;
  at: number; // unix ms
}

export class IVSampleStore {
  private buckets = new Map<string, Sample[]>();

  private key(underlying: string, expiryBucket: string): string {
    return `${underlying}:${expiryBucket}`;
  }

  record(underlying: string, expiryBucket: string, iv: number, at: Date): void {
    const key = this.key(underlying, expiryBucket);
    const samples = this.buckets.get(key) ?? [];
    const cutoff = at.getTime() - RETENTION_MS;
    const fresh = samples.filter((s) => s.at >= cutoff);
    fresh.push({ iv, at: at.getTime() });
    if (fresh.length > MAX_SAMPLES_PER_BUCKET) fresh.shift();
    this.buckets.set(key, fresh);
  }

  getPercentile(underlying: string, expiryBucket: string, iv: number): number | null {
    const samples = this.buckets.get(this.key(underlying, expiryBucket)) ?? [];
    if (samples.length < MIN_WARMUP_SAMPLES) return null;
    const below = samples.filter((s) => s.iv < iv).length;
    return (below / samples.length) * 100;
  }

  warmupRemaining(underlying: string, expiryBucket: string): string | null {
    const samples = this.buckets.get(this.key(underlying, expiryBucket)) ?? [];
    if (samples.length >= MIN_WARMUP_SAMPLES) return null;
    const need = MIN_WARMUP_SAMPLES - samples.length;
    // Estimate: one sample per call every ~30 min
    const hours = Math.ceil(need * 0.5);
    return `${hours}h`;
  }
}

export function expiryBucket(symbol: string): string {
  const parts = symbol.split("-");
  if (parts.length < 2) return "unknown";
  const exp = parts[1]; // e.g. "25APR26"
  return exp.slice(2); // "APR26"
}

export interface ScanOptionsResult {
  underlying: string;
  filter: string;
  percentileAvailable: boolean;
  isPlaceholder?: boolean;
  warmupRemaining?: string;
  contracts: Array<{
    symbol: string;
    strike: number;
    expiry: string;
    type: "call" | "put";
    iv: number;
    ivPercentile?: number;
    openInterest: number;
    oi24hChange?: number;
    skew?: number;
  }>;
}

export async function handleScanOptions(
  client: BybitClient,
  ivStore: IVSampleStore,
  params: {
    underlying: "BTC" | "ETH" | "SOL";
    filter: "high_iv" | "low_iv" | "skew" | "high_oi_change";
    expiry?: "weekly" | "monthly" | "all";
    limit?: number;
  }
): Promise<ScanOptionsResult> {
  const { underlying, filter, limit = 10 } = params;

  const [chainRes, spotPrice] = await Promise.all([
    client.publicGet<OptionTickersResult>("/v5/market/tickers", {
      category: "option",
      baseCoin: underlying,
    }),
    client.publicGet<{ list: Array<{ lastPrice: string }> }>("/v5/market/tickers", {
      category: "linear",
      symbol: `${underlying}USDT`,
    }).then((r) => parseFloat(r.list[0]?.lastPrice ?? "0")).catch(() => 0),
  ]);

  for (const t of chainRes.list) {
    const iv = parseFloat(t.markIv);
    if (!isNaN(iv) && iv > 0) {
      ivStore.record(underlying, expiryBucket(t.symbol), iv, new Date());
    }
  }

  const repBucket = chainRes.list[0] ? expiryBucket(chainRes.list[0].symbol) : "unknown";
  const remaining = ivStore.warmupRemaining(underlying, repBucket);
  const pctAvailable = remaining === null;
  const warmupRemaining = remaining ?? undefined;

  const spot = spotPrice;

  const enriched = chainRes.list.flatMap((t) => {
    let parsed: ReturnType<typeof parseOptionSymbol>;
    try { parsed = parseOptionSymbol(t.symbol); } catch { return []; }

    const iv = parseFloat(t.markIv);
    const bucket = expiryBucket(t.symbol);
    const ivPercentile = pctAvailable ? (ivStore.getPercentile(underlying, bucket, iv) ?? undefined) : undefined;

    return [{
      symbol: t.symbol,
      strike: parsed.strike,
      expiry: parsed.expiry.toISOString(),
      type: parsed.type,
      iv,
      ivPercentile,
      openInterest: parseFloat(t.openInterest),
    }];
  });

  let sorted: typeof enriched;
  if (filter === "high_iv" || filter === "low_iv") {
    // Exclude deep OTM smile tails — constrain to ±20% of spot when spot is available
    const nearSpot = spot > 0
      ? enriched.filter((c) => Math.abs(c.strike - spot) / spot <= 0.2)
      : enriched;
    if (filter === "high_iv") {
      sorted = nearSpot
        .filter((c) => !pctAvailable || (c.ivPercentile ?? 0) >= 90)
        .sort((a, b) => pctAvailable
          ? (b.ivPercentile ?? 0) - (a.ivPercentile ?? 0)
          : b.iv - a.iv
        );
    } else {
      sorted = nearSpot
        .filter((c) => !pctAvailable || (c.ivPercentile ?? 100) <= 10)
        .sort((a, b) => pctAvailable
          ? (a.ivPercentile ?? 100) - (b.ivPercentile ?? 100)
          : a.iv - b.iv
        );
    }
  } else {
    // skew and high_oi_change: placeholder — real analysis not yet implemented
    sorted = enriched.sort((a, b) => b.openInterest - a.openInterest);
  }

  const isPlaceholder = filter === "skew" || filter === "high_oi_change" ? true : undefined;

  return {
    underlying,
    filter,
    percentileAvailable: pctAvailable,
    ...(isPlaceholder ? { isPlaceholder } : {}),
    ...(warmupRemaining ? { warmupRemaining } : {}),
    contracts: sorted.slice(0, limit),
  };
}
