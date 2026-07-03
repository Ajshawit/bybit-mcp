// Binary float division can land just below an exact integer
// (0.3 / 0.1 === 2.9999999999999996), and a bare Math.floor on that quotient
// drops a full step — a percent=100 close would leave a residual position.
// Snap the quotient to 9 decimals first; exchange steps never need sub-1e-9
// quotient resolution, so this only removes float noise.
const STEP_QUOTIENT_DECIMALS = 9;

function quotientInSteps(value: number, stepNum: number): number {
  return Number((value / stepNum).toFixed(STEP_QUOTIENT_DECIMALS));
}

export function floorToStep(value: number, step: string): string {
  const decimals = step.includes(".") ? step.split(".")[1].length : 0;
  const stepNum = parseFloat(step);
  const floored = Math.floor(quotientInSteps(value, stepNum)) * stepNum;
  return floored.toFixed(decimals);
}

export function roundToStep(value: number, step: string): string {
  const decimals = step.includes(".") ? step.split(".")[1].length : 0;
  const stepNum = parseFloat(step);
  const rounded = Math.round(quotientInSteps(value, stepNum)) * stepNum;
  return rounded.toFixed(decimals);
}

// Bybit returns numeric fields as strings; empty/missing fields parse to NaN
// and every NaN comparison is false — which silently disables balance and
// notional gates. Parse at the boundary and fail loudly (or explicitly).
export function parseFiniteOrThrow(value: string | undefined, label: string): number {
  const n = parseFloat(value ?? "");
  if (!Number.isFinite(n)) {
    throw new Error(`${label} is missing or non-numeric (got: ${JSON.stringify(value ?? null)})`);
  }
  return n;
}

export function parseFiniteOr(value: string | undefined, fallback: number): number {
  const n = parseFloat(value ?? "");
  return Number.isFinite(n) ? n : fallback;
}

// Significant-figure rounding for OHLC/ticker price/volume. Precision scales
// with magnitude, so high-priced symbols (BTC ~67234.5) and sub-cent tokens
// (PEPE ~1.2e-5) both keep meaningful digits. Fixed 2dp rounding zeroes out
// sub-cent prices/volumes — corrupting periodLow/lastPrice and any
// stop-placement or swing-level read on low-priced symbols. Trailing float
// noise is still trimmed, preserving most of the token saving.
export const sigFig = (v: number, sig = 8) =>
  v === 0 || !Number.isFinite(v) ? v : Number(v.toPrecision(sig));

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

function getNthSundayUtc(year: number, month: number, n: number, utcHour: number): Date {
  // month is 0-indexed (2=March, 10=November)
  const firstOfMonth = new Date(Date.UTC(year, month, 1));
  const firstSunday = (7 - firstOfMonth.getUTCDay()) % 7 + 1;
  const dayOfMonth = firstSunday + (n - 1) * 7;
  return new Date(Date.UTC(year, month, dayOfMonth, utcHour));
}

// Day-of-month of the nth <weekday> (0=Sun..6=Sat) in a 0-indexed month.
function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): number {
  const firstDow = new Date(Date.UTC(year, month, 1)).getUTCDay();
  return 1 + ((weekday - firstDow + 7) % 7) + (n - 1) * 7;
}

function lastWeekdayOfMonth(year: number, month: number, weekday: number): number {
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const lastDow = new Date(Date.UTC(year, month, lastDay)).getUTCDay();
  return lastDay - ((lastDow - weekday + 7) % 7);
}

// Anonymous Gregorian computus — Easter Sunday (month is 0-indexed).
function easterSunday(year: number): { month: number; day: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  return {
    month: Math.floor((h + l - 7 * m + 114) / 31) - 1,
    day: ((h + l - 7 * m + 114) % 31) + 1,
  };
}

// NYSE full-closure holidays for a given ET calendar date, or null.
// Fixed-date holidays shift per NYSE observance: Saturday → preceding Friday
// (except New Year's, whose Friday falls in the prior year and is NOT
// observed), Sunday → following Monday.
function nyseHoliday(year: number, month: number, day: number): string | null {
  const fixed: Array<[number, number, string]> = [
    [0, 1, "New Year's Day"],
    [5, 19, "Juneteenth"],
    [6, 4, "Independence Day"],
    [11, 25, "Christmas Day"],
  ];
  for (const [hMonth, hDay, name] of fixed) {
    const hDow = new Date(Date.UTC(year, hMonth, hDay)).getUTCDay();
    let obsDay = hDay;
    if (hDow === 6) {
      if (hMonth === 0 && hDay === 1) continue; // New Year's Saturday: not observed
      obsDay = hDay - 1;
    } else if (hDow === 0) {
      obsDay = hDay + 1;
    }
    if (month === hMonth && day === obsDay) {
      return obsDay === hDay ? name : `${name} (observed)`;
    }
  }
  if (month === 0 && day === nthWeekdayOfMonth(year, 0, 1, 3)) return "Martin Luther King Jr. Day";
  if (month === 1 && day === nthWeekdayOfMonth(year, 1, 1, 3)) return "Washington's Birthday";
  const easter = easterSunday(year);
  const goodFriday = new Date(Date.UTC(year, easter.month, easter.day - 2));
  if (month === goodFriday.getUTCMonth() && day === goodFriday.getUTCDate()) return "Good Friday";
  if (month === 4 && day === lastWeekdayOfMonth(year, 4, 1)) return "Memorial Day";
  if (month === 8 && day === nthWeekdayOfMonth(year, 8, 1, 1)) return "Labor Day";
  if (month === 10 && day === nthWeekdayOfMonth(year, 10, 4, 4)) return "Thanksgiving Day";
  return null;
}

// 13:00 ET early closes (checked after full holidays, so an observed-holiday
// July 3 never reaches here).
function nyseEarlyClose(year: number, month: number, day: number): string | null {
  if (month === 6 && day === 3) return "early close 13:00 ET (day before Independence Day)";
  if (month === 10 && day === nthWeekdayOfMonth(year, 10, 4, 4) + 1) return "early close 13:00 ET (day after Thanksgiving)";
  if (month === 11 && day === 24) return "early close 13:00 ET (Christmas Eve)";
  return null;
}

export function isNyseOpen(now = new Date()): NyseStatus {
  const utcYear = now.getUTCFullYear();
  const dstStart = getNthSundayUtc(utcYear, 2, 2, 7);  // spring-forward: 2 AM EST = 07:00 UTC
  const dstEnd   = getNthSundayUtc(utcYear, 10, 1, 6); // fall-back: 2 AM EDT = 06:00 UTC
  const isDst = now >= dstStart && now < dstEnd;
  const etOffsetHours = isDst ? -4 : -5;

  // ET calendar parts via a shifted Date — weekend/holiday must be judged in
  // ET, not UTC (Friday 21:00 ET is already Saturday in UTC).
  const et = new Date(now.getTime() + etOffsetHours * 3600000);
  const etDow = et.getUTCDay();
  if (etDow === 0 || etDow === 6) return { open: false, session: "closed", note: "Weekend — NYSE closed" };

  const holiday = nyseHoliday(et.getUTCFullYear(), et.getUTCMonth(), et.getUTCDate());
  if (holiday) return { open: false, session: "closed", note: `NYSE closed — ${holiday}` };

  const etMinutes = et.getUTCHours() * 60 + et.getUTCMinutes();

  const PRE_OPEN  = 4 * 60;       // 04:00
  const REG_OPEN  = 9 * 60 + 30;  // 09:30
  const REG_CLOSE = 16 * 60;      // 16:00
  const AH_CLOSE  = 20 * 60;      // 20:00

  const earlyClose = nyseEarlyClose(et.getUTCFullYear(), et.getUTCMonth(), et.getUTCDate());
  const regClose = earlyClose ? 13 * 60 : REG_CLOSE;

  if (etMinutes >= REG_OPEN && etMinutes < regClose) {
    return {
      open: true,
      session: "regular",
      note: earlyClose ? `NYSE regular hours — ${earlyClose}` : "NYSE regular hours (09:30–16:00 ET)",
    };
  }
  if (etMinutes >= PRE_OPEN && etMinutes < REG_OPEN) {
    return { open: false, session: "pre", note: "NYSE pre-market (04:00–09:30 ET)" };
  }
  if (etMinutes >= regClose && etMinutes < AH_CLOSE) {
    return { open: false, session: "after", note: earlyClose ? `NYSE after-hours (after ${earlyClose})` : "NYSE after-hours (16:00–20:00 ET)" };
  }
  return { open: false, session: "closed", note: "NYSE closed" };
}
