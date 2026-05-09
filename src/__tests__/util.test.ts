import { concurrentMap, floorToStep, roundToStep, isNyseOpen } from "../util";

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
