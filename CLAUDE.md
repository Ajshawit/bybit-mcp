# Bybit Quant MCP Server

Bybit V5 trading + analytics MCP server (stdio). TypeScript, 22 tools (12 always-on, 4 options behind `ENABLE_OPTIONS`, 6 RFQ behind `ENABLE_RFQ`).
User-facing docs live in README.md — keep this file for working-on-the-code context.

## Commands

```bash
npm run build      # tsc + chmod +x dist/index.js (required: bin must be executable)
npm run dev        # tsc --watch
npm test           # jest (287 cases, 24 suites) — must stay green before publish
npm test -- trade  # run a single suite by path fragment
npm start          # node dist/index.js (needs prior build)
```

`prepublishOnly` runs build + test, so a failing test blocks `npm publish`.

## Architecture

- `src/index.ts` — MCP server: tool registry, request routing, env bootstrap (large; ~entry point).
- `src/client.ts` / `src/auth.ts` — Bybit V5 signed REST client + HMAC auth.
- `src/tools/*.ts` — always-on tools (account, market, orders, trade-spot, trade-perp).
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

- Execution tools (`place_trade`, `close_position`, `manage_position`, `place_option_trade`, `close_option_position`) require explicit `CONFIRM` and support `dry_run=true`.
- `cancel_order` and SL/TP-cancel are also confirmation-gated.
- Naked short options blocked unless `OPTIONS_ALLOW_NAKED_SHORT=true` or an offsetting long exists (catches partial naked shorts) — `src/tools/options/trade.ts`.
- RFQ writes (`create_rfq`, `execute_quote`) fail closed: `dry_run` defaults true, live submit needs `RFQ_ENABLE_WRITES=true` (kill-switch, off until endpoint paths are live-verified) + eligibility + combo-risk gate. `cancel_rfq` is exempt (risk-reducing). `assess_combo_risk` maxLoss is ±30%-grid-bounded — trust `uncovered`/`allowed`, not the magnitude — `src/tools/rfq/{trade,risk}.ts`.

## Environment

- `BYBIT_API_KEY`, `BYBIT_API_SECRET` — required.
- `BYBIT_TESTNET` — **defaults to testnet (true)**; only `BYBIT_TESTNET=false` hits mainnet. (README env table now agrees: default `true`.)
- `ENABLE_OPTIONS`, `OPTIONS_ALLOW_NAKED_SHORT`, `OPTIONS_MAX_PREMIUM_PCT_BALANCE` — see `.env.example`.
- `ENABLE_RFQ` — enable the 6 RFQ block-trade tools. `RFQ_ENABLE_WRITES` — kill-switch for live RFQ submission (off until paths live-verified; `cancel_rfq` not gated by it). `RFQ_ALLOW_UNCOVERED` — RFQ-path equivalent of `OPTIONS_ALLOW_NAKED_SHORT`. See `.env.example`.
