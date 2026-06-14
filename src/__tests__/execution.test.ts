import {
  handleEstimateExecutionCost,
  walkBook,
  maxQtyWithinBps,
  BookLevel,
} from "../tools/execution";
import { BybitClient } from "../client";

jest.mock("../client");
const MockClient = BybitClient as jest.MockedClass<typeof BybitClient>;

const levels = (rows: Array<[number, number]>): BookLevel[] =>
  rows.map(([price, size]) => ({ price, size }));

describe("walkBook", () => {
  it("computes volume-weighted average across levels", () => {
    const result = walkBook(levels([[100, 1], [101, 2]]), 2);
    expect(result.filledQty).toBe(2);
    expect(result.avgFillPrice).toBeCloseTo(100.5, 10); // 1@100 + 1@101
    expect(result.worstFillPrice).toBe(101);
    expect(result.levelsConsumed).toBe(2);
    expect(result.exhausted).toBe(false);
  });

  it("flags exhaustion when the book is too thin", () => {
    const result = walkBook(levels([[100, 1], [101, 2]]), 5);
    expect(result.filledQty).toBe(3);
    expect(result.exhausted).toBe(true);
  });

  it("handles inverse contracts with harmonic averaging", () => {
    // 100 contracts @100 → 1 base; 101 contracts @101 → 1 base.
    // avg = 201 USD / 2 base = 100.5
    const result = walkBook(levels([[100, 100], [101, 101]]), 201, true);
    expect(result.filledQty).toBe(201);
    expect(result.avgFillPrice).toBeCloseTo(100.5, 10);
  });

  it("skips zero/garbage levels", () => {
    const result = walkBook(levels([[0, 5], [100, 1]]), 1);
    expect(result.avgFillPrice).toBe(100);
  });

  it("returns nulls for zero fill", () => {
    const result = walkBook([], 1);
    expect(result.filledQty).toBe(0);
    expect(result.avgFillPrice).toBeNull();
    expect(result.exhausted).toBe(true);
  });
});

describe("maxQtyWithinBps", () => {
  it("sums Buy-side sizes up to the bps threshold", () => {
    // mid 100, 10bps → threshold 100.1: only the 100.05 level qualifies.
    const asks = levels([[100.05, 1], [100.2, 2]]);
    expect(maxQtyWithinBps(asks, 100, 10, "Buy")).toBe(1);
  });

  it("sums Sell-side sizes down to the bps threshold", () => {
    // mid 100, 10bps → threshold 99.9: 99.95 qualifies, 99.8 does not.
    const bids = levels([[99.95, 3], [99.8, 5]]);
    expect(maxQtyWithinBps(bids, 100, 10, "Sell")).toBe(3);
  });

  it("returns 0 for an empty book or zero mid", () => {
    expect(maxQtyWithinBps([], 100, 10, "Buy")).toBe(0);
    expect(maxQtyWithinBps(levels([[100, 1]]), 0, 10, "Buy")).toBe(0);
  });
});

describe("handleEstimateExecutionCost", () => {
  const orderbook = {
    s: "BTCUSDT",
    b: [["29999", "2"], ["29998", "3"], ["29990", "10"]],
    a: [["30001", "1"], ["30002", "2"], ["30010", "10"]],
  };
  const feeRate = { list: [{ symbol: "BTCUSDT", takerFeeRate: "0.00055", makerFeeRate: "0.0002" }] };

  it("estimates slippage, fees, and all-in cost for a Buy", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValueOnce(orderbook);
    (client.signedGet as jest.Mock).mockResolvedValueOnce(feeRate);

    const result = await handleEstimateExecutionCost(client, {
      symbol: "BTCUSDT", side: "Buy", qty: 2,
    });

    // mid = 30000; fills 1@30001 + 1@30002 → avg 30001.5 → 0.5 bps
    expect(result.book.midPrice).toBe(30000);
    expect(result.sweep.avgFillPrice).toBeCloseTo(30001.5, 6);
    expect(result.sweep.slippageBpsVsMid).toBeCloseTo(0.5, 2);
    expect(result.sweep.worstSlippageBpsVsMid).toBeCloseTo(0.67, 2);
    expect(result.sweep.bookExhausted).toBe(false);
    expect(result.fees!.takerFeeBps).toBeCloseTo(5.5, 2);
    expect(result.allInCostBps).toBeCloseTo(0.5 + 5.5, 1);
    expect(result.warnings).toHaveLength(0);
    // Deep-book request used the category's max depth.
    const obCall = (client.publicGet as jest.Mock).mock.calls[0];
    expect(obCall[1].limit).toBe("500");
  });

  it("converts notionalUsd to qty at mid", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValueOnce(orderbook);
    (client.signedGet as jest.Mock).mockResolvedValueOnce(feeRate);

    const result = await handleEstimateExecutionCost(client, {
      symbol: "BTCUSDT", side: "Buy", notionalUsd: 60000,
    });
    expect(result.qty).toBeCloseTo(2, 6);
  });

  it("warns when the order sweeps the whole book", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValueOnce(orderbook);
    (client.signedGet as jest.Mock).mockResolvedValueOnce(feeRate);

    const result = await handleEstimateExecutionCost(client, {
      symbol: "BTCUSDT", side: "Buy", qty: 1000,
    });
    expect(result.sweep.bookExhausted).toBe(true);
    expect(result.warnings.some((w) => w.includes("ENTIRE visible book"))).toBe(true);
  });

  it("soft-fails the fee fetch and still returns slippage", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValueOnce(orderbook);
    (client.signedGet as jest.Mock).mockRejectedValueOnce(new Error("no auth"));

    const result = await handleEstimateExecutionCost(client, {
      symbol: "BTCUSDT", side: "Buy", qty: 1,
    });
    expect(result.fees).toBeNull();
    expect(result.allInCostBps).toBeCloseTo(result.sweep.slippageBpsVsMid!, 6);
    expect(result.warnings.some((w) => w.includes("Fee rate unavailable"))).toBe(true);
  });

  it("skips the fee fetch entirely when includeFees=false", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValueOnce(orderbook);

    const result = await handleEstimateExecutionCost(client, {
      symbol: "BTCUSDT", side: "Sell", qty: 1, includeFees: false,
    });
    expect(client.signedGet).not.toHaveBeenCalled();
    expect(result.fees).toBeNull();
    expect(result.warnings).toHaveLength(0);
  });

  it("computes Sell-side slippage against bids", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValueOnce(orderbook);
    (client.signedGet as jest.Mock).mockResolvedValueOnce(feeRate);

    const result = await handleEstimateExecutionCost(client, {
      symbol: "BTCUSDT", side: "Sell", qty: 4,
    });
    // fills 2@29999 + 2@29998 → avg 29998.5 → (30000-29998.5)/30000 = 0.5 bps
    expect(result.sweep.avgFillPrice).toBeCloseTo(29998.5, 6);
    expect(result.sweep.slippageBpsVsMid).toBeCloseTo(0.5, 2);
  });

  it("reports book imbalance from full-depth notionals", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValueOnce(orderbook);
    (client.signedGet as jest.Mock).mockResolvedValueOnce(feeRate);

    const result = await handleEstimateExecutionCost(client, {
      symbol: "BTCUSDT", side: "Buy", qty: 1,
    });
    const bidNotional = 29999 * 2 + 29998 * 3 + 29990 * 10;
    const askNotional = 30001 * 1 + 30002 * 2 + 30010 * 10;
    expect(result.book.imbalance).toBeCloseTo(bidNotional / askNotional, 2);
  });

  it("uses contract-qty semantics for the inverse path", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValueOnce({
      s: "BTCUSD",
      b: [["30000", "60000"]],
      a: [["30002", "60000"]],
    });
    (client.signedGet as jest.Mock).mockResolvedValueOnce(feeRate);

    const result = await handleEstimateExecutionCost(client, {
      symbol: "BTCUSD", side: "Buy", category: "inverse", notionalUsd: 30002,
    });
    expect(result.qty).toBe(30002); // inverse: contracts ARE USD
    expect(result.qtyUnit).toBe("USD contracts");
    expect(result.sweep.avgFillPrice).toBeCloseTo(30002, 6);
  });

  it("rejects missing or non-positive sizes", async () => {
    const client = new MockClient("k", "s", "u");
    await expect(handleEstimateExecutionCost(client, { symbol: "BTCUSDT", side: "Buy" }))
      .rejects.toThrow("provide qty or notionalUsd");
    await expect(handleEstimateExecutionCost(client, { symbol: "BTCUSDT", side: "Buy", qty: 0 }))
      .rejects.toThrow("qty must be > 0");
    await expect(handleEstimateExecutionCost(client, { symbol: "BTCUSDT", side: "Buy", notionalUsd: -5 }))
      .rejects.toThrow("notionalUsd must be > 0");
  });

  it("rejects an invalid side before touching the book", async () => {
    const client = new MockClient("k", "s", "u");
    await expect(handleEstimateExecutionCost(client, {
      symbol: "BTCUSDT",
      side: undefined as unknown as "Buy",
      qty: 1,
    })).rejects.toThrow("side must be 'Buy' or 'Sell'");
  });

  it("throws on an empty or one-sided book", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValueOnce({ s: "X", b: [], a: [["1", "1"]] });
    (client.signedGet as jest.Mock).mockResolvedValueOnce(feeRate);
    await expect(handleEstimateExecutionCost(client, { symbol: "X", side: "Buy", qty: 1 }))
      .rejects.toThrow("empty or one-sided");
  });
});
