# bybit-mcp

A Model Context Protocol (MCP) server that connects Claude Desktop to the Bybit V5 REST API. Trade linear/inverse perps, spot, and options directly from Claude conversations.

---

## Tools

### Account & Market

| Tool | Description |
|------|-------------|
| `get_account_status` | Balance, free capital, margin in use, unrealised PnL, and all open positions (perps, spot, options) |
| `get_market_data` | Price, funding rate, open interest, klines, and top-20 orderbook for a single linear perp |
| `get_market_regime` | BTC trend + aggregate funding sentiment across top-20 perps — returns `risk_on` / `risk_off` / `choppy` |
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
| `get_option_chain` | Browse contracts for BTC, ETH, or SOL — filter by expiry, type, OI, and strike range |
| `get_option_quote` | Full pricing and Greeks for a single contract; optional local Black-Scholes verification |
| `get_option_payoff` | Compute expiry payoff for one or more legs — max loss, max profit, breakevens |
| `scan_options` | Scan for high/low IV outliers across the option surface |
| `get_options_regime` | ATM IV, IV percentile, put/call skew, and term structure for BTC/ETH/SOL |
| `place_option_trade` | Place a single-leg option order with dry-run support and safety guards |
| `close_option_position` | Close an open option position fully or partially |

---

## Setup

### 1. Install & build

```bash
git clone https://github.com/Ajshawit/bybit-mcp.git
cd bybit-mcp
npm install
npm run build
```

### 2. Configure Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "bybit": {
      "command": "node",
      "args": ["/absolute/path/to/bybit-mcp/dist/index.js"],
      "env": {
        "BYBIT_API_KEY": "your_api_key",
        "BYBIT_API_SECRET": "your_api_secret"
      }
    }
  }
}
```

Restart Claude Desktop after saving.

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BYBIT_API_KEY` | Yes | — | Bybit V5 API key |
| `BYBIT_API_SECRET` | Yes | — | Bybit V5 API secret |
| `ENABLE_OPTIONS` | No | `false` | Enable the 7 options tools |
| `OPTIONS_ALLOW_NAKED_SHORT` | No | `false` | Allow selling options without an offsetting long |
| `OPTIONS_MAX_PREMIUM_PCT_BALANCE` | No | none | Block option buys where premium exceeds N% of USDC balance |

---

## Safety

All execution tools (`place_trade`, `close_position`, `manage_position`, `place_option_trade`, `close_option_position`) require explicit `CONFIRM` from the user before submitting an order. Each supports `dry_run=true` to preview the order without placing it.

Option short selling is blocked by default unless `OPTIONS_ALLOW_NAKED_SHORT=true` is set or an offsetting long position exists. Option premium is charged in USDC — USDT is not used.

---

## Development

```bash
npm test          # run all tests
npm run test:watch  # watch mode
npm run dev       # TypeScript watch (recompiles on save)
npm run build     # compile to dist/
```

Tests: 388 passing across 38 suites.
