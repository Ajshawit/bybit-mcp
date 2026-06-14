import { concurrentMap, floorToStep, roundToStep, isNyseOpen, parseFiniteOrThrow, parseFiniteOr } from "../util";

describe("floorToStep", () => {
  it("floors to 3-decimal qtyStep", () => {
    expect(floorToStep(0.12345, "0.001")).toBe("0.123");
  });
  it("floors to integer step", () => {
    expect(floorToStep(15.7, "1")).toBe("15");
  });
  it("floors to 0.01 step", () => {
    expect(floorToStep(1.239, "0.01")).toBe("1.23");
  });
});

describe("roundToStep", () => {
  it("rounds to nearest tickSize", () => {
    expect(roundToStep(29500.7, "0.5")).toBe("29500.5");
  });
  it("rounds up correctly", () => {
    expect(roundToStep(29500.8, "0.5")).toBe("29501.0");
  });
});

describe("concurrentMap", () => {
  it("processes all items with concurrency limit", async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await concurrentMap(items, 2, async (x) => x * 2);
    expect(results).toEqual([2, 4, 6, 8, 10]);
  });

  it("preserves order", async () => {
    const order: number[] = [];
    await concurrentMap([10, 5, 1], 3, async (delay) => {
      await new Promise((r) => setTimeout(r, delay));
      order.push(delay);
    });
    expect(order).toEqual([1, 5, 10]);
  });

  it("respects concurrency cap", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    await concurrentMap([1, 2, 3, 4, 5, 6], 3, async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 10));
      concurrent--;
    });
    expect(maxConcurrent).toBeLessThanOrEqual(3);
  });

  it("throws on limit <= 0", async () => {
    await expect(concurrentMap([1], 0, async (x) => x)).rejects.toThrow("limit must be > 0");
  });
});

describe("isNyseOpen", () => {
  function utcDate(isoString: string): Date {
    return new Date(isoString);
  }

  it("returns session=regular and open=true during NYSE regular hours (ET)", () => {
    // Tuesday 2026-05-12 14:00 UTC = 10:00 AM EDT (UTC-4) — regular hours
    const result = isNyseOpen(utcDate("2026-05-12T14:00:00Z"));
    expect(result.open).toBe(true);
    expect(result.session).toBe("regular");
  });

  it("returns session=pre and open=false during pre-market (ET)", () => {
    // Tuesday 2026-05-12 10:00 UTC = 06:00 AM EDT — pre-market
    const result = isNyseOpen(utcDate("2026-05-12T10:00:00Z"));
    expect(result.open).toBe(false);
    expect(result.session).toBe("pre");
  });

  it("returns session=after and open=false during after-hours (ET)", () => {
    // Tuesday 2026-05-12 21:30 UTC = 17:30 EDT — after-hours
    const result = isNyseOpen(utcDate("2026-05-12T21:30:00Z"));
    expect(result.open).toBe(false);
    expect(result.session).toBe("after");
  });

  it("returns session=closed and open=false after after-hours (ET)", () => {
    // Tuesday 2026-05-12 02:00 UTC = 22:00 prev day EDT — closed
    const result = isNyseOpen(utcDate("2026-05-12T02:00:00Z"));
    expect(result.open).toBe(false);
    expect(result.session).toBe("closed");
  });

  it("returns session=closed on Saturday", () => {
    const result = isNyseOpen(utcDate("2026-05-09T15:00:00Z")); // Saturday
    expect(result.open).toBe(false);
    expect(result.session).toBe("closed");
  });

  it("returns session=closed on Sunday", () => {
    const result = isNyseOpen(utcDate("2026-05-10T15:00:00Z")); // Sunday
    expect(result.open).toBe(false);
    expect(result.session).toBe("closed");
  });

  it("uses EST offset (UTC-5) in winter outside DST", () => {
    // Friday 2026-01-09 14:45 UTC = 09:45 EST — just inside regular hours
    const result = isNyseOpen(utcDate("2026-01-09T14:45:00Z"));
    expect(result.open).toBe(true);
    expect(result.session).toBe("regular");
  });

  it("note field is a non-empty string", () => {
    const result = isNyseOpen(utcDate("2026-05-12T14:00:00Z"));
    expect(typeof result.note).toBe("string");
    expect(result.note.length).toBeGreaterThan(0);
  });
});

// Binary float division (0.3 / 0.1 === 2.9999999999999996) must not drop a
// step for values that are exact multiples of the step — a percent=100 close
// that submits one step short leaves a leveraged residual position.
describe("floorToStep on-step values", () => {
  it("keeps exactly on-step values intact", () => {
    expect(floorToStep(0.3, "0.1")).toBe("0.3");
    expect(floorToStep(0.7, "0.1")).toBe("0.7");
    expect(floorToStep(8.2, "0.1")).toBe("8.2");
    expect(floorToStep(4.6, "0.1")).toBe("4.6");
    expect(floorToStep(100.35, "0.05")).toBe("100.35");
    expect(floorToStep(1.4, "0.2")).toBe("1.4");
  });

  it("still floors values strictly between steps", () => {
    expect(floorToStep(0.39, "0.1")).toBe("0.3");
    expect(floorToStep(0.2999, "0.1")).toBe("0.2");
    expect(floorToStep(1.59, "0.2")).toBe("1.4");
  });

  it("closes the full size for a 100% close of a 0.3 position", () => {
    expect(floorToStep((0.3 * 100) / 100, "0.1")).toBe("0.3");
  });
});

describe("roundToStep on-step values", () => {
  it("keeps exactly on-step values intact", () => {
    expect(roundToStep(0.3, "0.1")).toBe("0.3");
    expect(roundToStep(29500.5, "0.5")).toBe("29500.5");
  });
});

describe("isNyseOpen holiday calendar", () => {
  function at(iso: string) {
    return isNyseOpen(new Date(iso));
  }

  it("closed on Independence Day (Fri Jul 4 2025)", () => {
    const r = at("2025-07-04T15:00:00Z"); // 11:00 ET
    expect(r.open).toBe(false);
    expect(r.note).toMatch(/Independence Day/);
  });

  it("closed on the observed Friday when July 4 falls on Saturday (Jul 3 2026)", () => {
    const r = at("2026-07-03T15:00:00Z");
    expect(r.open).toBe(false);
    expect(r.note).toMatch(/Independence Day \(observed\)/);
  });

  it("closed on Thanksgiving (Thu Nov 27 2025)", () => {
    const r = at("2025-11-27T16:00:00Z"); // 11:00 EST
    expect(r.open).toBe(false);
    expect(r.note).toMatch(/Thanksgiving/);
  });

  it("day after Thanksgiving: open in the morning with an early-close note, not open at 14:00 ET", () => {
    const morning = at("2025-11-28T15:00:00Z"); // 10:00 EST
    expect(morning.open).toBe(true);
    expect(morning.note).toMatch(/early close/);

    const afternoon = at("2025-11-28T19:00:00Z"); // 14:00 EST
    expect(afternoon.open).toBe(false);
  });

  it("closed on Good Friday (Apr 3 2026, Easter Apr 5)", () => {
    const r = at("2026-04-03T15:00:00Z");
    expect(r.open).toBe(false);
    expect(r.note).toMatch(/Good Friday/);
  });

  it("closed on MLK Day (3rd Monday Jan 19 2026)", () => {
    const r = at("2026-01-19T16:00:00Z");
    expect(r.open).toBe(false);
    expect(r.note).toMatch(/Martin Luther King/);
  });

  it("closed on Juneteenth (Fri Jun 19 2026)", () => {
    const r = at("2026-06-19T15:00:00Z");
    expect(r.open).toBe(false);
    expect(r.note).toMatch(/Juneteenth/);
  });

  it("closed on Christmas (Fri Dec 25 2026); Christmas Eve closes early", () => {
    expect(at("2026-12-25T16:00:00Z").open).toBe(false);
    const eve = at("2026-12-24T18:30:00Z"); // 13:30 EST — past the 13:00 early close
    expect(eve.open).toBe(false);
  });

  it("does NOT observe New Year's on the prior Friday when Jan 1 falls Saturday (Dec 31 2027 trades)", () => {
    const r = at("2027-12-31T15:00:00Z"); // Friday 10:00 EST
    expect(r.open).toBe(true);
  });

  it("closed on Memorial Day (last Monday May 25 2026) and Labor Day (Sep 7 2026)", () => {
    expect(at("2026-05-25T15:00:00Z").open).toBe(false);
    expect(at("2026-09-07T15:00:00Z").open).toBe(false);
  });
});

describe("parseFiniteOrThrow", () => {
  it("parses normal numeric strings", () => {
    expect(parseFiniteOrThrow("123.45", "x")).toBe(123.45);
  });

  it("throws with the field label on empty string", () => {
    expect(() => parseFiniteOrThrow("", "walletBalance")).toThrow("walletBalance");
  });

  it("throws on undefined", () => {
    expect(() => parseFiniteOrThrow(undefined, "lastPrice")).toThrow("lastPrice");
  });

  it("throws on non-numeric garbage", () => {
    expect(() => parseFiniteOrThrow("abc", "qty")).toThrow("qty");
  });
});

describe("parseFiniteOr", () => {
  it("parses normal numeric strings", () => {
    expect(parseFiniteOr("42", 0)).toBe(42);
  });

  it("falls back on empty string (portfolio-margin totalPositionIM)", () => {
    expect(parseFiniteOr("", 0)).toBe(0);
  });

  it("falls back on undefined", () => {
    expect(parseFiniteOr(undefined, 7)).toBe(7);
  });
});
