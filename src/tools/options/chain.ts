import { BybitClient } from "../../client";
import { TickersResult } from "../types";
import {
  OptionTickersResult,
  OptionContract,
  OptionUnderlying,
  parseOptionSymbol,
  computeMoneyness,
} from "./types";

// Tuple order documented by CONTRACTS_FORMAT below.
export type CompactContractTuple = [
  strike: number,
  type: "C" | "P",
  bid: number,
  ask: number,
  iv: number,
  openInterest: number,
];

export interface OptionChainExpiryGroup {
  /** Exact date segment of the Bybit symbol (e.g. "4JUL26", "31JUL26") — reconstructs tradable symbols. */
  expiryToken: string;
  /** ISO date, e.g. "2026-07-04". */
  expiryDate: string;
  daysToExpiry: number;
  contracts: CompactContractTuple[];
}

export interface CompactOptionChainResult {
  underlying: string;
  spot: number;
  contractsFormat: string;
  returned: number;
  matched: number;
  expiries: OptionChainExpiryGroup[];
  serverTimestamp: string;
}

export interface FullOptionChainResult {
  underlying: string;
  spot: number;
  returned: number;
  matched: number;
  contracts: OptionContract[];
  serverTimestamp: string;
}

export type OptionChainResult = CompactOptionChainResult | FullOptionChainResult;

const CONTRACTS_FORMAT =
  'contracts: [strike, "C"|"P", bid, ask, iv, openInterest]; symbol = {UNDERLYING}-{expiryToken}-{strike}-{C|P}-USDT';

const DEFAULT_LIMIT = 50;

interface MatchedContract {
  symbol: string;
  expiryToken: string;
  expiry: string; // full ISO timestamp (full-mode field)
  daysToExpiry: number;
  strike: number;
  type: "call" | "put";
  bid: number;
  ask: number;
  mark: number;
  lastPrice: number;
  iv: number;
  openInterest: number;
  volume24h: number;
}

export async function handleGetOptionChain(
  client: BybitClient,
  params: {
    underlying: OptionUnderlying;
    minDaysToExpiry?: number;
    maxDaysToExpiry?: number;
    type?: "call" | "put";
    minOpenInterest?: number;
    strikeRange?: { minPctFromSpot: number; maxPctFromSpot: number };
    compact?: boolean;
    limit?: number;
  }
): Promise<OptionChainResult> {
  const {
    underlying,
    minDaysToExpiry = 0,
    maxDaysToExpiry = 60,
    type,
    minOpenInterest = 10,
    strikeRange,
    compact = true,
    limit = DEFAULT_LIMIT,
  } = params;

  const [chainRes, spotRes] = await Promise.all([
    client.publicGet<OptionTickersResult>("/v5/market/tickers", {
      category: "option",
      baseCoin: underlying,
    }),
    client.publicGet<TickersResult>("/v5/market/tickers", {
      category: "spot",
      symbol: `${underlying}USDT`,
    }),
  ]);

  const spot = parseFloat(spotRes.list[0]?.lastPrice ?? "0");
  const now = Date.now();

  const matched: MatchedContract[] = [];

  for (const t of chainRes.list) {
    let parsed: ReturnType<typeof parseOptionSymbol>;
    try { parsed = parseOptionSymbol(t.symbol); } catch { continue; }

    const daysToExpiry = Math.max(0, Math.round((parsed.expiry.getTime() - now) / 86400000));
    if (daysToExpiry < minDaysToExpiry || daysToExpiry > maxDaysToExpiry) continue;
    if (type && parsed.type !== type) continue;

    const oi = parseFloat(t.openInterest);
    if (oi < minOpenInterest) continue;

    if (strikeRange && spot > 0) {
      const pct = (parsed.strike - spot) / spot * 100;
      if (pct < strikeRange.minPctFromSpot || pct > strikeRange.maxPctFromSpot) continue;
    }

    matched.push({
      symbol: t.symbol,
      expiryToken: t.symbol.split("-")[1],
      expiry: parsed.expiry.toISOString(),
      daysToExpiry,
      strike: parsed.strike,
      type: parsed.type,
      bid: parseFloat(t.bid1Price),
      ask: parseFloat(t.ask1Price),
      mark: parseFloat(t.markPrice),
      lastPrice: parseFloat(t.lastPrice),
      iv: parseFloat(t.markIv),
      openInterest: oi,
      volume24h: parseFloat(t.volume24h),
    });
  }

  // Cap AFTER filtering: keep the top `limit` by openInterest so truncation
  // drops the least liquid contracts first. `matched` vs `returned` in the
  // response makes any truncation explicit.
  const cap = Math.max(0, Math.floor(limit));
  const kept = matched.length > cap
    ? [...matched].sort((a, b) => b.openInterest - a.openInterest).slice(0, cap)
    : matched;

  const sorted = [...kept].sort((a, b) =>
    a.daysToExpiry !== b.daysToExpiry ? a.daysToExpiry - b.daysToExpiry :
    a.strike !== b.strike ? a.strike - b.strike :
    a.type.localeCompare(b.type) // deterministic: call before put at same strike
  );

  const serverTimestamp = new Date(now).toISOString();

  if (!compact) {
    return {
      underlying,
      spot,
      returned: sorted.length,
      matched: matched.length,
      contracts: sorted.map((c): OptionContract => ({
        symbol: c.symbol,
        strike: c.strike,
        expiry: c.expiry,
        daysToExpiry: c.daysToExpiry,
        type: c.type,
        bid: c.bid,
        ask: c.ask,
        mark: c.mark,
        lastPrice: c.lastPrice,
        iv: c.iv,
        openInterest: c.openInterest,
        volume24h: c.volume24h,
        moneyness: computeMoneyness(c.strike, spot, c.type),
      })),
      serverTimestamp,
    };
  }

  // Group by expiry; `sorted` is already ordered by daysToExpiry then strike,
  // so groups form in expiry order and tuples land in strike order.
  const groups = new Map<string, OptionChainExpiryGroup>();
  for (const c of sorted) {
    const tuple: CompactContractTuple = [
      c.strike,
      c.type === "call" ? "C" : "P",
      c.bid,
      c.ask,
      c.iv,
      c.openInterest,
    ];
    const group = groups.get(c.expiryToken);
    if (group) {
      group.contracts.push(tuple);
    } else {
      groups.set(c.expiryToken, {
        expiryToken: c.expiryToken,
        expiryDate: c.expiry.slice(0, 10),
        daysToExpiry: c.daysToExpiry,
        contracts: [tuple],
      });
    }
  }

  return {
    underlying,
    spot,
    contractsFormat: CONTRACTS_FORMAT,
    returned: sorted.length,
    matched: matched.length,
    expiries: [...groups.values()],
    serverTimestamp,
  };
}
