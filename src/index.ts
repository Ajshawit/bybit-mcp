#!/usr/bin/env node
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
import {
  handleGetOptionChain, handleGetOptionQuote, handleGetOptionPayoff,
  handleScanOptions, handleGetOptionsRegime, IVSampleStore,
  handlePlaceOptionTrade, handleCloseOptionPosition,
} from "./tools/options/index.js";

const MAINNET_URL = "https://api.bybit.com";
const TESTNET_URL = "https://api-testnet.bybit.com";

function createServer(apiKey: string, apiSecret: string, enableOptions: boolean): Server {
  const baseUrl = process.env.BYBIT_TESTNET === "true" ? TESTNET_URL : MAINNET_URL;
  const client = new BybitClient(apiKey, apiSecret, baseUrl);
  const ENABLE_OPTIONS = enableOptions;
  const ivStore = ENABLE_OPTIONS ? new IVSampleStore() : null;

  const server = new Server(
    { name: "bybit-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "get_account_status",
        description: "Get current account balance, free capital, margin in use, unrealised PnL, and all open positions. Returns three position arrays: `positions` (linear USDT perps), `inverse_positions` (coin-margined perps), and `spot_holdings` (non-USDT spot balances with USD value). Each position includes entry price, mark price, PnL%, SL, TP, trailing stop, and liquidation price. When options are enabled, also returns `option_positions` (open option contracts with Greeks, premiumFlow, unrealisedPnl, daysToExpiry, and breakeven).",
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
        description: "BTC trend (SMA20/SMA50) + aggregate funding sentiment across top-20 linear perps by volume. Returns a synthesised regime label (risk_on / risk_off / choppy) plus raw signals. Use timeframe='swing' (default, 4h bars, ~1-2 week horizon) for session positioning, or timeframe='macro' (daily bars, ~2-3 month horizon) for structural bias. regime is BTC trend-based — does not capture alt/BTC divergence. Throws if Bybit returns fewer than 50 candles.",
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
      ...(ENABLE_OPTIONS ? [
        {
          name: "options_market",
          description: "Options market data — four actions. action='chain': browse contracts for BTC/ETH/SOL, returns contracts[]. action='quote': full pricing + Greeks for a single symbol (e.g. BTC-25APR26-80000-C-USDT), returns contract details + greeks object. action='scan': scan for unusual IV (high_iv/low_iv require ~24h warmup), returns anomaly contracts[] + percentileAvailable. action='regime': ATM IV, IV percentile, put/call skew, term structure per underlying, returns per-underlying regime object.",
          inputSchema: {
            type: "object" as const,
            properties: {
              action: { type: "string", enum: ["chain", "quote", "scan", "regime"] },
              underlying: { type: "string", enum: ["BTC", "ETH", "SOL"], description: "Required for chain and scan" },
              underlyings: { type: "array", items: { type: "string", enum: ["BTC", "ETH", "SOL"] }, description: "For regime: default all three" },
              symbol: { type: "string", description: "For quote: full Bybit option symbol" },
              computeGreeksLocal: { type: "boolean", description: "For quote: verify Greeks via Black-Scholes. Default: false" },
              minDaysToExpiry: { type: "number", description: "For chain. Default: 0" },
              maxDaysToExpiry: { type: "number", description: "For chain. Default: 60" },
              type: { type: "string", enum: ["call", "put"], description: "For chain: omit for both" },
              minOpenInterest: { type: "number", description: "For chain. Default: 10" },
              strikeRange: {
                type: "object" as const,
                properties: { minPctFromSpot: { type: "number" }, maxPctFromSpot: { type: "number" } },
                required: ["minPctFromSpot", "maxPctFromSpot"],
              },
              filter: { type: "string", enum: ["high_iv", "low_iv", "skew", "high_oi_change"], description: "For scan" },
              expiry: { type: "string", enum: ["weekly", "monthly", "all"], description: "For scan. Default: all" },
              limit: { type: "number", description: "For scan. Default: 10" },
            },
            required: ["action"],
            allOf: [
              {
                if: { properties: { action: { const: "chain" } }, required: ["action"] },
                then: { required: ["underlying"] },
              },
              {
                if: { properties: { action: { const: "quote" } }, required: ["action"] },
                then: { required: ["symbol"] },
              },
              {
                if: { properties: { action: { const: "scan" } }, required: ["action"] },
                then: { required: ["underlying", "filter"] },
              },
            ],
          },
        },
        {
          name: "get_option_payoff",
          description: "Compute payoff at expiry for one or more option legs. Pure math — no API call. Returns PnL at each price point, max loss, max profit, and breakeven(s). Use before placing a trade to verify risk/reward.",
          inputSchema: {
            type: "object" as const,
            properties: {
              legs: {
                type: "array",
                items: {
                  type: "object" as const,
                  properties: {
                    symbol: { type: "string" },
                    side: { type: "string", enum: ["Buy", "Sell"] },
                    qty: { type: "number" },
                    premium: { type: "number", description: "Per-contract premium paid/received" },
                  },
                  required: ["symbol", "side", "qty", "premium"],
                },
              },
              currentSpot: { type: "number", description: "Underlying spot price at time of analysis" },
              underlyingPriceRange: {
                type: "object" as const,
                properties: { min: { type: "number" }, max: { type: "number" } },
                required: ["min", "max"],
              },
              steps: { type: "number", description: "Price points to compute. Default: 50" },
            },
            required: ["legs", "currentSpot"],
          },
        },
        {
          name: "place_option_trade",
          description: "place_option_trade — Place a single-leg option order on Bybit (BTC, ETH, SOL). CONFIRMATION REQUIRED: (1) Present the full trade plan — symbol, side, qty, orderType, estimated premium, Greeks, payoff summary. (2) Wait for the user to reply with 'CONFIRM'. (3) Only call this tool after receiving explicit CONFIRM. Recommended workflow: present plan → CONFIRM → call with dry_run=true → verify estimatedPremium and warnings → call again with dry_run=false. Short selling requires OPTIONS_ALLOW_NAKED_SHORT=true unless an offsetting long exists.",
          inputSchema: {
            type: "object" as const,
            properties: {
              symbol: { type: "string", description: "Full Bybit option symbol e.g. BTC-25APR26-80000-C-USDT" },
              side: { type: "string", enum: ["Buy", "Sell"] },
              qty: { type: "number", description: "Number of contracts" },
              orderType: { type: "string", enum: ["Market", "Limit"] },
              price: { type: "number", description: "Required for Limit orders" },
              notes: { type: "string", description: "Trade rationale — echoed back in response" },
              dry_run: { type: "boolean", description: "If true, returns trade plan without submitting. Default: false" },
            },
            required: ["symbol", "side", "qty", "orderType"],
          },
        },
        {
          name: "close_option_position",
          description: "close_option_position — Close an open option position (fully or partially). CONFIRMATION REQUIRED: (1) Present the close plan — symbol, qty, side, estimated P&L. (2) Wait for the user to reply with 'CONFIRM'. (3) Only call this tool after receiving explicit CONFIRM. Use dry_run=true first to verify estimated P&L before submitting.",
          inputSchema: {
            type: "object" as const,
            properties: {
              symbol: { type: "string", description: "Full Bybit option symbol" },
              qty: { type: "number", description: "Contracts to close. Defaults to full position size." },
              orderType: { type: "string", enum: ["Market", "Limit"] },
              price: { type: "number", description: "Required for Limit orders" },
              notes: { type: "string", description: "Rationale — echoed back in response" },
              dry_run: { type: "boolean", description: "If true, returns close plan without submitting. Default: false" },
            },
            required: ["symbol", "orderType"],
          },
        },
      ] : []),
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const a = (args ?? {}) as Record<string, unknown>;

    try {
      let result: unknown;

      switch (name) {
        case "get_account_status": {
          const data = await handleGetAccountStatus(client, ENABLE_OPTIONS);
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
          result = { ...data, serverTimestamp: new Date().toISOString() };
          break;
        }

        case "get_market_regime": {
          const data = await handleGetMarketRegime(
            client,
            a.timeframe as "intraday" | "swing" | "macro" | undefined
          );
          result = { ...data, serverTimestamp: new Date().toISOString() };
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

        case "close_position": {
          const data = await handleClosePosition(client, {
            symbol: a.symbol as string,
            side: a.side as "Buy" | "Sell",
            category: a.category as "linear" | "inverse" | "spot" | "spot_margin" | undefined,
            percent: a.percent as number | undefined,
            qty: a.qty as number | undefined,
            notes: a.notes as string | undefined,
          });
          result = { ...data, serverTimestamp: new Date().toISOString() };
          break;
        }

        case "manage_position": {
          const data = await handleManagePosition(client, {
            symbol: a.symbol as string,
            side: a.side as "Buy" | "Sell",
            category: a.category as "linear" | "inverse" | undefined,
            updates: a.updates as { sl?: number; tp?: number; trailingStop?: number; trailingActivatePrice?: number },
            notes: a.notes as string | undefined,
          });
          result = { ...data, serverTimestamp: new Date().toISOString() };
          break;
        }

        case "options_market": {
          if (!ivStore) throw new Error("Options module not enabled");
          const action = a.action as string;
          if (action === "chain") {
            const data = await handleGetOptionChain(client, {
              underlying: a.underlying as "BTC" | "ETH" | "SOL",
              minDaysToExpiry: a.minDaysToExpiry as number | undefined,
              maxDaysToExpiry: a.maxDaysToExpiry as number | undefined,
              type: a.type as "call" | "put" | undefined,
              minOpenInterest: a.minOpenInterest as number | undefined,
              strikeRange: a.strikeRange as { minPctFromSpot: number; maxPctFromSpot: number } | undefined,
            });
            result = { ...data, serverTimestamp: new Date().toISOString() };
          } else if (action === "quote") {
            const data = await handleGetOptionQuote(
              client,
              a.symbol as string,
              a.computeGreeksLocal as boolean | undefined
            );
            result = { ...data, serverTimestamp: new Date().toISOString() };
          } else if (action === "scan") {
            const data = await handleScanOptions(client, ivStore, {
              underlying: a.underlying as "BTC" | "ETH" | "SOL",
              filter: a.filter as "high_iv" | "low_iv" | "skew" | "high_oi_change",
              expiry: a.expiry as "weekly" | "monthly" | "all" | undefined,
              limit: a.limit as number | undefined,
            });
            result = { ...data, serverTimestamp: new Date().toISOString() };
          } else if (action === "regime") {
            const data = await handleGetOptionsRegime(client, ivStore, {
              underlying: a.underlyings as Array<"BTC" | "ETH" | "SOL"> | undefined,
            });
            result = { ...data, serverTimestamp: new Date().toISOString() };
          } else {
            throw new Error(`Unknown options_market action: ${action}`);
          }
          break;
        }

        case "get_option_payoff": {
          const data = handleGetOptionPayoff({
            legs: a.legs as Array<{ symbol: string; side: "Buy" | "Sell"; qty: number; premium: number }>,
            currentSpot: a.currentSpot as number,
            underlyingPriceRange: a.underlyingPriceRange as { min: number; max: number } | undefined,
            steps: a.steps as number | undefined,
          });
          result = { ...data, serverTimestamp: new Date().toISOString() };
          break;
        }

        case "place_option_trade": {
          if (!ENABLE_OPTIONS) throw new Error("Options module not enabled");
          const data = await handlePlaceOptionTrade(client, {
            symbol: a.symbol as string,
            side: a.side as "Buy" | "Sell",
            qty: a.qty as number,
            orderType: a.orderType as "Market" | "Limit",
            price: a.price as number | undefined,
            notes: a.notes as string | undefined,
            dry_run: a.dry_run as boolean | undefined,
          });
          result = data;
          break;
        }

        case "close_option_position": {
          if (!ENABLE_OPTIONS) throw new Error("Options module not enabled");
          const data = await handleCloseOptionPosition(client, {
            symbol: a.symbol as string,
            qty: a.qty as number | undefined,
            orderType: a.orderType as "Market" | "Limit",
            price: a.price as number | undefined,
            notes: a.notes as string | undefined,
            dry_run: a.dry_run as boolean | undefined,
          });
          result = data;
          break;
        }

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

  return server;
}

export function createSandboxServer(): Server {
  return createServer("sandbox-key", "sandbox-secret", true);
}

if (require.main === module) {
  const apiKey = process.env.BYBIT_API_KEY;
  const apiSecret = process.env.BYBIT_API_SECRET;
  if (!apiKey || !apiSecret) {
    console.error("BYBIT_API_KEY and BYBIT_API_SECRET environment variables are required");
    process.exit(1);
  }
  const enableOptions = process.env.ENABLE_OPTIONS === "true";
  const server = createServer(apiKey, apiSecret, enableOptions);

  async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Bybit MCP server running on stdio");
  }

  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
