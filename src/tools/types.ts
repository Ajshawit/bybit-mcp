export interface WalletBalanceCoin {
  coin: string;
  walletBalance: string;
  totalPositionIM: string;
  unrealisedPnl: string;
  equity: string;
  locked: string;
  usdValue?: string;
}

export interface WalletBalanceAccount {
  accountType: string;
  totalEquity: string;
  totalMaintenanceMargin: string;
  coin: WalletBalanceCoin[];
}

export interface WalletBalanceResult {
  list: WalletBalanceAccount[];
}

export interface BybitPosition {
  symbol: string;
  side: "Buy" | "Sell" | "None";
  size: string;
  avgPrice: string;
  markPrice: string;
  unrealisedPnl: string;
  stopLoss: string;
  takeProfit: string;
  trailingStop: string;
  liquidationPrice: string;
  positionIdx: 0 | 1 | 2;
  leverage: string;
  positionIM: string;
}

export interface PositionListResult {
  list: BybitPosition[];
  category: string;
}

export interface BybitTicker {
  symbol: string;
  lastPrice: string;
  price24hPcnt: string;
  fundingRate: string;
  nextFundingTime: string;
  openInterest: string;
  openInterestValue: string;
  volume24h: string;
  turnover24h: string;
  highPrice24h: string;
  lowPrice24h: string;
  prevPrice24h: string;
  bid1Price: string;
  ask1Price: string;
}

export interface TickersResult {
  list: BybitTicker[];
  category: string;
}

// Kline tuple: [startTime, open, high, low, close, volume, turnover]
export type BybitKline = [string, string, string, string, string, string, string];

export interface KlineResult {
  list: BybitKline[];
  symbol: string;
  category: string;
}

export interface FundingRecord {
  symbol: string;
  fundingRate: string;
  fundingRateTimestamp: string;
}

export interface FundingHistoryResult {
  list: FundingRecord[];
}

export interface OIRecord {
  openInterest: string;
  timestamp: string;
}

export interface OIHistoryResult {
  list: OIRecord[];
  symbol: string;
}

export interface OrderbookEntry {
  b: [string, string][]; // bids [price, size]
  a: [string, string][]; // asks [price, size]
  s: string;
}

// lotSizeFilter has qtyStep for linear/inverse and basePrecision for spot
export interface InstrumentInfoResult {
  list: Array<{
    symbol: string;
    lotSizeFilter: {
      qtyStep?: string;
      basePrecision?: string;
      minOrderQty: string;
    };
    priceFilter: { tickSize: string };
    minNotionalValue?: string;
  }>;
}

export interface OrderCreateResult {
  orderId: string;
  orderLinkId: string;
}

// Shared result types used by both perp and spot handlers

export interface PlaceTradeResult {
  orderId: string;
  orderLinkId: string;
  symbol: string;
  filledQty: string;
  avgFillPrice: number;
  serverTimestamp: string;
  notes?: string;
  sizeWarning?: string;
  partialSuccess?: boolean;
  trailingStopError?: string;
}

export interface ClosePositionResult {
  orderId: string;
  orderLinkId: string;
  symbol: string;
  closedQty: string;
  remainingSize: number;
  serverTimestamp: string;
  notes?: string;
}

export interface SpotCloseResult {
  orderId: string;
  orderLinkId: string;
  symbol: string;
  closedQty: string;
  remainingBalance: number;
  serverTimestamp: string;
  notes?: string;
}

export interface SpotHolding {
  coin: string;
  balance: string;
  usdValue: string;
  usdValueAvailable: boolean;
}

export interface DryRunResult {
  dryRun: true;
  category: string;
  symbol: string;
  side: "Buy" | "Sell";
  orderType: "Market" | "Limit";
  computedQty: string;
  executionPrice: string;
  notional: string;
  effectiveLeverage?: number;
  estimatedLiqPrice?: string;
  liqPriceApproximate?: boolean;
  marginCoin: string;
  marginRequired: string;
  walletBalanceAvailable: string;
  warnings: string[];
  wouldSubmit: boolean;
  serverTimestamp: string;
}
