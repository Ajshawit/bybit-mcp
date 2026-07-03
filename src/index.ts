#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { BybitClient } from "./client";
import { handleGetAccountStatus } from "./tools/account";
import { handleGetMarketData, handleScanMarket, handleGetOhlc, handleGetMarketRegime, handleListTradfiInstruments, ScanFilter } from "./tools/market";
import { handleGetVolatility } from "./tools/volatility";
import { handleGetCarryAnalytics } from "./tools/carry";
import { handleEstimateExecutionCost } from "./tools/execution";
import { handleGetPortfolioRisk } from "./tools/portfolio";
import { handleGetEventCalendar } from "./tools/calendar";
import { handleCalculatePositionSize, SizingMethod } from "./tools/sizing";
import { handleGetPerformanceStats } from "./tools/performance";
import { handleAnalyzePair } from "./tools/pairs";
import { handlePlaceTrade, handleClosePosition, handleManagePosition } from "./tools/trade";
import { handleListOpenOrders, handleCancelOrder, handleGetClosedTrades } from "./tools/orders";
import {
  handleGetOptionChain, handleGetOptionQuote, handleGetOptionPayoff,
  handleScanOptions, handleGetOptionsRegime, IVSampleStore,
  handlePlaceOptionTrade, handleCloseOptionPosition,
} from "./tools/options/index.js";
import { OPTION_UNDERLYINGS } from "./tools/options/types.js";
import type { OptionUnderlying } from "./tools/options/types.js";
import {
  handleGetRfqList, handleGetRfqRealtime, handleGetQuoteList,
  handleGetQuoteRealtime, handleGetRfqTradeList,
  checkRfqEligibility, assessComboRisk,
  handleCreateRfq, handleExecuteQuote, handleCancelRfq,
} from "./tools/rfq/index.js";
import type {
  RfqListTraderType, RfqQuoteTraderType, RfqStatus, RfqTradeStatus, RiskLeg,
  CreateRfqLeg, RfqSide,
} from "./tools/rfq/index.js";

import { readFileSync } from "fs";
import { join } from "path";
import { resolveBaseUrl, isEnvEnabled, TESTNET_URL } from "./config";
import { sigFig } from "./util";
import { createSampleFileStore } from "./storage";
import { assertBooleanFlag, assertOneOf } from "./tools/confirm";

// Report the real package version over MCP instead of a hardcoded constant
// that drifts from package.json.
function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function createServer(
  apiKey: string,
  apiSecret: string,
  enableOptions: boolean,
  enableRfq: boolean
): Server {
  const baseUrl = resolveBaseUrl(process.env.BYBIT_TESTNET);
  const client = new BybitClient(apiKey, apiSecret, baseUrl);
  const ENABLE_OPTIONS = enableOptions;
  const ENABLE_RFQ = enableRfq;
  const ivStore = ENABLE_OPTIONS ? new IVSampleStore(createSampleFileStore("iv-samples")) : null;

  const server = new Server(
    { name: "bybit-quant", version: packageVersion() },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "get_account_status",
        description: "Account balance, free capital, margin in use, unrealised PnL, and all open positions (linear perps, inverse perps, spot holdings incl. xStock tokens; option positions with Greeks when enabled). accountInfo reports the API key's UID and account type.",
        inputSchema: { type: "object" as const, properties: {}, required: [] },
      },
      {
        name: "get_market_data",
        description: "Market snapshot for one symbol: price, ticker, spread, orderbook summary, funding rate, open interest. Use get_ohlc for candle history and list_tradfi_instruments to discover TradFi symbols.",
        inputSchema: {
          type: "object" as const,
          properties: {
            symbol: { type: "string", description: "Symbol e.g. BTCUSDT" },
            category: {
              type: "string",
              enum: ["linear", "spot"],
              description: "linear (default) for crypto, stock (e.g. TSLAPUSDT), and commodity (e.g. XAUUSDT) perps — full funding/OI. spot for xStock tokens (e.g. TSLAXUSDT) — price, orderbook, and NYSE market-hours status; funding/OI omitted.",
            },
            klineIntervals: { type: "array", items: { type: "string" }, description: "Kline intervals e.g. [\"60\",\"240\"]. Default: [\"60\",\"240\"]" },
            klineLimit: { type: "number", description: "Number of candles per interval. Default: 24" },
            fundingHistoryLimit: { type: "number", description: "Number of funding rate history records. Default: 8" },
            includeOrderbook: { type: "boolean", description: "If true, include full 20-level bids/asks arrays in the orderbook field. Default: false (returns 5-field summary only: bestBid, bestAsk, spread, spreadPct, midPrice)." },
            includeKlines: { type: "boolean", description: "If true, fetch and return kline arrays per klineIntervals. Default: false (ticker/funding/OI only — use get_ohlc for candle history)." },
          },
          required: ["symbol"],
        },
      },
      {
        name: "scan_market",
        description: "Scan all linear perpetuals for one condition; returns raw numbers and machine-readable tags. Filters: oi_divergence (price/OI divergence), crowded_positioning (extreme funding + range, with fundingZScore vs ~200-epoch history), volume_spike (unusual hourly volume), account_ratio (retail long/short crowding ≥2 or ≤0.5 — contrarian when crowding and funding stretch together).",
        inputSchema: {
          type: "object" as const,
          properties: {
            filter: { type: "string", enum: ["oi_divergence", "crowded_positioning", "volume_spike", "account_ratio"] },
            minVolume24hUsd: { type: "number", description: "Minimum 24h volume in USD. Default: 10000000" },
            limit: { type: "number", description: "Maximum results to return. Default: 15" },
          },
          required: ["filter"],
        },
      },
      {
        name: "get_ohlc",
        description: "OHLC for any symbol/category. Default: summary only (lastPrice, count, periodHigh, periodLow); set includeCandles=true for the series, newest first. Use get_market_data for ticker/funding/OI without candles.",
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
            includeCandles: { type: "boolean", description: "Return the candle series. Default: false (summary stats only)." },
            candleFormat: { type: "string", enum: ["tuples", "objects"], description: "When includeCandles=true: tuples (default) = compact [t,o,h,l,c,v] arrays; objects = named fields." },
          },
          required: ["symbol"],
        },
      },
      {
        name: "get_market_regime",
        description: "BTC trend (SMA20/SMA50) + aggregate funding sentiment across top-20 linear perps by volume, synthesised into a regime label (risk_on / risk_off / choppy) plus raw signals. BTC trend-based — does not capture alt/BTC divergence.",
        inputSchema: {
          type: "object" as const,
          properties: {
            timeframe: {
              type: "string",
              enum: ["intraday", "swing", "macro"],
              description: "Trend resolution: intraday (1h bars), swing (4h bars, ~1-2 week horizon), macro (daily bars, ~2-3 month horizon). Default: swing",
            },
          },
          required: [],
        },
      },
      {
        name: "get_volatility",
        description: "Realized-vol analytics: three annualized RV estimators (closeToClose, parkinson, yangZhang) plus a vol cone (current RV vs its own 1d-30d history). For option underlyings (options enabled), adds ATM IV and ivMinusRv (positive = implied rich — the variance-risk-premium signal). Vols are annualized decimals (0.45 = 45%).",
        inputSchema: {
          type: "object" as const,
          properties: {
            symbol: { type: "string", description: "e.g. BTCUSDT" },
            category: { type: "string", enum: ["linear", "inverse", "spot"], description: "Default: linear" },
            interval: {
              type: "string",
              enum: ["1", "3", "5", "15", "30", "60", "120", "240", "360", "720", "D", "W", "M"],
              description: "Bar interval the estimators run on. Default: 60 (1 hour)",
            },
            limit: { type: "number", minimum: 10, maximum: 1000, description: "Bars of history to fetch (sets vol-cone depth). Default: 1000" },
            windowBars: { type: "number", description: "Estimator window in bars. Default: ~7 days of bars (clamped 24-336)" },
            compareIv: { type: "boolean", description: "Compare against ATM IV when options are enabled. Default: true" },
          },
          required: ["symbol"],
        },
      },
      {
        name: "get_carry_analytics",
        description: "Basis and funding-carry analytics. action='basis' (requires symbol): mark-vs-index basis, current/realized/predicted funding annualized, perp-vs-spot and dated-futures basis. action='scan': rank linear perps by annualized funding carry each side, using real funding intervals. For delta-neutral carry and funding-arb discovery.",
        inputSchema: {
          type: "object" as const,
          properties: {
            action: { type: "string", enum: ["basis", "scan"] },
            symbol: { type: "string", description: "Required for action 'basis'. e.g. BTCUSDT" },
            minVolume24hUsd: { type: "number", description: "For scan: minimum 24h volume in USD. Default: 10000000" },
            limit: { type: "number", description: "For scan: max symbols per side. Default: 10" },
          },
          required: ["action"],
        },
      },
      {
        name: "get_portfolio_risk",
        description: "Portfolio risk across ALL open positions (linear, inverse, options when enabled): per-underlying delta USD and Greeks, totals (net/gross delta, vega, theta/day, leverage, concentration), and a spot × IV shock PnL grid with the worst-case cell — options repriced via Black-Scholes at constant time, all underlyings shocked together.",
        inputSchema: {
          type: "object" as const,
          properties: {
            spotShocksPct: { type: "array", items: { type: "number" }, description: "Spot shock percentages, e.g. [-30,-15,0,15,30]. Max 9 values; 0 auto-included. Default: [-20,-10,-5,0,5,10,20]" },
            ivShocksPts: { type: "array", items: { type: "number" }, description: "IV shocks in vol points (only applied when option positions exist). Max 9 values; 0 auto-included. Default: [-10,0,10]" },
          },
          required: [],
        },
      },
      {
        name: "estimate_execution_cost",
        description: "Pre-trade cost estimate from deep orderbook data: expected fill price, slippage vs mid (bps), book imbalance, real fee-tier taker/maker fees, all-in cost, and max size executable within maxSlippageBps. Run before place_trade; a bookExhausted warning means the order would sweep the visible book.",
        inputSchema: {
          type: "object" as const,
          properties: {
            symbol: { type: "string", description: "e.g. BTCUSDT" },
            side: { type: "string", enum: ["Buy", "Sell"] },
            category: { type: "string", enum: ["linear", "inverse", "spot"], description: "Default: linear" },
            qty: { type: "number", description: "Order size in base units (USD contracts for inverse). Provide qty or notionalUsd." },
            notionalUsd: { type: "number", description: "Order size in USD. Provide qty or notionalUsd." },
            maxSlippageBps: { type: "number", description: "Threshold for the maxExecutable calculation. Default: 10" },
            includeFees: { type: "boolean", description: "Fetch account taker/maker fee rates (signed call). Default: true" },
          },
          required: ["symbol", "side"],
        },
      },
      {
        name: "get_event_calendar",
        description: "Upcoming market events in one call: next funding time + rate per symbol, option expiry schedule with OI notional by date (when options are enabled), dated-futures deliveries, and current NYSE session status. Use for timing decisions — imminent funding prints, expiry-day OI.",
        inputSchema: {
          type: "object" as const,
          properties: {
            symbols: { type: "array", items: { type: "string" }, description: "Symbols for the funding section (max 10, assumed linear). Default: open-position symbols, else BTCUSDT/ETHUSDT." },
            daysAhead: { type: "number", description: "Event horizon in days for expiries/deliveries (1-365). Default: 45" },
          },
          required: [],
        },
      },
      {
        name: "calculate_position_size",
        description: "Position sizing calculator — advisory math only, no order placed. method='risk_per_trade': qty whose loss at your stop equals a USD or %-equity budget. 'kelly': fractional Kelly from win/loss stats (explicit or from closed trades). 'vol_target': size to a target annualized vol contribution. Returns qty floored to the instrument step, notional, margin, and a liquidation-distance check vs your stop. Run before place_trade.",
        inputSchema: {
          type: "object" as const,
          properties: {
            symbol: { type: "string", description: "e.g. BTCUSDT" },
            method: { type: "string", enum: ["risk_per_trade", "vol_target", "kelly"] },
            category: { type: "string", enum: ["linear", "inverse", "spot"], description: "Default: linear" },
            side: { type: "string", enum: ["Buy", "Sell"], description: "Default: Buy. Spot supports Buy only." },
            entryPrice: { type: "number", description: "Planned entry price. Default: current last price." },
            stopPrice: { type: "number", description: "Stop-loss price. Required for risk_per_trade and kelly; also enables the liquidation-distance check." },
            riskUsd: { type: "number", description: "risk_per_trade: absolute USD risk budget. Mutually exclusive with riskPctEquity." },
            riskPctEquity: { type: "number", description: "risk_per_trade: risk as % of equity. Default: 1." },
            targetAnnualVolPct: { type: "number", description: "vol_target: target annualized vol contribution as % of equity, e.g. 10." },
            kellyFraction: { type: "number", description: "kelly: fraction of full Kelly to apply, in (0,1]. Default: 0.25." },
            winRate: { type: "number", description: "kelly: explicit win rate (0-1). Provide together with avgWinUsd and avgLossUsd, or omit all three to use closed-trade history." },
            avgWinUsd: { type: "number", description: "kelly: average winning trade in USD." },
            avgLossUsd: { type: "number", description: "kelly: average losing trade in USD (positive number)." },
            leverage: { type: "number", description: "Planned leverage — enables marginRequiredUsd and estimatedLiqPrice outputs. Perps only." },
            equityUsd: { type: "number", description: "Equity override. Default: fetches wallet totalEquity (signed call)." },
          },
          required: ["symbol", "method"],
        },
      },
      {
        name: "analyze_pair",
        description: "Pairs/stat-arb toolkit vs a benchmark (default BTCUSDT): log-return correlation (full + recent), OLS hedge-ratio beta with hedge notional per $1k, log-spread z-score with signal tag (spread_rich/spread_cheap at |z| ≥ 2), and AR(1) mean-reversion half-life (null when trending). For hedge sizing, alt/BTC divergence, and pair-trade timing.",
        inputSchema: {
          type: "object" as const,
          properties: {
            symbol: { type: "string", description: "Symbol to analyze, e.g. ETHUSDT" },
            benchmark: { type: "string", description: "Benchmark symbol. Default: BTCUSDT" },
            category: { type: "string", enum: ["linear", "inverse", "spot"], description: "Default: linear (applies to both legs)" },
            interval: {
              type: "string",
              enum: ["1", "3", "5", "15", "30", "60", "120", "240", "360", "720", "D", "W", "M"],
              description: "Bar interval. Default: 60 (1 hour)",
            },
            limit: { type: "number", minimum: 50, maximum: 1000, description: "Bars of history. Default: 500" },
            windowBars: { type: "number", description: "Recent-window size for correlationRecent/betaRecent. Default: 168" },
          },
          required: ["symbol"],
        },
      },
      {
        name: "get_performance_stats",
        description: "Closed-trade performance over a lookback (default 30d, max 180; cap 1000 trades): win rate, profit factor, expectancy, payoff ratio, Sharpe/Sortino on daily USD PnL (scale-dependent), max drawdown, per-symbol attribution, long/short and hold-time stats. Stats source for calculate_position_size method='kelly'.",
        inputSchema: {
          type: "object" as const,
          properties: {
            category: { type: "string", enum: ["linear", "inverse"], description: "Default: linear" },
            symbol: { type: "string", description: "Restrict to one symbol e.g. BTCUSDT. Omit for all symbols." },
            daysBack: { type: "number", minimum: 1, maximum: 180, description: "Lookback window in days. Default: 30" },
          },
          required: [],
        },
      },
      {
        name: "place_trade",
        description: "Place a trade on a Bybit linear perp, inverse perp, or spot market — market, limit, or conditional/stop entry (pass `triggerPrice`). CONFIRMATION REQUIRED: (1) Present the full trade plan — symbol, category, side, margin, leverage (perps), SL (perps), TP, estimated position size. (2) Wait for the user to reply with 'CONFIRM'. (3) Only call this tool after receiving explicit CONFIRM. Never call this tool in the same turn as presenting the trade plan. Recommended workflow: present plan → CONFIRM → call with dry_run=true → verify computedQty, notional, and warnings → call again with dry_run=false. The dry_run call does not require a second CONFIRM. If dry_run returns wouldSubmit: false, do not proceed without addressing the warnings.",
        inputSchema: {
          type: "object" as const,
          properties: {
            symbol: { type: "string", description: "Symbol e.g. BTCUSDT, BTCUSD" },
            side: { type: "string", enum: ["Buy", "Sell"] },
            margin: { type: "number", description: "Margin to allocate. USDT for linear/spot; base coin (e.g. BTC) for inverse." },
            category: { type: "string", enum: ["linear", "inverse", "spot", "spot_margin"], description: "Default: linear (crypto/stock/commodity perps, e.g. TSLAPUSDT, XAUUSDT). 'spot'/'spot_margin' to own the asset — incl. xStock tokens (e.g. TSLAXUSDT; no leverage/SL). Confirm TradFi symbols via list_tradfi_instruments first." },
            orderType: { type: "string", enum: ["Market", "Limit"], description: "Default: Market" },
            price: { type: "number", description: "Required for Limit orders. Limit entry price." },
            leverage: { type: "number", description: "Required for linear/inverse. Ignored for spot." },
            sl: { type: "number", description: "Stop loss price. Required for linear/inverse. Not supported for spot." },
            tp: { type: "number", description: "Take profit price. Optional, perps only." },
            trailingStop: { type: "number", description: "Trailing stop distance in quote currency. Optional, perps only." },
            trailingActivatePrice: { type: "number", description: "Price at which trailing stop activates. Optional, perps only." },
            triggerPrice: { type: "number", description: "Makes the order a conditional/stop entry: rests until price crosses this level, then submits as orderType (Market = stop-market, Limit = stop-limit). For breakout/breakdown setups." },
            triggerBy: { type: "string", enum: ["LastPrice", "MarkPrice", "IndexPrice"], description: "Price feed the trigger watches. Default: LastPrice. Perps only; ignored for spot." },
            triggerDirection: { type: "number", enum: [1, 2], description: "1 = trigger on rise to triggerPrice; 2 = on fall. Auto-derived if omitted. Perps only; ignored for spot." },
            notes: { type: "string", description: "Trade rationale — echoed back in response" },
            dry_run: { type: "boolean", description: "If true, returns computed order details without submitting. Default: false. executionPrice is the current last price, not a slippage-adjusted estimate." },
            confirm: { type: "string", description: "Must equal the literal string 'CONFIRM' (case-sensitive, no whitespace) to submit live. Validated server-side at call time. Omit when dry_run=true." },
          },
          // Conditional requirements (price for Limit; leverage+sl for perps)
          // are enforced at runtime in the trade handlers — JSON Schema
          // `allOf`/`anyOf` is not supported at the top level of a tool
          // input schema by the Anthropic API.
          required: ["symbol", "side", "margin"],
        },
      },
      {
        name: "close_position",
        description: "Close an open position (fully or partially). Perp/inverse default to Market close; orderType='Limit' + price places reduce-only take-profit ladders. Spot is Market-only — sells from total wallet balance; pass `qty` for an exact amount. CONFIRMATION REQUIRED: (1) Present the close plan — symbol, category, side, orderType, size, price (if Limit), rationale. (2) Wait for the user to reply with 'CONFIRM'. (3) Only call this tool after receiving explicit CONFIRM. Never call this tool in the same turn as proposing the close.",
        inputSchema: {
          type: "object" as const,
          properties: {
            symbol: { type: "string" },
            side: { type: "string", enum: ["Buy", "Sell"], description: "The side of the position being closed (not the order direction). 'Buy' closes a long, 'Sell' closes a short. For spot: always 'Buy' since you can only hold (not short) the base asset." },
            category: { type: "string", enum: ["linear", "inverse", "spot", "spot_margin"], description: "Default: linear" },
            percent: { type: "number", description: "Percentage to close (1-100). Default: 100. Ignored if qty provided." },
            qty: { type: "number", description: "Explicit close quantity in base coin. Overrides percent." },
            orderType: { type: "string", enum: ["Market", "Limit"], description: "Default: Market. Limit = layered take-profit at a specific price, perp/inverse only; the order is reduceOnly:true so it can only shrink the position." },
            price: { type: "number", exclusiveMinimum: 0, description: "Required when orderType=Limit. Limit price for the reduce-only close. Must be > 0." },
            notes: { type: "string", description: "Rationale — echoed back in response" },
            dry_run: { type: "boolean", description: "If true, returns the computed close (closeQty, remainingSize) without submitting. No confirm needed. Default: false." },
            confirm: { type: "string", description: "Must equal the literal string 'CONFIRM' (case-sensitive, no whitespace). Validated server-side at call time." },
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
            dry_run: { type: "boolean", description: "If true, returns the trading-stop request body that would be sent, without submitting. No confirm needed. Default: false." },
            confirm: { type: "string", description: "Must equal the literal string 'CONFIRM' (case-sensitive, no whitespace). Validated server-side at call time." },
          },
          required: ["symbol", "side", "updates"],
        },
      },
      {
        name: "list_open_orders",
        description: "List all resting (unfilled) orders with price, size, SL/TP, fill status, and orderId. Use before cancel_order to look up the orderId.",
        inputSchema: {
          type: "object" as const,
          properties: {
            symbol: { type: "string", description: "Filter by symbol e.g. BTCUSDT. Omit to list all symbols (linear defaults to USDT-settled; pass a symbol for USDC-linear)." },
            category: { type: "string", enum: ["linear", "inverse", "spot", "option"], description: "Default: linear. (spot_margin orders live in the spot order book — use 'spot'.)" },
          },
          required: [],
        },
      },
      {
        name: "cancel_order",
        description: "Cancel a specific resting order by orderId. Use list_open_orders first to find the orderId. Non-destructive to other orders.",
        inputSchema: {
          type: "object" as const,
          properties: {
            symbol: { type: "string", description: "Symbol e.g. BTCUSDT" },
            orderId: { type: "string", description: "Order ID from list_open_orders or place_trade response" },
            category: { type: "string", enum: ["linear", "inverse", "spot", "option"], description: "Default: linear. (spot_margin orders live in the spot order book — use 'spot'.)" },
            orderFilter: { type: "string", enum: ["Order", "StopOrder", "tpslOrder"], description: "Spot only: which order book the orderId lives in. Spot conditional orders created by place_trade use 'StopOrder'. If omitted, a failed spot cancel is automatically retried with 'StopOrder'." },
            dry_run: { type: "boolean", description: "If true, echoes what would be cancelled without submitting. No confirm needed. Default: false." },
            confirm: { type: "string", description: "Must equal the literal string 'CONFIRM' (case-sensitive, no whitespace). Validated server-side at call time." },
          },
          required: ["symbol", "orderId"],
        },
      },
      {
        name: "get_closed_trades",
        description: "Realised P&L for recently closed perp positions (linear or inverse): entry/exit averages, closedPnl, fees-net P&L, leverage, hold duration, pnlPct. Use for post-trade journaling. Bybit retains up to 7 days by default; use startTime/endTime to narrow.",
        inputSchema: {
          type: "object" as const,
          properties: {
            symbol: { type: "string", description: "Filter to one symbol e.g. BTCUSDT. Omit to get all closed trades." },
            category: { type: "string", enum: ["linear", "inverse"], description: "Default: linear" },
            limit: { type: "number", description: "Max trades to return (1-100). Default: 50" },
            startTime: { type: "number", description: "Filter start (ms since epoch). Optional." },
            endTime: { type: "number", description: "Filter end (ms since epoch). Optional." },
          },
          required: [],
        },
      },
      {
        name: "list_tradfi_instruments",
        description: "Discover Bybit TradFi instruments and constraints (tickSize, minOrderQty, maxLeverage): xStocks (tokenized equities e.g. TSLAXUSDT, category=spot), stock perps (e.g. TSLAPUSDT) and commodity perps (e.g. XAUUSDT), category=linear. Call before the first TradFi trade in a session. These markets trade 24/7 but underlying equities move only during NYSE hours; volume/funding/OI are Bybit-market-only positioning indicators, not real NYSE/CME flows.",
        inputSchema: {
          type: "object" as const,
          properties: {
            type: {
              type: "string",
              enum: ["xstocks", "stock_perps", "commodity_perps", "all"],
              description: "Which TradFi asset type to list. Default: all",
            },
            search: {
              type: "string",
              description: "Optional filter — case-insensitive substring match on symbol or base coin. E.g. 'TSLA' returns TSLAXUSDT and TSLAPUSDT.",
            },
          },
        },
      },
      ...(ENABLE_OPTIONS ? [
        {
          name: "options_market",
          description: "Options market data for BTC/ETH/SOL/XAUT/XRP/MNT/DOGE — four actions. 'chain': browse an underlying's contracts. 'quote': full pricing + Greeks for one symbol (e.g. BTC-25APR26-80000-C-USDT). 'scan': unusual-IV scan (high_iv/low_iv require ~24h warmup). 'regime': ATM IV, IV percentile, put/call skew, term structure per underlying.",
          inputSchema: {
            type: "object" as const,
            properties: {
              action: { type: "string", enum: ["chain", "quote", "scan", "regime"] },
              underlying: { type: "string", enum: [...OPTION_UNDERLYINGS], description: "Required for chain and scan" },
              underlyings: { type: "array", items: { type: "string", enum: [...OPTION_UNDERLYINGS] }, description: "For regime: default all underlyings" },
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
              limit: { type: "number", description: "For chain: max contracts returned, top open-interest kept when more match (default 50; response reports returned vs matched). For scan: max results (default 10)." },
              compact: { type: "boolean", description: "For chain: grouped-by-expiry response — expiries[] of {expiryToken, expiryDate, daysToExpiry, contracts: [strike, \"C\"|\"P\", bid, ask, iv, openInterest]}. Default: true. Set false for full per-contract objects." },
            },
            // Per-action required fields (chain→underlying, quote→symbol,
            // scan→underlying+filter) are enforced at runtime in the options
            // handlers — JSON Schema `allOf` is not supported at the top
            // level of a tool input schema by the Anthropic API.
            required: ["action"],
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
              steps: { type: "number", description: "Price points to compute. Default: 15" },
            },
            required: ["legs", "currentSpot"],
          },
        },
        {
          name: "place_option_trade",
          description: "Place a single-leg option order on Bybit (BTC, ETH, SOL, XAUT, XRP, MNT, DOGE). CONFIRMATION REQUIRED: (1) Present the full trade plan — symbol, side, qty, orderType, estimated premium, Greeks, payoff summary. (2) Wait for the user to reply with 'CONFIRM'. (3) Only call this tool after receiving explicit CONFIRM. Recommended workflow: present plan → CONFIRM → call with dry_run=true → verify estimatedPremium and warnings → call again with dry_run=false. Short selling requires OPTIONS_ALLOW_NAKED_SHORT=true unless an offsetting long exists.",
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
              confirm: { type: "string", description: "Must equal the literal string 'CONFIRM' (case-sensitive, no whitespace) to submit live. Validated server-side at call time. Omit when dry_run=true." },
            },
            required: ["symbol", "side", "qty", "orderType"],
          },
        },
        {
          name: "close_option_position",
          description: "Close an open option position (fully or partially). CONFIRMATION REQUIRED: (1) Present the close plan — symbol, qty, side, estimated P&L. (2) Wait for the user to reply with 'CONFIRM'. (3) Only call this tool after receiving explicit CONFIRM. Use dry_run=true first to verify estimated P&L before submitting.",
          inputSchema: {
            type: "object" as const,
            properties: {
              symbol: { type: "string", description: "Full Bybit option symbol" },
              qty: { type: "number", description: "Contracts to close. Defaults to full position size." },
              orderType: { type: "string", enum: ["Market", "Limit"] },
              price: { type: "number", description: "Required for Limit orders" },
              notes: { type: "string", description: "Rationale — echoed back in response" },
              dry_run: { type: "boolean", description: "If true, returns close plan without submitting. Default: false" },
              confirm: { type: "string", description: "Must equal the literal string 'CONFIRM' (case-sensitive, no whitespace) to submit live. Validated server-side at call time. Omit when dry_run=true." },
            },
            required: ["symbol", "orderType"],
          },
        },
      ] : []),
      ...(ENABLE_RFQ ? [
        {
          name: "rfq_query",
          description: "Read-only Bybit RFQ / block-trade queries (taker side): 'rfq_list' / 'rfq_realtime' (historical / active RFQs), 'quote_list' / 'quote_realtime' (LP quote history / live quotes — the poll path), 'trade_list' (executed trades). No orders placed. Requires UTA 2.0 + portfolio margin; use check_rfq_eligibility first.",
          inputSchema: {
            type: "object" as const,
            properties: {
              action: { type: "string", enum: ["rfq_list", "rfq_realtime", "quote_list", "quote_realtime", "trade_list"] },
              rfqId: { type: "string" },
              rfqLinkId: { type: "string" },
              quoteId: { type: "string", description: "For quote_* and trade_list" },
              quoteLinkId: { type: "string", description: "For quote_* and trade_list" },
              traderType: { type: "string", description: "rfq_list: 'quoter'|'request'; quote_*: 'quote'|'request'" },
              status: { type: "string", description: "rfq_list/quote_list: Active|Canceled|PendingFill|Filled|Expired|Failed. trade_list: Filled|Rejected" },
              limit: { type: "number", description: "History actions only" },
              cursor: { type: "string", description: "History pagination cursor" },
            },
            required: ["action"],
          },
        },
        {
          name: "check_rfq_eligibility",
          description: "Pre-flight check for Bybit RFQ access against the hard requirements: UTA 2.0 (unifiedMarginStatus 5 or 6), PORTFOLIO_MARGIN, and — if notionalUsd is supplied — the 10,000 USD per-RFQ minimum. reasons[] explains every failed gate. Run before any RFQ workflow.",
          inputSchema: {
            type: "object" as const,
            properties: {
              notionalUsd: { type: "number", description: "Optional planned RFQ notional in USD; checked against the 10,000 USD minimum" },
            },
          },
        },
        {
          name: "assess_combo_risk",
          description: "Pure-math combo risk assessment for a multi-leg RFQ structure — no API call. Models max loss only when EVERY leg is an option; any linear/spot leg, missing spot, or unpriced leg => modeled:false, maxLossUsd:null, treated as uncovered. Uncovered/unmodeled combos are blocked unless RFQ_ALLOW_UNCOVERED=true (or OPTIONS_ALLOW_NAKED_SHORT=true). Risk-defined spreads are correctly NOT flagged.",
          inputSchema: {
            type: "object" as const,
            properties: {
              legs: {
                type: "array",
                items: {
                  type: "object" as const,
                  properties: {
                    category: { type: "string", enum: ["spot", "linear", "option"] },
                    symbol: { type: "string" },
                    side: { type: "string", enum: ["buy", "sell"] },
                    qty: { type: "number" },
                    price: { type: "number", description: "Per-unit price/premium; required for option payoff modelling" },
                  },
                  required: ["category", "symbol", "side", "qty"],
                },
              },
              currentSpot: { type: "number", description: "Underlying spot; required to model an all-option combo" },
            },
            required: ["legs"],
          },
        },
        {
          name: "create_rfq",
          description: "Create a multi-leg Bybit RFQ (block-trade request for quote). MOVES TOWARD REAL MONEY. CONFIRMATION REQUIRED: (1) Present the full RFQ plan — counterparties, every leg, estimated notional. (2) Wait for the user to reply 'CONFIRM'. (3) Call with dry_run=true first — inspect eligibility, risk, and the exact request body. (4) Only call with dry_run=false after explicit CONFIRM. dry_run defaults to true. Live submission ALSO requires RFQ_ENABLE_WRITES=true (off until endpoint paths are live-verified). Pre-flights: account must be RFQ-eligible (UTA 2.0 + portfolio margin) and the combo must pass the risk gate (uncovered/unmodeled combos blocked unless RFQ_ALLOW_UNCOVERED).",
          inputSchema: {
            type: "object" as const,
            properties: {
              counterparties: { type: "array", items: { type: "string" }, description: "LP desk codes to send the RFQ to (>=1)" },
              list: {
                type: "array",
                description: "1-25 legs",
                items: {
                  type: "object" as const,
                  properties: {
                    category: { type: "string", enum: ["spot", "linear", "inverse", "option"] },
                    symbol: { type: "string" },
                    side: { type: "string", enum: ["buy", "sell"] },
                    qty: { type: "string", description: "Quantity as a string (Bybit wire format)" },
                    isLeverage: { type: "boolean" },
                  },
                  required: ["category", "symbol", "side", "qty"],
                },
              },
              rfqLinkId: { type: "string", description: "Optional client RFQ id (1-32 chars)" },
              anonymous: { type: "boolean" },
              strategyType: { type: "string" },
              estimatedNotionalUsd: { type: "number", description: "Your estimate of the RFQ's USD notional; checked against the 10,000 USD minimum" },
              dry_run: { type: "boolean", description: "Default true. Must be explicitly false to submit." },
              confirm: { type: "string", description: "Must equal the literal string 'CONFIRM' (case-sensitive, no whitespace) to submit live. Validated server-side at call time. Omit when dry_run=true (the default)." },
            },
            required: ["counterparties", "list"],
          },
        },
        {
          name: "execute_quote",
          description: "Execute an LP's quote against an existing RFQ. IRREVERSIBLE, FILLS REAL MONEY ASYNCHRONOUSLY. CONFIRMATION REQUIRED: (1) Present the quote (use quote_realtime) and the exact rfqId/quoteId/quoteSide. (2) Wait for 'CONFIRM'. (3) Call with dry_run=true to echo the request. (4) Only call dry_run=false after explicit CONFIRM. dry_run defaults to true. Live submission ALSO requires RFQ_ENABLE_WRITES=true.",
          inputSchema: {
            type: "object" as const,
            properties: {
              rfqId: { type: "string" },
              quoteId: { type: "string" },
              quoteSide: { type: "string", enum: ["buy", "sell"], description: "Side of the quote to take" },
              dry_run: { type: "boolean", description: "Default true. Must be explicitly false to submit." },
              confirm: { type: "string", description: "Must equal the literal string 'CONFIRM' (case-sensitive, no whitespace) to submit live. Validated server-side at call time. Omit when dry_run=true (the default)." },
            },
            required: ["rfqId", "quoteId", "quoteSide"],
          },
        },
        {
          name: "cancel_rfq",
          description: "Cancel an open RFQ you created. Risk-reducing; not behind the write kill-switch. Supply rfqId or rfqLinkId.",
          inputSchema: {
            type: "object" as const,
            properties: {
              rfqId: { type: "string" },
              rfqLinkId: { type: "string" },
            },
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
            a.fundingHistoryLimit as number | undefined,
            a.includeOrderbook as boolean | undefined,
            a.includeKlines as boolean | undefined,
            (a.category as "linear" | "spot" | undefined) ?? "linear"
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
            a.limit as number | undefined,
            a.includeCandles as boolean | undefined,
            assertOneOf(a.candleFormat, ["tuples", "objects"] as const, "candleFormat", "get_ohlc")
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

        case "get_volatility": {
          const data = await handleGetVolatility(client, ENABLE_OPTIONS, {
            symbol: a.symbol as string,
            category: a.category as "linear" | "inverse" | "spot" | undefined,
            interval: a.interval as string | undefined,
            limit: a.limit as number | undefined,
            windowBars: a.windowBars as number | undefined,
            compareIv: a.compareIv as boolean | undefined,
          });
          result = { ...data, serverTimestamp: new Date().toISOString() };
          break;
        }

        case "get_carry_analytics": {
          const carryAction = assertOneOf(a.action, ["basis", "scan"] as const, "action", "get_carry_analytics");
          if (!carryAction) throw new Error("get_carry_analytics: action is required ('basis' or 'scan')");
          const data = await handleGetCarryAnalytics(client, {
            action: carryAction,
            symbol: a.symbol as string | undefined,
            minVolume24hUsd: a.minVolume24hUsd as number | undefined,
            limit: a.limit as number | undefined,
          });
          result = { ...data, serverTimestamp: new Date().toISOString() };
          break;
        }

        case "get_portfolio_risk": {
          const data = await handleGetPortfolioRisk(client, ENABLE_OPTIONS, {
            spotShocksPct: a.spotShocksPct as number[] | undefined,
            ivShocksPts: a.ivShocksPts as number[] | undefined,
          });
          result = { ...data, serverTimestamp: new Date().toISOString() };
          break;
        }

        case "estimate_execution_cost": {
          const data = await handleEstimateExecutionCost(client, {
            symbol: a.symbol as string,
            side: assertOneOf(a.side, ["Buy", "Sell"] as const, "side", "estimate_execution_cost") as "Buy" | "Sell",
            category: assertOneOf(a.category, ["linear", "inverse", "spot"] as const, "category", "estimate_execution_cost"),
            qty: a.qty as number | undefined,
            notionalUsd: a.notionalUsd as number | undefined,
            maxSlippageBps: a.maxSlippageBps as number | undefined,
            includeFees: a.includeFees as boolean | undefined,
          });
          result = { ...data, serverTimestamp: new Date().toISOString() };
          break;
        }

        case "get_event_calendar": {
          const data = await handleGetEventCalendar(client, ENABLE_OPTIONS, {
            symbols: a.symbols as string[] | undefined,
            daysAhead: a.daysAhead as number | undefined,
          });
          result = { ...data, serverTimestamp: new Date().toISOString() };
          break;
        }

        case "calculate_position_size": {
          const sizingMethod = assertOneOf(
            a.method,
            ["risk_per_trade", "vol_target", "kelly"] as const,
            "method",
            "calculate_position_size"
          );
          if (!sizingMethod) throw new Error("calculate_position_size: method is required (risk_per_trade, vol_target, or kelly)");
          const data = await handleCalculatePositionSize(client, {
            symbol: a.symbol as string,
            method: sizingMethod as SizingMethod,
            category: assertOneOf(a.category, ["linear", "inverse", "spot"] as const, "category", "calculate_position_size"),
            side: assertOneOf(a.side, ["Buy", "Sell"] as const, "side", "calculate_position_size"),
            entryPrice: a.entryPrice as number | undefined,
            stopPrice: a.stopPrice as number | undefined,
            riskUsd: a.riskUsd as number | undefined,
            riskPctEquity: a.riskPctEquity as number | undefined,
            targetAnnualVolPct: a.targetAnnualVolPct as number | undefined,
            kellyFraction: a.kellyFraction as number | undefined,
            winRate: a.winRate as number | undefined,
            avgWinUsd: a.avgWinUsd as number | undefined,
            avgLossUsd: a.avgLossUsd as number | undefined,
            leverage: a.leverage as number | undefined,
            equityUsd: a.equityUsd as number | undefined,
          });
          result = { ...data, serverTimestamp: new Date().toISOString() };
          break;
        }

        case "analyze_pair": {
          const data = await handleAnalyzePair(client, {
            symbol: a.symbol as string,
            benchmark: a.benchmark as string | undefined,
            category: assertOneOf(a.category, ["linear", "inverse", "spot"] as const, "category", "analyze_pair"),
            interval: a.interval as string | undefined,
            limit: a.limit as number | undefined,
            windowBars: a.windowBars as number | undefined,
          });
          result = { ...data, serverTimestamp: new Date().toISOString() };
          break;
        }

        case "get_performance_stats": {
          const data = await handleGetPerformanceStats(client, {
            category: assertOneOf(a.category, ["linear", "inverse"] as const, "category", "get_performance_stats"),
            symbol: a.symbol as string | undefined,
            daysBack: a.daysBack as number | undefined,
          });
          result = { ...data, serverTimestamp: new Date().toISOString() };
          break;
        }

        case "place_trade": {
          // Gate-relevant params are runtime-validated: schema enums are
          // advisory only (the SDK does no server-side argument validation),
          // and a wrong-typed value here routes around the safety rails.
          const tradeData = await handlePlaceTrade(client, {
            symbol: a.symbol as string,
            side: assertOneOf(a.side, ["Buy", "Sell"] as const, "side", "place_trade") as "Buy" | "Sell",
            margin: a.margin as number,
            category: assertOneOf(a.category, ["linear", "inverse", "spot", "spot_margin"] as const, "category", "place_trade"),
            orderType: a.orderType as "Market" | "Limit" | undefined,
            price: a.price as number | undefined,
            leverage: a.leverage as number | undefined,
            sl: a.sl as number | undefined,
            tp: a.tp as number | undefined,
            trailingStop: a.trailingStop as number | undefined,
            trailingActivatePrice: a.trailingActivatePrice as number | undefined,
            triggerPrice: a.triggerPrice as number | undefined,
            triggerBy: a.triggerBy as "LastPrice" | "MarkPrice" | "IndexPrice" | undefined,
            triggerDirection: a.triggerDirection as 1 | 2 | undefined,
            notes: a.notes as string | undefined,
            dry_run: assertBooleanFlag(a.dry_run, "dry_run", "place_trade"),
            confirm: a.confirm as string | undefined,
          });
          result = { ...tradeData, serverTimestamp: new Date().toISOString() };
          break;
        }

        case "close_position":
          result = await handleClosePosition(client, {
            symbol: a.symbol as string,
            side: assertOneOf(a.side, ["Buy", "Sell"] as const, "side", "close_position") as "Buy" | "Sell",
            category: a.category as "linear" | "inverse" | "spot" | "spot_margin" | undefined,
            percent: a.percent as number | undefined,
            qty: a.qty as number | undefined,
            orderType: a.orderType as "Market" | "Limit" | undefined,
            price: a.price as number | undefined,
            notes: a.notes as string | undefined,
            dry_run: assertBooleanFlag(a.dry_run, "dry_run", "close_position"),
            confirm: a.confirm as string | undefined,
          });
          break;

        case "manage_position":
          result = await handleManagePosition(client, {
            symbol: a.symbol as string,
            side: assertOneOf(a.side, ["Buy", "Sell"] as const, "side", "manage_position") as "Buy" | "Sell",
            category: assertOneOf(a.category, ["linear", "inverse"] as const, "category", "manage_position"),
            updates: a.updates as { sl?: number; tp?: number; trailingStop?: number; trailingActivatePrice?: number },
            notes: a.notes as string | undefined,
            dry_run: assertBooleanFlag(a.dry_run, "dry_run", "manage_position"),
            confirm: a.confirm as string | undefined,
          });
          break;

        case "list_open_orders": {
          result = await handleListOpenOrders(client, {
            symbol: a.symbol as string | undefined,
            category: a.category as "linear" | "inverse" | "spot" | "option" | undefined,
          });
          break;
        }

        case "cancel_order": {
          result = await handleCancelOrder(client, {
            symbol: a.symbol as string,
            orderId: a.orderId as string,
            category: assertOneOf(a.category, ["linear", "inverse", "spot", "option"] as const, "category", "cancel_order"),
            orderFilter: assertOneOf(a.orderFilter, ["Order", "StopOrder", "tpslOrder"] as const, "orderFilter", "cancel_order"),
            dry_run: assertBooleanFlag(a.dry_run, "dry_run", "cancel_order"),
            confirm: a.confirm as string | undefined,
          });
          break;
        }

        case "get_closed_trades": {
          result = await handleGetClosedTrades(client, {
            symbol: a.symbol as string | undefined,
            category: a.category as "linear" | "inverse" | undefined,
            limit: a.limit as number | undefined,
            startTime: a.startTime as number | undefined,
            endTime: a.endTime as number | undefined,
          });
          break;
        }

        case "options_market": {
          if (!ivStore) throw new Error("Options module not enabled");
          const action = a.action as string;
          if (action === "chain") {
            if (!a.underlying) throw new Error("underlying is required for action 'chain'");
            const data = await handleGetOptionChain(client, {
              underlying: a.underlying as OptionUnderlying,
              minDaysToExpiry: a.minDaysToExpiry as number | undefined,
              maxDaysToExpiry: a.maxDaysToExpiry as number | undefined,
              type: a.type as "call" | "put" | undefined,
              minOpenInterest: a.minOpenInterest as number | undefined,
              strikeRange: a.strikeRange as { minPctFromSpot: number; maxPctFromSpot: number } | undefined,
              compact: a.compact as boolean | undefined,
              limit: a.limit as number | undefined,
            });
            result = { ...data, serverTimestamp: new Date().toISOString() };
          } else if (action === "quote") {
            if (!a.symbol) throw new Error("symbol is required for action 'quote'");
            const data = await handleGetOptionQuote(
              client,
              a.symbol as string,
              assertBooleanFlag(a.computeGreeksLocal, "computeGreeksLocal", "options_market")
            );
            result = { ...data, serverTimestamp: new Date().toISOString() };
          } else if (action === "scan") {
            if (!a.underlying) throw new Error("underlying is required for action 'scan'");
            if (!a.filter) throw new Error("filter is required for action 'scan'");
            const data = await handleScanOptions(client, ivStore, {
              underlying: a.underlying as OptionUnderlying,
              filter: a.filter as "high_iv" | "low_iv" | "skew" | "high_oi_change",
              expiry: a.expiry as "weekly" | "monthly" | "all" | undefined,
              limit: a.limit as number | undefined,
            });
            result = { ...data, serverTimestamp: new Date().toISOString() };
          } else if (action === "regime") {
            const data = await handleGetOptionsRegime(client, ivStore, {
              underlying: a.underlyings as OptionUnderlying[] | undefined,
            });
            result = { ...data, serverTimestamp: new Date().toISOString() };
          } else {
            throw new Error(`Unknown options_market action: ${action}`);
          }
          break;
        }

        case "get_option_payoff": {
          if (!ENABLE_OPTIONS) throw new Error("Options module not enabled");
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
            side: assertOneOf(a.side, ["Buy", "Sell"] as const, "side", "place_option_trade") as "Buy" | "Sell",
            qty: a.qty as number,
            orderType: a.orderType as "Market" | "Limit",
            price: a.price as number | undefined,
            notes: a.notes as string | undefined,
            dry_run: assertBooleanFlag(a.dry_run, "dry_run", "place_option_trade"),
            confirm: a.confirm as string | undefined,
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
            dry_run: assertBooleanFlag(a.dry_run, "dry_run", "close_option_position"),
            confirm: a.confirm as string | undefined,
          });
          result = data;
          break;
        }

        case "list_tradfi_instruments": {
          const data = await handleListTradfiInstruments(
            client,
            (a.type as "xstocks" | "stock_perps" | "commodity_perps" | "all" | undefined) ?? "all",
            a.search as string | undefined
          );
          result = { ...data, serverTimestamp: new Date().toISOString() };
          break;
        }

        case "rfq_query": {
          if (!ENABLE_RFQ) throw new Error("RFQ module not enabled");
          const action = a.action as string;
          let data: unknown;
          switch (action) {
            case "rfq_list":
              data = await handleGetRfqList(client, {
                rfqId: a.rfqId as string | undefined,
                rfqLinkId: a.rfqLinkId as string | undefined,
                traderType: a.traderType as RfqListTraderType | undefined,
                status: a.status as RfqStatus | undefined,
                limit: a.limit as number | undefined,
                cursor: a.cursor as string | undefined,
              });
              break;
            case "rfq_realtime":
              data = await handleGetRfqRealtime(client, {
                rfqId: a.rfqId as string | undefined,
                rfqLinkId: a.rfqLinkId as string | undefined,
                traderType: a.traderType as RfqQuoteTraderType | undefined,
              });
              break;
            case "quote_list":
              data = await handleGetQuoteList(client, {
                rfqId: a.rfqId as string | undefined,
                quoteId: a.quoteId as string | undefined,
                quoteLinkId: a.quoteLinkId as string | undefined,
                traderType: a.traderType as RfqQuoteTraderType | undefined,
                status: a.status as RfqStatus | undefined,
                limit: a.limit as number | undefined,
                cursor: a.cursor as string | undefined,
              });
              break;
            case "quote_realtime":
              data = await handleGetQuoteRealtime(client, {
                rfqId: a.rfqId as string | undefined,
                quoteId: a.quoteId as string | undefined,
                quoteLinkId: a.quoteLinkId as string | undefined,
                traderType: a.traderType as RfqQuoteTraderType | undefined,
              });
              break;
            case "trade_list":
              data = await handleGetRfqTradeList(client, {
                rfqId: a.rfqId as string | undefined,
                rfqLinkId: a.rfqLinkId as string | undefined,
                quoteId: a.quoteId as string | undefined,
                quoteLinkId: a.quoteLinkId as string | undefined,
                status: a.status as RfqTradeStatus | undefined,
                limit: a.limit as number | undefined,
                cursor: a.cursor as string | undefined,
              });
              break;
            default:
              throw new Error(`Unknown rfq_query action: ${action}`);
          }
          result = { ...(data as object), serverTimestamp: new Date().toISOString() };
          break;
        }

        case "check_rfq_eligibility": {
          if (!ENABLE_RFQ) throw new Error("RFQ module not enabled");
          const data = await checkRfqEligibility(
            client,
            a.notionalUsd as number | undefined
          );
          result = { ...data, serverTimestamp: new Date().toISOString() };
          break;
        }

        case "assess_combo_risk": {
          if (!ENABLE_RFQ) throw new Error("RFQ module not enabled");
          const data = assessComboRisk({
            legs: a.legs as RiskLeg[],
            currentSpot: a.currentSpot as number | undefined,
          });
          result = { ...data, serverTimestamp: new Date().toISOString() };
          break;
        }

        case "create_rfq": {
          if (!ENABLE_RFQ) throw new Error("RFQ module not enabled");
          result = await handleCreateRfq(client, {
            counterparties: a.counterparties as string[],
            list: a.list as CreateRfqLeg[],
            rfqLinkId: a.rfqLinkId as string | undefined,
            anonymous: a.anonymous as boolean | undefined,
            strategyType: a.strategyType as string | undefined,
            estimatedNotionalUsd: a.estimatedNotionalUsd as number | undefined,
            dry_run: assertBooleanFlag(a.dry_run, "dry_run", "create_rfq"),
            confirm: a.confirm as string | undefined,
          });
          break;
        }

        case "execute_quote": {
          if (!ENABLE_RFQ) throw new Error("RFQ module not enabled");
          result = await handleExecuteQuote(client, {
            rfqId: a.rfqId as string,
            quoteId: a.quoteId as string,
            quoteSide: assertOneOf(a.quoteSide, ["buy", "sell"] as const, "quoteSide", "execute_quote") as RfqSide,
            dry_run: assertBooleanFlag(a.dry_run, "dry_run", "execute_quote"),
            confirm: a.confirm as string | undefined,
          });
          break;
        }

        case "cancel_rfq": {
          if (!ENABLE_RFQ) throw new Error("RFQ module not enabled");
          result = await handleCancelRfq(client, {
            rfqId: a.rfqId as string | undefined,
            rfqLinkId: a.rfqLinkId as string | undefined,
          });
          break;
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      // Round only non-integer floats: integers include ms-epoch timestamps, which sigFig(8) would corrupt.
      const text = JSON.stringify(result, (_k, v) =>
        typeof v === "number" && !Number.isInteger(v) ? sigFig(v) : v);
      return { content: [{ type: "text" as const, text }] };
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
  return createServer("sandbox-key", "sandbox-secret", true, true);
}

if (require.main === module) {
  const apiKey = process.env.BYBIT_API_KEY;
  const apiSecret = process.env.BYBIT_API_SECRET;
  if (!apiKey || !apiSecret) {
    console.error("BYBIT_API_KEY and BYBIT_API_SECRET environment variables are required");
    process.exit(1);
  }
  const enableOptions = isEnvEnabled(process.env.ENABLE_OPTIONS);
  const enableRfq = isEnvEnabled(process.env.ENABLE_RFQ);
  const server = createServer(apiKey, apiSecret, enableOptions, enableRfq);

  async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    const isTestnet = resolveBaseUrl(process.env.BYBIT_TESTNET) === TESTNET_URL;
    if (isTestnet) {
      console.error("[bybit-quant] Connecting to Bybit TESTNET (api-testnet.bybit.com)");
    } else {
      console.error("[bybit-quant] ⚠ Connecting to Bybit MAINNET (api.bybit.com) — real funds at risk");
    }
  }

  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
