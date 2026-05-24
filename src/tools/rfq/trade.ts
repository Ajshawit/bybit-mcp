import { BybitClient } from "../../client";
import { assertRfqEligible, checkRfqEligibility } from "./eligibility";
import { assessComboRisk } from "./risk";
import { handleGetQuoteRealtime } from "./query";
import { OptionTickersResult } from "../options/types";
import { assertConfirm } from "../confirm";
import {
  CreateRfqParams,
  CreateRfqResult,
  ExecuteQuoteParams,
  ExecuteQuoteResult,
  CancelRfqParams,
  CancelRfqResult,
  RfqWriteDryRunResult,
  ComboRiskResult,
  RiskLeg,
} from "./types";

// Phase 3 — RFQ write handlers (taker side: create / execute / cancel).
//
// SAFETY POSTURE (deliberate, layered):
//   1. dry_run defaults to TRUE. A caller must explicitly pass dry_run:false.
//   2. Real submission additionally requires RFQ_ENABLE_WRITES=true — a
//      kill-switch that stays OFF until the RFQ endpoint paths have been
//      confirmed against a live RFQ-eligible account (paths are currently
//      cross-checked against the typed client but NOT live-verified).
//   3. create_rfq runs assertRfqEligible + assessComboRisk as hard
//      pre-flights; an ineligible account or a non-allowed (uncovered/
//      unmodeled) combo cannot submit.
//   4. cancel_rfq is intentionally NOT behind the write kill-switch —
//      blocking a risk-reducing cancel is the unsafe direction.

// Verified flat paths (no /trade/ segment) — tiagosiebler/bybit-api.
const PATHS = {
  create: "/v5/rfq/create-rfq",
  execute: "/v5/rfq/execute-quote",
  cancel: "/v5/rfq/cancel-rfq",
} as const;

// Documented Bybit constraint: an RFQ may carry at most 25 legs.
const MAX_RFQ_LEGS = 25;

function writesEnabled(): boolean {
  return process.env.RFQ_ENABLE_WRITES === "true";
}

const WRITES_DISABLED_MSG =
  "Live RFQ submission is disabled. Set RFQ_ENABLE_WRITES=true only after " +
  "confirming RFQ endpoint paths against a live RFQ-eligible account. " +
  "dry_run still works without it.";

// create-rfq legs may be inverse; the risk engine only models options, so
// map every non-option category to a non-option bucket.
function toRiskLegCategory(c: string): RiskLeg["category"] {
  return c === "option" ? "option" : c === "spot" ? "spot" : "linear";
}

// Build priced RiskLegs for the combo risk gate. create-rfq legs carry no
// price/spot, so the payoff engine would never run — we fetch live option
// mark prices + underlying spot here so assessComboRisk does real
// structure-aware modelling. Non-option combos genuinely cannot be modelled
// and are passed through unpriced (assessComboRisk fails safe → uncovered).
async function buildPricedRisk(
  client: BybitClient,
  params: CreateRfqParams
): Promise<{ risk: ComboRiskResult; pricingWarnings: string[] }> {
  const pricingWarnings: string[] = [];
  const allOptions = params.list.every((l) => l.category === "option");

  if (!allOptions) {
    // Honest: linear/spot/inverse risk is not modellable here.
    const legs: RiskLeg[] = params.list.map((l) => ({
      category: toRiskLegCategory(l.category),
      symbol: l.symbol,
      side: l.side,
      qty: Number(l.qty),
    }));
    return { risk: assessComboRisk({ legs }), pricingWarnings };
  }

  // Fetch each unique option symbol's mark price + underlying spot.
  const uniqueSymbols = [...new Set(params.list.map((l) => l.symbol))];
  const priceBySymbol = new Map<string, number>();
  let currentSpot: number | undefined;

  for (const symbol of uniqueSymbols) {
    try {
      const res = await client.publicGet<OptionTickersResult>("/v5/market/tickers", {
        category: "option",
        symbol,
      });
      const t = res.list?.[0];
      const mark = t ? parseFloat(t.markPrice) : NaN;
      if (t && Number.isFinite(mark) && mark > 0) {
        priceBySymbol.set(symbol, mark);
      } else {
        pricingWarnings.push(`No usable mark price for ${symbol}; risk left unmodeled.`);
      }
      const spot = t?.underlyingPrice ? parseFloat(t.underlyingPrice) : NaN;
      if (currentSpot === undefined && Number.isFinite(spot) && spot > 0) {
        currentSpot = spot;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      pricingWarnings.push(`Ticker fetch failed for ${symbol} (${msg}); risk left unmodeled.`);
    }
  }

  const legs: RiskLeg[] = params.list.map((l) => ({
    category: "option",
    symbol: l.symbol,
    side: l.side,
    qty: Number(l.qty),
    price: priceBySymbol.get(l.symbol),
  }));

  return { risk: assessComboRisk({ legs, currentSpot }), pricingWarnings };
}

function buildCreateBody(params: CreateRfqParams): Record<string, unknown> {
  const body: Record<string, unknown> = {
    counterparties: params.counterparties,
    list: params.list.map((l) => ({
      category: l.category,
      symbol: l.symbol,
      side: l.side,
      qty: l.qty,
      ...(l.isLeverage !== undefined ? { isLeverage: l.isLeverage } : {}),
    })),
  };
  if (params.rfqLinkId !== undefined) body.rfqLinkId = params.rfqLinkId;
  if (params.anonymous !== undefined) body.anonymous = params.anonymous;
  if (params.strategyType !== undefined) body.strategyType = params.strategyType;
  return body;
}

export async function handleCreateRfq(
  client: BybitClient,
  params: CreateRfqParams
): Promise<CreateRfqResult | RfqWriteDryRunResult> {
  if (!params.counterparties || params.counterparties.length === 0) {
    throw new Error("create_rfq requires at least one counterparty.");
  }
  if (!params.list || params.list.length === 0) {
    throw new Error("create_rfq requires at least one leg.");
  }
  if (params.list.length > MAX_RFQ_LEGS) {
    throw new Error(`create_rfq supports at most ${MAX_RFQ_LEGS} legs; got ${params.list.length}.`);
  }

  const isDryRun = params.dry_run !== false; // default TRUE
  assertConfirm(params.confirm, isDryRun, "create_rfq");
  const body = buildCreateBody(params);
  const { risk, pricingWarnings } = await buildPricedRisk(client, params);

  if (isDryRun) {
    const eligibility = await checkRfqEligibility(client, params.estimatedNotionalUsd);
    const warnings: string[] = [...pricingWarnings];
    if (!writesEnabled()) warnings.push(WRITES_DISABLED_MSG);
    if (!eligibility.eligible) warnings.push(...eligibility.reasons);
    if (!risk.allowed) warnings.push(...risk.reasons);
    return {
      dryRun: true,
      action: "create_rfq",
      wouldSubmit: eligibility.eligible && risk.allowed,
      eligibility,
      risk,
      warnings,
      request: body,
      serverTimestamp: new Date().toISOString(),
    };
  }

  // --- Live submission path ---
  if (!writesEnabled()) throw new Error(WRITES_DISABLED_MSG);
  await assertRfqEligible(client, params.estimatedNotionalUsd);
  if (!risk.allowed) {
    throw new Error(
      `Combo risk gate blocked submission:\n- ${[...pricingWarnings, ...risk.reasons].join("\n- ")}`
    );
  }

  const res = await client.signedPost<Omit<CreateRfqResult, "serverTimestamp">>(PATHS.create, body);
  return { ...res, serverTimestamp: new Date().toISOString() };
}

export async function handleExecuteQuote(
  client: BybitClient,
  params: ExecuteQuoteParams
): Promise<ExecuteQuoteResult | RfqWriteDryRunResult> {
  if (!params.rfqId) throw new Error("execute_quote requires rfqId.");
  if (!params.quoteId) throw new Error("execute_quote requires quoteId.");
  if (params.quoteSide !== "buy" && params.quoteSide !== "sell") {
    throw new Error(`execute_quote quoteSide must be "buy" or "sell"; got "${params.quoteSide}".`);
  }

  const isDryRun = params.dry_run !== false; // default TRUE
  assertConfirm(params.confirm, isDryRun, "execute_quote");
  const body: Record<string, unknown> = {
    rfqId: params.rfqId,
    quoteId: params.quoteId,
    quoteSide: params.quoteSide,
  };

  if (isDryRun) {
    const warnings = [
      "Executing a quote is IRREVERSIBLE and fills asynchronously.",
    ];
    if (!writesEnabled()) warnings.push(WRITES_DISABLED_MSG);

    // Surface the actual quote being targeted so a human CONFIRM sees the
    // real legs/prices, not just opaque IDs. A query failure must not block
    // the (informational) dry run — downgrade to a warning instead.
    let quote;
    try {
      const live = await handleGetQuoteRealtime(client, {
        rfqId: params.rfqId,
        quoteId: params.quoteId,
      });
      quote = live.list.find((q) => q.quoteId === params.quoteId) ?? live.list[0];
      if (!quote) {
        warnings.push(
          `No live quote found for quoteId ${params.quoteId} on rfqId ${params.rfqId} — it may be expired or filled. Do NOT submit without verifying.`
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(
        `Could not fetch the live quote (${msg}); the legs/prices below are unverified. Run quote_realtime manually before submitting.`
      );
    }

    return {
      dryRun: true,
      action: "execute_quote",
      wouldSubmit: true,
      ...(quote ? { quote } : {}),
      warnings,
      request: body,
      serverTimestamp: new Date().toISOString(),
    };
  }

  // --- Live submission path ---
  if (!writesEnabled()) throw new Error(WRITES_DISABLED_MSG);
  const res = await client.signedPost<Omit<ExecuteQuoteResult, "serverTimestamp">>(PATHS.execute, body);
  return { ...res, serverTimestamp: new Date().toISOString() };
}

export async function handleCancelRfq(
  client: BybitClient,
  params: CancelRfqParams
): Promise<CancelRfqResult> {
  if (!params.rfqId && !params.rfqLinkId) {
    throw new Error("cancel_rfq requires rfqId or rfqLinkId.");
  }
  // Cancel is risk-reducing; intentionally NOT behind RFQ_ENABLE_WRITES.
  const body: Record<string, unknown> = {};
  if (params.rfqId !== undefined) body.rfqId = params.rfqId;
  if (params.rfqLinkId !== undefined) body.rfqLinkId = params.rfqLinkId;

  const res = await client.signedPost<Omit<CancelRfqResult, "serverTimestamp">>(PATHS.cancel, body);
  return { ...res, serverTimestamp: new Date().toISOString() };
}
