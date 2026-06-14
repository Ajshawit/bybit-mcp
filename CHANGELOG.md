# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] — 2026-06-12

Quant analytics expansion and roadmap completion: 8 new always-on read-only tools plus a new scan filter (22 → 30 total) and a persistence layer. 579 tests across 35 suites.

### Added — roadmap completion

- **`calculate_position_size`** — advisory sizing math (no orders): `risk_per_trade` (quantity whose loss at the stop equals a USD or %-of-equity budget; inverse contracts valued at the stop), `kelly` (fractional Kelly, default 0.25×, from explicit stats or recent closed trades — refuses on thin/no-loss/negative-edge history), `vol_target` (position sized to contribute a target annualized vol on equity). Output floored to the instrument qty step, with margin at the chosen leverage and a liquidation-distance check: estimated liq price vs the stop plus the max leverage that keeps liquidation safely beyond it.
- **`get_performance_stats`** — closed-trade analytics over up to 180 days (chunks Bybit's 7-day closed-PnL windows, cursor pagination, 1000-trade cap with truncation flag): win rate, profit factor, expectancy, payoff ratio, largest win/loss, annualized Sharpe/Sortino on daily USD PnL (explicitly scale-dependent — field names and a dataNote say so), max drawdown on the cumulative PnL curve, per-symbol attribution, long-vs-short breakdown, hold-time stats.
- **`analyze_pair`** — stat-arb toolkit vs a benchmark (default BTCUSDT) on timestamp-aligned klines: log-return correlation (full + recent window), beta/hedge ratio with benchmark notional per $1k of symbol, pair log-spread z-score with `spread_rich`/`spread_cheap` tags at |z| ≥ 2, and an AR(1) mean-reversion half-life (null when the spread trends).
- **`scan_market` crowding signals** — new `account_ratio` filter (long/short account ratio from `/v5/market/account-ratio`; extremes ≥ 2.0 / ≤ 0.5 returned with the 24h-ago ratio, funding z-score, and `retail_crowded_long/short` tags) and `fundingZScore` on `crowded_positioning` (current funding vs the trailing history, now 200 records). Unknown scan filters now throw instead of returning undefined. Funding z-scores read Bybit's funding-history API directly — no persistence warmup needed.

### Added — quant analytics expansion

- **`get_portfolio_risk`** — portfolio-level aggregation (net/gross delta USD per underlying across linear perps, inverse perps, and options; summed gamma/vega/theta; gross notional, leverage ratio, concentration) plus a spot×IV scenario stress grid with Black-Scholes repricing and a worst-case cell. New `blackScholesPrice` in the options math module.
- **`get_volatility`** — annualized realized-vol estimators (close-to-close, Parkinson, Yang-Zhang), a vol cone across 1d–30d horizons, and (options enabled, BTC/ETH/SOL) ATM IV with the IV−RV spread.
- **`get_carry_analytics`** — `basis`: mark-vs-index basis, realized + annualized funding, predicted next funding from the premium-index kline (Bybit's clamp formula), perp-vs-spot basis, dated-futures annualized basis; `scan`: all liquid perps ranked by annualized funding carry using per-symbol funding intervals from instruments-info.
- **`estimate_execution_cost`** — deep-orderbook sweep (500 levels perps / 200 spot): average fill, slippage bps vs mid, book imbalance, account taker/maker fees via `/v5/account/fee-rate`, all-in cost bps, max size within a slippage budget, whole-book-sweep warning.
- **`get_event_calendar`** — next funding per symbol (defaults to open-position symbols), option expiry schedule with OI notional by date, dated-futures deliveries, NYSE session status.
- **Persistence layer** (`src/storage.ts`) — IV percentile samples now survive restarts via a debounced atomic JSON snapshot under `BYBIT_MCP_DATA_DIR` (default `~/.bybit-mcp`); disable with `BYBIT_MCP_PERSIST=false`. Fail-open: a broken disk degrades to in-memory, never takes down the session.
- README Roadmap section documenting the planned second tier: position sizing calculator, closed-trade performance analytics, pairs/stat-arb toolkit, crowding signals — all four shipped in this same release (see above).

## [0.4.0] — 2026-06-12

Fixes all 60 findings from a comprehensive multi-agent security/correctness audit of v0.3.0. Highlights below; every execution-path change carries new regression tests (416 tests across 26 suites).

### Fixed — live-money bugs

- **Order sizing:** `floorToStep`/`roundToStep` no longer drop a full step on exactly on-step values (binary float quotient noise). A `close_position` with `percent: 100` previously left a leveraged residual position.
- **`dry_run` on `close_position`, `manage_position`, `cancel_order`:** the documented flag was silently dropped — a preview call with `confirm` attached executed live. Now implemented end-to-end (schema, dispatch, handlers, previews).
- **Option premium gates checked USDC** while every tradable symbol is USDT-settled; gates now check USDT, refuse Market buys with an empty ask book, and fail closed on malformed `OPTIONS_MAX_PREMIUM_PCT_BALANCE`.
- **`parseOptionSymbol` rejected single-digit expiry days** (Bybit does not zero-pad), which also made `get_account_status` throw for the whole account; the parser accepts 1–2 digit days and account mapping skips (with a stderr warning) instead of crashing.
- **Spot conditional orders could not be cancelled:** `cancel_order` gains `orderFilter` and automatically retries failed spot cancels with `StopOrder`.
- **NaN-blind balance gates:** empty `totalPositionIM` (portfolio-margin accounts) silently disabled the insufficient-balance pre-flight; Bybit string→number conversions at gates now fail loudly or default explicitly.

### Fixed — RFQ/options risk gates

- **CRITICAL: the combo-risk gate was blind to downside tails.** The payoff engine now computes max loss/profit/breakevens analytically from the piecewise-linear expiry payoff (kinks + net tail slopes) instead of sampling a ±30% grid — naked short puts and far-OTM short calls no longer pass `assess_combo_risk` as covered, and an unbounded loss reports `maxLossUsd: null` instead of a wrong positive number.
- **`execute_quote` live path** now enforces eligibility + quote-liveness + a combo-risk gate over the structure the taker would end up with (leg sides invert when executing the LP's sell side); dry-run `wouldSubmit` is honest about the kill-switch.
- **Naked-short gate hardening:** resting short option orders now count against the same long cover; `close_option_position` refuses to close a covering long while a same-type/expiry short depends on it.
- RFQ realtime query path corrected to `/v5/rfq/rfq-realtime` (re-verified against the reference client source).
- The `OPTIONS_ALLOW_NAKED_SHORT` → RFQ-gate override coupling is now documented everywhere the env vars are.

### Fixed — API correctness & analytics

- Unfiltered linear `list_open_orders` sends `settleCoin=USDT` (Bybit requires a filter); inverse positions are no longer queried with the bogus `settleCoin=USD` (which hid every inverse position); invalid `spot_margin` category removed from two tool schemas.
- Spot conditionals no longer send futures-only `triggerBy`/`triggerDirection`; USDC-settled linear contracts (`BTCPERP`) use the USDC balance for margin gates; inverse dry-run liquidation uses the inverse formula.
- `scan_market`: true rolling 4h price change; per-symbol funding interval derived from history (annualization and 8h/24h lookbacks were hardcoded to 8h); zero-OI guard.
- Black-Scholes returns the intrinsic limit instead of NaN for σ≤0/invalid inputs; local Greeks use exact fractional time to expiry; options regime flags `spotUnavailable` instead of silently computing skew against spot=0.

### Fixed — robustness & housekeeping

- HTTP client: 15s request timeout, unparseable-response guard, rate-limit retries re-sign with a fresh timestamp, Bybit error messages scrubbed of the API key, throttle race fixed.
- Gate-relevant tool arguments (`dry_run`, `category`, `side`, `orderFilter`) are runtime-validated at dispatch — schema enums alone are advisory in MCP.
- `get_option_payoff` now respects `ENABLE_OPTIONS` at call time; the MCP server reports the real package version; instrument specs cache expires after 24h; trade results flag fallback (non-fill) `avgFillPrice` explicitly.
- `isNyseOpen` knows the NYSE holiday calendar (fixed + floating + Good Friday) and 13:00 ET early closes.
- Docs corrected: USDT options settlement, `dry_run` support table, SECURITY.md logging claims, smithery.yaml RFQ config surface, test counts.

### Pre-release commits folded in

- `feat(options)`: risk-defined verticals recognized as covered by the naked-short gate (same type+expiry long covers a short leg).
- `fix`: tolerate set-leverage rejection (110077) on portfolio-margin accounts.

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
