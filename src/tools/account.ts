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
  liquidationPrice: number;
  positionIdx: 0 | 1 | 2;
}

export interface AccountStatus {
  totalEquity: number;
  freeCapital: number;
  marginInUse: number;
  unrealisedPnl: number;
  maintenanceMargin: number;
  positions: AccountPosition[];
  inverse_positions: AccountPosition[];
  spot_holdings: SpotHolding[];
  option_positions: OptionPosition[];  // always present; empty array when none or options disabled
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
        entryPrice: entry, markPrice: mark, uPnl, uPnlPct,
        sl: p.stopLoss ? parseFloat(p.stopLoss) : null,
        tp: p.takeProfit ? parseFloat(p.takeProfit) : null,
        trailingStop: parseFloat(p.trailingStop || "0"),
        liquidationPrice: parseFloat(p.liquidationPrice),
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
      const realisedPnl = parseFloat(pos.cumRealisedPnl ?? "0");
      const totalPnl = unrealisedPnl + realisedPnl;
      const daysToExpiry = Math.max(0, Math.ceil((parsed.expiry.getTime() - Date.now()) / 86400000));
      const breakeven = parsed.type === "call"
        ? parsed.strike + Math.abs(premiumFlow) / (qty * multiplier)
        : parsed.strike - Math.abs(premiumFlow) / (qty * multiplier);
      return {
        symbol: pos.symbol,
        underlying: parsed.underlying,
        side,
        qty,
        entryPrice,
        markPrice,
        premiumFlow,
        currentValue,
        unrealisedPnl,
        unrealisedPnlPct,
        realisedPnl,
        totalPnl,
        greeks: {
          delta: parseFloat(pos.delta ?? "0"),
          gamma: parseFloat(pos.gamma ?? "0"),
          theta: parseFloat(pos.theta ?? "0"),
          vega: parseFloat(pos.vega ?? "0"),
        },
        daysToExpiry,
        breakeven,
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
    freeCapital: walletBalance - totalPositionIM,
    marginInUse: totalPositionIM,
    unrealisedPnl,
    maintenanceMargin: parseFloat(account.totalMaintenanceMargin),
    positions: mapPositions(linearRes.list),
    inverse_positions: mapPositions(inverseRes.list),
    spot_holdings,
    option_positions: mapOptionPositions(optionRes.list),
  };
}
