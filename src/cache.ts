export interface InstrumentInfo {
  tickSize: string;
  qtyStep: string;
  minNotionalValue: string;
}

// Exchanges do occasionally retune qtyStep/tickSize/minNotional — a
// process-lifetime cache would keep sizing orders against stale specs.
const INSTRUMENT_TTL_MS = 24 * 60 * 60 * 1000;

interface InstrumentCacheEntry {
  info: InstrumentInfo;
  expiresAt: number;
}

export class InstrumentsCache {
  private store = new Map<string, InstrumentCacheEntry>();

  get(symbol: string): InstrumentInfo | undefined {
    const entry = this.store.get(symbol);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(symbol);
      return undefined;
    }
    return entry.info;
  }

  set(symbol: string, info: InstrumentInfo): void {
    this.store.set(symbol, { info, expiresAt: Date.now() + INSTRUMENT_TTL_MS });
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
