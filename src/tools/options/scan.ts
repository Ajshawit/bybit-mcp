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

function expiryBucket(symbol: string): string {
  const parts = symbol.split("-");
  if (parts.length < 2) return "unknown";
  const exp = parts[1]; // e.g. "25APR26"
  return exp.slice(2); // "APR26"
}

export interface ScanOptionsResult {
  underlying: string;
  filter: string;
  percentileAvailable: boolean;
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
  const now = Date.now();

  const chainRes = await client.publicGet<OptionTickersResult>("/v5/market/tickers", {
    category: "option",
    baseCoin: underlying,
  });

  // Record IV samples as side-effect
  for (const t of chainRes.list) {
    const iv = parseFloat(t.markIv);
    if (!isNaN(iv) && iv > 0) {
      ivStore.record(underlying, expiryBucket(t.symbol), iv, new Date());
    }
  }

  // Determine warmup state using the first contract's bucket as representative
  const repBucket = chainRes.list[0] ? expiryBucket(chainRes.list[0].symbol) : "unknown";
  const pctAvailable = ivStore.warmupRemaining(underlying, repBucket) === null;
  const warmupRemaining = pctAvailable ? undefined : (ivStore.warmupRemaining(underlying, repBucket) ?? undefined);

  // Parse and enrich contracts
  const enriched = chainRes.list.flatMap((t) => {
    let parsed: ReturnType<typeof parseOptionSymbol>;
    try { parsed = parseOptionSymbol(t.symbol); } catch { return []; }

    const daysToExpiry = Math.max(0, Math.ceil((parsed.expiry.getTime() - now) / 86400000));
    const iv = parseFloat(t.markIv);
    const bucket = expiryBucket(t.symbol);
    const ivPercentile = pctAvailable ? (ivStore.getPercentile(underlying, bucket, iv) ?? undefined) : undefined;

    return [{
      symbol: t.symbol,
      strike: parsed.strike,
      expiry: parsed.expiry.toISOString(),
      daysToExpiry,
      type: parsed.type,
      iv,
      ivPercentile,
      openInterest: parseFloat(t.openInterest),
    }];
  });

  let sorted: typeof enriched;
  if (filter === "high_iv") {
    sorted = enriched
      .filter((c) => !pctAvailable || (c.ivPercentile ?? 0) >= 90)
      .sort((a, b) => b.iv - a.iv);
  } else if (filter === "low_iv") {
    sorted = enriched
      .filter((c) => !pctAvailable || (c.ivPercentile ?? 100) <= 10)
      .sort((a, b) => a.iv - b.iv);
  } else {
    // skew and high_oi_change: sort by OI descending (v1 placeholder)
    sorted = enriched.sort((a, b) => b.openInterest - a.openInterest);
  }

  return {
    underlying,
    filter,
    percentileAvailable: pctAvailable,
    ...(warmupRemaining ? { warmupRemaining } : {}),
    contracts: sorted.slice(0, limit).map(({ daysToExpiry: _dte, ...rest }) => rest),
  };
}
