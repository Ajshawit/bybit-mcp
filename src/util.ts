export function floorToStep(value: number, step: string): string {
  const decimals = step.includes(".") ? step.split(".")[1].length : 0;
  const stepNum = parseFloat(step);
  const floored = Math.floor(value / stepNum) * stepNum;
  return floored.toFixed(decimals);
}

export function roundToStep(value: number, step: string): string {
  const decimals = step.includes(".") ? step.split(".")[1].length : 0;
  const stepNum = parseFloat(step);
  const rounded = Math.round(value / stepNum) * stepNum;
  return rounded.toFixed(decimals);
}

export async function concurrentMap<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  if (limit <= 0) throw new Error("concurrentMap: limit must be > 0");
  const results: R[] = new Array(items.length);
  let nextIdx = 0;

  async function worker() {
    while (nextIdx < items.length) {
      const i = nextIdx++;
      results[i] = await fn(items[i]);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

export interface NyseStatus {
  open: boolean;
  session: "regular" | "pre" | "after" | "closed";
  note: string;
}

function getNthSundayUtc(year: number, month: number, n: number): Date {
  // month is 0-indexed (2=March, 10=November)
  // DST changes at 2 AM local = 7 AM UTC (EST offset) on the Sunday
  const firstOfMonth = new Date(Date.UTC(year, month, 1));
  const firstSunday = (7 - firstOfMonth.getUTCDay()) % 7 + 1;
  const dayOfMonth = firstSunday + (n - 1) * 7;
  return new Date(Date.UTC(year, month, dayOfMonth, 7));
}

export function isNyseOpen(now = new Date()): NyseStatus {
  const day = now.getUTCDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return { open: false, session: "closed", note: "Weekend — NYSE closed" };

  const year = now.getUTCFullYear();
  const dstStart = getNthSundayUtc(year, 2, 2); // 2nd Sunday in March
  const dstEnd = getNthSundayUtc(year, 10, 1);  // 1st Sunday in November
  const isDst = now >= dstStart && now < dstEnd;
  const etOffsetHours = isDst ? -4 : -5;

  const etHour = ((now.getUTCHours() + etOffsetHours) % 24 + 24) % 24;
  const etMin = now.getUTCMinutes();
  const etMinutes = etHour * 60 + etMin;

  const PRE_OPEN  = 4 * 60;       // 04:00
  const REG_OPEN  = 9 * 60 + 30;  // 09:30
  const REG_CLOSE = 16 * 60;      // 16:00
  const AH_CLOSE  = 20 * 60;      // 20:00

  if (etMinutes >= REG_OPEN && etMinutes < REG_CLOSE) {
    return { open: true, session: "regular", note: "NYSE regular hours (09:30–16:00 ET)" };
  }
  if (etMinutes >= PRE_OPEN && etMinutes < REG_OPEN) {
    return { open: false, session: "pre", note: "NYSE pre-market (04:00–09:30 ET)" };
  }
  if (etMinutes >= REG_CLOSE && etMinutes < AH_CLOSE) {
    return { open: false, session: "after", note: "NYSE after-hours (16:00–20:00 ET)" };
  }
  return { open: false, session: "closed", note: "NYSE closed" };
}
