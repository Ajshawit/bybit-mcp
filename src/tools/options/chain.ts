import { BybitClient } from "../../client";
import { TickersResult } from "../types";
import {
  OptionTickersResult,
  OptionContract,
  parseOptionSymbol,
  computeMoneyness,
} from "./types";

export type CompactOptionContract = Pick<OptionContract,
  "symbol" | "strike" | "expiry" | "daysToExpiry" | "type" | "bid" | "ask" | "iv" | "openInterest"
>;

export interface OptionChainResult {
  underlying: string;
  spot: number;
  contracts: OptionContract[] | CompactOptionContract[];
}

export async function handleGetOptionChain(
  client: BybitClient,
  params: {
    underlying: "BTC" | "ETH" | "SOL";
    minDaysToExpiry?: number;
    maxDaysToExpiry?: number;
    type?: "call" | "put";
    minOpenInterest?: number;
    strikeRange?: { minPctFromSpot: number; maxPctFromSpot: number };
    compact?: boolean;
  }
): Promise<OptionChainResult> {
  const {
    underlying,
    minDaysToExpiry = 0,
    maxDaysToExpiry = 60,
    type,
    minOpenInterest = 10,
    strikeRange,
    compact = false,
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

  const contracts: Array<OptionContract | CompactOptionContract> = [];

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

    if (compact) {
      contracts.push({
        symbol: t.symbol,
        strike: parsed.strike,
        expiry: parsed.expiry.toISOString(),
        daysToExpiry,
        type: parsed.type,
        bid: parseFloat(t.bid1Price),
        ask: parseFloat(t.ask1Price),
        iv: parseFloat(t.markIv),
        openInterest: oi,
      });
    } else {
      contracts.push({
        symbol: t.symbol,
        strike: parsed.strike,
        expiry: parsed.expiry.toISOString(),
        daysToExpiry,
        type: parsed.type,
        bid: parseFloat(t.bid1Price),
        ask: parseFloat(t.ask1Price),
        mark: parseFloat(t.markPrice),
        lastPrice: parseFloat(t.lastPrice),
        iv: parseFloat(t.markIv),
        openInterest: oi,
        volume24h: parseFloat(t.volume24h),
        moneyness: computeMoneyness(parsed.strike, spot, parsed.type),
      });
    }
  }

  contracts.sort((a, b) =>
    a.daysToExpiry !== b.daysToExpiry ? a.daysToExpiry - b.daysToExpiry : a.strike - b.strike
  );

  return { underlying, spot, contracts };
}
