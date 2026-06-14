import { BybitClient } from "../client";
import {
  ClosedTrade, ClosedPnlCategory, BybitClosedPnlResult, mapClosedPnl,
} from "./orders";

// Closed-trade performance analytics: win rate, profit factor, expectancy,
// Sharpe/Sortino on daily PnL, max drawdown, per-symbol and long/short
// attribution. Read-only; aggregates the same /v5/position/closed-pnl data
// get_closed_trades returns raw.

const MAX_WINDOW_MS = 7 * 86400000; // Bybit limits closed-pnl queries to 7-day spans
const PAGE_LIMIT = 100;
const MAX_TRADES = 1000;            // hard cap on records aggregated per call
const MAX_DAYS_BACK = 180;
const DAYS_PER_YEAR = 365;          // crypto trades every day

const r2 = (v: number) => Math.round(v * 100) / 100;
const r4 = (v: number) => Math.round(v * 10000) / 10000;

export interface SideStats {
  trades: number;
  wins: number;
  winRate: number | null;
  totalPnlUsd: number;
}

export interface PerformanceStats {
  tradesAnalyzed: number;
  wins: number;
  losses: number;
  breakevens: number;
  winRate: number | null;            // wins / (wins + losses)
  totalPnlUsd: number;
  grossProfitUsd: number;
  grossLossUsd: number;              // positive magnitude
  profitFactor: number | null;       // null when there are no losses
  expectancyUsd: number | null;      // mean PnL per trade
  avgWinUsd: number | null;
  avgLossUsd: number | null;         // positive magnitude
  payoffRatio: number | null;        // avgWin / avgLoss
  largestWinUsd: number | null;
  largestLossUsd: number | null;     // negative number
  dailyPnl: {
    days: number;
    meanUsd: number | null;
    stdUsd: number | null;
    // Computed on the daily USD PnL series, NOT percent returns — these scale
    // with account size and are not comparable to return-based Sharpe/Sortino
    // or across accounts. Consistent within one account at constant sizing.
    sharpeAnnualizedUsdPnl: number | null;   // mean/std · √365 (sample std)
    sortinoAnnualizedUsdPnl: number | null;  // mean/downsideDev · √365 (target 0, sample denominator)
  };
  tradesDroppedInvalidTimestamp?: number;
  maxDrawdown: {
    maxDrawdownUsd: number;            // peak-to-trough on cumulative PnL
    peakCumPnlUsd: number;
    troughCumPnlUsd: number;
  };
  perSymbol: Array<{ symbol: string; trades: number; wins: number; winRate: number | null; totalPnlUsd: number }>;
  longShort: { long: SideStats; short: SideStats };
  holdTime: { avgHours: number | null; medianHours: number | null };
}

export interface PerformanceResult {
  category: ClosedPnlCategory;
  symbol?: string;
  period: { from: string; to: string; daysBack: number };
  tradesAnalyzed: number;
  truncated: boolean;
  stats: PerformanceStats;
  dataNote?: string;
}

function sideStats(trades: ClosedTrade[]): SideStats {
  const wins = trades.filter((t) => t.closedPnl > 0).length;
  const decided = trades.filter((t) => t.closedPnl !== 0).length;
  return {
    trades: trades.length,
    wins,
    winRate: decided > 0 ? r4(wins / decided) : null,
    totalPnlUsd: r2(trades.reduce((s, t) => s + t.closedPnl, 0)),
  };
}

function median(sortedAsc: number[]): number | null {
  if (sortedAsc.length === 0) return null;
  const mid = Math.floor(sortedAsc.length / 2);
  return sortedAsc.length % 2 === 0
    ? (sortedAsc[mid - 1] + sortedAsc[mid]) / 2
    : sortedAsc[mid];
}

export function computePerformanceStats(trades: ClosedTrade[]): PerformanceStats {
  // A malformed Bybit timestamp maps to closedAt = "" (NaN sort key) — it
  // would scramble the drawdown ordering and daily grouping silently.
  const valid = trades.filter((t) => t.closedAt.length > 0);
  const droppedInvalid = trades.length - valid.length;
  const sorted = [...valid].sort(
    (a, b) => new Date(a.closedAt).getTime() - new Date(b.closedAt).getTime()
  );

  const winTrades = sorted.filter((t) => t.closedPnl > 0);
  const lossTrades = sorted.filter((t) => t.closedPnl < 0);
  const breakevens = sorted.length - winTrades.length - lossTrades.length;
  const decided = winTrades.length + lossTrades.length;

  const grossProfit = winTrades.reduce((s, t) => s + t.closedPnl, 0);
  const grossLoss = -lossTrades.reduce((s, t) => s + t.closedPnl, 0);
  const totalPnl = grossProfit - grossLoss;
  const avgWin = winTrades.length > 0 ? grossProfit / winTrades.length : null;
  const avgLoss = lossTrades.length > 0 ? grossLoss / lossTrades.length : null;

  // Daily PnL series (UTC dates) → Sharpe / Sortino.
  const byDay = new Map<string, number>();
  for (const t of sorted) {
    const day = t.closedAt.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + t.closedPnl);
  }
  const daily = [...byDay.values()];
  const mean = daily.length > 0 ? daily.reduce((s, v) => s + v, 0) / daily.length : null;
  let std: number | null = null;
  if (daily.length >= 2 && mean !== null) {
    const ss = daily.reduce((s, v) => s + (v - mean) * (v - mean), 0);
    std = Math.sqrt(ss / (daily.length - 1));
  }
  const sharpe = mean !== null && std !== null && std > 0
    ? (mean / std) * Math.sqrt(DAYS_PER_YEAR)
    : null;
  let sortino: number | null = null;
  if (mean !== null && daily.length >= 2) {
    const downSq = daily.reduce((s, v) => s + (v < 0 ? v * v : 0), 0);
    // Sample denominator (n-1) to match the Sharpe std convention above.
    const downsideDev = Math.sqrt(downSq / (daily.length - 1));
    sortino = downsideDev > 0 ? (mean / downsideDev) * Math.sqrt(DAYS_PER_YEAR) : null;
  }

  // Max drawdown on the cumulative PnL curve, trade by trade.
  let cum = 0;
  let peak = 0;
  let maxDd = 0;
  let ddPeak = 0;
  let ddTrough = 0;
  for (const t of sorted) {
    cum += t.closedPnl;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDd) {
      maxDd = dd;
      ddPeak = peak;
      ddTrough = cum;
    }
  }

  const bySymbol = new Map<string, ClosedTrade[]>();
  for (const t of sorted) {
    bySymbol.set(t.symbol, [...(bySymbol.get(t.symbol) ?? []), t]);
  }
  const perSymbol = [...bySymbol.entries()]
    .map(([symbol, ts]) => {
      const s = sideStats(ts);
      return { symbol, trades: s.trades, wins: s.wins, winRate: s.winRate, totalPnlUsd: s.totalPnlUsd };
    })
    .sort((a, b) => b.totalPnlUsd - a.totalPnlUsd);

  const holdHours = sorted.map((t) => t.holdSeconds / 3600).sort((a, b) => a - b);
  const avgHold = holdHours.length > 0
    ? holdHours.reduce((s, v) => s + v, 0) / holdHours.length
    : null;
  const medianHold = median(holdHours);

  return {
    tradesAnalyzed: sorted.length,
    wins: winTrades.length,
    losses: lossTrades.length,
    breakevens,
    winRate: decided > 0 ? r4(winTrades.length / decided) : null,
    totalPnlUsd: r2(totalPnl),
    grossProfitUsd: r2(grossProfit),
    grossLossUsd: r2(grossLoss),
    profitFactor: grossLoss > 0 ? r4(grossProfit / grossLoss) : null,
    expectancyUsd: sorted.length > 0 ? r4(totalPnl / sorted.length) : null,
    avgWinUsd: avgWin !== null ? r4(avgWin) : null,
    avgLossUsd: avgLoss !== null ? r4(avgLoss) : null,
    payoffRatio: avgWin !== null && avgLoss !== null && avgLoss > 0 ? r4(avgWin / avgLoss) : null,
    largestWinUsd: winTrades.length > 0 ? r2(Math.max(...winTrades.map((t) => t.closedPnl))) : null,
    largestLossUsd: lossTrades.length > 0 ? r2(Math.min(...lossTrades.map((t) => t.closedPnl))) : null,
    dailyPnl: {
      days: daily.length,
      meanUsd: mean !== null ? r4(mean) : null,
      stdUsd: std !== null ? r4(std) : null,
      sharpeAnnualizedUsdPnl: sharpe !== null ? r4(sharpe) : null,
      sortinoAnnualizedUsdPnl: sortino !== null ? r4(sortino) : null,
    },
    ...(droppedInvalid > 0 ? { tradesDroppedInvalidTimestamp: droppedInvalid } : {}),
    maxDrawdown: {
      maxDrawdownUsd: r2(maxDd),
      peakCumPnlUsd: r2(ddPeak),
      troughCumPnlUsd: r2(ddTrough),
    },
    perSymbol,
    longShort: {
      long: sideStats(sorted.filter((t) => t.positionSide === "LONG")),
      short: sideStats(sorted.filter((t) => t.positionSide === "SHORT")),
    },
    holdTime: {
      avgHours: avgHold !== null ? r2(avgHold) : null,
      medianHours: medianHold !== null ? r2(medianHold) : null,
    },
  };
}

/**
 * Fetch closed-PnL records across an arbitrary period by chunking it into
 * Bybit's 7-day maximum query windows (newest first, so the cap keeps the
 * most recent trades) and following the pagination cursor within each.
 */
async function fetchClosedTradesWindow(
  client: BybitClient,
  params: { category: ClosedPnlCategory; symbol?: string; startMs: number; endMs: number }
): Promise<{ trades: ClosedTrade[]; truncated: boolean }> {
  const trades: ClosedTrade[] = [];
  let truncated = false;

  for (let winEnd = params.endMs; winEnd > params.startMs && !truncated; ) {
    const winStart = Math.max(params.startMs, winEnd - MAX_WINDOW_MS + 1);
    let cursor: string | undefined;
    do {
      const query: Record<string, string> = {
        category: params.category,
        limit: String(PAGE_LIMIT),
        startTime: String(winStart),
        endTime: String(winEnd),
        ...(params.symbol ? { symbol: params.symbol } : {}),
        ...(cursor ? { cursor } : {}),
      };
      const res = await client.signedGet<BybitClosedPnlResult>("/v5/position/closed-pnl", query);
      trades.push(...(res.list ?? []).map(mapClosedPnl));
      cursor = res.nextPageCursor || undefined;
      if (trades.length >= MAX_TRADES) {
        truncated = true;
        break;
      }
    } while (cursor);
    winEnd = winStart - 1;
  }

  return { trades: trades.slice(0, MAX_TRADES), truncated };
}

export async function handleGetPerformanceStats(
  client: BybitClient,
  params: { category?: ClosedPnlCategory; symbol?: string; daysBack?: number }
): Promise<PerformanceResult> {
  const category = params.category ?? "linear";
  const daysBack = params.daysBack ?? 30;
  if (!(Number.isFinite(daysBack) && daysBack >= 1 && daysBack <= MAX_DAYS_BACK)) {
    throw new Error(`get_performance_stats: daysBack must be between 1 and ${MAX_DAYS_BACK}`);
  }

  const endMs = Date.now();
  const startMs = endMs - daysBack * 86400000;
  const { trades, truncated } = await fetchClosedTradesWindow(client, {
    category, symbol: params.symbol, startMs, endMs,
  });

  const stats = computePerformanceStats(trades);

  const notes: string[] = [];
  if (trades.length === 0) {
    notes.push(`No closed trades found in the last ${daysBack} day(s) for category '${category}'.`);
  }
  if (truncated) {
    notes.push(
      `Hit the ${MAX_TRADES}-trade cap — stats cover the most recent ${MAX_TRADES} trades, not the full period.`
    );
  }
  if (stats.tradesDroppedInvalidTimestamp) {
    notes.push(
      `${stats.tradesDroppedInvalidTimestamp} trade(s) had unparseable timestamps and were excluded from all stats.`
    );
  }
  if (stats.dailyPnl.sharpeAnnualizedUsdPnl !== null || stats.dailyPnl.sortinoAnnualizedUsdPnl !== null) {
    notes.push(
      "Sharpe/Sortino are computed on daily USD PnL (not returns) — they scale with account size and are not comparable to return-based ratios."
    );
  }

  return {
    category,
    ...(params.symbol ? { symbol: params.symbol } : {}),
    period: {
      from: new Date(startMs).toISOString(),
      to: new Date(endMs).toISOString(),
      daysBack,
    },
    tradesAnalyzed: stats.tradesAnalyzed,
    truncated,
    stats,
    ...(notes.length > 0 ? { dataNote: notes.join(" ") } : {}),
  };
}
