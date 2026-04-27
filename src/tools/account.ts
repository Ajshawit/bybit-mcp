import { BybitClient } from "../client";
import { WalletBalanceResult, PositionListResult, SpotHolding } from "./types";
import {
  parseOptionSymbol, OPTION_MULTIPLIERS, OptionPosition,
  BybitOptionPosition, OptionPositionListResult,
} from "./options/types";

export interface AccountPosition {
  symbol: string;
  side: "LONG" | "SHORT";
  size: number;
  entryPrice: number;
  markPrice: number;
  uPnl: number;
  uPnlPct: number;
  sl: number | null;
  tp: number | null;
  trailingStop: number;
  liquidationPrice: number | null;
  positionIdx: 0 | 1 | 2;
}

export interface AccountStatus {
  totalEquity: number;
  freeCapital: number;
  marginInUse: number;
  marginReservedForOrders: number;
  unrealisedPnl: number;
  maintenanceMargin: number;
  positions: AccountPosition[];
  inverse_positions: AccountPosition[];
  spot_holdings: SpotHolding[];
  option_positions: OptionPosition[];  // always present; empty array when none or options disabled
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const r4 = (v: number) => Math.round(v * 10000) / 10000;

function rPrice(v: number): number {
  if (v < 0.01) return Math.round(v * 1_000_000) / 1_000_000;
  if (v < 1)    return Math.round(v * 100_000) / 100_000;
  if (v < 100)  return Math.round(v * 10_000) / 10_000;
  return Math.round(v * 100) / 100;
}

function mapPositions(list: PositionListResult["list"]): AccountPosition[] {
  return list
    .filter((p) => parseFloat(p.size) > 0)
    .map((p) => {
      const side = p.side === "Buy" ? "LONG" : "SHORT";
      const entry = parseFloat(p.avgPrice);
      const mark = parseFloat(p.markPrice);
      const uPnl = parseFloat(p.unrealisedPnl);
      const uPnlPct = side === "LONG"
        ? (mark - entry) / entry * 100
        : (entry - mark) / entry * 100;
      return {
        symbol: p.symbol, side, size: parseFloat(p.size),
        entryPrice: rPrice(entry), markPrice: rPrice(mark), uPnl: r2(uPnl), uPnlPct: r2(uPnlPct),
        sl: p.stopLoss ? rPrice(parseFloat(p.stopLoss)) : null,
        tp: p.takeProfit ? rPrice(parseFloat(p.takeProfit)) : null,
        trailingStop: rPrice(parseFloat(p.trailingStop || "0")),
        liquidationPrice: (() => { const v = parseFloat(p.liquidationPrice); return v > 0 ? rPrice(v) : null; })(),
        positionIdx: p.positionIdx,
      };
    });
}

function mapOptionPositions(list: BybitOptionPosition[]): OptionPosition[] {
  return list
    .filter((pos) => pos.side !== "None" && parseFloat(pos.size) > 0)
    .map((pos) => {
      const parsed = parseOptionSymbol(pos.symbol);
      const multiplier = OPTION_MULTIPLIERS[parsed.underlying] ?? 1;
      const side: "Long" | "Short" = pos.side === "Buy" ? "Long" : "Short";
      const qty = parseFloat(pos.size);
      const entryPrice = parseFloat(pos.avgPrice);
      const markPrice = parseFloat(pos.markPrice);
      const premiumFlow = side === "Long"
        ? entryPrice * qty * multiplier
        : -(entryPrice * qty * multiplier);
      const currentValue = markPrice * qty * multiplier;
      const unrealisedPnl = side === "Long"
        ? currentValue - premiumFlow
        : -premiumFlow - currentValue;
      const unrealisedPnlPct = premiumFlow !== 0
        ? (unrealisedPnl / Math.abs(premiumFlow)) * 100
        : 0;
      const realisedPnl = parseFloat(pos.cumRealisedPnl || "0");
      const totalPnl = unrealisedPnl + realisedPnl;
      const daysToExpiry = Math.max(0, Math.round((parsed.expiry.getTime() - Date.now()) / 86400000));
      const breakeven = parsed.type === "call"
        ? parsed.strike + Math.abs(premiumFlow) / (qty * multiplier)
        : parsed.strike - Math.abs(premiumFlow) / (qty * multiplier);
      return {
        symbol: pos.symbol,
        underlying: parsed.underlying,
        side,
        qty,
        entryPrice: r2(entryPrice),
        markPrice: r2(markPrice),
        premiumFlow: r2(premiumFlow),
        currentValue: r2(currentValue),
        unrealisedPnl: r2(unrealisedPnl),
        unrealisedPnlPct: r2(unrealisedPnlPct),
        realisedPnl: r2(realisedPnl),
        totalPnl: r2(totalPnl),
        greeks: {
          delta: r4(parseFloat(pos.delta ?? "0")),
          gamma: r4(parseFloat(pos.gamma ?? "0")),
          theta: r4(parseFloat(pos.theta ?? "0")),
          vega: r4(parseFloat(pos.vega ?? "0")),
        },
        daysToExpiry,
        breakeven: r2(breakeven),
      };
    });
}

export async function handleGetAccountStatus(
  client: BybitClient,
  includeOptions = false
): Promise<AccountStatus> {
  const [walletRes, linearRes, inverseRes, optionRes] = await Promise.all([
    client.signedGet<WalletBalanceResult>("/v5/account/wallet-balance", { accountType: "UNIFIED" }),
    client.signedGet<PositionListResult>("/v5/position/list", { category: "linear", settleCoin: "USDT" }),
    client.signedGet<PositionListResult>("/v5/position/list", { category: "inverse", settleCoin: "USD" }),
    includeOptions
      ? client.signedGet<OptionPositionListResult>("/v5/position/list", { category: "option" })
      : Promise.resolve({ list: [] as BybitOptionPosition[] }),
  ]);

  const account = walletRes.list[0];
  const usdtCoin = account.coin.find((c) => c.coin === "USDT");
  if (!usdtCoin) throw new Error("USDT coin not found in wallet balance response");

  const walletBalance = parseFloat(usdtCoin.walletBalance);
  const totalPositionIM = parseFloat(usdtCoin.totalPositionIM);
  const totalOrderIM = parseFloat(usdtCoin.totalOrderIM ?? "0");
  const unrealisedPnl = parseFloat(usdtCoin.unrealisedPnl);

  const spot_holdings: SpotHolding[] = account.coin
    .filter((c) => c.coin !== "USDT" && parseFloat(c.walletBalance) > 0)
    .map((c) => ({
      coin: c.coin,
      balance: c.walletBalance,
      usdValue: c.usdValue ?? "0",
      usdValueAvailable: c.usdValue != null,
    }));

  return {
    totalEquity: parseFloat(account.totalEquity),
    freeCapital: walletBalance - totalPositionIM - totalOrderIM,
    marginInUse: totalPositionIM,
    marginReservedForOrders: totalOrderIM,
    unrealisedPnl,
    maintenanceMargin: parseFloat(account.totalMaintenanceMargin),
    positions: mapPositions(linearRes.list),
    inverse_positions: mapPositions(inverseRes.list),
    spot_holdings,
    option_positions: mapOptionPositions(optionRes.list),
  };
}
