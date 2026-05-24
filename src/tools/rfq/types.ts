// RFQ / block-trade types for Bybit V5 `/v5/rfq/*`.
//
// Shapes are ported from the maintained typed client
// (tiagosiebler/bybit-api: src/types/{request,response}/v5-rfq.ts) and kept
// faithful to the wire format: numeric fields arrive as strings, exactly as
// Bybit returns them, mirroring the raw `BybitOption*` types in ../options.
// Phase 1 covers the read-only (taker-side query) surface only.

export type RfqCategory = "spot" | "linear" | "option";

// Bybit's RFQ endpoints use lowercase sides, unlike the rest of the V5 API.
export type RfqSide = "buy" | "sell";

export type RfqStatus =
  | "Active"
  | "Canceled"
  | "PendingFill"
  | "Filled"
  | "Expired"
  | "Failed";

export type RfqTradeStatus = "Filled" | "Rejected";

// Bybit deliberately uses two different literals across endpoints (verified
// against tiagosiebler/bybit-api request/v5-rfq.ts):
//  - the RFQ-list (history) endpoint uses "quoter"
//  - realtime + quote endpoints use "quote"
// These are NOT interchangeable; do not merge into one type.
export type RfqListTraderType = "quoter" | "request";
export type RfqQuoteTraderType = "quote" | "request";

// --- Request params (read-only query endpoints) ---

export interface GetRfqListParams {
  rfqId?: string;
  rfqLinkId?: string;
  traderType?: RfqListTraderType;
  status?: RfqStatus;
  limit?: number;
  cursor?: string;
}

export interface GetRfqRealtimeParams {
  rfqId?: string;
  rfqLinkId?: string;
  traderType?: RfqQuoteTraderType;
}

export interface GetQuoteListParams {
  rfqId?: string;
  quoteId?: string;
  quoteLinkId?: string;
  traderType?: RfqQuoteTraderType;
  status?: RfqStatus;
  limit?: number;
  cursor?: string;
}

export interface GetQuoteRealtimeParams {
  rfqId?: string;
  quoteId?: string;
  quoteLinkId?: string;
  traderType?: RfqQuoteTraderType;
}

export interface GetRfqTradeListParams {
  rfqId?: string;
  rfqLinkId?: string;
  quoteId?: string;
  quoteLinkId?: string;
  status?: RfqTradeStatus;
  limit?: number;
  cursor?: string;
}

// --- Response shapes ---

export interface RfqLeg {
  category: RfqCategory;
  symbol: string;
  side: RfqSide;
  qty: string;
  isLeverage?: boolean;
}

export interface RfqItem {
  rfqId: string;
  rfqLinkId: string;
  counterparties: string[];
  expiresAt: string;
  strategyType: string;
  status: RfqStatus;
  acceptOtherQuoteStatus?: string;
  deskCode: string;
  createdAt: number;
  updatedAt: number;
  legs: RfqLeg[];
}

export interface QuoteLeg {
  category: RfqCategory;
  symbol: string;
  price: string;
  qty?: string;
  isLeverage?: boolean;
}

export interface RfqQuoteItem {
  rfqId: string;
  rfqLinkId: string;
  quoteId: string;
  quoteLinkId: string;
  expiresAt: string;
  deskCode: string;
  status: RfqStatus;
  execQuoteSide: string;
  createdAt: number;
  updatedAt: number;
  quoteBuyList: QuoteLeg[];
  quoteSellList: QuoteLeg[];
}

export interface RfqTradeLeg {
  category: RfqCategory;
  orderId: string;
  symbol: string;
  side: RfqSide;
  price: string;
  qty: string;
  isLeverage?: boolean;
  markPrice: string;
  execFee: string;
  execId: string;
  resultCode: number;
  resultMessage: string;
  rejectParty: string;
}

export interface RfqTrade {
  rfqId: string;
  quoteId: string;
  quoteSide: RfqSide;
  strategyType: string;
  status: RfqTradeStatus;
  rfqDeskCode: string;
  quoteDestCode: string;
  createdAt: number;
  updatedAt: number;
  legs: RfqTradeLeg[];
}

// Realtime endpoints return a bare list; history endpoints add a cursor.
export interface RfqListResult {
  cursor: string;
  list: RfqItem[];
}

export interface RfqRealtimeResult {
  list: RfqItem[];
}

export interface QuoteListResult {
  cursor: string;
  list: RfqQuoteItem[];
}

export interface QuoteRealtimeResult {
  list: RfqQuoteItem[];
}

export interface RfqTradeListResult {
  cursor: string;
  list: RfqTrade[];
}

// --- Eligibility (Phase 2) ---

// Verified against official Bybit docs (bybit-exchange.github.io/docs/v5):
//  - /v5/account/info enum `unifiedMarginStatus`:
//      1: Classic account
//      3: Unified trading account 1.0
//      4: Unified trading account 1.0 (pro version)
//      5: Unified trading account 2.0
//      6: Unified trading account 2.0 (pro version)
//  - `marginMode`: ISOLATED_MARGIN | REGULAR_MARGIN | PORTFOLIO_MARGIN
export type MarginMode = "ISOLATED_MARGIN" | "REGULAR_MARGIN" | "PORTFOLIO_MARGIN";

// /v5/account/info response. Only the fields the eligibility gate needs are
// modelled; Bybit returns more, but we deliberately keep the surface small.
export interface AccountInfo {
  unifiedMarginStatus: number;
  marginMode: MarginMode;
  isMasterTrader?: boolean;
  spotHedgingStatus?: string;
  updatedTime?: string;
}

// RFQ requires UTA 2.0 (status 5 or 6) AND portfolio margin. Min notional is
// 10,000 USD per RFQ. These are the documented hard gates captured in the
// investigation session — treated as a first-class pre-flight, not a failure.
export const RFQ_MIN_NOTIONAL_USD = 10_000;
export const RFQ_UTA2_STATUSES: readonly number[] = [5, 6];

export interface RfqEligibilityResult {
  eligible: boolean;
  reasons: string[]; // empty when eligible; one human-readable line per failed gate
  accountInfo: AccountInfo;
  checkedNotionalUsd?: number;
}

// --- Combo risk (Phase 2) ---

// A leg as it is assessed for risk, independent of the wire shape.
export interface RiskLeg {
  category: RfqCategory;
  symbol: string;
  side: RfqSide;
  qty: number;
  // Estimated per-unit price/premium; required only for option payoff modelling.
  price?: number;
}

export interface ComboRiskResult {
  // True only when every leg is an option and payoff math was applied.
  modeled: boolean;
  maxLossUsd: number | null; // null when not modeled — never fabricated
  maxProfit: number | "unlimited" | null;
  breakevens: number[];
  // Net-short / uncovered exposure that is not provably risk-defined.
  uncovered: boolean;
  // True when the combo may proceed: either covered, or override flag set.
  allowed: boolean;
  reasons: string[];
}

// --- Write surface (Phase 3) ---
//
// Ported verbatim from the verified typed client request/response shapes
// (tiagosiebler/bybit-api request|response/v5-rfq.ts). NOTE: the create-rfq
// leg category set includes "inverse" (wider than the read-side RfqCategory).

export type CreateRfqLegCategory = "spot" | "linear" | "inverse" | "option";

export interface CreateRfqLeg {
  category: CreateRfqLegCategory;
  symbol: string;
  side: RfqSide;
  qty: string;
  isLeverage?: boolean;
}

export interface CreateRfqParams {
  counterparties: string[];
  list: CreateRfqLeg[];
  rfqLinkId?: string;
  anonymous?: boolean;
  strategyType?: string;
  // Caller-supplied estimate of the RFQ's USD notional, used only for the
  // >=10,000 USD eligibility gate. We do NOT fabricate notional from prices
  // we cannot reliably obtain for every leg category.
  estimatedNotionalUsd?: number;
  dry_run?: boolean;
  confirm?: string;
}

export interface CreateRfqResult {
  dryRun?: false;
  rfqId: string;
  rfqLinkId: string;
  status: "Active" | "Canceled" | "Filled" | "Expired" | "Failed";
  expiresAt: string;
  deskCode: string;
  serverTimestamp: string;
}

export interface ExecuteQuoteParams {
  rfqId: string;
  quoteId: string;
  quoteSide: RfqSide;
  dry_run?: boolean;
  confirm?: string;
}

export interface ExecuteQuoteResult {
  dryRun?: false;
  rfqId: string;
  rfqLinkId: string;
  quoteId: string;
  status: "Processing" | "Rejected";
  rejectParty: string;
  serverTimestamp: string;
}

export interface CancelRfqParams {
  rfqId?: string;
  rfqLinkId?: string;
}

export interface CancelRfqResult {
  rfqId: string;
  rfqLinkId: string;
  serverTimestamp: string;
}

// Returned by create/execute when dry_run (default) — nothing was submitted.
export interface RfqWriteDryRunResult {
  dryRun: true;
  action: "create_rfq" | "execute_quote";
  wouldSubmit: boolean; // false when a pre-flight gate would block submission
  eligibility?: RfqEligibilityResult;
  risk?: ComboRiskResult;
  // For execute_quote: the live quote being targeted, so a human CONFIRM
  // sees the actual legs/prices — not just opaque IDs. Undefined if the
  // quote could not be fetched (a warning is added instead).
  quote?: RfqQuoteItem;
  warnings: string[];
  request: Record<string, unknown>; // exact body that would be POSTed
  serverTimestamp: string;
}
