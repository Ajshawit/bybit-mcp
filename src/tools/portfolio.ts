import { BybitClient } from "../client";
import { PositionListResult, WalletBalanceResult } from "./types";
import {
  BybitOptionPosition, OptionPositionListResult, OptionTickersResult,
  OPTION_MULTIPLIERS, parseOptionSymbol,
} from "./options/types";
import { blackScholesPrice } from "./options/blackscholes";

// Portfolio-level risk: aggregate delta/gamma/vega/theta across perp and
// option positions per underlying, then shock spot × IV to build a scenario
// PnL grid. Turns per-position data into actual risk management.

const DEFAULT_SPOT_SHOCKS_PCT = [-20, -10, -5, 0, 5, 10, 20];
const DEFAULT_IV_SHOCKS_PTS = [-10, 0, 10];
const MAX_SHOCKS = 9;

const r2 = (v: number) => Math.round(v * 100) / 100;
const r4 = (v: number) => Math.round(v * 10000) / 10000;

interface PerpExposure {
  underlying: string;
  symbol: string;
  deltaUnits: number;   // signed, base-coin units
  deltaUsd: number;     // signed
  markPrice: number;
  isInverse: boolean;
}

interface OptionExposure {
  symbol: string;
  underlying: string;
  sideSign: 1 | -1;
  qty: number;
  multiplier: number;
  strike: number;
  type: "call" | "put";
  timeToExpiryYears: number;
  markPrice: number;
  iv: number | null;    // markIv from the chain; null → Taylor fallback
  // Bybit position-level greeks (signed by direction)
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
}

export interface UnderlyingRisk {
  underlying: string;
  spot: number;
  perpDeltaUnits: number;
  perpDeltaUsd: number;
  optionDeltaUnits: number;
  optionDeltaUsd: number;
  netDeltaUsd: number;
  gamma: number;            // Bybit position gamma, summed
  vegaUsdPer1IvPt: number;  // USD PnL per +1 IV point
  thetaUsdPerDay: number;
  positionCount: number;
}

export interface ScenarioCell {
  spotShockPct: number;
  ivShockPts: number;
  pnlUsd: number;
  pnlPctOfEquity: number | null;
}

export interface PortfolioRiskResult {
  equityUsd: number | null;
  byUnderlying: UnderlyingRisk[];
  totals: {
    netDeltaUsd: number;
    grossDeltaUsd: number;       // sum of |netDeltaUsd| per underlying
    vegaUsdPer1IvPt: number;
    thetaUsdPerDay: number;
    grossNotionalUsd: number;
    leverageRatio: number | null;       // grossNotional / equity
    concentrationPct: number | null;    // largest |exposure| share of gross
  };
  scenarios: {
    spotShocksPct: number[];
    ivShocksPts: number[];
    grid: ScenarioCell[];
    worstCase: ScenarioCell | null;
    note: string;
  };
  warnings: string[];
}

// Strip the quote suffix to group perps with their options underlying
// (BTCUSDT + BTC options → "BTC"). Order matters: USDT before USD.
function perpUnderlying(symbol: string): string {
  return symbol.replace(/(USDT|USDC|USD)$/, "") || symbol;
}

function validateShocks(input: number[] | undefined, fallback: number[], label: string): number[] {
  if (input === undefined) return fallback;
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_SHOCKS) {
    throw new Error(`get_portfolio_risk: ${label} must be a non-empty array of at most ${MAX_SHOCKS} numbers`);
  }
  for (const v of input) {
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error(`get_portfolio_risk: ${label} contains a non-numeric value`);
    }
  }
  // Always include 0 so the grid has an anchor row/column.
  return input.includes(0) ? [...input].sort((a, b) => a - b) : [...input, 0].sort((a, b) => a - b);
}

// Option PnL under a spot/IV shock, anchored to the MODEL price at current
// spot/IV (not the market mark) so the zero-shock cell is exactly 0.
function optionShockPnl(opt: OptionExposure, spot: number, spotShockPct: number, ivShockPts: number): number {
  const shockedSpot = spot * (1 + spotShockPct / 100);
  if (opt.iv !== null) {
    const base = blackScholesPrice(opt.type, spot, opt.strike, opt.timeToExpiryYears, opt.iv);
    const shocked = blackScholesPrice(
      opt.type, shockedSpot, opt.strike, opt.timeToExpiryYears,
      Math.max(opt.iv + ivShockPts / 100, 0.0001)
    );
    return (shocked - base) * opt.qty * opt.multiplier * opt.sideSign;
  }
  // Taylor fallback from Bybit position greeks (delta/gamma are already
  // position-level and signed): dPnL ≈ Δ·dS + ½Γ·dS² + vega·dIVpts.
  const dS = shockedSpot - spot;
  return opt.delta * dS + 0.5 * opt.gamma * dS * dS + opt.vega * ivShockPts;
}

export async function handleGetPortfolioRisk(
  client: BybitClient,
  enableOptions: boolean,
  params: { spotShocksPct?: number[]; ivShocksPts?: number[] } = {}
): Promise<PortfolioRiskResult> {
  const spotShocks = validateShocks(params.spotShocksPct, DEFAULT_SPOT_SHOCKS_PCT, "spotShocksPct");
  const warnings: string[] = [];

  const [walletRes, linearRes, inverseRes, optionRes] = await Promise.all([
    client.signedGet<WalletBalanceResult>("/v5/account/wallet-balance", { accountType: "UNIFIED" })
      .catch(() => null),
    client.signedGet<PositionListResult>("/v5/position/list", { category: "linear", settleCoin: "USDT" }),
    client.signedGet<PositionListResult>("/v5/position/list", { category: "inverse" }),
    enableOptions
      ? client.signedGet<OptionPositionListResult>("/v5/position/list", { category: "option" })
      : Promise.resolve({ list: [] as BybitOptionPosition[] }),
  ]);

  const equityUsd = (() => {
    const raw = walletRes?.list?.[0]?.totalEquity;
    const v = raw !== undefined ? parseFloat(raw) : NaN;
    return Number.isFinite(v) ? r2(v) : null;
  })();
  if (equityUsd === null) warnings.push("Equity unavailable — pnlPctOfEquity and leverageRatio omitted.");

  // ---- Perp exposures -------------------------------------------------
  const perps: PerpExposure[] = [];
  for (const p of linearRes.list ?? []) {
    const size = parseFloat(p.size);
    if (!(size > 0) || p.side === "None") continue;
    const mark = parseFloat(p.markPrice);
    const sign = p.side === "Buy" ? 1 : -1;
    perps.push({
      underlying: perpUnderlying(p.symbol),
      symbol: p.symbol,
      deltaUnits: sign * size,
      deltaUsd: sign * size * mark,
      markPrice: mark,
      isInverse: false,
    });
  }
  for (const p of inverseRes.list ?? []) {
    const size = parseFloat(p.size); // inverse size = USD contracts
    if (!(size > 0) || p.side === "None") continue;
    const mark = parseFloat(p.markPrice);
    const sign = p.side === "Buy" ? 1 : -1;
    perps.push({
      underlying: perpUnderlying(p.symbol),
      symbol: p.symbol,
      deltaUnits: mark > 0 ? sign * size / mark : 0,
      deltaUsd: sign * size,
      markPrice: mark,
      isInverse: true,
    });
  }
  if (perps.some((p) => p.isInverse)) {
    warnings.push("Inverse perp delta is a USD-notional approximation (coin-margined PnL convexity ignored).");
  }

  // ---- Option exposures ------------------------------------------------
  const optionPositions = (optionRes.list ?? []).filter(
    (p) => p.side !== "None" && parseFloat(p.size) > 0
  );
  const optionUnderlyings = new Set<string>();
  const parsedOptions: Array<{ pos: BybitOptionPosition; parsed: ReturnType<typeof parseOptionSymbol> }> = [];
  for (const pos of optionPositions) {
    try {
      const parsed = parseOptionSymbol(pos.symbol);
      parsedOptions.push({ pos, parsed });
      optionUnderlyings.add(parsed.underlying);
    } catch {
      warnings.push(`Skipped option position with unparseable symbol: ${pos.symbol}`);
    }
  }

  // One chain fetch per underlying with option positions: markIv + spot.
  const ivBySymbol = new Map<string, number>();
  const spotByUnderlying = new Map<string, number>();
  await Promise.all(
    Array.from(optionUnderlyings).map(async (u) => {
      try {
        const chain = await client.publicGet<OptionTickersResult>("/v5/market/tickers", {
          category: "option", baseCoin: u,
        });
        for (const t of chain.list ?? []) {
          const iv = parseFloat(t.markIv);
          if (Number.isFinite(iv) && iv > 0) ivBySymbol.set(t.symbol, iv);
          const up = t.underlyingPrice ? parseFloat(t.underlyingPrice) : NaN;
          if (!spotByUnderlying.has(u) && Number.isFinite(up) && up > 0) spotByUnderlying.set(u, up);
        }
      } catch {
        warnings.push(`Option chain fetch failed for ${u} — its legs use the Taylor (greeks) approximation.`);
      }
    })
  );

  const now = Date.now();
  const options: OptionExposure[] = [];
  const taylorSymbols: string[] = [];
  for (const { pos, parsed } of parsedOptions) {
    const qty = parseFloat(pos.size);
    const sideSign: 1 | -1 = pos.side === "Buy" ? 1 : -1;
    const iv = ivBySymbol.get(pos.symbol) ?? null;
    if (iv === null) taylorSymbols.push(pos.symbol);
    options.push({
      symbol: pos.symbol,
      underlying: parsed.underlying,
      sideSign,
      qty,
      multiplier: OPTION_MULTIPLIERS[parsed.underlying] ?? 1,
      strike: parsed.strike,
      type: parsed.type,
      timeToExpiryYears: Math.max((parsed.expiry.getTime() - now) / (365 * 86400000), 0),
      markPrice: parseFloat(pos.markPrice),
      iv,
      delta: parseFloat(pos.delta ?? "0"),
      gamma: parseFloat(pos.gamma ?? "0"),
      theta: parseFloat(pos.theta ?? "0"),
      vega: parseFloat(pos.vega ?? "0"),
    });
  }
  if (taylorSymbols.length > 0) {
    warnings.push(
      `No markIv found for ${taylorSymbols.join(", ")} — scenario PnL for these legs uses the ` +
      `delta/gamma/vega Taylor approximation (less accurate for large shocks).`
    );
  }

  // ---- Per-underlying aggregation --------------------------------------
  const underlyings = new Map<string, UnderlyingRisk>();
  const getBucket = (u: string, spot: number): UnderlyingRisk => {
    const existing = underlyings.get(u);
    if (existing) {
      // Prefer a real spot over a 0 placeholder if one arrives later.
      if (existing.spot === 0 && spot > 0) existing.spot = spot;
      return existing;
    }
    const fresh: UnderlyingRisk = {
      underlying: u, spot, perpDeltaUnits: 0, perpDeltaUsd: 0,
      optionDeltaUnits: 0, optionDeltaUsd: 0, netDeltaUsd: 0,
      gamma: 0, vegaUsdPer1IvPt: 0, thetaUsdPerDay: 0, positionCount: 0,
    };
    underlyings.set(u, fresh);
    return fresh;
  };

  for (const p of perps) {
    const bucket = getBucket(p.underlying, spotByUnderlying.get(p.underlying) ?? p.markPrice);
    bucket.perpDeltaUnits += p.deltaUnits;
    bucket.perpDeltaUsd += p.deltaUsd;
    bucket.positionCount++;
  }
  for (const o of options) {
    const spot = spotByUnderlying.get(o.underlying) ?? 0;
    const bucket = getBucket(o.underlying, spot);
    bucket.optionDeltaUnits += o.delta; // Bybit delta is position-level, signed
    bucket.optionDeltaUsd += o.delta * (bucket.spot || 0);
    bucket.gamma += o.gamma;
    bucket.vegaUsdPer1IvPt += o.vega;
    bucket.thetaUsdPerDay += o.theta;
    bucket.positionCount++;
  }
  for (const b of underlyings.values()) {
    b.netDeltaUsd = b.perpDeltaUsd + b.optionDeltaUsd;
  }
  const optionsMissingSpot = options.filter((o) => !((spotByUnderlying.get(o.underlying) ?? 0) > 0));
  if (optionsMissingSpot.length > 0) {
    warnings.push(
      `No underlying spot for ${[...new Set(optionsMissingSpot.map((o) => o.underlying))].join(", ")} — ` +
      `option delta USD and BS scenario repricing degrade to greeks-only for those legs.`
    );
  }

  // ---- Totals ----------------------------------------------------------
  const byUnderlying = Array.from(underlyings.values())
    .map((b) => ({
      ...b,
      perpDeltaUnits: r4(b.perpDeltaUnits),
      perpDeltaUsd: r2(b.perpDeltaUsd),
      optionDeltaUnits: r4(b.optionDeltaUnits),
      optionDeltaUsd: r2(b.optionDeltaUsd),
      netDeltaUsd: r2(b.netDeltaUsd),
      gamma: r4(b.gamma),
      vegaUsdPer1IvPt: r2(b.vegaUsdPer1IvPt),
      thetaUsdPerDay: r2(b.thetaUsdPerDay),
    }))
    .sort((a, b) => Math.abs(b.netDeltaUsd) - Math.abs(a.netDeltaUsd));

  const netDeltaUsd = byUnderlying.reduce((s, b) => s + b.netDeltaUsd, 0);
  const grossDeltaUsd = byUnderlying.reduce((s, b) => s + Math.abs(b.netDeltaUsd), 0);
  const perpNotional = perps.reduce((s, p) => s + Math.abs(p.deltaUsd), 0);
  const optionNotional = options.reduce(
    (s, o) => s + o.qty * o.multiplier * (spotByUnderlying.get(o.underlying) ?? 0), 0
  );
  const grossNotionalUsd = perpNotional + optionNotional;
  const largestExposure = byUnderlying.reduce((m, b) => Math.max(m, Math.abs(b.netDeltaUsd)), 0);

  // ---- Scenario grid ----------------------------------------------------
  const hasOptions = options.length > 0;
  const ivShocks = hasOptions
    ? validateShocks(params.ivShocksPts, DEFAULT_IV_SHOCKS_PTS, "ivShocksPts")
    : [0];

  const grid: ScenarioCell[] = [];
  for (const s of spotShocks) {
    for (const v of ivShocks) {
      let pnl = 0;
      // Linear perps are linear in spot — delta×shock is exact. Inverse is
      // the documented approximation.
      for (const p of perps) pnl += p.deltaUsd * (s / 100);
      for (const o of options) {
        const spot = spotByUnderlying.get(o.underlying) ?? 0;
        if (spot > 0) {
          pnl += optionShockPnl(o, spot, s, v);
        } else {
          // No price level to shock against — vega term is all that survives.
          pnl += o.vega * v;
        }
      }
      grid.push({
        spotShockPct: s,
        ivShockPts: v,
        pnlUsd: r2(pnl),
        pnlPctOfEquity: equityUsd !== null && equityUsd > 0 ? r2((pnl / equityUsd) * 100) : null,
      });
    }
  }
  const worstCase = grid.length > 0
    ? grid.reduce((w, c) => (c.pnlUsd < w.pnlUsd ? c : w))
    : null;

  if (perps.length === 0 && options.length === 0) {
    warnings.push("No open positions — portfolio risk is flat.");
  }

  return {
    equityUsd,
    byUnderlying,
    totals: {
      netDeltaUsd: r2(netDeltaUsd),
      grossDeltaUsd: r2(grossDeltaUsd),
      vegaUsdPer1IvPt: r2(byUnderlying.reduce((s, b) => s + b.vegaUsdPer1IvPt, 0)),
      thetaUsdPerDay: r2(byUnderlying.reduce((s, b) => s + b.thetaUsdPerDay, 0)),
      grossNotionalUsd: r2(grossNotionalUsd),
      leverageRatio: equityUsd !== null && equityUsd > 0 ? r2(grossNotionalUsd / equityUsd) : null,
      concentrationPct: grossDeltaUsd > 0 ? r2((largestExposure / grossDeltaUsd) * 100) : null,
    },
    scenarios: {
      spotShocksPct: spotShocks,
      ivShocksPts: ivShocks,
      grid,
      worstCase,
      note:
        "Instantaneous shock: options repriced via Black-Scholes at shocked spot/IV with time held " +
        "constant (no theta decay applied); zero-shock cell is 0 by construction. Spot shocks move " +
        "every underlying simultaneously (worst case assumes correlation 1).",
    },
    warnings,
  };
}
