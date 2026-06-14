import {
  handleGetRfqList,
  handleGetRfqRealtime,
  handleGetQuoteList,
  handleGetQuoteRealtime,
  handleGetRfqTradeList,
} from "../../tools/rfq/query";
import { BybitClient } from "../../client";
import {
  RfqItem,
  RfqQuoteItem,
  RfqTrade,
} from "../../tools/rfq/types";

jest.mock("../../client");
const MockClient = BybitClient as jest.MockedClass<typeof BybitClient>;

const rfqItem: RfqItem = {
  rfqId: "rfq-1",
  rfqLinkId: "link-1",
  counterparties: ["DESK_A"],
  expiresAt: "2026-05-19T12:00:00Z",
  strategyType: "custom",
  status: "Active",
  deskCode: "MYDESK",
  createdAt: 1747651200000,
  updatedAt: 1747651200000,
  legs: [
    { category: "option", symbol: "BTC-30MAY26-80000-C-USDT", side: "buy", qty: "1" },
    { category: "linear", symbol: "BTCUSDT", side: "sell", qty: "0.5" },
  ],
};

const quoteItem: RfqQuoteItem = {
  rfqId: "rfq-1",
  rfqLinkId: "link-1",
  quoteId: "q-1",
  quoteLinkId: "qlink-1",
  expiresAt: "2026-05-19T12:01:00Z",
  deskCode: "LPDESK",
  status: "Active",
  execQuoteSide: "",
  createdAt: 1747651260000,
  updatedAt: 1747651260000,
  quoteBuyList: [{ category: "option", symbol: "BTC-30MAY26-80000-C-USDT", price: "1200" }],
  quoteSellList: [{ category: "option", symbol: "BTC-30MAY26-80000-C-USDT", price: "1150" }],
};

const tradeItem: RfqTrade = {
  rfqId: "rfq-1",
  quoteId: "q-1",
  quoteSide: "buy",
  strategyType: "custom",
  status: "Filled",
  rfqDeskCode: "MYDESK",
  quoteDestCode: "LPDESK",
  createdAt: 1747651300000,
  updatedAt: 1747651300000,
  legs: [
    {
      category: "option",
      orderId: "o-1",
      symbol: "BTC-30MAY26-80000-C-USDT",
      side: "buy",
      price: "1175",
      qty: "1",
      markPrice: "1180",
      execFee: "0.5",
      execId: "e-1",
      resultCode: 0,
      resultMessage: "OK",
      rejectParty: "",
    },
  ],
};

function newClient(): BybitClient {
  return new MockClient("k", "s", "u");
}

describe("rfq query handlers", () => {
  afterEach(() => jest.restoreAllMocks());

  describe("handleGetRfqList", () => {
    it("calls the flat rfq-list path with no /trade/ segment", async () => {
      const client = newClient();
      (client.signedGet as jest.Mock).mockResolvedValue({ cursor: "", list: [rfqItem] });

      const res = await handleGetRfqList(client);

      const call = (client.signedGet as jest.Mock).mock.calls[0];
      expect(call[0]).toBe("/v5/rfq/rfq-list");
      expect(call[1]).toEqual({});
      expect(res.list[0].rfqId).toBe("rfq-1");
    });

    it("stringifies numeric params and drops undefined ones", async () => {
      const client = newClient();
      (client.signedGet as jest.Mock).mockResolvedValue({ cursor: "abc", list: [] });

      await handleGetRfqList(client, { status: "Active", limit: 20, cursor: undefined });

      expect((client.signedGet as jest.Mock).mock.calls[0][1]).toEqual({
        status: "Active",
        limit: "20",
      });
    });
  });

  describe("handleGetRfqRealtime", () => {
    it("queries the realtime path and returns the active RFQ list", async () => {
      const client = newClient();
      (client.signedGet as jest.Mock).mockResolvedValue({ list: [rfqItem] });

      const res = await handleGetRfqRealtime(client, { rfqId: "rfq-1" });

      const call = (client.signedGet as jest.Mock).mock.calls[0];
      expect(call[0]).toBe("/v5/rfq/rfq-realtime");
      expect(call[1]).toEqual({ rfqId: "rfq-1" });
      expect(res.list).toHaveLength(1);
    });
  });

  describe("handleGetQuoteList", () => {
    it("queries quote-list history and passes the cursor through", async () => {
      const client = newClient();
      (client.signedGet as jest.Mock).mockResolvedValue({ cursor: "next", list: [quoteItem] });

      const res = await handleGetQuoteList(client, { rfqId: "rfq-1", limit: 50 });

      const call = (client.signedGet as jest.Mock).mock.calls[0];
      expect(call[0]).toBe("/v5/rfq/quote-list");
      expect(call[1]).toEqual({ rfqId: "rfq-1", limit: "50" });
      expect(res.cursor).toBe("next");
      expect(res.list[0].quoteId).toBe("q-1");
    });
  });

  describe("handleGetQuoteRealtime", () => {
    it("queries quote-realtime for live LP quotes (taker poll path)", async () => {
      const client = newClient();
      (client.signedGet as jest.Mock).mockResolvedValue({ list: [quoteItem] });

      const res = await handleGetQuoteRealtime(client, { rfqId: "rfq-1" });

      const call = (client.signedGet as jest.Mock).mock.calls[0];
      expect(call[0]).toBe("/v5/rfq/quote-realtime");
      expect(call[1]).toEqual({ rfqId: "rfq-1" });
      expect(res.list[0].quoteBuyList[0].price).toBe("1200");
    });
  });

  describe("handleGetRfqTradeList", () => {
    it("queries the flat trade-list path and returns executed trades", async () => {
      const client = newClient();
      (client.signedGet as jest.Mock).mockResolvedValue({ cursor: "", list: [tradeItem] });

      const res = await handleGetRfqTradeList(client, { status: "Filled" });

      const call = (client.signedGet as jest.Mock).mock.calls[0];
      expect(call[0]).toBe("/v5/rfq/trade-list");
      expect(call[1]).toEqual({ status: "Filled" });
      expect(res.list[0].legs[0].orderId).toBe("o-1");
    });

    it("sends an empty query object when no params are given", async () => {
      const client = newClient();
      (client.signedGet as jest.Mock).mockResolvedValue({ cursor: "", list: [] });

      await handleGetRfqTradeList(client);

      expect((client.signedGet as jest.Mock).mock.calls[0][1]).toEqual({});
    });
  });

  describe("default param handling", () => {
    it("defaults to an empty query for realtime and quote handlers when called with no params", async () => {
      const client = newClient();
      (client.signedGet as jest.Mock).mockResolvedValue({ list: [] });

      await handleGetRfqRealtime(client);
      await handleGetQuoteList(client);
      await handleGetQuoteRealtime(client);

      for (const call of (client.signedGet as jest.Mock).mock.calls) {
        expect(call[1]).toEqual({});
      }
    });
  });

  describe("barrel export", () => {
    it("re-exports every query handler from rfq/index", async () => {
      const barrel = await import("../../tools/rfq");
      expect(typeof barrel.handleGetRfqList).toBe("function");
      expect(typeof barrel.handleGetRfqRealtime).toBe("function");
      expect(typeof barrel.handleGetQuoteList).toBe("function");
      expect(typeof barrel.handleGetQuoteRealtime).toBe("function");
      expect(typeof barrel.handleGetRfqTradeList).toBe("function");
    });
  });
});
