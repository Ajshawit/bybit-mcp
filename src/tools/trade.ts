import { BybitClient } from "../client";
import { PlaceTradeResult, ClosePositionResult, SpotCloseResult, DryRunResult } from "./types";
import { handlePlacePerp, handleClosePerp } from "./trade-perp";
import { handlePlaceSpot, handleCloseSpot } from "./trade-spot";
import type { PerpCategory } from "./trade-shared";

export { handleManagePosition } from "./trade-perp";

export type TradeCategory = "linear" | "inverse" | "spot" | "spot_margin";

export interface PlaceTradeParams {
  symbol: string;
  side: "Buy" | "Sell";
  margin: number;
  category?: TradeCategory;
  orderType?: "Market" | "Limit";
  price?: number;
  leverage?: number;
  sl?: number;
  tp?: number;
  trailingStop?: number;
  trailingActivatePrice?: number;
  triggerPrice?: number;
  triggerBy?: "LastPrice" | "MarkPrice" | "IndexPrice";
  triggerDirection?: 1 | 2;
  notes?: string;
  dry_run?: boolean;
  confirm?: string;
}

export interface ClosePositionParams {
  symbol: string;
  side: "Buy" | "Sell";
  category?: TradeCategory;
  percent?: number;
  qty?: number;
  orderType?: "Market" | "Limit";
  price?: number;
  notes?: string;
  confirm?: string;
}

export async function handlePlaceTrade(
  client: BybitClient,
  params: PlaceTradeParams
): Promise<PlaceTradeResult | DryRunResult> {
  const category = params.category ?? "linear";

  if (category === "spot" || category === "spot_margin") {
    return handlePlaceSpot(client, { ...params, category });
  }

  if (params.leverage == null) throw new Error("leverage is required for linear/inverse trades");
  if (params.sl == null) throw new Error("sl is required for linear/inverse trades");

  return handlePlacePerp(client, {
    ...params,
    category: category as PerpCategory,
    leverage: params.leverage,
    sl: params.sl,
  });
}

export async function handleClosePosition(
  client: BybitClient,
  params: ClosePositionParams
): Promise<ClosePositionResult | SpotCloseResult> {
  const category = params.category ?? "linear";

  if (category === "spot" || category === "spot_margin") {
    if (params.orderType === "Limit") {
      throw new Error("close_position with orderType=Limit is only supported for perps — spot has no reduceOnly concept");
    }
    return handleCloseSpot(client, params);
  }

  return handleClosePerp(client, { ...params, category: category as PerpCategory });
}
