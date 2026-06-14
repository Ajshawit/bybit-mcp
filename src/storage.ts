import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { homedir } from "os";

// Collapse record() bursts (one per chain ticker — hundreds per options call)
// into a single disk write.
const FLUSH_DELAY_MS = 1000;

// Persistence is opt-out (inverse coercion, same pattern as BYBIT_TESTNET):
// only the exact string "false" disables it. Analytics that need history
// (IV percentile warmup, vol cones, funding baselines) are useless if every
// restart wipes their samples.
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.BYBIT_MCP_PERSIST === "false") return null;
  const custom = env.BYBIT_MCP_DATA_DIR?.trim();
  if (!custom) return join(homedir(), ".bybit-mcp");
  // Shells expand ~, but MCP client configs pass env values verbatim.
  // resolve() pins a relative/.. path to an absolute one so a misconfigured
  // env var never writes somewhere surprising relative to cwd.
  return resolve(custom.startsWith("~/") ? join(homedir(), custom.slice(2)) : custom);
}

/**
 * Minimal JSON-snapshot persistence for in-memory sample stores.
 * Fail-open by design: a broken disk must degrade to in-memory behaviour,
 * never take down the MCP session. All diagnostics go to stderr — stdout is
 * the MCP transport.
 */
export class JsonFileStore {
  private flushTimer: NodeJS.Timeout | null = null;
  private pendingSnapshot: (() => unknown) | null = null;
  private writeFailed = false;

  constructor(readonly filePath: string) {}

  load<T>(): T | null {
    try {
      if (!existsSync(this.filePath)) return null;
      return JSON.parse(readFileSync(this.filePath, "utf8")) as T;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[bybit-quant] Could not load ${this.filePath} (${msg}) — starting with empty history`);
      return null;
    }
  }

  // `snapshot` is a thunk so the debounced flush serialises the latest state,
  // not the state at schedule time.
  scheduleSave(snapshot: () => unknown): void {
    this.pendingSnapshot = snapshot;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flushNow(), FLUSH_DELAY_MS);
    // Never keep the process alive just to flush analytics samples.
    this.flushTimer.unref?.();
  }

  flushNow(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const snapshot = this.pendingSnapshot;
    this.pendingSnapshot = null;
    if (!snapshot) return;

    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      // Write-then-rename so a crash mid-write can't corrupt the live file.
      const tmpPath = `${this.filePath}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(snapshot()), "utf8");
      renameSync(tmpPath, this.filePath);
      this.writeFailed = false;
    } catch (err: unknown) {
      if (!this.writeFailed) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[bybit-quant] Could not persist ${this.filePath} (${msg}) — continuing in-memory only`);
        this.writeFailed = true;
      }
    }
  }
}

export function createSampleFileStore(
  name: string,
  env: NodeJS.ProcessEnv = process.env
): JsonFileStore | null {
  const dir = resolveDataDir(env);
  return dir ? new JsonFileStore(join(dir, `${name}.json`)) : null;
}
