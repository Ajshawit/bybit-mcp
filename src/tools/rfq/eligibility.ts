import { BybitClient } from "../../client";
import {
  AccountInfo,
  RfqEligibilityResult,
  RFQ_MIN_NOTIONAL_USD,
  RFQ_UTA2_STATUSES,
} from "./types";

// Bybit RFQ / block trades have hard account-level prerequisites (captured in
// the investigation session, anchored on doc-verified enums):
//   - Unified Trading Account 2.0 (unifiedMarginStatus 5 or 6)
//   - Portfolio margin mode
//   - >= 10,000 USD notional per RFQ
//
// Per the design decision, eligibility is a first-class pre-flight check that
// reports *why* an account cannot trade RFQ — not an opaque failure. Demo-
// account exclusion is intentionally NOT asserted here: it is a property of
// the configured base URL, which the client does not expose, so claiming to
// check it would be dishonest. Document, don't fake.

const ACCOUNT_INFO_PATH = "/v5/account/info";

function describeMarginStatus(status: number): string {
  switch (status) {
    case 1: return "Classic account";
    case 3: return "UTA 1.0";
    case 4: return "UTA 1.0 (pro)";
    case 5: return "UTA 2.0";
    case 6: return "UTA 2.0 (pro)";
    default: return `unknown unifiedMarginStatus ${status}`;
  }
}

export async function checkRfqEligibility(
  client: BybitClient,
  notionalUsd?: number
): Promise<RfqEligibilityResult> {
  const accountInfo = await client.signedGet<AccountInfo>(ACCOUNT_INFO_PATH, {});

  const reasons: string[] = [];

  if (!RFQ_UTA2_STATUSES.includes(accountInfo.unifiedMarginStatus)) {
    reasons.push(
      `RFQ requires UTA 2.0; account is ${describeMarginStatus(accountInfo.unifiedMarginStatus)}. ` +
        `Upgrade the account to Unified Trading Account 2.0.`
    );
  }

  if (accountInfo.marginMode !== "PORTFOLIO_MARGIN") {
    reasons.push(
      `RFQ requires portfolio margin; account marginMode is ${accountInfo.marginMode}. ` +
        `Switch to PORTFOLIO_MARGIN.`
    );
  }

  if (notionalUsd !== undefined && notionalUsd < RFQ_MIN_NOTIONAL_USD) {
    reasons.push(
      `RFQ notional ${notionalUsd} USD is below the ${RFQ_MIN_NOTIONAL_USD} USD minimum per RFQ.`
    );
  }

  return {
    eligible: reasons.length === 0,
    reasons,
    accountInfo,
    ...(notionalUsd !== undefined ? { checkedNotionalUsd: notionalUsd } : {}),
  };
}

export async function assertRfqEligible(
  client: BybitClient,
  notionalUsd?: number
): Promise<RfqEligibilityResult> {
  const result = await checkRfqEligibility(client, notionalUsd);
  if (!result.eligible) {
    throw new Error(`Account is not RFQ-eligible:\n- ${result.reasons.join("\n- ")}`);
  }
  return result;
}
