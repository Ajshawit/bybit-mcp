import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { BybitClient } from "./client";
import { handleGetAccountStatus } from "./tools/account";
import { handleGetMarketData, handleScanMarket, handleGetOhlc, handleGetMarketRegime, ScanFilter } from "./tools/market";
import { handlePlaceTrade, handleClosePosition, handleManagePosition } from "./tools/trade";

const apiKey = process.env.BYBIT_API_KEY;
const apiSecret = process.env.BYBIT_API_SECRET;

if (!apiKey || !apiSecret) {
  console.error("BYBIT_API_KEY and BYBIT_API_SECRET environment variables are required");
  process.exit(1);
}

const BASE_URL = "https://api.bybit.com";
const client = new BybitClient(apiKey, apiSecret, BASE_URL);

const server = new Server(
  { name: "bybit-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_account_status",
      description: "Get current account balance, free capital, margin in use, unrealised PnL, and all open positions. Returns three position arrays: `positions` (linear USDT perps), `inverse_positions` (coin-margined perps), and `spot_holdings` (non-USDT spot balances with USD value). Each position includes entry price, mark price, PnL%, SL, TP, trailing stop, and liquidation price.",
      inputSchema: { type: "object" as const, properties: {}, required: [] },
    },
    {
      name: "get_market_data",
      description: "Get comprehensive market data for a single linear perpetual symbol: current price, funding rate, open interest, klines for requested intervals, funding rate history, and top-20 orderbook depth.",
      inputSchema: {
        type: "object" as const,
        properties: {
          symbol: { type: "string", description: "Symbol e.g. BTCUSDT" },
          klineIntervals: { type: "array", items: { type: "string" }, description: "Kline intervals e.g. [\"60\",\"240\"]. Default: [\"60\",\"240\"]" },
          klineLimit: { type: "number", description: "Number of candles per interval. Default: 24" },
          fundingHistoryLimit: { type: "number", description: "Number of funding rate history records. Default: 16" },
        },
        required: ["symbol"],
      },
    },
    {
      name: "scan_market",
      description: "Scan all linear perpetuals for a specific market condition. Returns raw numbers and short machine-readable tags. Filters: oi_divergence (price/OI divergence signals), crowded_positioning (extreme funding + range), volume_spike (unusual hourly volume).",
      inputSchema: {
        type: "object" as const,
        properties: {
          filter: { type: "string", enum: ["oi_divergence", "crowded_positioning", "volume_spike"] },
          minVolume24hUsd: { type: "number", description: "Minimum 24h volume in USD. Default: 10000000" },
          limit: { type: "number", description: "Maximum results to return. Default: 15" },
        },
        required: ["filter"],
      },
    },
    {
      name: "get_ohlc",
      description: "Fetch raw OHLC candles for any symbol and category. Returns candles newest-first; candles[0] is the most recent bar and its close is exposed as lastPrice. Use for swing level identification, stop placement reference, and blue-chip context (e.g. BTCUSDT spot or BTCUSD inverse). Returns empty candles array (not an error) if Bybit returns no data for the requested range.",
      inputSchema: {
        type: "object" as const,
        properties: {
          symbol: { type: "string", description: "e.g. BTCUSDT, BTCUSD, ETHUSDT" },
          category: {
            type: "string",
            enum: ["linear", "inverse", "spot"],
            description: "Default: linear",
          },
          interval: {
            type: "string",
            enum: ["1", "3", "5", "15", "30", "60", "120", "240", "360", "720", "D", "W", "M"],
            description: "Candle interval. Default: 60 (1 hour)",
          },
          limit: {
            type: "number",
            minimum: 1,
            maximum: 1000,
            description: "Number of candles to return. Default: 100",
          },
        },
        required: ["symbol"],
      },
    },
    {
      name: "get_market_regime",
      description: "Get macro market context: BTC trend from SMAs (20 and 50 period) and aggregate funding sentiment across top-20 linear perps by volume. Returns a synthesised regime label (risk_on / risk_off / choppy) plus raw signals. Use timeframe='swing' (default, 4h bars, ~1-2 week horizon) for session positioning, or timeframe='macro' (daily bars, ~2-3 month horizon) for structural bias. regime is BTC-specific — does not capture alt/BTC divergence. Throws if Bybit returns insufficient candle data.",
      inputSchema: {
        type: "object" as const,
        properties: {
          timeframe: {
            type: "string",
            enum: ["intraday", "swing", "macro"],
            description: "Trend resolution. Default: swing (4h bars, ~1-2 week horizon)",
          },
        },
        required: [],
      },
    },
    {
      name: "place_trade",
      description: "Place a trade on a Bybit linear perp, inverse perp, or spot market. Supports market and limit entry orders. For inverse perps the `margin` field is in base coin units (e.g. BTC for BTCUSD). CONFIRMATION REQUIRED: (1) Present the full trade plan — symbol, category, side, margin, leverage (perps), SL (perps), TP, estimated position size. (2) Wait for the user to reply with 'CONFIRM'. (3) Only call this tool after receiving explicit CONFIRM. Never call this tool in the same turn as presenting the trade plan. Recommended workflow: present plan → CONFIRM → call with dry_run=true → verify computedQty, notional, and warnings → call again with dry_run=false. The dry_run call does not require a second CONFIRM. If dry_run returns wouldSubmit: false, do not proceed without addressing the warnings.",
      inputSchema: {
        type: "object" as const,
        properties: {
          symbol: { type: "string", description: "Symbol e.g. BTCUSDT, BTCUSD" },
          side: { type: "string", enum: ["Buy", "Sell"] },
          margin: { type: "number", description: "Margin to allocate. USDT for linear/spot; base coin (e.g. BTC) for inverse." },
          category: { type: "string", enum: ["linear", "inverse", "spot", "spot_margin"], description: "Default: linear (futures/perp). Pass 'spot' or 'spot_margin' if the user intends to own the asset rather than hold a perp position." },
          orderType: { type: "string", enum: ["Market", "Limit"], description: "Default: Market" },
          price: { type: "number", description: "Required for Limit orders. Limit entry price." },
          leverage: { type: "number", description: "Required for linear/inverse. Ignored for spot." },
          sl: { type: "number", description: "Stop loss price. Required for linear/inverse. Not supported for spot." },
          tp: { type: "number", description: "Take profit price. Optional, perps only." },
          trailingStop: { type: "number", description: "Trailing stop distance in quote currency. Optional, perps only." },
          trailingActivatePrice: { type: "number", description: "Price at which trailing stop activates. Optional, perps only." },
          notes: { type: "string", description: "Trade rationale — echoed back in response" },
          dry_run: { type: "boolean", description: "If true, returns computed order details without submitting. Default: false. executionPrice in the result is the current last-traded price, not a slippage-adjusted estimate — actual fill may differ." },
        },
        required: ["symbol", "side", "margin"],
        allOf: [
          {
            if: { properties: { orderType: { const: "Limit" } }, required: ["orderType"] },
            then: { required: ["price"] },
          },
          {
            if: {
              anyOf: [
                { not: { required: ["category"] } },
                { properties: { category: { enum: ["linear", "inverse"] } }, required: ["category"] },
              ],
            },
            then: { required: ["leverage", "sl"] },
          },
        ],
      },
    },
    {
      name: "close_position",
      description: "Close an open position (fully or partially). For spot: sells from total wallet balance for the base coin — use `qty` to specify exact amount if you hold the coin from sources outside this MCP. CONFIRMATION REQUIRED: (1) Present the close plan — symbol, category, side, size to close, rationale. (2) Wait for the user to reply with 'CONFIRM'. (3) Only call this tool after receiving explicit CONFIRM. Never call this tool in the same turn as proposing the close.",
      inputSchema: {
        type: "object" as const,
        properties: {
          symbol: { type: "string" },
          side: { type: "string", enum: ["Buy", "Sell"], description: "The side of the position being closed (not the order direction). 'Buy' closes a long, 'Sell' closes a short. For spot: always 'Buy' since you can only hold (not short) the base asset." },
          category: { type: "string", enum: ["linear", "inverse", "spot", "spot_margin"], description: "Default: linear" },
          percent: { type: "number", description: "Percentage to close (1-100). Default: 100. Ignored if qty provided." },
          qty: { type: "number", description: "Explicit close quantity in base coin. Overrides percent." },
          notes: { type: "string", description: "Rationale — echoed back in response" },
        },
        required: ["symbol", "side"],
      },
    },
    {
      name: "manage_position",
      description: "Update stop loss, take profit, or trailing stop on an open perp position (linear or inverse). Not supported for spot. Pass 0 to cancel an existing SL or TP. CONFIRMATION REQUIRED: (1) Present the change plan — which position, which field, old value → new value. (2) Wait for the user to reply with 'CONFIRM'. (3) Only call this tool after receiving explicit CONFIRM. Passing 0 to cancel an SL is destructive — confirm explicitly.",
      inputSchema: {
        type: "object" as const,
        properties: {
          symbol: { type: "string" },
          side: { type: "string", enum: ["Buy", "Sell"] },
          category: { type: "string", enum: ["linear", "inverse"], description: "Default: linear" },
          updates: {
            type: "object" as const,
            properties: {
              sl: { type: "number" },
              tp: { type: "number" },
              trailingStop: { type: "number" },
              trailingActivatePrice: { type: "number" },
            },
          },
          notes: { type: "string", description: "Rationale — echoed back in response" },
        },
        required: ["symbol", "side", "updates"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, unknown>;

  try {
    let result: unknown;

    switch (name) {
      case "get_account_status": {
        const data = await handleGetAccountStatus(client);
        result = { ...data, serverTimestamp: new Date().toISOString() };
        break;
      }

      case "get_market_data": {
        const data = await handleGetMarketData(
          client,
          a.symbol as string,
          a.klineIntervals as string[] | undefined,
          a.klineLimit as number | undefined,
          a.fundingHistoryLimit as number | undefined
        );
        result = { ...data, serverTimestamp: new Date().toISOString() };
        break;
      }

      case "scan_market": {
        const data = await handleScanMarket(
          client,
          a.filter as ScanFilter,
          a.minVolume24hUsd as number | undefined,
          a.limit as number | undefined
        );
        result = { results: data, serverTimestamp: new Date().toISOString() };
        break;
      }

      case "get_ohlc": {
        const data = await handleGetOhlc(
          client,
          a.symbol as string,
          a.category as "linear" | "inverse" | "spot" | undefined,
          a.interval as string | undefined,
          a.limit as number | undefined
        );
        result = data;
        break;
      }

      case "get_market_regime": {
        const data = await handleGetMarketRegime(
          client,
          a.timeframe as "intraday" | "swing" | "macro" | undefined
        );
        result = data;
        break;
      }

      case "place_trade":
        result = await handlePlaceTrade(client, {
          symbol: a.symbol as string,
          side: a.side as "Buy" | "Sell",
          margin: a.margin as number,
          category: a.category as "linear" | "inverse" | "spot" | "spot_margin" | undefined,
          orderType: a.orderType as "Market" | "Limit" | undefined,
          price: a.price as number | undefined,
          leverage: a.leverage as number | undefined,
          sl: a.sl as number | undefined,
          tp: a.tp as number | undefined,
          trailingStop: a.trailingStop as number | undefined,
          trailingActivatePrice: a.trailingActivatePrice as number | undefined,
          notes: a.notes as string | undefined,
          dry_run: a.dry_run as boolean | undefined,
        });
        break;

      case "close_position":
        result = await handleClosePosition(client, {
          symbol: a.symbol as string,
          side: a.side as "Buy" | "Sell",
          category: a.category as "linear" | "inverse" | "spot" | "spot_margin" | undefined,
          percent: a.percent as number | undefined,
          qty: a.qty as number | undefined,
          notes: a.notes as string | undefined,
        });
        break;

      case "manage_position":
        result = await handleManagePosition(client, {
          symbol: a.symbol as string,
          side: a.side as "Buy" | "Sell",
          category: a.category as "linear" | "inverse" | undefined,
          updates: a.updates as { sl?: number; tp?: number; trailingStop?: number; trailingActivatePrice?: number },
          notes: a.notes as string | undefined,
        });
        break;

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Bybit MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
