#!/usr/bin/env node
// Live drift probe: asserts Bybit public V5 endpoints still return the fields this server reads.
// Zero deps (Node >=18 global fetch). Exit 1 on any failure.
// Override lets CI route around Bybit's US geo-block (GitHub runners) without a code change.
const BASE = process.env.BYBIT_PROBE_BASE ?? "https://api.bybit.com";
const TIMEOUT_MS = 15_000;
const GAP_MS = 150;

// Must match OPTION_UNDERLYINGS in src/tools/options/types.ts.
const OPTION_UNDERLYINGS = [
  "BTC", "ETH", "SOL", "XAUT", "HYPE", "XRP", "MNT", "DOGE",
  "SPCX", "NVDA", "SNDK", "QQQ", "SKHY", "MU", "TSLA", "SOXL",
];

const getPath = (obj, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

const missing = (obj, paths) => paths.filter((p) => getPath(obj, p) === undefined);
const first = (result) => result?.list?.[0];
const isArrayOfLen = (v, min, exact) =>
  Array.isArray(v) && (exact ? v.length === min : v.length >= min);

let failures = 0;
console.log(`base: ${BASE}`);

// check(result) returns an array of problem strings (empty = ok).
async function probe(path, check) {
  let problems;
  try {
    const res = await fetch(BASE + path, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text();
    // Raw-response context so geo-block / CDN pages are visible in CI logs.
    const raw = () => `[http ${res.status} ${res.headers.get("content-type")}] ${text.slice(0, 160).replace(/\s+/g, " ")}`;
    let body;
    try {
      body = JSON.parse(text);
    } catch (err) {
      throw new Error(`bad JSON (${err.message}) ${raw()}`);
    }
    problems = body.retCode === 0
      ? check(body.result)
      : [`retCode=${body.retCode} ${body.retMsg} ${raw()}`];
  } catch (err) {
    problems = [`request error: ${err.message}`];
  }
  if (problems.length) failures++;
  console.log(`${problems.length ? "FAIL" : "ok  "} ${path}${problems.length ? "  -> " + problems.join(", ") : ""}`);
  await new Promise((r) => setTimeout(r, GAP_MS));
}

const fieldsOnResult = (...paths) => (r) => missing(r, paths).map((p) => `missing ${p}`);
const fieldsOnFirst = (...paths) => (r) =>
  first(r) === undefined ? ["empty list"] : missing(first(r), paths).map((p) => `missing ${p}`);
const listAtLeast = (n) => (r) => ((r?.list?.length ?? 0) >= n ? [] : [`list length < ${n}`]);
const firstIsArray = (len, exact) => (r) =>
  isArrayOfLen(first(r), len, exact) ? [] : [`list[0] not array of length ${exact ? "" : ">="}${len}`];

await probe("/v5/market/time", fieldsOnResult("timeSecond"));
await probe("/v5/market/tickers?category=linear&symbol=BTCUSDT", fieldsOnFirst(
  "symbol", "lastPrice", "markPrice", "indexPrice", "price24hPcnt", "fundingRate", "nextFundingTime",
  "openInterest", "openInterestValue", "turnover24h", "volume24h", "highPrice24h", "lowPrice24h",
  "prevPrice24h", "bid1Price", "ask1Price"));
await probe("/v5/market/tickers?category=spot&symbol=BTCUSDT", fieldsOnFirst(
  "symbol", "lastPrice", "price24hPcnt", "turnover24h", "bid1Price", "ask1Price"));
await probe("/v5/market/tickers?category=option&baseCoin=BTC", fieldsOnFirst(
  "symbol", "markIv", "underlyingPrice", "openInterest", "bid1Price", "ask1Price", "markPrice",
  "lastPrice", "volume24h", "delta", "gamma", "theta", "vega"));
await probe("/v5/market/tickers?category=option&baseCoin=TSLA", fieldsOnFirst("symbol", "markIv", "underlyingPrice"));
await probe("/v5/market/kline?category=linear&symbol=BTCUSDT&interval=60&limit=2", firstIsArray(7, true));
await probe("/v5/market/orderbook?category=linear&symbol=BTCUSDT&limit=5", (r) => [
  ...(Array.isArray(r?.b) ? [] : ["b not array"]),
  ...(Array.isArray(r?.a) ? [] : ["a not array"]),
  ...(isArrayOfLen(r?.b?.[0], 2, true) ? [] : ["b[0] not [price, size]"]),
]);
await probe("/v5/market/funding/history?category=linear&symbol=BTCUSDT&limit=2",
  fieldsOnFirst("fundingRate", "fundingRateTimestamp"));
await probe("/v5/market/open-interest?category=linear&symbol=BTCUSDT&intervalTime=4h&limit=2",
  fieldsOnFirst("openInterest", "timestamp"));
await probe("/v5/market/account-ratio?category=linear&symbol=BTCUSDT&period=1h&limit=2",
  fieldsOnFirst("buyRatio", "sellRatio", "timestamp"));
await probe("/v5/market/instruments-info?category=linear&symbol=BTCUSDT", fieldsOnFirst(
  "priceFilter.tickSize", "lotSizeFilter.qtyStep", "lotSizeFilter.minOrderQty",
  "lotSizeFilter.minNotionalValue", "fundingInterval", "deliveryTime", "symbolType", "fullName", "marketRegion"));
await probe("/v5/market/instruments-info?category=spot&symbol=BTCUSDT", fieldsOnFirst(
  "priceFilter.tickSize", "lotSizeFilter.basePrecision", "lotSizeFilter.minOrderQty"));
await probe("/v5/market/instruments-info?category=option&baseCoin=BTC&limit=1", fieldsOnFirst(
  "symbol", "deliveryTime", "priceFilter.tickSize", "lotSizeFilter.qtyStep"));
await probe("/v5/market/instruments-info?category=linear&symbolType=stock&limit=1", listAtLeast(1));
await probe("/v5/market/instruments-info?category=spot&symbolType=xstocks&limit=1", listAtLeast(1));
await probe("/v5/market/premium-index-price-kline?category=linear&symbol=BTCUSDT&interval=5&limit=2", firstIsArray(5, false));
await probe("/v5/market/option-base-coins", (r) => {
  const live = (r?.list ?? []).map((c) => c.baseCoin);
  const extra = live.filter((c) => !OPTION_UNDERLYINGS.includes(c));
  if (extra.length) console.log(`warn new option base coins not in OPTION_UNDERLYINGS: ${extra.join(" ")}`);
  return [
    ...(live.length >= OPTION_UNDERLYINGS.length ? [] : [`list length ${live.length} < ${OPTION_UNDERLYINGS.length}`]),
    ...OPTION_UNDERLYINGS.filter((c) => !live.includes(c)).map((c) => `missing baseCoin ${c}`),
  ];
});

console.log(failures ? `\n${failures} probe(s) FAILED` : "\nall probes ok");
process.exit(failures ? 1 : 0);
