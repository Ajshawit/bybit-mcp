# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] — 2026-05-24

This release closes three tool-surface gaps surfaced from live trading sessions: a soft-enforced CONFIRM gate, no reduce-only limit closes for layered take-profit, and no conditional/trigger orders for breakout entries. **Includes one breaking change** — see Migration below.

### Added

- **Conditional / stop-entry orders on `place_trade`.** New optional parameters `triggerPrice`, `triggerBy` (`LastPrice` / `MarkPrice` / `IndexPrice`, default `LastPrice`), and `triggerDirection` (`1` rises through / `2` falls through). When `triggerPrice` is set the order becomes a stop-market or stop-limit entry that rests until the chosen price feed crosses the level. `triggerDirection` auto-derives from `triggerPrice` vs current market price if omitted, so the common breakout-long / breakdown-short patterns Just Work. Works for linear, inverse, and spot (spot conditionals additionally set `orderFilter=StopOrder`). Trailing stops on conditional orders are rejected (no position to attach to until fill).
- **Reduce-only limit close on `close_position`.** New optional parameters `orderType` (`Market` default / `Limit`) and `price` for perp and inverse. Enables layered take-profit ladders at specific prices. The order is always submitted with `reduceOnly: true`, so a limit close can only shrink the position, never accidentally open a new one. Spot remains Market-only (no `reduceOnly` semantics); a Limit close on spot throws a clear error from the router.
- **Schema-validated `confirm: "CONFIRM"` parameter on every execution tool.** Required for live submission; rejected exact-match and case-sensitive by `src/tools/confirm.ts` before any signed request is sent. Dry-run paths are unaffected — `dry_run=true` still works without `confirm`. The gate fires **before** any other request-shape validation so a missing confirm is always the first error a caller sees.
- **Dry-run near-market warning for conditional orders.** When `triggerPrice` is within 0.1% of the current market price, the dry-run preview surfaces a warning that the order will likely fire immediately (or be rejected as already-triggered).
- **`CHANGELOG.md`** — this file.

### Changed

- `cancel_order`, `manage_position`, `place_option_trade`, `close_option_position`, `create_rfq`, and `execute_quote` all gain the same schema-validated `confirm` requirement as `place_trade` / `close_position`. RFQ `cancel_rfq` is intentionally exempt (blocking a risk-reducing cancel is the unsafe direction).
- `close_position` schema marks `price` as `exclusiveMinimum: 0` to catch obvious bad inputs before the API does.
- Tool descriptions and the README Safety section updated to describe protocol-layer enforcement instead of prose-only enforcement.

### Migration (BREAKING)

If you call any of the gated execution tools programmatically, you must now pass `confirm: "CONFIRM"` whenever `dry_run` is `false` (or omitted). The string must be exact: case-sensitive, no whitespace.

```jsonc
// Before — would execute on any prior natural-language "CONFIRM" reply.
{ "name": "place_trade", "arguments": { "symbol": "BTCUSDT", "side": "Buy", "margin": 30, "leverage": 10, "sl": 29000 } }

// After — required for live submission.
{ "name": "place_trade", "arguments": { "symbol": "BTCUSDT", "side": "Buy", "margin": 30, "leverage": 10, "sl": 29000, "confirm": "CONFIRM" } }

// Dry runs unchanged — confirm is not required when previewing.
{ "name": "place_trade", "arguments": { "symbol": "BTCUSDT", "side": "Buy", "margin": 30, "leverage": 10, "sl": 29000, "dry_run": true } }
```

If you use this server from Claude Desktop / Claude Code / Cursor via the natural-language flow, the model will translate the user's `CONFIRM` reply into the new parameter automatically. The user-facing flow does not change.

### Tests

- 287 → 325 tests across 25 suites. All passing.

## [0.2.2] and earlier

See git history (`git log v0.2.2`).
