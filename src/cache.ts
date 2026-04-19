export interface InstrumentInfo {
  tickSize: string;
  qtyStep: string;
  minNotionalValue: string;
}

export class InstrumentsCache {
  private store = new Map<string, InstrumentInfo>();

  get(symbol: string): InstrumentInfo | undefined {
    return this.store.get(symbol);
  }

  set(symbol: string, info: InstrumentInfo): void {
    this.store.set(symbol, info);
  }
}

export const instrumentsCache = new InstrumentsCache();

const POSITION_MODE_TTL_MS = 24 * 60 * 60 * 1000;

interface PositionModeCacheEntry {
  positionIdx: 0 | 1 | 2;
  expiresAt: number;
}

export class PositionModeCache {
  private store = new Map<string, PositionModeCacheEntry>();

  get(category: string, symbol: string, side: "Buy" | "Sell"): (0 | 1 | 2) | undefined {
    const key = `${category}:${symbol}:${side}`;
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.positionIdx;
  }

  set(category: string, symbol: string, side: "Buy" | "Sell", positionIdx: 0 | 1 | 2): void {
    this.store.set(`${category}:${symbol}:${side}`, {
      positionIdx,
      expiresAt: Date.now() + POSITION_MODE_TTL_MS,
    });
  }
}

export const positionModeCache = new PositionModeCache();
