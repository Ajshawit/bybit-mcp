import { handleGetOptionQuote } from "../../tools/options/quote";
import { BybitClient } from "../../client";

jest.mock("../../client");
const MockClient = BybitClient as jest.MockedClass<typeof BybitClient>;

const mockSingleTicker = {
  list: [{
    symbol: "BTC-25APR26-80000-C-USDT",
    lastPrice: "1180",
    bid1Price: "1100",
    ask1Price: "1200",
    markPrice: "1150",
    markIv: "0.65",
    openInterest: "100",
    volume24h: "10",
    delta: "0.45",
    gamma: "0.000012",
    theta: "-48.5",
    vega: "115",
    underlyingPrice: "95000",
  }],
  category: "option",
};

describe("handleGetOptionQuote", () => {
  it("maps single option ticker to OptionQuoteResult", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValueOnce(mockSingleTicker);

    const result = await handleGetOptionQuote(client, "BTC-25APR26-80000-C-USDT");

    expect(result.symbol).toBe("BTC-25APR26-80000-C-USDT");
    expect(result.underlying).toBe("BTC");
    expect(result.strike).toBe(80000);
    expect(result.type).toBe("call");
    expect(result.bid).toBe(1100);
    expect(result.ask).toBe(1200);
    expect(result.mark).toBe(1150);
    expect(result.iv).toBe(0.65);
    expect(result.greeks.delta).toBe(0.45);
    expect(result.greeks.theta).toBe(-48.5);
    expect(result.greeks.vega).toBe(115);
    expect(result.openInterest).toBe(100);
  });

  it("fetches with category=option and specific symbol", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValueOnce(mockSingleTicker);

    await handleGetOptionQuote(client, "BTC-25APR26-80000-C-USDT");

    expect((client.publicGet as jest.Mock).mock.calls[0][1]).toMatchObject({
      category: "option",
      symbol: "BTC-25APR26-80000-C-USDT",
    });
  });

  it("includes greeksLocal when computeGreeksLocal=true", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValueOnce(mockSingleTicker);

    const result = await handleGetOptionQuote(client, "BTC-25APR26-80000-C-USDT", true);

    expect(result.greeksLocal).toBeDefined();
    expect(result.greeksLocal!.delta).toBeGreaterThan(0);
    expect(result.greeksLocal!.diffFromBybit).toBeDefined();
  });

  it("greeksLocal not present when computeGreeksLocal=false (default)", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValueOnce(mockSingleTicker);

    const result = await handleGetOptionQuote(client, "BTC-25APR26-80000-C-USDT");
    expect(result.greeksLocal).toBeUndefined();
  });

  it("computes daysToExpiry from symbol", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValueOnce(mockSingleTicker);

    const result = await handleGetOptionQuote(client, "BTC-25APR26-80000-C-USDT");
    // BTC-25APR26 expires 2026-04-25T08:00Z; test runs ~2026-04-19, so ~6 days out
    expect(result.daysToExpiry).toBeGreaterThan(0);
    expect(result.daysToExpiry).toBeLessThan(30);
  });
});
