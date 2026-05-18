import { checkRfqEligibility, assertRfqEligible } from "../../tools/rfq/eligibility";
import { BybitClient } from "../../client";
import { AccountInfo } from "../../tools/rfq/types";

jest.mock("../../client");
const MockClient = BybitClient as jest.MockedClass<typeof BybitClient>;

function clientReturning(info: AccountInfo): BybitClient {
  const client = new MockClient("k", "s", "u");
  (client.signedGet as jest.Mock).mockResolvedValue(info);
  return client;
}

const eligibleInfo: AccountInfo = {
  unifiedMarginStatus: 5,
  marginMode: "PORTFOLIO_MARGIN",
};

describe("checkRfqEligibility", () => {
  afterEach(() => jest.restoreAllMocks());

  it("calls /v5/account/info with a signed GET and no params", async () => {
    const client = clientReturning(eligibleInfo);
    await checkRfqEligibility(client);
    const call = (client.signedGet as jest.Mock).mock.calls[0];
    expect(call[0]).toBe("/v5/account/info");
    expect(call[1]).toEqual({});
  });

  it("is eligible for UTA 2.0 (status 5) with portfolio margin", async () => {
    const res = await checkRfqEligibility(clientReturning(eligibleInfo));
    expect(res.eligible).toBe(true);
    expect(res.reasons).toEqual([]);
  });

  it("is eligible for UTA 2.0 pro (status 6)", async () => {
    const res = await checkRfqEligibility(
      clientReturning({ unifiedMarginStatus: 6, marginMode: "PORTFOLIO_MARGIN" })
    );
    expect(res.eligible).toBe(true);
  });

  it("rejects UTA 1.0 (status 3) and names the account tier", async () => {
    const res = await checkRfqEligibility(
      clientReturning({ unifiedMarginStatus: 3, marginMode: "PORTFOLIO_MARGIN" })
    );
    expect(res.eligible).toBe(false);
    expect(res.reasons.join(" ")).toMatch(/UTA 2\.0/);
    expect(res.reasons.join(" ")).toMatch(/UTA 1\.0/);
  });

  it("names UTA 1.0 pro (status 4) when rejecting", async () => {
    const res = await checkRfqEligibility(
      clientReturning({ unifiedMarginStatus: 4, marginMode: "PORTFOLIO_MARGIN" })
    );
    expect(res.eligible).toBe(false);
    expect(res.reasons.join(" ")).toMatch(/UTA 1\.0 \(pro\)/);
  });

  it("handles an unknown unifiedMarginStatus without crashing", async () => {
    const res = await checkRfqEligibility(
      clientReturning({ unifiedMarginStatus: 99, marginMode: "PORTFOLIO_MARGIN" })
    );
    expect(res.eligible).toBe(false);
    expect(res.reasons.join(" ")).toMatch(/unknown unifiedMarginStatus 99/);
  });

  it("rejects classic account (status 1)", async () => {
    const res = await checkRfqEligibility(
      clientReturning({ unifiedMarginStatus: 1, marginMode: "PORTFOLIO_MARGIN" })
    );
    expect(res.eligible).toBe(false);
    expect(res.reasons.join(" ")).toMatch(/Classic account/);
  });

  it("rejects non-portfolio margin mode", async () => {
    const res = await checkRfqEligibility(
      clientReturning({ unifiedMarginStatus: 5, marginMode: "REGULAR_MARGIN" })
    );
    expect(res.eligible).toBe(false);
    expect(res.reasons.join(" ")).toMatch(/portfolio margin/);
    expect(res.reasons.join(" ")).toMatch(/REGULAR_MARGIN/);
  });

  it("rejects notional below the 10,000 USD minimum", async () => {
    const res = await checkRfqEligibility(clientReturning(eligibleInfo), 9999);
    expect(res.eligible).toBe(false);
    expect(res.reasons.join(" ")).toMatch(/10000 USD minimum/);
    expect(res.checkedNotionalUsd).toBe(9999);
  });

  it("accepts notional at exactly the 10,000 USD minimum", async () => {
    const res = await checkRfqEligibility(clientReturning(eligibleInfo), 10_000);
    expect(res.eligible).toBe(true);
  });

  it("skips the notional gate when no notional is supplied", async () => {
    const res = await checkRfqEligibility(clientReturning(eligibleInfo));
    expect(res.eligible).toBe(true);
    expect(res.checkedNotionalUsd).toBeUndefined();
  });

  it("aggregates multiple failed gates", async () => {
    const res = await checkRfqEligibility(
      clientReturning({ unifiedMarginStatus: 1, marginMode: "ISOLATED_MARGIN" }),
      500
    );
    expect(res.eligible).toBe(false);
    expect(res.reasons).toHaveLength(3);
  });
});

describe("assertRfqEligible", () => {
  afterEach(() => jest.restoreAllMocks());

  it("returns the result when eligible", async () => {
    const res = await assertRfqEligible(clientReturning(eligibleInfo));
    expect(res.eligible).toBe(true);
  });

  it("throws an aggregated error when ineligible", async () => {
    await expect(
      assertRfqEligible(clientReturning({ unifiedMarginStatus: 3, marginMode: "REGULAR_MARGIN" }))
    ).rejects.toThrow(/not RFQ-eligible/);
  });
});
