# Bybit Quant MCP Server

**Bybit V5 trading and market analytics for Claude Desktop, Claude Code, and Cursor.** Linear and inverse perpetuals, spot, options (Greeks, IV scanning), and TradFi (xStocks, stock & commodity perps) — with portfolio-level risk and scenario stress testing, realized-vol and carry analytics, pre-trade execution cost estimates, market regime detection, OI divergence scanning, post-trade journaling, and confirmation-based safety rails.

[![npm version](https://img.shields.io/npm/v/ajs-bybit-mcp.svg?color=blue)](https://www.npmjs.com/package/ajs-bybit-mcp)
[![npm downloads](https://img.shields.io/npm/dm/ajs-bybit-mcp.svg)](https://www.npmjs.com/package/ajs-bybit-mcp)
[![smithery badge](https://smithery.ai/badge/ajs-bybit-mcp)](https://smithery.ai/server/ajs-bybit-mcp)
[![tests](https://img.shields.io/badge/tests-585%20passing-brightgreen)](./src)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **This MCP allows AI models to execute real trades with real money on Bybit. Models make mistakes. Markets move fast. You are the only safeguard between a bad model decision and your account. Use a testnet API key until you understand exactly what every tool does.**

---

## Why this one

There are several Bybit MCPs. Most are thin V5 REST wrappers with one tool per endpoint, no analytics, no options, and no TradFi support. This one is built for traders making actual decisions, not just querying the API.

| | `ajs-bybit-mcp` (this repo) | Typical Bybit MCP |
|---|---|---|
| **Options trading** | Full stack: chains, Greeks, IV scanning, skew and term structure, payoff math, safe place/close | Not supported |
| **Multi-leg / block trades** 🚧 | RFQ taker flow: eligibility pre-flight, combo-risk gate, dry-run default — **live submit coming soon** (kill-switched until endpoint paths are live-verified) | Not supported |
| **TradFi** | xStocks (tokenized equities), stock perps, commodity perps, with NYSE-hours awareness | Not supported |
| **Market analytics** | Regime detection (risk_on / risk_off / choppy), OI divergence scan, crowded positioning scan, volume spike scan | Individual endpoint queries |
| **Quant analytics** | Portfolio Greeks aggregation + spot×IV scenario stress grid, realized-vol estimators + vol cone + IV−RV spread, basis & funding-carry analytics with predicted funding, pre-trade slippage/fee estimates from 500-level books, event calendar (funding/expiries/deliveries) | Not supported |
| **Account view** | Single `get_account_status` call: balance, margin in use, unrealised PnL, and all positions across perps, spot, options | Multiple calls for wallet, positions, orders |
| **Consolidated market data** | `get_market_data` returns price, funding, OI, and top-20 orderbook in one call (klines opt-in via `includeKlines`) | One endpoint per data type |
| **Post-trade review** | `get_closed_trades` returns realised PnL, fees-net PnL, hold duration, leverage used | None |
| **Execution safety** | Schema-validated `confirm: "CONFIRM"` required on every execution tool + `dry_run` preview on every order | None beyond testnet default |
| **Options safety** | Naked short blocked by default, partial-short detection, premium % of balance guard | N/A |
| **Token efficiency** | Compact responses by default: orderbook 5-field summary instead of 20-level arrays, summary-only OHLC (candles opt-in), compact option chains, significant-figure numerics, klines off unless requested | Full arrays, raw floats |
| **Test coverage** | 585 tests across 35 suites | Usually unstated |
| **Scope** | Trading decisions | Bybit V5 CRUD |

If you want "what's the price of BTC" and a place-order endpoint, the other Bybit MCPs will do fine. If you want a toolkit for real trading workflow — regime views, positioning scans, options flow, TradFi, safe execution, post-trade journaling — use this one.

---

## Scope

Bybit V5 API for AI agents, with confirmation-based safety rails. Exposes Bybit's trading functionality cleanly to any MCP-compatible model (Claude Desktop, Claude Code, Cursor, or any client that speaks MCP over stdio).

**This is not** a trading bot, strategy framework, backtesting tool, or multi-exchange aggregator. If you want different behaviour, fork it.

---

## Tools

30 tools total: 20 always available, plus 4 options tools gated behind `ENABLE_OPTIONS=true` and 6 RFQ block-trade tools gated behind `ENABLE_RFQ=true`.

### Account & Market Data

| Tool | Description |
|------|-------------|
| `get_account_status` | Balance, free capital, margin in use, unrealised PnL, and all open positions in one call. Returns `positions` (linear USDT perps), `inverse_positions` (coin-margined perps), `spot_holdings` (non-USDT spot incl. xStock tokens), and — when options are enabled — `option_positions` (with Greeks, premiumFlow, daysToExpiry, breakeven). Includes `accountInfo` (UID + account type) so you can confirm which sub-account the key targets. |
| `get_market_data` | One call for price, mark price, spread, orderbook, funding rate + history, and open interest. `category=linear` (default) for crypto/stock/commodity perps; `category=spot` for xStock tokens — which return price, orderbook and **NYSE market-hours status** instead of funding/OI. Orderbook is a 5-field summary by default; `includeOrderbook=true` returns full 20-level depth. Klines are returned only when `includeKlines=true` (default false) — use `get_ohlc` for candle history. |
| `get_ohlc` | OHLC for any symbol and category (`linear` / `inverse` / `spot`). Returns a summary by default (`lastPrice`, `count`, `periodHigh`, `periodLow`); set `includeCandles=true` for the series — `candleFormat=tuples` (default) gives compact `[t,o,h,l,c,v]` arrays, `objects` gives named fields. Newest-first, intervals 1m → 1M, up to 1000 candles. For swing levels, stop placement, and blue-chip context. Returns `count:0` with candles omitted (not an error) when Bybit has no data for the range. |

### Market Analytics

| Tool | Description |
|------|-------------|
| `get_market_regime` | BTC trend (SMA20/SMA50) + aggregate funding sentiment across the top-20 linear perps by volume. Returns a synthesised label — `risk_on` / `risk_off` / `choppy` — plus raw signals. `timeframe`: `intraday`, `swing` (default, 4h, ~1–2 week horizon), or `macro` (daily, ~2–3 month horizon). |
| `scan_market` | Scan **all** linear perps for one condition: `oi_divergence` (price/OI divergence), `crowded_positioning` (extreme funding + tight range, now with a **funding z-score** vs the trailing ~200-epoch history), `volume_spike` (unusual hourly volume), or `account_ratio` (**retail crowding** — long/short account ratio ≥ 2 or ≤ 0.5, with the 24h-ago ratio and funding z-score; contrarian when crowding and funding stretch together). Returns raw numbers and machine-readable tags. Filterable by `minVolume24hUsd` and `limit`. |

### Quant Analytics

| Tool | Description |
|------|-------------|
| `get_portfolio_risk` | Portfolio-level risk in one call: net delta (USD) per underlying across linear perps, inverse perps, and options; aggregated gamma / vega / theta; gross notional, leverage ratio, concentration. Then a **scenario stress grid** — spot shocks (default ±5/10/20%) × IV shocks (default ±10 pts) with options repriced via Black-Scholes — including the worst-case cell. Answers "what does a −20% gap do to the account?" |
| `get_volatility` | Realized-volatility toolkit for any symbol: three annualized estimators (close-to-close, Parkinson, Yang-Zhang) over a recent window, plus a **vol cone** (current RV vs its own min/p25/median/p75/max across 1d–30d horizons). With options enabled on BTC/ETH/SOL/XAUT/XRP/MNT/DOGE it adds ATM IV from the matching expiry and the **IV−RV spread** — the variance-risk-premium signal for vol buy/sell decisions. |
| `get_carry_analytics` | Basis & funding carry. `action=basis`: mark-vs-index basis, current + realized funding annualized, **predicted next funding** from the premium index (Bybit's formula), perp-vs-spot basis, dated-futures annualized basis. `action=scan`: every liquid perp ranked by annualized carry — who pays shorts, who pays longs — using each symbol's real funding interval. |
| `estimate_execution_cost` | Pre-trade cost from deep books (500 levels perps / 200 spot): expected average fill, slippage vs mid (bps), book imbalance, your account's actual taker/maker fees, **all-in cost** (slippage + fees), and the max size executable within a slippage budget. Warns when an order would sweep the whole visible book. |
| `get_event_calendar` | Upcoming events: next funding time + rate per symbol (defaults to your open positions), option expiry schedule with OI notional by date, dated-futures deliveries, and NYSE session status for TradFi symbols. |
| `analyze_pair` | Pairs / stat-arb toolkit: any symbol vs a benchmark (default BTC) on aligned klines — log-return **correlation** (full + recent window), **beta / hedge ratio** (incl. benchmark notional per $1k of symbol), pair **log-spread z-score** with `spread_rich` / `spread_cheap` tags at \|z\| ≥ 2, and an AR(1) **mean-reversion half-life** (null when the spread trends). For hedge sizing, alt/BTC divergence, and pair-trade timing. |
| `calculate_position_size` | Turn a risk budget into an order quantity — advisory math only, no order placed. `method=risk_per_trade`: qty whose loss at your stop equals `riskUsd` (or `riskPctEquity`, default 1%). `method=kelly`: fractional Kelly (default 0.25×) from explicit win/loss stats or recent closed trades. `method=vol_target`: size so the position contributes a target annualized vol on equity. Output is floored to the instrument qty step and includes notional, margin at your leverage, and a **liquidation-distance check** — estimated liq price vs your stop plus the max leverage that keeps liquidation safely beyond it. |

### Perpetuals & Spot Execution

| Tool | Description |
|------|-------------|
| `place_trade` | Place a market, limit, or conditional/stop order on a linear perp, inverse perp, spot, or spot-margin market. Pass `triggerPrice` (plus optional `triggerBy` / `triggerDirection`) to create a stop-market or stop-limit entry — `triggerDirection` is auto-derived from `triggerPrice` vs current price if omitted. `margin` is USDT for linear/spot, **base coin** (e.g. BTC) for inverse. Perps require `leverage` + `sl`; spot does not support `sl`. Supports `tp`, `trailingStop`, `trailingActivatePrice`, `notes`, and `dry_run`. |
| `close_position` | Close an open position fully (`percent`) or partially, or by explicit `qty`. Defaults to `orderType: "Market"`; pass `orderType: "Limit"` + `price` for perp/inverse to layer reduce-only take-profit ladders (the order stays `reduceOnly: true` and cannot accidentally open a new position). Works for linear, inverse, spot, spot-margin — spot is Market-only. For spot, sells from total wallet balance for the base coin. |
| `manage_position` | Update SL, TP, or trailing stop on an open perp position (linear or inverse — not spot). Pass `0` to cancel an existing SL/TP (destructive — confirm explicitly). |

### Orders & Post-Trade Review

| Tool | Description |
|------|-------------|
| `list_open_orders` | List all resting (unfilled) orders with entry price, size, SL, TP, trailing stop, activation price, fill status, and `orderId`. Optional `symbol` filter; `category` covers linear/inverse/spot/spot_margin/option. |
| `cancel_order` | Cancel one resting order by `orderId` (look it up via `list_open_orders`). Non-destructive to other orders. |
| `get_closed_trades` | Realised P&L for recently closed perp positions (linear or inverse): avg entry/exit, `closedPnl`, fees-net P&L, leverage used, hold duration (seconds), and `pnlPct`. For post-trade journaling without reconstructing from account deltas. Bybit retains ~7 days; narrow with `startTime`/`endTime` (ms epoch). |
| `get_performance_stats` | Closed-trade performance analytics over up to 180 days (chunks Bybit's 7-day closed-PnL windows automatically, cap 1000 trades): win rate, profit factor, expectancy, payoff ratio, largest win/loss, **annualized Sharpe & Sortino** on daily USD PnL (scale-dependent — not comparable to return-based ratios), **max drawdown** on the cumulative PnL curve, per-symbol attribution, long-vs-short breakdown, and hold-time stats. The stats source for `calculate_position_size` `method=kelly`. |

### TradFi Discovery

| Tool | Description |
|------|-------------|
| `list_tradfi_instruments` | Discover Bybit's TradFi instruments: **xStocks** (tokenized equities, e.g. `TSLAXUSDT` — trade with `category=spot`), **stock perpetuals** (e.g. `TSLAPUSDT` — `category=linear`), and **commodity perpetuals** (e.g. `XAUUSDT` gold, `XAGUSDT` silver, `CLUSDT` crude — `category=linear`). Filter by `type` (`xstocks` / `stock_perps` / `commodity_perps` / `all`) and `search` substring. Returns `tickSize`, `minOrderQty`, `maxLeverage`. Call this before the first TradFi trade in a session to confirm exact symbols. |

> **TradFi data caveat:** Bybit's stock/commodity perps and xStocks trade around the clock, but the underlying equity only moves during NYSE hours (09:30–16:00 ET, Mon–Fri). Use `get_market_data` with `category=spot` on an xStock symbol for real-time NYSE session status. Volume, funding, and OI for **all** TradFi instruments reflect Bybit's market only — not real NYSE/CME flow. Responses include a `dataNote` field repeating this.

### Options (requires `ENABLE_OPTIONS=true`)

Underlyings: **BTC, ETH, SOL, XAUT (Tether Gold), XRP, MNT, DOGE** — all USDT-settled and USDT-quoted. `quote` and `place_option_trade` accept any full Bybit option symbol (e.g. `XAUT-31JUL26-3950-P-USDT`), so every listed contract is reachable.

| Tool | Description |
|------|-------------|
| `options_market` | Consolidated options data for BTC, ETH, SOL, XAUT, XRP, MNT, DOGE. Select mode via `action`: **`chain`** (browse contracts, filterable by expiry/type/OI/strike range; returns minimal fields by default — pass `compact:false` for the full set incl. moneyness/mark/lastPrice/volume24h), **`quote`** (full pricing + Greeks for one symbol, opt-in local Black-Scholes verification via `computeGreeksLocal:true`), **`scan`** (IV anomalies — `high_iv`/`low_iv` need ~24h warmup — plus `skew`, `high_oi_change`), **`regime`** (ATM IV, IV percentile, put/call skew, term structure per underlying). |
| `get_option_payoff` | Compute expiry payoff for one or more legs — PnL at each price point, max loss, max profit, breakeven(s). Pure math, no API call. Use before placing to verify risk/reward. |
| `place_option_trade` | Place a single-leg option order (BTC, ETH, SOL, XAUT, XRP, MNT, DOGE) with `dry_run` support and naked-short guards. |
| `close_option_position` | Close an open option position fully or partially, with `dry_run` P&L preview. |

All option symbols this server trades are **USDT-settled** (`-USDT` suffix) — premium is charged in USDT. Ensure USDT balance before placing option trades.

### RFQ / Block Trades (requires `ENABLE_RFQ=true`)

> 🚧 **Coming soon** — live RFQ block-trade submission is not yet enabled. The tools ship today as **read-only queries and dry-run previews**; live submit stays kill-switched (`RFQ_ENABLE_WRITES=false`) until the endpoint paths are verified against a live RFQ-eligible account.

Multi-leg / block-trade support, taker side, for negotiated combos (options + linear + spot, up to 25 legs). **Read-only and dry-run by default** — see the safety note below.

| Tool | Description |
|------|-------------|
| `rfq_query` | Read-only RFQ queries: `rfq_list` / `rfq_realtime` (your RFQs), `quote_list` / `quote_realtime` (LP quotes — the poll path while waiting for makers), `trade_list` (executed RFQ trades). Account-scoped; places no orders. |
| `check_rfq_eligibility` | Pre-flight: calls `/v5/account/info` and reports whether the account meets RFQ hard requirements — UTA 2.0 + `PORTFOLIO_MARGIN` + (if a notional is supplied) the 10,000 USD per-RFQ minimum. Returns `{ eligible, reasons[], accountInfo }`. |
| `assess_combo_risk` | Pure-math combo risk. Models max loss only when every leg is an option; any linear/spot, missing-spot, unpriced, or mixed-underlying leg → `modeled:false`, treated as uncovered. Max loss is **exact** (analytic kinks + tail slopes — naked short puts and far-OTM strikes are caught); `maxLossUsd` is `null` when the loss is unbounded rather than a fake number. |
| `create_rfq` | Create a 1–25-leg RFQ. `dry_run` defaults true; runs eligibility + combo-risk pre-flights. Live submission also requires `RFQ_ENABLE_WRITES=true`. |
| `execute_quote` | Execute an LP quote against an RFQ — **irreversible, fills asynchronously**. `dry_run` (default) fetches and shows the live quote's legs/prices so confirmation is informed. Live requires `RFQ_ENABLE_WRITES=true`. |
| `cancel_rfq` | Cancel an open RFQ you created (by `rfqId` or `rfqLinkId`). Risk-reducing — intentionally not behind the write kill-switch. |

RFQ requires a **UTA 2.0 account in portfolio/combined margin mode** with a **10,000 USD minimum notional per RFQ**; it cannot be used on classic or demo accounts. RFQ endpoint paths are verified against the maintained typed client but **not yet live-verified** — `RFQ_ENABLE_WRITES` stays `false` until you confirm them against a live RFQ-eligible account. Until then every write path is dry-run only.

---

## Setup

### 1. Get Bybit API keys

Create an API key at [Bybit API Management](https://www.bybit.com/app/user/api-management).

**Required permissions**: Read + Trade.
**Never enable**: Withdrawal or Transfer. This MCP does not need them, and enabling them creates unnecessary risk.
**Recommended for first use**: Read-only. This lets you explore all data tools (`get_market_data`, `scan_market`, `get_ohlc`, `list_tradfi_instruments`, `options_market`, etc.) without execution risk. Add Trade permissions when you're ready.

For testnet keys, use [Bybit Testnet](https://testnet.bybit.com/app/user/api-management).

### 2. Configure Claude Desktop

Add to your Claude Desktop config file:

| Platform | Config path |
|----------|-------------|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

```json
{
  "mcpServers": {
    "bybit-quant": {
      "command": "npx",
      "args": ["-y", "ajs-bybit-mcp"],
      "env": {
        "BYBIT_API_KEY": "your_api_key",
        "BYBIT_API_SECRET": "your_api_secret",
        "BYBIT_TESTNET": "true"
      }
    }
  }
}
```

Start with `BYBIT_TESTNET=true`. Remove it or set to `false` only after you are comfortable with how the tools behave.

To use the options tools, add `"ENABLE_OPTIONS": "true"` to `env`.

To use the RFQ block-trade tools, add `"ENABLE_RFQ": "true"`. They are read-only / dry-run until you also set `"RFQ_ENABLE_WRITES": "true"` — keep that off until RFQ endpoint paths are confirmed against a live RFQ-eligible account.

Restart Claude Desktop after saving.

### Install from source (contributors)

```bash
git clone https://github.com/Ajshawit/bybit-mcp.git
cd bybit-mcp
npm install
npm run build
```

Then use `node /absolute/path/to/bybit-mcp/dist/index.js` instead of `npx ajs-bybit-mcp` in the config above.

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BYBIT_API_KEY` | Yes | - | Bybit V5 API key |
| `BYBIT_API_SECRET` | Yes | - | Bybit V5 API secret |
| `BYBIT_TESTNET` | No | `true` | Use Bybit testnet API (`api-testnet.bybit.com`). Defaults to testnet; set `BYBIT_TESTNET=false` to trade on mainnet. **Keep the default for first-time setup.** |
| `BYBIT_MCP_DATA_DIR` | No | `~/.bybit-mcp` | Directory for persisted analytics history (currently IV percentile samples, so the ~24h warmup survives restarts). A leading `~/` is expanded. |
| `BYBIT_MCP_PERSIST` | No | `true` | Set to exactly `false` to disable analytics persistence (in-memory only, resets every session). |
| `ENABLE_OPTIONS` | No | `false` | Enable the 4 options tools (`options_market`, `get_option_payoff`, `place_option_trade`, `close_option_position`) |
| `OPTIONS_ALLOW_NAKED_SHORT` | No | `false` | Allow selling options without an offsetting long position. Naked short options carry unlimited or very large maximum loss. **Also overrides the RFQ uncovered-combo gate** (legacy coupling — prefer `RFQ_ALLOW_UNCOVERED` for RFQ-only). |
| `OPTIONS_MAX_PREMIUM_PCT_BALANCE` | No | none | Block option buys where premium exceeds N% of USDT balance. Malformed values are rejected at call time (fail-closed). |
| `ENABLE_RFQ` | No | `false` | Enable the 6 RFQ block-trade tools (`rfq_query`, `check_rfq_eligibility`, `assess_combo_risk`, `create_rfq`, `execute_quote`, `cancel_rfq`) |
| `RFQ_ENABLE_WRITES` | No | `false` | Kill-switch for live RFQ submission. While `false`, `create_rfq`/`execute_quote` are dry-run only even with `dry_run=false`. Keep off until RFQ endpoint paths are confirmed against a live RFQ-eligible account. `cancel_rfq` is not gated by this. |
| `RFQ_ALLOW_UNCOVERED` | No | `false` | Allow RFQ combos the risk engine cannot prove are risk-defined (uncovered net-short, or unmodelable mixed/unpriced legs). Off = such combos are blocked. The RFQ-path equivalent of `OPTIONS_ALLOW_NAKED_SHORT`. |

---

## Safety

All execution tools (`place_trade`, `close_position`, `manage_position`, `cancel_order`, `place_option_trade`, `close_option_position`, `create_rfq`, `execute_quote`) require an explicit `confirm: "CONFIRM"` parameter for live submission — schema-validated, exact and case-sensitive. A missing or malformed `confirm` rejects the call before any signed request is sent. Each tool supports `dry_run=true` to preview the order without placing it (and without `confirm`). The `CONFIRM` discipline is therefore enforced at the protocol layer, not just in tool descriptions. RFQ `cancel_rfq` is intentionally exempt (blocking a risk-reducing cancel is the unsafe direction).

Option short selling is blocked by default unless `OPTIONS_ALLOW_NAKED_SHORT=true` is set or an offsetting long position exists. The naked short guard also catches partial naked shorts (e.g. selling 2 contracts when only 1 long exists).

RFQ block-trade writes carry an additional kill-switch. `create_rfq` and `execute_quote` require **all** of: an explicit `dry_run=false`, `RFQ_ENABLE_WRITES=true`, and a passing eligibility + combo-risk pre-flight — and `RFQ_ENABLE_WRITES` stays `false` until RFQ endpoint paths are confirmed against a live RFQ-eligible account. `execute_quote` risk-gates the book the taker would *end up with*: executing the LP's sell side inverts every leg, and the gate sees the inverted structure. `cancel_rfq` is deliberately exempt (blocking a risk-reducing cancel is the unsafe direction). `assess_combo_risk` max-loss is exact for all-option combos; when the loss is unbounded (net short calls) `maxLossUsd` is `null` — never a fake bound. Heads-up: `OPTIONS_ALLOW_NAKED_SHORT=true` also overrides the RFQ uncovered-combo gate (legacy coupling); prefer `RFQ_ALLOW_UNCOVERED` for RFQ-only overrides.

---

## Example Conversation

```
You:   What's the market looking like?

Claude: [calls get_market_regime]
        Swing regime is risk_off. BTC is below both SMAs at $75,190,
        trending bear. Funding sentiment is neutral.

You:   Any short setups?

Claude: [calls scan_market with filter=oi_divergence]
        AAVE showing OI divergence: price -20% in 24h but OI +21% in 4h
        with funding flipping negative. Fresh shorts entering.

You:   Short AAVE.

Claude: Here's the plan:
        - AAVE short, 0.89 contracts @ ~$90.67
        - Margin: $27, leverage: 3x
        - SL: $93, TP: $87
        - R:R: 1.57:1

        Reply CONFIRM to proceed.

You:   CONFIRM

Claude: [calls place_trade with dry_run=true]
        Dry run verified. Estimated fill $90.49, notional $81, margin $27.
        Warning: uses 25% of free balance. wouldSubmit: true.

        [calls place_trade with dry_run=false]
        Filled 0.89 AAVE @ $90.67. Order ID: b53a54b4-...
```

The model presents a plan, waits for the user's `CONFIRM` reply, translates that reply into the schema-validated `confirm: "CONFIRM"` parameter on the tool call, verifies via dry run, then submits. The literal `CONFIRM` string in the chat is what the model passes through as the `confirm` argument — the protocol-layer gate rejects the call if the parameter is missing, lower-cased, or has whitespace. This flow applies to all execution tools.

---

## Development

```bash
npm test            # run all tests
npm run test:watch  # watch mode
npm run dev         # auto-rebuild on file changes (TypeScript watch)
npm run build       # compile to dist/
```

Tests: 585 passing across 35 suites.

---

## Roadmap

All four items of the second-tier quant roadmap shipped in v0.5.0:

- ~~Position sizing calculator~~ → `calculate_position_size` (risk-per-trade, fractional Kelly, vol targeting, liquidation-distance constraint)
- ~~Performance analytics~~ → `get_performance_stats` (win rate, profit factor, expectancy, Sharpe/Sortino, max drawdown, per-symbol attribution)
- ~~Pairs / stat-arb toolkit~~ → `analyze_pair` (correlation, beta/hedge ratio, log-spread z-score, mean-reversion half-life)
- ~~Crowding signals~~ → `scan_market` `account_ratio` filter + funding z-scores on `crowded_positioning`

No further items are currently planned — open an issue if you want something on the list.

---

## License

MIT

---

## Disclaimer

This software is provided as-is under the MIT License. It is not financial advice. The authors are not responsible for any trades executed through this tool. You are solely responsible for your own trading decisions and any resulting financial outcomes. Use at your own risk.
