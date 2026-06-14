import { BybitClient } from "../../client";
import {
  GetRfqListParams,
  GetRfqRealtimeParams,
  GetQuoteListParams,
  GetQuoteRealtimeParams,
  GetRfqTradeListParams,
  RfqListResult,
  RfqRealtimeResult,
  QuoteListResult,
  QuoteRealtimeResult,
  RfqTradeListResult,
} from "./types";

// Verified against the maintained typed client
// (tiagosiebler/bybit-api: rest-client-v5.ts). RFQ query paths are flat —
// there is NO `/trade/` segment.
const PATHS = {
  rfqList: "/v5/rfq/rfq-list",
  // NOTE: rfq-realtime, not realtime — re-verified against the reference
  // client source (tiagosiebler/bybit-api rest-client-v5.ts) 2026-06-12.
  rfqRealtime: "/v5/rfq/rfq-realtime",
  quoteList: "/v5/rfq/quote-list",
  quoteRealtime: "/v5/rfq/quote-realtime",
  tradeList: "/v5/rfq/trade-list",
} as const;

// Bybit query strings are flat strings; drop undefined params and stringify
// the rest so callers can pass typed optional params naturally.
function toQuery(params: Record<string, string | number | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) out[key] = String(value);
  }
  return out;
}

// RFQ data is account-scoped (taker's own RFQs/quotes/trades) → signed GET.

export async function handleGetRfqList(
  client: BybitClient,
  params: GetRfqListParams = {}
): Promise<RfqListResult> {
  return client.signedGet<RfqListResult>(PATHS.rfqList, toQuery({ ...params }));
}

export async function handleGetRfqRealtime(
  client: BybitClient,
  params: GetRfqRealtimeParams = {}
): Promise<RfqRealtimeResult> {
  return client.signedGet<RfqRealtimeResult>(PATHS.rfqRealtime, toQuery({ ...params }));
}

export async function handleGetQuoteList(
  client: BybitClient,
  params: GetQuoteListParams = {}
): Promise<QuoteListResult> {
  return client.signedGet<QuoteListResult>(PATHS.quoteList, toQuery({ ...params }));
}

export async function handleGetQuoteRealtime(
  client: BybitClient,
  params: GetQuoteRealtimeParams = {}
): Promise<QuoteRealtimeResult> {
  return client.signedGet<QuoteRealtimeResult>(PATHS.quoteRealtime, toQuery({ ...params }));
}

export async function handleGetRfqTradeList(
  client: BybitClient,
  params: GetRfqTradeListParams = {}
): Promise<RfqTradeListResult> {
  return client.signedGet<RfqTradeListResult>(PATHS.tradeList, toQuery({ ...params }));
}
