# TradFi Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add discovery and market-data support for Bybit's three TradFi instrument types (xStocks, stock perpetuals, commodity perpetuals) while preserving the token-efficiency of the existing MCP.

**Architecture:** New `list_tradfi_instruments` tool fans out to the Bybit instruments-info API with three `symbolType` filters in parallel. `get_market_data` gains an optional `category` param; when `category="spot"` it takes an xStock path (no funding/OI, adds NYSE hours status). A phased spike verifies the TradFi account structure before execution code is finalised.

**Tech Stack:** TypeScript, Jest + ts-jest, Bybit V5 REST API (`/v5/market/instruments-info`, `/v5/market/tickers`, `/v5/market/kline`, `/v5/market/orderbook`)

---

## Phase 0 — Discovery spike (verify account structure before building execution)

### Task 1: NYSE hours utility

**Files:**
- Modify: `src/util.ts`
- Modify: `src/__tests__/util.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/__tests__/util.test.ts`:

```typescript
import { concurrentMap, floorToStep, roundToStep, isNyseOpen } from "../util";

describe("isNyseOpen", () => {
  function utcDate(isoString: string): Date {
    return new Date(isoString);
  }

  it("returns session=regular and open=true during NYSE regular hours (ET)", () => {
    // Tuesday 2026-05-12 14:00 UTC = 10:00 AM EDT (UTC-4) — regular hours
    const result = isNyseOpen(utcDate("2026-05-12T14:00:00Z"));
    expect(result.open).toBe(true);
    expect(result.session).toBe("regular");
  });

  it("returns session=pre and open=false during pre-market (ET)", () => {
    // Tuesday 2026-05-12 10:00 UTC = 06:00 AM EDT — pre-market
    const result = isNyseOpen(utcDate("2026-05-12T10:00:00Z"));
    expect(result.open).toBe(false);
    expect(result.session).toBe("pre");
  });

  it("returns session=after and open=false during after-hours (ET)", () => {
    // Tuesday 2026-05-12 21:30 UTC = 17:30 EDT — after-hours
    const result = isNyseOpen(utcDate("2026-05-12T21:30:00Z"));
    expect(result.open).toBe(false);
    expect(result.session).toBe("after");
  });

  it("returns session=closed and open=false after after-hours (ET)", () => {
    // Tuesday 2026-05-12 02:00 UTC = 22:00 prev day EDT — closed
    const result = isNyseOpen(utcDate("2026-05-12T02:00:00Z"));
    expect(result.open).toBe(false);
    expect(result.session).toBe("closed");
  });

  it("returns session=closed on Saturday", () => {
    const result = isNyseOpen(utcDate("2026-05-09T15:00:00Z")); // Saturday
    expect(result.open).toBe(false);
    expect(result.session).toBe("closed");
  });

  it("returns session=closed on Sunday", () => {
    const result = isNyseOpen(utcDate("2026-05-10T15:00:00Z")); // Sunday
    expect(result.open).toBe(false);
    expect(result.session).toBe("closed");
  });

  it("uses EST offset (UTC-5) in winter outside DST", () => {
    // Friday 2026-01-09 14:45 UTC = 09:45 EST — just inside regular hours
    const result = isNyseOpen(utcDate("2026-01-09T14:45:00Z"));
    expect(result.open).toBe(true);
    expect(result.session).toBe("regular");
  });

  it("note field is a non-empty string", () => {
    const result = isNyseOpen(utcDate("2026-05-12T14:00:00Z"));
    expect(typeof result.note).toBe("string");
    expect(result.note.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run to verify tests fail**

```bash
cd ~/dev/bybit-mcp && npx jest --testPathPattern="util.test" --no-coverage 2>&1 | tail -15
```
Expected: `isNyseOpen is not a function` or similar import error.

- [ ] **Step 3: Implement `NyseStatus` and `isNyseOpen` in `src/util.ts`**

Add at the bottom of `src/util.ts`:

```typescript
export interface NyseStatus {
  open: boolean;
  session: "regular" | "pre" | "after" | "closed";
  note: string;
}

function getNthSundayUtc(year: number, month: number, n: number): Date {
  // month is 0-indexed (2=March, 10=November)
  // DST changes at 2 AM local = 7 AM UTC (EST offset) on the Sunday
  const firstOfMonth = new Date(Date.UTC(year, month, 1));
  const firstSunday = (7 - firstOfMonth.getUTCDay()) % 7 + 1;
  const dayOfMonth = firstSunday + (n - 1) * 7;
  return new Date(Date.UTC(year, month, dayOfMonth, 7));
}

export function isNyseOpen(now = new Date()): NyseStatus {
  const day = now.getUTCDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return { open: false, session: "closed", note: "Weekend — NYSE closed" };

  const year = now.getUTCFullYear();
  const dstStart = getNthSundayUtc(year, 2, 2); // 2nd Sunday in March
  const dstEnd = getNthSundayUtc(year, 10, 1);  // 1st Sunday in November
  const isDst = now >= dstStart && now < dstEnd;
  const etOffsetHours = isDst ? -4 : -5;

  const etHour = ((now.getUTCHours() + etOffsetHours) % 24 + 24) % 24;
  const etMin = now.getUTCMinutes();
  const etMinutes = etHour * 60 + etMin;

  const PRE_OPEN  = 4 * 60;       // 04:00
  const REG_OPEN  = 9 * 60 + 30;  // 09:30
  const REG_CLOSE = 16 * 60;      // 16:00
  const AH_CLOSE  = 20 * 60;      // 20:00

  if (etMinutes >= REG_OPEN && etMinutes < REG_CLOSE) {
    return { open: true, session: "regular", note: "NYSE regular hours (09:30–16:00 ET)" };
  }
  if (etMinutes >= PRE_OPEN && etMinutes < REG_OPEN) {
    return { open: false, session: "pre", note: "NYSE pre-market (04:00–09:30 ET)" };
  }
  if (etMinutes >= REG_CLOSE && etMinutes < AH_CLOSE) {
    return { open: false, session: "after", note: "NYSE after-hours (16:00–20:00 ET)" };
  }
  return { open: false, session: "closed", note: "NYSE closed" };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd ~/dev/bybit-mcp && npx jest --testPathPattern="util.test" --no-coverage 2>&1 | tail -10
```
Expected: all `isNyseOpen` tests pass.

- [ ] **Step 5: Commit**

```bash
cd ~/dev/bybit-mcp && git add src/util.ts src/__tests__/util.test.ts && git commit -m "feat: add isNyseOpen NYSE hours utility"
```

---

### Task 2: TradFi types

**Files:**
- Modify: `src/tools/types.ts`

- [ ] **Step 1: Add TradFi types to `src/tools/types.ts`**

Add at the end of `src/tools/types.ts` (after the `DryRunResult` interface):

```typescript
// Raw API response type for instruments-info TradFi discovery queries.
// Richer than InstrumentInfoResult which is kept minimal for trade-shared use.
export interface TradfiInstrumentRaw {
  symbol: string;
  baseCoin: string;
  status: string;
  priceFilter: { tickSize: string };
  lotSizeFilter: {
    minOrderQty: string;
    maxOrderQty?: string;
    basePrecision?: string;
    qtyStep?: string;
  };
  leverageFilter?: { maxLeverage?: string };
}

export interface TradfiInstrumentListResult {
  list: TradfiInstrumentRaw[];
  nextPageCursor?: string;
}

export interface TradfiInstrument {
  symbol: string;
  baseCoin: string;
  type: "xstock" | "stock_perp" | "commodity_perp";
  status: string;
  tickSize: string;
  minOrderQty: string;
  maxOrderQty: string;
  maxLeverage?: string;
}

export interface TradfiInstrumentsResult {
  xstocks: TradfiInstrument[];
  stock_perps: TradfiInstrument[];
  commodity_perps: TradfiInstrument[];
  total: number;
}
```

Note: `MarketDataResult` lives in `src/tools/market.ts` (not types.ts). The `nyseStatus` field will be added to it in Task 6 alongside the xStock branch implementation.

- [ ] **Step 2: Build to verify no type errors**

```bash
cd ~/dev/bybit-mcp && npx tsc --noEmit 2>&1 | head -20
```
Expected: no errors (or only pre-existing ones unrelated to these changes).

- [ ] **Step 3: Commit**

```bash
cd ~/dev/bybit-mcp && git add src/tools/types.ts && git commit -m "feat: add TradFi instrument types and nyseStatus to MarketDataResult"
```

---

### Task 3: `handleListTradfiInstruments` + tests

**Files:**
- Modify: `src/tools/market.ts`
- Modify: `src/__tests__/market.test.ts`

- [ ] **Step 1: Write failing tests**

First, update the existing import at the top of `src/__tests__/market.test.ts` to add `handleListTradfiInstruments`:
```typescript
// Change this line:
import { handleGetMarketData, handleScanMarket, handleGetOhlc, handleGetMarketRegime } from "../tools/market";
// To:
import { handleGetMarketData, handleScanMarket, handleGetOhlc, handleGetMarketRegime, handleListTradfiInstruments } from "../tools/market";
```

Then add to the end of `src/__tests__/market.test.ts`:

describe("handleListTradfiInstruments", () => {
  function makeRawInstrument(overrides: Partial<{
    symbol: string; baseCoin: string; status: string;
    tickSize: string; minOrderQty: string; maxOrderQty: string; maxLeverage: string;
  }> = {}) {
    return {
      symbol: overrides.symbol ?? "TSLAXUSDT",
      baseCoin: overrides.baseCoin ?? "TSLAX",
      status: overrides.status ?? "Trading",
      priceFilter: { tickSize: overrides.tickSize ?? "0.01" },
      lotSizeFilter: {
        minOrderQty: overrides.minOrderQty ?? "1",
        maxOrderQty: overrides.maxOrderQty ?? "10000",
        basePrecision: "1",
      },
      leverageFilter: overrides.maxLeverage ? { maxLeverage: overrides.maxLeverage } : undefined,
    };
  }

  it("returns xstocks from spot/xstocks call", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock)
      .mockResolvedValueOnce({ list: [makeRawInstrument({ symbol: "TSLAXUSDT", baseCoin: "TSLAX" })] }) // xstocks
      .mockResolvedValueOnce({ list: [] }) // stock_perps
      .mockResolvedValueOnce({ list: [] }); // commodity_perps

    const result = await handleListTradfiInstruments(client);

    expect(result.xstocks).toHaveLength(1);
    expect(result.xstocks[0].symbol).toBe("TSLAXUSDT");
    expect(result.xstocks[0].type).toBe("xstock");
    expect(result.xstocks[0].maxLeverage).toBeUndefined();
  });

  it("returns stock_perps from linear/stock call", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock)
      .mockResolvedValueOnce({ list: [] }) // xstocks
      .mockResolvedValueOnce({ list: [makeRawInstrument({ symbol: "TSLAPUSDT", baseCoin: "TSLAP", maxLeverage: "5" })] })
      .mockResolvedValueOnce({ list: [] });

    const result = await handleListTradfiInstruments(client);

    expect(result.stock_perps).toHaveLength(1);
    expect(result.stock_perps[0].symbol).toBe("TSLAPUSDT");
    expect(result.stock_perps[0].type).toBe("stock_perp");
    expect(result.stock_perps[0].maxLeverage).toBe("5");
  });

  it("returns commodity_perps from linear/commodity call", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock)
      .mockResolvedValueOnce({ list: [] })
      .mockResolvedValueOnce({ list: [] })
      .mockResolvedValueOnce({ list: [makeRawInstrument({ symbol: "XAUUSDT", baseCoin: "XAU", maxLeverage: "25" })] });

    const result = await handleListTradfiInstruments(client);

    expect(result.commodity_perps).toHaveLength(1);
    expect(result.commodity_perps[0].symbol).toBe("XAUUSDT");
    expect(result.commodity_perps[0].type).toBe("commodity_perp");
  });

  it("total equals sum of all three arrays", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock)
      .mockResolvedValueOnce({ list: [makeRawInstrument({ symbol: "TSLAXUSDT" }), makeRawInstrument({ symbol: "AAPLXUSDT" })] })
      .mockResolvedValueOnce({ list: [makeRawInstrument({ symbol: "TSLAPUSDT" })] })
      .mockResolvedValueOnce({ list: [makeRawInstrument({ symbol: "XAUUSDT" })] });

    const result = await handleListTradfiInstruments(client);
    expect(result.total).toBe(4);
  });

  it("filters by search string case-insensitively", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock)
      .mockResolvedValueOnce({ list: [
        makeRawInstrument({ symbol: "TSLAXUSDT", baseCoin: "TSLAX" }),
        makeRawInstrument({ symbol: "AAPLXUSDT", baseCoin: "AAPLX" }),
      ]})
      .mockResolvedValueOnce({ list: [makeRawInstrument({ symbol: "TSLAPUSDT", baseCoin: "TSLAP" })] })
      .mockResolvedValueOnce({ list: [] });

    const result = await handleListTradfiInstruments(client, "all", "tsla");

    expect(result.xstocks).toHaveLength(1);
    expect(result.xstocks[0].symbol).toBe("TSLAXUSDT");
    expect(result.stock_perps).toHaveLength(1);
    expect(result.stock_perps[0].symbol).toBe("TSLAPUSDT");
  });

  it("makes three parallel publicGet calls with correct params", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValue({ list: [] });

    await handleListTradfiInstruments(client);

    const calls = (client.publicGet as jest.Mock).mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls.some(([, p]: [string, Record<string, string>]) => p.symbolType === "xstocks" && p.category === "spot")).toBe(true);
    expect(calls.some(([, p]: [string, Record<string, string>]) => p.symbolType === "stock" && p.category === "linear")).toBe(true);
    expect(calls.some(([, p]: [string, Record<string, string>]) => p.symbolType === "commodity" && p.category === "linear")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify tests fail**

```bash
cd ~/dev/bybit-mcp && npx jest --testPathPattern="market.test" --no-coverage 2>&1 | grep -E "FAIL|handleListTradfi|not a function" | head -10
```
Expected: `handleListTradfiInstruments is not a function` or import error.

- [ ] **Step 3: Add `handleListTradfiInstruments` to `src/tools/market.ts`**

Update the existing import from `"./types"` at the top of `src/tools/market.ts`:
```typescript
// Change this:
import {
  TickersResult,
  KlineResult,
  FundingHistoryResult,
  OrderbookEntry,
  OIHistoryResult,
} from "./types";
// To:
import {
  TickersResult,
  KlineResult,
  FundingHistoryResult,
  OrderbookEntry,
  OIHistoryResult,
  TradfiInstrumentListResult,
  TradfiInstrument,
  TradfiInstrumentsResult,
} from "./types";
```

Then add the function at the end of `src/tools/market.ts`:

```typescript
export async function handleListTradfiInstruments(
  client: BybitClient,
  type: "xstocks" | "stock_perps" | "commodity_perps" | "all" = "all",
  search?: string
): Promise<TradfiInstrumentsResult> {
  const [xstocksRes, stockPerpsRes, commodityPerpsRes] = await Promise.all([
    type === "all" || type === "xstocks"
      ? client.publicGet<TradfiInstrumentListResult>("/v5/market/instruments-info", { category: "spot", symbolType: "xstocks", limit: "500" })
      : Promise.resolve({ list: [] }),
    type === "all" || type === "stock_perps"
      ? client.publicGet<TradfiInstrumentListResult>("/v5/market/instruments-info", { category: "linear", symbolType: "stock", limit: "500" })
      : Promise.resolve({ list: [] }),
    type === "all" || type === "commodity_perps"
      ? client.publicGet<TradfiInstrumentListResult>("/v5/market/instruments-info", { category: "linear", symbolType: "commodity", limit: "500" })
      : Promise.resolve({ list: [] }),
  ]);

  function mapInstrument(raw: TradfiInstrumentListResult["list"][number], instrumentType: TradfiInstrument["type"]): TradfiInstrument {
    return {
      symbol: raw.symbol,
      baseCoin: raw.baseCoin,
      type: instrumentType,
      status: raw.status,
      tickSize: raw.priceFilter.tickSize,
      minOrderQty: raw.lotSizeFilter.minOrderQty,
      maxOrderQty: raw.lotSizeFilter.maxOrderQty ?? raw.lotSizeFilter.basePrecision ?? "0",
      maxLeverage: raw.leverageFilter?.maxLeverage,
    };
  }

  const searchLower = search?.toLowerCase();
  function filterBySearch(instruments: TradfiInstrument[]): TradfiInstrument[] {
    if (!searchLower) return instruments;
    return instruments.filter((i) =>
      i.symbol.toLowerCase().includes(searchLower) || i.baseCoin.toLowerCase().includes(searchLower)
    );
  }

  const xstocks = filterBySearch(xstocksRes.list.map((r) => mapInstrument(r, "xstock")));
  const stock_perps = filterBySearch(stockPerpsRes.list.map((r) => mapInstrument(r, "stock_perp")));
  const commodity_perps = filterBySearch(commodityPerpsRes.list.map((r) => mapInstrument(r, "commodity_perp")));

  return { xstocks, stock_perps, commodity_perps, total: xstocks.length + stock_perps.length + commodity_perps.length };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd ~/dev/bybit-mcp && npx jest --testPathPattern="market.test" --no-coverage 2>&1 | grep -E "PASS|FAIL|Tests:" | head -5
```
Expected: all `handleListTradfiInstruments` tests pass; no regressions in existing market tests.

- [ ] **Step 5: Commit**

```bash
cd ~/dev/bybit-mcp && git add src/tools/market.ts src/__tests__/market.test.ts && git commit -m "feat: add handleListTradfiInstruments for TradFi discovery"
```

---

### Task 4: Register `list_tradfi_instruments` in `index.ts`

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add import for `handleListTradfiInstruments`**

In `src/index.ts`, find the line:
```typescript
import { handleGetMarketData, handleScanMarket, handleGetOhlc, handleGetMarketRegime, ScanFilter } from "./tools/market";
```
Replace it with:
```typescript
import { handleGetMarketData, handleScanMarket, handleGetOhlc, handleGetMarketRegime, handleListTradfiInstruments, ScanFilter } from "./tools/market";
```

- [ ] **Step 2: Register the tool in the `tools` array**

In `src/index.ts`, find the closing of the `tools` array (look for the last tool entry before the `]`). Add the new tool after the last existing tool entry (before the `]`):

```typescript
      {
        name: "list_tradfi_instruments",
        description: "Discover available TradFi instruments on Bybit. Returns xStocks (tokenized equities e.g. TSLAXUSDT — trade with category=spot), stock perpetuals (e.g. TSLAPUSDT — trade with category=linear), and commodity perpetuals (e.g. XAUUSDT gold, XAGUSDT silver, CLUSDT crude oil — trade with category=linear). Always call this before the first TradFi trade in a session to confirm exact symbols and constraints (tickSize, minOrderQty, maxLeverage).",
        inputSchema: {
          type: "object",
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
```

- [ ] **Step 3: Add the handler in the `callTool` switch/dispatch**

Find where the other tool handlers are dispatched (look for `case "get_account_status":` or similar pattern). Add:

```typescript
      if (name === "list_tradfi_instruments") {
        const { type = "all", search } = args as { type?: string; search?: string };
        result = await handleListTradfiInstruments(
          client,
          (type as "xstocks" | "stock_perps" | "commodity_perps" | "all"),
          search
        );
      }
```

- [ ] **Step 4: Build to verify no type errors**

```bash
cd ~/dev/bybit-mcp && npx tsc --noEmit 2>&1 | head -20
```
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
cd ~/dev/bybit-mcp && git add src/index.ts && git commit -m "feat: register list_tradfi_instruments MCP tool"
```

---

### Task 5: Phase 0 smoke test — live verification

This task is a manual verification step. Run against your real Bybit account to discover the TradFi account structure before building the execution path.

**Files:** none — observation only.

- [ ] **Step 1: Build and start the MCP server**

```bash
cd ~/dev/bybit-mcp && npm run build 2>&1 | tail -5
```
Expected: build succeeds with no errors.

- [ ] **Step 2: Call `list_tradfi_instruments` via Claude**

Ask Claude (with this MCP loaded): "List all available TradFi instruments"

Verify:
- xStocks list contains symbols like `TSLAXUSDT`, `AAPLXUSDT`
- stock_perps list contains symbols like `TSLAPUSDT`
- commodity_perps list contains `XAUUSDT`, `XAGUSDT`, `CLUSDT`

If the API returns an error or empty lists, check whether your API key has TradFi permissions enabled on the Bybit dashboard.

- [ ] **Step 3: Call `get_account_status` and inspect the output**

Ask Claude: "What's my account status?"

Look at the `spot_holdings` array in the response. Answer these questions and record them here:
- Does `spot_holdings` contain a coin named `USDx` or `USDX` or similar?
- Does `totalEquity` include TradFi capital, or is it only crypto UTA equity?
- Is `freeCapital` the right field to show available capital for xStock trading?

- [ ] **Step 4: Attempt a dry-run xStock trade**

Ask Claude: "Dry-run a market buy of TSLAXUSDT with margin 100 USDT, category spot" (using `place_trade` with `dry_run=true`).

Note: `place_trade` already supports `category=spot` so this should work as-is at the API level. Record:
- Does `dry_run=true` succeed and return a valid `computedQty`?
- What `marginCoin` does it report? (Should indicate USDx if that's the settlement currency)
- Does it warn about insufficient balance if USDx is needed but USDT is held?

- [ ] **Step 5: Record findings**

Based on the above, update the design for Task 6 (account status labeling in Task 8):
- If USDx is a spot holding in UNIFIED wallet → Task 8 just needs description updates
- If TradFi capital lives outside UNIFIED → Task 8 needs a new API call (document the endpoint here)

---

## Phase 1 — TradFi-aware `get_market_data`

### Task 6: Extend `handleGetMarketData` for xStock path

**Files:**
- Modify: `src/tools/market.ts`
- Modify: `src/__tests__/market.test.ts`

- [ ] **Step 1: Write failing tests**

Add to the `describe("handleGetMarketData")` block in `src/__tests__/market.test.ts`:

```typescript
  it("xStock path: skips funding/OI and includes nyseStatus when category=spot", async () => {
    const xstockTicker = {
      list: [{
        symbol: "TSLAXUSDT",
        lastPrice: "185.50",
        price24hPcnt: "0.012",
        fundingRate: "",
        nextFundingTime: "",
        openInterest: "",
        openInterestValue: "",
        volume24h: "50000",
        turnover24h: "9275000",
        highPrice24h: "190.00",
        lowPrice24h: "180.00",
        prevPrice24h: "183.00",
        bid1Price: "185.40",
        ask1Price: "185.60",
      }],
    };
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock)
      .mockResolvedValueOnce(xstockTicker)  // tickers (spot)
      .mockResolvedValueOnce(mockKline)     // kline interval 60
      .mockResolvedValueOnce(mockKline)     // kline interval 240
      .mockResolvedValueOnce(mockOrderbook); // orderbook

    const result = await handleGetMarketData(client, "TSLAXUSDT", ["60", "240"], 24, 8, false, "spot");

    expect(result.ticker.symbol).toBe("TSLAXUSDT");
    expect(result.ticker.price).toBe(185.5);
    expect(result.ticker.fundingRate).toBe(0);
    expect(result.ticker.nextFundingTime).toBeNull();
    expect(result.ticker.oi).toBe(0);
    expect(result.fundingHistory).toEqual([]);
    expect(result.nyseStatus).toBeDefined();
    expect(typeof result.nyseStatus!.open).toBe("boolean");
    expect(typeof result.nyseStatus!.session).toBe("string");
    // Verify only 4 publicGet calls (tickers + 2 klines + orderbook) — no funding or OI
    expect((client.publicGet as jest.Mock).mock.calls).toHaveLength(4);
  });

  it("xStock path: passes category=spot to all API calls", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock).mockResolvedValue({ list: [], b: [], a: [], s: "" });

    await handleGetMarketData(client, "TSLAXUSDT", ["60"], 24, 8, false, "spot");

    const calls = (client.publicGet as jest.Mock).mock.calls;
    expect(calls.every(([, p]: [string, Record<string, string>]) => p.category === "spot")).toBe(true);
  });

  it("linear path: still works unchanged when category=linear (default)", async () => {
    const client = new MockClient("k", "s", "u");
    (client.publicGet as jest.Mock)
      .mockResolvedValueOnce(mockTicker)
      .mockResolvedValueOnce(mockKline)
      .mockResolvedValueOnce(mockKline)
      .mockResolvedValueOnce(mockFunding)
      .mockResolvedValueOnce(mockOrderbook)
      .mockResolvedValueOnce({ list: [] });

    const result = await handleGetMarketData(client, "BTCUSDT");
    expect(result.ticker.fundingRate).toBe(0.0001);
    expect(result.nyseStatus).toBeUndefined();
  });
```

- [ ] **Step 2: Run to verify tests fail**

```bash
cd ~/dev/bybit-mcp && npx jest --testPathPattern="market.test" --no-coverage -t "xStock path" 2>&1 | tail -10
```
Expected: tests fail because `handleGetMarketData` doesn't have a `category` param yet.

- [ ] **Step 3: Update `src/tools/market.ts` — import, `MarketDataResult`, and function signature**

Update the existing util import at the top of `src/tools/market.ts`:
```typescript
// Change this:
import { concurrentMap } from "../util";
// To:
import { concurrentMap, isNyseOpen, NyseStatus } from "../util";
```

Add `nyseStatus` to `MarketDataResult` in `src/tools/market.ts` (find the interface at line ~75 and add the field):
```typescript
export interface MarketDataResult {
  ticker: MarketTicker;
  klines: Record<string, MarketKlineBar[]>;
  fundingHistory: Array<{ rate: number; timestamp: number }>;
  orderbook: {
    bestBid: number;
    bestAsk: number;
    spread: number;
    spreadPct: number;
    midPrice: number;
    bids?: [number, number][];
    asks?: [number, number][];
  };
  nyseStatus?: NyseStatus;
}
```

Change the function signature (find the existing `export async function handleGetMarketData(`):

```typescript
export async function handleGetMarketData(
  client: BybitClient,
  symbol: string,
  klineIntervals = ["60", "240"],
  klineLimit = 24,
  fundingHistoryLimit = 8,
  includeOrderbook = false,
  category: "linear" | "spot" = "linear"
): Promise<MarketDataResult> {
```

Then wrap the existing function body with a branch. Replace the entire body (from `const allResults = await Promise.all([` to `return { ticker, klines, fundingHistory, orderbook };`) with:

```typescript
  if (category === "spot") {
    const spotResults = await Promise.all([
      client.publicGet<TickersResult>("/v5/market/tickers", { category: "spot", symbol }),
      ...klineIntervals.map((interval) =>
        client.publicGet<KlineResult>("/v5/market/kline", {
          category: "spot", symbol, interval, limit: String(klineLimit),
        })
      ),
      client.publicGet<OrderbookEntry>("/v5/market/orderbook", {
        category: "spot", symbol, limit: "20",
      }),
    ]);

    const spotTicker = (spotResults[0] as TickersResult).list?.[0];
    const spotKlineResults = spotResults.slice(1, 1 + klineIntervals.length) as KlineResult[];
    const spotObRes = spotResults[1 + klineIntervals.length] as OrderbookEntry;

    const ticker: MarketTicker = {
      symbol: spotTicker?.symbol ?? symbol,
      price: spotTicker ? parseFloat(spotTicker.lastPrice) : 0,
      price24hPct: spotTicker ? parseFloat(spotTicker.price24hPcnt) * 100 : 0,
      fundingRate: 0,
      funding8hAgo: null,
      funding24hAgo: null,
      nextFundingTime: null,
      secondsToNextFunding: null,
      oi: 0,
      oiValueUsd: 0,
      oi4hAgo: null,
      oi24hAgo: null,
      volume24hUsd: spotTicker ? parseFloat(spotTicker.turnover24h) : 0,
      bid: spotTicker ? parseFloat(spotTicker.bid1Price) : 0,
      ask: spotTicker ? parseFloat(spotTicker.ask1Price) : 0,
    };

    const klines: Record<string, MarketKlineBar[]> = {};
    klineIntervals.forEach((interval, i) => {
      klines[interval] = (spotKlineResults[i]?.list ?? []).map(
        ([time, open, high, low, close, volume]) => ({
          time: parseInt(time), open: parseFloat(open), high: parseFloat(high),
          low: parseFloat(low), close: parseFloat(close), volume: parseFloat(volume),
        })
      );
    });

    const spotBids = (spotObRes.b ?? []).map(([p, s]) => [parseFloat(p), parseFloat(s)] as [number, number]);
    const spotAsks = (spotObRes.a ?? []).map(([p, s]) => [parseFloat(p), parseFloat(s)] as [number, number]);
    const spotBestBid = spotBids[0]?.[0] ?? 0;
    const spotBestAsk = spotAsks[0]?.[0] ?? 0;
    const spotMid = spotBestBid > 0 && spotBestAsk > 0 ? (spotBestBid + spotBestAsk) / 2 : 0;
    const spotSpread = spotBestAsk - spotBestBid;
    const spotSpreadPct = spotMid > 0 ? spotSpread / spotMid * 100 : 0;
    const spotOrderbook = includeOrderbook
      ? { bestBid: spotBestBid, bestAsk: spotBestAsk, spread: spotSpread, spreadPct: spotSpreadPct, midPrice: spotMid, bids: spotBids, asks: spotAsks }
      : { bestBid: spotBestBid, bestAsk: spotBestAsk, spread: spotSpread, spreadPct: spotSpreadPct, midPrice: spotMid };

    return { ticker, klines, fundingHistory: [], orderbook: spotOrderbook, nyseStatus: isNyseOpen() };
  }

  // Linear perp path (unchanged)
  const allResults = await Promise.all([
    client.publicGet<TickersResult>("/v5/market/tickers", { category: "linear", symbol }),
    ...klineIntervals.map((interval) =>
      client.publicGet<KlineResult>("/v5/market/kline", {
        category: "linear",
        symbol,
        interval,
        limit: String(klineLimit),
      })
    ),
    client.publicGet<FundingHistoryResult>("/v5/market/funding/history", {
      category: "linear",
      symbol,
      limit: String(fundingHistoryLimit),
    }),
    client.publicGet<OrderbookEntry>("/v5/market/orderbook", {
      category: "linear",
      symbol,
      limit: "20",
    }),
    client.publicGet<OIHistoryResult>("/v5/market/open-interest", {
      category: "linear",
      symbol,
      intervalTime: "4h",
      limit: "7",
    }).catch(() => null),
  ]);

  const tickersRes = allResults[0] as TickersResult;
  const klineResults = allResults.slice(1, 1 + klineIntervals.length) as KlineResult[];
  const fundingRes = allResults[1 + klineIntervals.length] as FundingHistoryResult;
  const obRes = allResults[2 + klineIntervals.length] as OrderbookEntry;
  const oiRes = allResults[3 + klineIntervals.length] as OIHistoryResult | null;
  const oiList = oiRes?.list ?? [];

  const t = tickersRes.list?.[0];
  const fundingList = fundingRes.list ?? [];

  const nextFundingMs = t?.nextFundingTime ? parseInt(t.nextFundingTime, 10) : NaN;
  const nextFundingTime = Number.isFinite(nextFundingMs) && nextFundingMs > 0
    ? new Date(nextFundingMs).toISOString()
    : null;
  const secondsToNextFunding = Number.isFinite(nextFundingMs) && nextFundingMs > 0
    ? Math.max(0, Math.round((nextFundingMs - Date.now()) / 1000))
    : null;

  const ticker: MarketTicker = {
    symbol: t?.symbol ?? symbol,
    price: t ? parseFloat(t.lastPrice) : 0,
    price24hPct: t ? parseFloat(t.price24hPcnt) * 100 : 0,
    fundingRate: t ? parseFloat(t.fundingRate) : 0,
    funding8hAgo: fundingList[1] ? parseFloat(fundingList[1].fundingRate) : null,
    funding24hAgo: fundingList[3] ? parseFloat(fundingList[3].fundingRate) : null,
    nextFundingTime,
    secondsToNextFunding,
    oi: t ? parseFloat(t.openInterest) : 0,
    oiValueUsd: t ? parseFloat(t.openInterestValue) : 0,
    oi4hAgo: oiList[1] ? parseFloat(oiList[1].openInterest) : null,
    oi24hAgo: oiList[6] ? parseFloat(oiList[6].openInterest) : null,
    volume24hUsd: t ? parseFloat(t.turnover24h) : 0,
    bid: t ? parseFloat(t.bid1Price) : 0,
    ask: t ? parseFloat(t.ask1Price) : 0,
  };

  const klines: Record<string, MarketKlineBar[]> = {};
  klineIntervals.forEach((interval, i) => {
    klines[interval] = (klineResults[i]?.list ?? []).map(
      ([time, open, high, low, close, volume]) => ({
        time: parseInt(time),
        open: parseFloat(open),
        high: parseFloat(high),
        low: parseFloat(low),
        close: parseFloat(close),
        volume: parseFloat(volume),
      })
    );
  });

  const fundingHistory = fundingList.map((f) => ({
    rate: parseFloat(f.fundingRate),
    timestamp: parseInt(f.fundingRateTimestamp),
  }));

  const bids = (obRes.b ?? []).map(([p, s]) => [parseFloat(p), parseFloat(s)] as [number, number]);
  const asks = (obRes.a ?? []).map(([p, s]) => [parseFloat(p), parseFloat(s)] as [number, number]);
  const bestBid = bids[0]?.[0] ?? 0;
  const bestAsk = asks[0]?.[0] ?? 0;
  const midPrice = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : 0;
  const spread = bestAsk - bestBid;
  const spreadPct = midPrice > 0 ? spread / midPrice * 100 : 0;
  const orderbook = includeOrderbook
    ? { bestBid, bestAsk, spread, spreadPct, midPrice, bids, asks }
    : { bestBid, bestAsk, spread, spreadPct, midPrice };

  return { ticker, klines, fundingHistory, orderbook };
```

- [ ] **Step 4: Run all market tests to verify they pass**

```bash
cd ~/dev/bybit-mcp && npx jest --testPathPattern="market.test" --no-coverage 2>&1 | grep -E "PASS|FAIL|Tests:" | head -5
```
Expected: all tests pass with no regressions.

- [ ] **Step 5: Commit**

```bash
cd ~/dev/bybit-mcp && git add src/tools/market.ts src/__tests__/market.test.ts && git commit -m "feat: extend handleGetMarketData with xStock branch (category=spot)"
```

---

### Task 7: Expose `category` on `get_market_data` + update all tool descriptions

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add `category` param to `get_market_data` tool schema**

In `src/index.ts`, find the `get_market_data` tool's `inputSchema.properties`. It currently has `symbol`, `klineIntervals`, `klineLimit`, `fundingHistoryLimit`, `includeOrderbook`. Add `category` after `symbol`:

```typescript
            category: {
              type: "string",
              enum: ["linear", "spot"],
              description: "linear (default) for crypto/stock perps/commodity perps. spot for xStock tokens (TSLAXUSDT etc.) — returns price, OHLC, orderbook and NYSE market hours status instead of funding/OI data.",
            },
```

- [ ] **Step 2: Update `get_market_data` description**

Find the current `get_market_data` description string and replace it with:

```
"Get comprehensive market data for a symbol. For linear perpetuals (crypto, stock perps e.g. TSLAPUSDT, commodity perps e.g. XAUUSDT): price, funding rate, next funding time, open interest, klines, funding history, orderbook. For xStock tokens (category=spot, e.g. TSLAXUSDT): price, klines, orderbook, and NYSE market hours status — funding/OI fields are omitted. Use list_tradfi_instruments to discover available TradFi symbols before calling."
```

- [ ] **Step 3: Update `place_trade` description**

Find the current `place_trade` description and append to it:

```
" TradFi: xStock tokens use category=spot (e.g. TSLAXUSDT — tokenized equities). Stock perpetuals and commodity perpetuals use category=linear (e.g. TSLAPUSDT for TSLA perp, XAUUSDT for gold). Always confirm the exact symbol with list_tradfi_instruments first."
```

- [ ] **Step 4: Update `get_ohlc` description**

Find the current `get_ohlc` description and ensure it mentions TradFi. Append:

```
" Works for all TradFi symbols: use category=spot for xStocks (TSLAXUSDT), category=linear for stock/commodity perps (TSLAPUSDT, XAUUSDT)."
```

- [ ] **Step 5: Update `get_market_data` handler to pass `category`**

In the tool dispatch section, find where `get_market_data` is handled. It currently calls `handleGetMarketData(client, symbol, ...)`. Add `category` extraction and pass it through:

```typescript
      // find existing get_market_data dispatch and update to include category:
      const { symbol, klineIntervals, klineLimit, fundingHistoryLimit, includeOrderbook, category: mdCategory } = args as {
        symbol: string;
        klineIntervals?: string[];
        klineLimit?: number;
        fundingHistoryLimit?: number;
        includeOrderbook?: boolean;
        category?: "linear" | "spot";
      };
      result = await handleGetMarketData(
        client, symbol, klineIntervals, klineLimit, fundingHistoryLimit, includeOrderbook,
        mdCategory ?? "linear"
      );
```

- [ ] **Step 6: Build and verify**

```bash
cd ~/dev/bybit-mcp && npx tsc --noEmit 2>&1 | head -10 && npx jest --no-coverage 2>&1 | grep -E "PASS|FAIL|Tests:" | head -5
```
Expected: no type errors; all tests pass.

- [ ] **Step 7: Commit**

```bash
cd ~/dev/bybit-mcp && git add src/index.ts && git commit -m "feat: expose category on get_market_data, update TradFi descriptions"
```

---

## Phase 2 — Account balance (implement after Task 5 findings)

### Task 8: Surface TradFi balance in `get_account_status`

> **⚠️ This task's implementation depends on findings from Task 5 (Phase 0 smoke test).**
> Read the Task 5 notes before implementing.

**Files:**
- Modify: `src/index.ts` (description update — always required)
- Conditionally modify: `src/tools/account.ts` (only if Task 5 reveals USDx is NOT in UNIFIED wallet)

- [ ] **Step 1: Update `get_account_status` description in `src/index.ts`**

Find the current `get_account_status` description and append:

```
" spot_holdings includes xStock token balances (e.g. coin='TSLAX') and any USDx stablecoin balance (coin='USDx' or similar) which is the capital available for xStock trading."
```

- [ ] **Step 2 (conditional): If Task 5 shows USDx is NOT in spot_holdings**

If the Phase 0 smoke test reveals TradFi capital lives in a separate account (not visible in `spot_holdings`), add a separate API call in `handleGetAccountStatus` in `src/tools/account.ts`. The exact endpoint will be known from Task 5 — document it here before implementing. Likely options:
  - An additional `signedGet` to a TradFi-specific balance endpoint
  - Add a `tradfi_balance` field to `AccountStatus`

Implement based on actual findings and add corresponding tests in `src/__tests__/account.test.ts`.

- [ ] **Step 3: Final full test run**

```bash
cd ~/dev/bybit-mcp && npm test 2>&1 | grep -E "PASS|FAIL|Tests:|Suites:" | head -10
```
Expected: all tests pass.

- [ ] **Step 4: Build**

```bash
cd ~/dev/bybit-mcp && npm run build 2>&1 | tail -5
```
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
cd ~/dev/bybit-mcp && git add src/index.ts src/tools/account.ts src/__tests__/account.test.ts && git commit -m "feat: surface TradFi balance in get_account_status"
```
