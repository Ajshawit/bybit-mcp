import { BybitClient } from "../../client";
import { OptionTickersResult, parseOptionSymbol } from "./types";
import { blackScholesGreeks, Greeks } from "./blackscholes";

export interface OptionQuoteResult {
  symbol: string;
  underlying: string;
  underlyingPrice: number;
  strike: number;
  expiry: string;
  daysToExpiry: number;
  type: "call" | "put";
  bid: number;
  ask: number;
  mark: number;
  iv: number;
  greeks: { delta: number; gamma: number; theta: number; vega: number };
  greeksLocal?: Greeks & {
    diffFromBybit: { delta: number; gamma: number; theta: number; vega: number };
  };
  openInterest: number;
  volume24h: number;
}

export async function handleGetOptionQuote(
  client: BybitClient,
  symbol: string,
  computeGreeksLocal = false
): Promise<OptionQuoteResult> {
  const res = await client.publicGet<OptionTickersResult>("/v5/market/tickers", {
    category: "option",
    symbol,
  });

  const t = res.list[0];
  if (!t) throw new Error(`No data returned for option symbol: ${symbol}`);

  const parsed = parseOptionSymbol(symbol);
  const now = Date.now();
  const daysToExpiry = Math.max(0, Math.ceil((parsed.expiry.getTime() - now) / 86400000));
  const underlyingPrice = parseFloat(t.underlyingPrice ?? "0");

  const greeks = {
    delta: parseFloat(t.delta),
    gamma: parseFloat(t.gamma),
    theta: parseFloat(t.theta),
    vega: parseFloat(t.vega),
  };

  let greeksLocal: OptionQuoteResult["greeksLocal"];
  if (computeGreeksLocal) {
    const T = daysToExpiry / 365;
    const local = blackScholesGreeks(parsed.type, underlyingPrice, parsed.strike, T, parseFloat(t.markIv));
    const absDiff5pct = (a: number, b: number) => Math.abs(b) > 0 && Math.abs(a - b) > Math.abs(b) * 0.05;
    if (absDiff5pct(local.delta, greeks.delta) || absDiff5pct(local.vega, greeks.vega)) {
      console.error(`[options] Greeks diff >5% for ${symbol} — may indicate stale data`);
    }
    greeksLocal = {
      ...local,
      diffFromBybit: {
        delta: local.delta - greeks.delta,
        gamma: local.gamma - greeks.gamma,
        theta: local.theta - greeks.theta,
        vega: local.vega - greeks.vega,
      },
    };
  }

  return {
    symbol,
    underlying: parsed.underlying,
    underlyingPrice,
    strike: parsed.strike,
    expiry: parsed.expiry.toISOString(),
    daysToExpiry,
    type: parsed.type,
    bid: parseFloat(t.bid1Price),
    ask: parseFloat(t.ask1Price),
    mark: parseFloat(t.markPrice),
    iv: parseFloat(t.markIv),
    greeks,
    ...(greeksLocal ? { greeksLocal } : {}),
    openInterest: parseFloat(t.openInterest),
    volume24h: parseFloat(t.volume24h),
  };
}
