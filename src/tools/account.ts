import { BybitClient } from "../client";
import { WalletBalanceResult, PositionListResult, SpotHolding } from "./types";

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

export async function handleGetAccountStatus(client: BybitClient): Promise<AccountStatus> {
  const [walletRes, linearRes, inverseRes] = await Promise.all([
    client.signedGet<WalletBalanceResult>("/v5/account/wallet-balance", { accountType: "UNIFIED" }),
    client.signedGet<PositionListResult>("/v5/position/list", { category: "linear", settleCoin: "USDT" }),
    client.signedGet<PositionListResult>("/v5/position/list", { category: "inverse", settleCoin: "USD" }),
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
  };
}
