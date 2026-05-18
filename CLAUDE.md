# Bybit Quant MCP Server

Bybit V5 trading + analytics MCP server (stdio). TypeScript, 14 tools.
User-facing docs live in README.md — keep this file for working-on-the-code context.

## Commands

```bash
npm run build      # tsc + chmod +x dist/index.js (required: bin must be executable)
npm run dev        # tsc --watch
npm test           # jest (235 cases, 20 suites) — must stay green before publish
npm test -- trade  # run a single suite by path fragment
npm start          # node dist/index.js (needs prior build)
```

`prepublishOnly` runs build + test, so a failing test blocks `npm publish`.

## Architecture

- `src/index.ts` — MCP server: tool registry, request routing, env bootstrap (large; ~entry point).
- `src/client.ts` / `src/auth.ts` — Bybit V5 signed REST client + HMAC auth.
- `src/tools/*.ts` — always-on tools (account, market, orders, trade-spot, trade-perp).
- `src/tools/options/*.ts` — options tools, gated behind `ENABLE_OPTIONS=true`.
- `src/__tests__/` mirrors `src/` 1:1 — every tool file has a matching test file.

Tools are conditionally spread into the registry, e.g. `...(ENABLE_OPTIONS ? [...] : [])`
in `src/index.ts`. Options handlers also guard on `ivStore` / `ENABLE_OPTIONS` at call time.

## Conventions

- **Immutable data** — never mutate inputs; return new objects.
- **No `console.log`** — stdout is the MCP transport; logging to it corrupts the protocol.
- New tool = tool file + test file + registry wiring in `src/index.ts` + README table row + `.env.example` if it adds an env var.
- Boolean env vars use strict `=== "true"` coercion; `BYBIT_TESTNET` uses inverse `!== "false"`.

## Safety Rails (do not weaken without explicit instruction)

- Execution tools (`place_trade`, `close_position`, `manage_position`, `place_option_trade`, `close_option_position`) require explicit `CONFIRM` and support `dry_run=true`.
- `cancel_order` and SL/TP-cancel are also confirmation-gated.
- Naked short options blocked unless `OPTIONS_ALLOW_NAKED_SHORT=true` or an offsetting long exists (catches partial naked shorts) — `src/tools/options/trade.ts`.

## Environment

- `BYBIT_API_KEY`, `BYBIT_API_SECRET` — required.
- `BYBIT_TESTNET` — **defaults to testnet (true)**; only `BYBIT_TESTNET=false` hits mainnet. (README env table says default `false` — that table is wrong; trust the code.)
- `ENABLE_OPTIONS`, `OPTIONS_ALLOW_NAKED_SHORT`, `OPTIONS_MAX_PREMIUM_PCT_BALANCE` — see `.env.example`.
