import { concurrentMap, floorToStep, roundToStep } from "../util";

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
