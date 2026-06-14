# Bybit Quant MCP Server

Bybit V5 trading + analytics MCP server (stdio). TypeScript, 30 tools (20 always-on, 4 options behind `ENABLE_OPTIONS`, 6 RFQ behind `ENABLE_RFQ`).
User-facing docs live in README.md — keep this file for working-on-the-code context.

## Commands

```bash
npm run build      # tsc + chmod +x dist/index.js (required: bin must be executable)
npm run dev        # tsc --watch
npm test           # jest (585 cases, 35 suites) — must stay green before publish
npm test -- trade  # run a single suite by path fragment
npm start          # node dist/index.js (needs prior build)
```

`prepublishOnly` runs build + test, so a failing test blocks `npm publish`.

## Architecture

- `src/index.ts` — MCP server: tool registry, request routing, env bootstrap (large; ~entry point).
- `src/client.ts` / `src/auth.ts` — Bybit V5 signed REST client + HMAC auth.
- `src/tools/*.ts` — always-on tools (account, market, orders, trade-spot, trade-perp) plus quant analytics (volatility, carry, execution, portfolio, calendar, sizing, performance, pairs — all read-only).
- `src/storage.ts` — JSON-file persistence for rolling analytics samples (IV percentile warmup survives restarts). Fail-open to in-memory; debounced atomic writes; `BYBIT_MCP_DATA_DIR` / `BYBIT_MCP_PERSIST` envs.
- `src/tools/options/*.ts` — options tools, gated behind `ENABLE_OPTIONS=true`.
- `src/tools/rfq/*.ts` — RFQ block-trade tools (query/eligibility/risk/trade), gated behind `ENABLE_RFQ=true`; live writes additionally gated by `RFQ_ENABLE_WRITES`.
- `src/__tests__/` mirrors `src/` 1:1 — every tool file has a matching test file.

Tools are conditionally spread into the registry, e.g. `...(ENABLE_OPTIONS ? [...] : [])` /
`...(ENABLE_RFQ ? [...] : [])` in `src/index.ts`. Options and RFQ cases also guard with an
explicit `if (!ENABLE_*) throw` at call time. RFQ write handlers fail closed: `dry_run`
defaults true and live submit requires `RFQ_ENABLE_WRITES=true` + eligibility + risk gate.

## Conventions

- **Immutable data** — never mutate inputs; return new objects.
- **No `console.log`** — stdout is the MCP transport; logging to it corrupts the protocol.
- New tool = tool file + test file + registry wiring in `src/index.ts` + README table row + `.env.example` if it adds an env var.
- Boolean env vars use strict `=== "true"` coercion; `BYBIT_TESTNET` uses inverse `!== "false"`.

## Safety Rails (do not weaken without explicit instruction)

- Execution tools (`place_trade`, `close_position`, `manage_position`, `place_option_trade`, `close_option_position`) require a schema-validated `confirm: "CONFIRM"` param (exact, case-sensitive) for live submission and support `dry_run=true` (no confirm needed for previews) — `src/tools/confirm.ts`.
- `cancel_order` and SL/TP-cancel are also `confirm`-gated. `close_position`, `manage_position`, and `cancel_order` support `dry_run` previews too (no order/cancel is sent). RFQ `cancel_rfq` is intentionally exempt (risk-reducing).
- Naked short options blocked unless `OPTIONS_ALLOW_NAKED_SHORT=true` or an offsetting long exists (catches partial naked shorts) — `src/tools/options/trade.ts`.
- RFQ writes (`create_rfq`, `execute_quote`) fail closed: `dry_run` defaults true, live submit needs `RFQ_ENABLE_WRITES=true` (kill-switch, off until endpoint paths are live-verified) + eligibility + combo-risk gate (`execute_quote` assesses the book the taker ends up with — leg sides invert when hitting the LP's sell side). `cancel_rfq` is exempt (risk-reducing). `assess_combo_risk` maxLoss is exact for all-option combos (analytic kinks + tail slopes; `maxLossUsd:null` when unbounded, never a fake bound). NOTE: `OPTIONS_ALLOW_NAKED_SHORT=true` also overrides the RFQ uncovered gate (legacy coupling; prefer `RFQ_ALLOW_UNCOVERED`) — `src/tools/rfq/{trade,risk}.ts`.

## Environment

- `BYBIT_API_KEY`, `BYBIT_API_SECRET` — required.
- `BYBIT_TESTNET` — **defaults to testnet (true)**; only `BYBIT_TESTNET=false` hits mainnet. (README env table now agrees: default `true`.)
- `ENABLE_OPTIONS`, `OPTIONS_ALLOW_NAKED_SHORT`, `OPTIONS_MAX_PREMIUM_PCT_BALANCE` — see `.env.example`.
- `ENABLE_RFQ` — enable the 6 RFQ block-trade tools. `RFQ_ENABLE_WRITES` — kill-switch for live RFQ submission (off until paths live-verified; `cancel_rfq` not gated by it). `RFQ_ALLOW_UNCOVERED` — RFQ-path equivalent of `OPTIONS_ALLOW_NAKED_SHORT`. See `.env.example`.
- `BYBIT_MCP_DATA_DIR` (default `~/.bybit-mcp`, `~/` expanded) / `BYBIT_MCP_PERSIST` (inverse coercion: only `"false"` disables) — analytics sample persistence.

## Roadmap

Complete as of v0.5.0 — the second-tier quant features all shipped: `calculate_position_size` (sizing.ts), `get_performance_stats` (performance.ts), `analyze_pair` (pairs.ts), and `scan_market` crowding signals (`account_ratio` filter + funding z-scores in market.ts). No open roadmap items. Note: funding z-scores read Bybit's 200-record funding-history API directly rather than the persistence layer — the API already retains a longer window than persisted samples would accumulate.
