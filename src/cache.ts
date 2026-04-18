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
