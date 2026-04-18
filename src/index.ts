import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { BybitClient } from "./client";
import { handleGetAccountStatus } from "./tools/account";
import { handleGetMarketData, handleScanMarket, ScanFilter } from "./tools/market";
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
      description: "Get current account balance, free capital, margin in use, unrealised PnL, and all open positions with entry price, mark price, PnL%, SL, TP, trailing stop, and liquidation price.",
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
      name: "place_trade",
      description: "Place a market order on a linear USDT perpetual. IMPORTANT: Before calling this tool, present the full trade plan as a message and wait for explicit user confirmation. Do not call this tool in the same turn as explaining the trade.",
      inputSchema: {
        type: "object" as const,
        properties: {
          symbol: { type: "string" },
          side: { type: "string", enum: ["Buy", "Sell"] },
          marginUsdt: { type: "number", description: "Margin to allocate in USDT" },
          leverage: { type: "number" },
          sl: { type: "number", description: "Stop loss price in USDT (absolute)" },
          tp: { type: "number", description: "Take profit price in USDT (absolute, optional)" },
          trailingStop: { type: "number", description: "Trailing stop distance in USDT (not %). Optional." },
          trailingActivatePrice: { type: "number", description: "Price at which trailing stop activates. Optional." },
          notes: { type: "string", description: "Trade rationale — echoed back in response" },
        },
        required: ["symbol", "side", "marginUsdt", "leverage", "sl"],
      },
    },
    {
      name: "close_position",
      description: "Close an open position (fully or partially) with a market order. Specify side to disambiguate hedge-mode long vs short on the same symbol.",
      inputSchema: {
        type: "object" as const,
        properties: {
          symbol: { type: "string" },
          side: { type: "string", enum: ["Buy", "Sell"], description: "Buy = close long, Sell = close short" },
          percent: { type: "number", description: "Percentage to close (1-100). Default: 100" },
        },
        required: ["symbol", "side"],
      },
    },
    {
      name: "manage_position",
      description: "Update stop loss, take profit, or trailing stop on an open position. Pass 0 to cancel an existing SL or TP.",
      inputSchema: {
        type: "object" as const,
        properties: {
          symbol: { type: "string" },
          side: { type: "string", enum: ["Buy", "Sell"] },
          updates: {
            type: "object" as const,
            properties: {
              sl: { type: "number" },
              tp: { type: "number" },
              trailingStop: { type: "number" },
              trailingActivatePrice: { type: "number" },
            },
          },
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
      case "get_account_status":
        result = await handleGetAccountStatus(client);
        break;

      case "get_market_data":
        result = await handleGetMarketData(
          client,
          a.symbol as string,
          a.klineIntervals as string[] | undefined,
          a.klineLimit as number | undefined,
          a.fundingHistoryLimit as number | undefined
        );
        break;

      case "scan_market":
        result = await handleScanMarket(
          client,
          a.filter as ScanFilter,
          a.minVolume24hUsd as number | undefined,
          a.limit as number | undefined
        );
        break;

      case "place_trade":
        result = await handlePlaceTrade(client, {
          symbol: a.symbol as string,
          side: a.side as "Buy" | "Sell",
          marginUsdt: a.marginUsdt as number,
          leverage: a.leverage as number,
          sl: a.sl as number,
          tp: a.tp as number | undefined,
          trailingStop: a.trailingStop as number | undefined,
          trailingActivatePrice: a.trailingActivatePrice as number | undefined,
          notes: a.notes as string | undefined,
        });
        break;

      case "close_position":
        result = await handleClosePosition(client, {
          symbol: a.symbol as string,
          side: a.side as "Buy" | "Sell",
          percent: a.percent as number | undefined,
        });
        break;

      case "manage_position":
        result = await handleManagePosition(client, {
          symbol: a.symbol as string,
          side: a.side as "Buy" | "Sell",
          updates: a.updates as {
            sl?: number; tp?: number; trailingStop?: number; trailingActivatePrice?: number;
          },
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
