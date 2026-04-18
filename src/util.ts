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
