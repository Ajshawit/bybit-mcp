# Bybit MCP Server

**Bybit V5 trading for Claude Desktop, Claude Code, and Cursor.** Linear and inverse perpetuals, spot, and options with Greeks, IV scanning, market regime detection, OI divergence scanning, and confirmation-based safety rails.

[![npm version](https://img.shields.io/npm/v/ajs-bybit-mcp.svg?color=blue)](https://www.npmjs.com/package/ajs-bybit-mcp)
[![npm downloads](https://img.shields.io/npm/dm/ajs-bybit-mcp.svg)](https://www.npmjs.com/package/ajs-bybit-mcp)
[![smithery badge](https://smithery.ai/badge/ajs-bybit-mcp)](https://smithery.ai/server/ajs-bybit-mcp)
[![tests](https://img.shields.io/badge/tests-196%20passing-brightgreen)](./src)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **This MCP allows AI models to execute real trades with real money on Bybit. Models make mistakes. Markets move fast. You are the only safeguard between a bad model decision and your account. Use a testnet API key until you understand exactly what every tool does.**

---

## Why this one

There are several Bybit MCPs. Most are thin V5 REST wrappers with one tool per endpoint, no analytics, and no options support. This one is built for traders making actual decisions, not just querying the API.

| | `ajs-bybit-mcp` (this repo) | Typical Bybit MCP |
|---|---|---|
| **Options trading** | Full stack: chains, Greeks, IV scanning, skew and term structure, payoff math, safe place/close | Not supported |
| **Market analytics** | Regime detection (risk_on / risk_off / choppy), OI divergence scan, crowded positioning scan, volume spike scan | Individual endpoint queries |
| **Account view** | Single `get_account_status` call: balance, margin in use, unrealised PnL, and all positions across perps, spot, and options | Multiple calls for wallet, positions, orders |
| **Consolidated market data** | `get_market_data` returns price, funding, OI, klines, and top-20 orderbook in one call | One endpoint per data type |
| **Execution safety** | `CONFIRM` required on every execution tool + `dry_run` preview on every order | None beyond testnet default |
| **Options safety** | Naked short blocked by default, partial-short detection, premium % of balance guard | N/A |
| **Test coverage** | 196 tests across 19 suites | Usually unstated |
| **Scope** | Trading decisions | Bybit V5 CRUD |

If you want "what's the price of BTC" and a place-order endpoint, the other Bybit MCPs will do fine. If you want a toolkit for real trading workflow — regime views, positioning scans, options flow, safe execution — use this one.

---

## Scope

Bybit V5 API for AI agents, with confirmation-based safety rails. Exposes Bybit's trading functionality cleanly to any MCP-compatible model (Claude Desktop, Claude Code, Cursor, or any client that speaks MCP over stdio).

**This is not** a trading bot, strategy framework, backtesting tool, or multi-exchange aggregator. If you want different behaviour, fork it.

---

## Tools

### Account & Market

| Tool | Description |
|------|-------------|
| `get_account_status` | Balance, free capital, margin in use, unrealised PnL, and all open positions (perps, spot, options) |
| `get_market_data` | Price, funding rate, open interest, klines, and top-20 orderbook for a single linear perp |
| `get_market_regime` | BTC trend + aggregate funding sentiment across top-20 perps - returns `risk_on` / `risk_off` / `choppy` |
| `scan_market` | Scan all linear perps for OI divergence, crowded positioning, or volume spikes |
| `get_ohlc` | Raw OHLC candles for any symbol and category |

### Perpetuals & Spot Execution

| Tool | Description |
|------|-------------|
| `place_trade` | Place a market or limit order on a linear perp, inverse perp, or spot market |
| `close_position` | Close an open position fully or partially |
| `manage_position` | Update SL, TP, or trailing stop on an open perp position |

### Options (requires `ENABLE_OPTIONS=true`)

| Tool | Description |
|------|-------------|
| `options_market` | Consolidated options data: browse chains, get single-contract quotes with Greeks, scan for IV anomalies, and view regime signals (ATM IV, skew, term structure). Use the `action` parameter to select mode: `chain`, `quote`, `scan`, or `regime`. |
| `get_option_payoff` | Compute expiry payoff for one or more legs - max loss, max profit, breakevens. Pure math, no API call. |
| `place_option_trade` | Place a single-leg option order with dry-run support and safety guards |
| `close_option_position` | Close an open option position fully or partially |

Option premium is charged in USDC. USDT is not used for options settlement. Ensure you have USDC balance before placing option trades.

---

## Setup

### 1. Get Bybit API keys

Create an API key at [Bybit API Management](https://www.bybit.com/app/user/api-management).

**Required permissions**: Read + Trade.
**Never enable**: Withdrawal or Transfer. This MCP does not need them, and enabling them creates unnecessary risk.
**Recommended for first use**: Read-only. This lets you explore all data tools (`get_market_data`, `scan_market`, `get_ohlc`, `options_market`, etc.) without execution risk. Add Trade permissions when you're ready.

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
    "bybit": {
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
| `BYBIT_TESTNET` | No | `false` | Use Bybit testnet API (`testnet.bybit.com`). **Recommended for first-time setup.** |
| `ENABLE_OPTIONS` | No | `false` | Enable the 4 options tools |
| `OPTIONS_ALLOW_NAKED_SHORT` | No | `false` | Allow selling options without an offsetting long position. Naked short options carry unlimited or very large maximum loss. |
| `OPTIONS_MAX_PREMIUM_PCT_BALANCE` | No | none | Block option buys where premium exceeds N% of USDC balance |

---

## Safety

All execution tools (`place_trade`, `close_position`, `manage_position`, `place_option_trade`, `close_option_position`) require explicit `CONFIRM` from the user before submitting an order. Each supports `dry_run=true` to preview the order without placing it.

Option short selling is blocked by default unless `OPTIONS_ALLOW_NAKED_SHORT=true` is set or an offsetting long position exists. The naked short guard also catches partial naked shorts (e.g. selling 2 contracts when only 1 long exists).

---

## Example Conversation

```
You:   What's the market looking like?

Claude: [calls get_market_regime]
        Intraday regime is risk_off. BTC is below both SMAs at $75,190,
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

The model presents a plan, waits for CONFIRM, verifies via dry run, then submits. This flow applies to all execution tools.

---

## Development

```bash
npm test            # run all tests
npm run test:watch  # watch mode
npm run dev         # auto-rebuild on file changes (TypeScript watch)
npm run build       # compile to dist/
```

Tests: 388 passing across 38 suites.

---

## License

MIT

---

## Disclaimer

This software is provided as-is under the MIT License. It is not financial advice. The authors are not responsible for any trades executed through this tool. You are solely responsible for your own trading decisions and any resulting financial outcomes. Use at your own risk.