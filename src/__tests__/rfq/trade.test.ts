import {
  handleCreateRfq,
  handleExecuteQuote,
  handleCancelRfq,
} from "../../tools/rfq/trade";
import { BybitClient } from "../../client";
import { AccountInfo, CreateRfqLeg } from "../../tools/rfq/types";

jest.mock("../../client");
const MockClient = BybitClient as jest.MockedClass<typeof BybitClient>;

const eligibleInfo: AccountInfo = { unifiedMarginStatus: 5, marginMode: "PORTFOLIO_MARGIN" };
const ineligibleInfo: AccountInfo = { unifiedMarginStatus: 3, marginMode: "REGULAR_MARGIN" };

const ENV_KEYS = ["RFQ_ENABLE_WRITES", "RFQ_ALLOW_UNCOVERED", "OPTIONS_ALLOW_NAKED_SHORT"] as const;

const liveQuote = {
  rfqId: "r",
  rfqLinkId: "rl",
  quoteId: "q",
  quoteLinkId: "ql",
  expiresAt: "2026-05-19T12:01:00Z",
  deskCode: "LP",
  status: "Active",
  execQuoteSide: "",
  createdAt: 1,
  updatedAt: 1,
  quoteBuyList: [{ category: "option", symbol: "BTC-25APR26-80000-C-USDT", price: "1200" }],
  quoteSellList: [],
};

interface ClientOpts {
  accountInfo?: AccountInfo;
  markPrice?: string; // option ticker mark price
  underlyingPrice?: string;
  tickerThrows?: boolean;
}

function newClient(opts: ClientOpts = {}): BybitClient {
  const {
    accountInfo = eligibleInfo,
    markPrice = "1000",
    underlyingPrice = "80000",
    tickerThrows = false,
  } = opts;
  const client = new MockClient("k", "s", "u");

  (client.signedGet as jest.Mock).mockImplementation((path: string) => {
    if (path === "/v5/account/info") return Promise.resolve(accountInfo);
    if (path === "/v5/rfq/quote-realtime") return Promise.resolve({ list: [liveQuote] });
    return Promise.resolve({});
  });

  (client.publicGet as jest.Mock).mockImplementation(() => {
    if (tickerThrows) return Promise.reject(new Error("ticker down"));
    return Promise.resolve({
      category: "option",
      list: [{
        symbol: "BTC-25APR26-80000-C-USDT",
        lastPrice: markPrice, bid1Price: markPrice, ask1Price: markPrice,
        markPrice, markIv: "0.6", openInterest: "1", volume24h: "1",
        delta: "0.5", gamma: "0", theta: "0", vega: "0",
        underlyingPrice,
      }],
    });
  });

  (client.signedPost as jest.Mock).mockResolvedValue({
    rfqId: "rfq-1",
    rfqLinkId: "link-1",
    status: "Active",
    expiresAt: "2026-05-19T12:00:00Z",
    deskCode: "DESK",
    quoteId: "q-1",
    rejectParty: "",
  });
  return client;
}

const optionLeg: CreateRfqLeg = {
  category: "option",
  symbol: "BTC-25APR26-80000-C-USDT",
  side: "buy",
  qty: "1",
};

describe("handleCreateRfq", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    jest.restoreAllMocks();
  });

  it("rejects empty counterparties", async () => {
    await expect(
      handleCreateRfq(newClient(), { counterparties: [], list: [optionLeg] })
    ).rejects.toThrow(/at least one counterparty/);
  });

  it("rejects empty legs", async () => {
    await expect(
      handleCreateRfq(newClient(), { counterparties: ["DESK"], list: [] })
    ).rejects.toThrow(/at least one leg/);
  });

  it("rejects more than 25 legs", async () => {
    const list = Array.from({ length: 26 }, () => optionLeg);
    await expect(
      handleCreateRfq(newClient(), { counterparties: ["DESK"], list })
    ).rejects.toThrow(/at most 25 legs/);
  });

  it("dry_run does not POST and models an all-option combo from live prices", async () => {
    const client = newClient();
    const res = await handleCreateRfq(client, { counterparties: ["DESK"], list: [optionLeg] });
    expect(client.signedPost).not.toHaveBeenCalled();
    expect(client.publicGet).toHaveBeenCalledWith("/v5/market/tickers", expect.objectContaining({ category: "option" }));
    if (!("dryRun" in res) || res.dryRun !== true) throw new Error("expected dry run");
    expect(res.action).toBe("create_rfq");
    // Long call, priced + spot => risk actually modeled, covered, allowed.
    expect(res.risk?.modeled).toBe(true);
    expect(res.risk?.uncovered).toBe(false);
    expect(res.wouldSubmit).toBe(true);
    expect(res.warnings.join(" ")).toMatch(/RFQ_ENABLE_WRITES/);
    expect(res.request.counterparties).toEqual(["DESK"]);
  });

  it("leaves risk unmodeled with a warning when ticker pricing fails", async () => {
    const res = await handleCreateRfq(newClient({ tickerThrows: true }), {
      counterparties: ["DESK"], list: [optionLeg],
    });
    if (!("dryRun" in res) || res.dryRun !== true) throw new Error("expected dry run");
    expect(res.risk?.modeled).toBe(false);
    expect(res.wouldSubmit).toBe(false); // unmodeled => uncovered => blocked
    expect(res.warnings.join(" ")).toMatch(/Ticker fetch failed/);
  });

  it("dry_run surfaces eligibility reasons and refuses to submit", async () => {
    const res = await handleCreateRfq(newClient({ accountInfo: ineligibleInfo }), {
      counterparties: ["DESK"], list: [optionLeg],
    });
    if (!("dryRun" in res) || res.dryRun !== true) throw new Error("expected dry run");
    expect(res.wouldSubmit).toBe(false);
    expect(res.eligibility?.eligible).toBe(false);
    expect(res.warnings.join(" ")).toMatch(/UTA 2\.0/);
  });

  it("blocks live submission when RFQ_ENABLE_WRITES is unset", async () => {
    await expect(
      handleCreateRfq(newClient(), { counterparties: ["DESK"], list: [optionLeg], dry_run: false })
    ).rejects.toThrow(/Live RFQ submission is disabled/);
  });

  it("blocks live submission for an ineligible account", async () => {
    process.env.RFQ_ENABLE_WRITES = "true";
    await expect(
      handleCreateRfq(newClient({ accountInfo: ineligibleInfo }), {
        counterparties: ["DESK"], list: [optionLeg], dry_run: false,
      })
    ).rejects.toThrow(/not RFQ-eligible/);
  });

  it("blocks live submission when the risk gate fails (naked short)", async () => {
    process.env.RFQ_ENABLE_WRITES = "true";
    // eligible account, priced naked short => modeled uncovered, no override
    await expect(
      handleCreateRfq(newClient(), {
        counterparties: ["DESK"],
        list: [{ category: "option", symbol: "BTC-25APR26-80000-C-USDT", side: "sell", qty: "1" }],
        dry_run: false,
      })
    ).rejects.toThrow(/risk gate blocked/);
  });

  it("includes optional fields and maps mixed leg categories in the request body", async () => {
    process.env.RFQ_ALLOW_UNCOVERED = "true";
    const client = newClient();
    const res = await handleCreateRfq(client, {
      counterparties: ["DESK"],
      list: [
        { category: "spot", symbol: "BTCUSDT", side: "buy", qty: "0.1", isLeverage: true },
        { category: "linear", symbol: "BTCUSDT", side: "sell", qty: "0.1" },
        { category: "inverse", symbol: "BTCUSD", side: "sell", qty: "1" },
      ],
      rfqLinkId: "my-rfq-1",
      anonymous: true,
      strategyType: "custom",
      estimatedNotionalUsd: 25000,
    });
    if (!("dryRun" in res) || res.dryRun !== true) throw new Error("expected dry run");
    expect(res.request.rfqLinkId).toBe("my-rfq-1");
    expect(res.request.anonymous).toBe(true);
    expect(res.request.strategyType).toBe("custom");
    const list = res.request.list as Array<Record<string, unknown>>;
    expect(list[0].isLeverage).toBe(true);
    expect(list[2].category).toBe("inverse");
    // Non-option legs => unmodeled/uncovered, allowed only via override
    expect(res.risk?.modeled).toBe(false);
  });

  it("submits live when writes enabled, eligible, and risk allowed", async () => {
    process.env.RFQ_ENABLE_WRITES = "true";
    process.env.RFQ_ALLOW_UNCOVERED = "true";
    const client = newClient();
    const res = await handleCreateRfq(client, {
      counterparties: ["DESK"], list: [optionLeg], dry_run: false,
    });
    expect(client.signedPost).toHaveBeenCalledWith("/v5/rfq/create-rfq", expect.any(Object));
    if ("dryRun" in res && res.dryRun) throw new Error("expected live result");
    expect(res.rfqId).toBe("rfq-1");
    expect(res.serverTimestamp).toBeDefined();
  });
});

describe("handleExecuteQuote", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    jest.restoreAllMocks();
  });

  it("validates rfqId/quoteId/quoteSide", async () => {
    await expect(handleExecuteQuote(newClient(), { rfqId: "", quoteId: "q", quoteSide: "buy" }))
      .rejects.toThrow(/requires rfqId/);
    await expect(handleExecuteQuote(newClient(), { rfqId: "r", quoteId: "", quoteSide: "buy" }))
      .rejects.toThrow(/requires quoteId/);
    await expect(
      handleExecuteQuote(newClient(), { rfqId: "r", quoteId: "q", quoteSide: "long" as never })
    ).rejects.toThrow(/quoteSide must be/);
  });

  it("dry_run surfaces the live quote (legs/prices), not just IDs", async () => {
    const client = newClient();
    const res = await handleExecuteQuote(client, { rfqId: "r", quoteId: "q", quoteSide: "buy" });
    expect(client.signedPost).not.toHaveBeenCalled();
    if (!("dryRun" in res) || res.dryRun !== true) throw new Error("expected dry run");
    expect(res.warnings.join(" ")).toMatch(/IRREVERSIBLE/);
    expect(res.quote?.quoteId).toBe("q");
    expect(res.quote?.quoteBuyList[0].price).toBe("1200");
  });

  it("dry_run warns (does not throw) when the live quote can't be fetched", async () => {
    const client = newClient();
    (client.signedGet as jest.Mock).mockImplementation((path: string) =>
      path === "/v5/rfq/quote-realtime"
        ? Promise.reject(new Error("quote svc down"))
        : Promise.resolve(eligibleInfo)
    );
    const res = await handleExecuteQuote(client, { rfqId: "r", quoteId: "q", quoteSide: "buy" });
    if (!("dryRun" in res) || res.dryRun !== true) throw new Error("expected dry run");
    expect(res.quote).toBeUndefined();
    expect(res.warnings.join(" ")).toMatch(/Could not fetch the live quote/);
  });

  it("blocks live execution without RFQ_ENABLE_WRITES", async () => {
    await expect(
      handleExecuteQuote(newClient(), { rfqId: "r", quoteId: "q", quoteSide: "buy", dry_run: false })
    ).rejects.toThrow(/Live RFQ submission is disabled/);
  });

  it("submits live when writes enabled", async () => {
    process.env.RFQ_ENABLE_WRITES = "true";
    const client = newClient();
    const res = await handleExecuteQuote(client, {
      rfqId: "r", quoteId: "q", quoteSide: "buy", dry_run: false,
    });
    expect(client.signedPost).toHaveBeenCalledWith("/v5/rfq/execute-quote", {
      rfqId: "r", quoteId: "q", quoteSide: "buy",
    });
    if ("dryRun" in res && res.dryRun) throw new Error("expected live result");
    expect(res.serverTimestamp).toBeDefined();
  });
});

describe("handleCancelRfq", () => {
  afterEach(() => jest.restoreAllMocks());

  it("requires rfqId or rfqLinkId", async () => {
    await expect(handleCancelRfq(newClient(), {})).rejects.toThrow(/requires rfqId or rfqLinkId/);
  });

  it("cancels without the write kill-switch (risk-reducing)", async () => {
    delete process.env.RFQ_ENABLE_WRITES;
    const client = newClient();
    const res = await handleCancelRfq(client, { rfqId: "rfq-1" });
    expect(client.signedPost).toHaveBeenCalledWith("/v5/rfq/cancel-rfq", { rfqId: "rfq-1" });
    expect(res.rfqId).toBe("rfq-1");
    expect(res.serverTimestamp).toBeDefined();
  });

  it("cancels by rfqLinkId", async () => {
    const client = newClient();
    await handleCancelRfq(client, { rfqLinkId: "my-rfq-1" });
    expect(client.signedPost).toHaveBeenCalledWith("/v5/rfq/cancel-rfq", { rfqLinkId: "my-rfq-1" });
  });
});
