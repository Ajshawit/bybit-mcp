import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir, homedir } from "os";
import { JsonFileStore, createSampleFileStore, resolveDataDir } from "../storage";
import { IVSampleStore } from "../tools/options/scan";

describe("resolveDataDir", () => {
  it("defaults to ~/.bybit-mcp when no env overrides are set", () => {
    expect(resolveDataDir({})).toBe(join(homedir(), ".bybit-mcp"));
  });

  it("returns null when BYBIT_MCP_PERSIST is exactly 'false'", () => {
    expect(resolveDataDir({ BYBIT_MCP_PERSIST: "false" })).toBeNull();
  });

  it("stays enabled for any other BYBIT_MCP_PERSIST value (inverse coercion like BYBIT_TESTNET)", () => {
    expect(resolveDataDir({ BYBIT_MCP_PERSIST: "FALSE" })).toBe(join(homedir(), ".bybit-mcp"));
    expect(resolveDataDir({ BYBIT_MCP_PERSIST: "0" })).toBe(join(homedir(), ".bybit-mcp"));
  });

  it("honours BYBIT_MCP_DATA_DIR", () => {
    expect(resolveDataDir({ BYBIT_MCP_DATA_DIR: "/tmp/custom" })).toBe("/tmp/custom");
  });

  it("treats a blank BYBIT_MCP_DATA_DIR as unset", () => {
    expect(resolveDataDir({ BYBIT_MCP_DATA_DIR: "   " })).toBe(join(homedir(), ".bybit-mcp"));
  });

  it("expands a leading ~/ (MCP client configs don't shell-expand)", () => {
    expect(resolveDataDir({ BYBIT_MCP_DATA_DIR: "~/custom-dir" })).toBe(join(homedir(), "custom-dir"));
  });
});

describe("createSampleFileStore", () => {
  it("returns null when persistence is disabled", () => {
    expect(createSampleFileStore("iv-samples", { BYBIT_MCP_PERSIST: "false" })).toBeNull();
  });

  it("builds the store path under the data dir", () => {
    const store = createSampleFileStore("iv-samples", { BYBIT_MCP_DATA_DIR: "/tmp/d" });
    expect(store?.filePath).toBe(join("/tmp/d", "iv-samples.json"));
  });
});

describe("JsonFileStore", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bybit-mcp-storage-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("load returns null when the file does not exist", () => {
    const store = new JsonFileStore(join(dir, "missing.json"));
    expect(store.load()).toBeNull();
  });

  it("round-trips data through scheduleSave + flushNow", () => {
    const path = join(dir, "samples.json");
    const store = new JsonFileStore(path);
    store.scheduleSave(() => ({ "BTC:APR26": [{ iv: 0.55, at: 1000 }] }));
    store.flushNow();

    const reread = new JsonFileStore(path).load<Record<string, Array<{ iv: number; at: number }>>>();
    expect(reread).toEqual({ "BTC:APR26": [{ iv: 0.55, at: 1000 }] });
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it("serialises the latest state, not the state at schedule time", () => {
    const path = join(dir, "samples.json");
    const store = new JsonFileStore(path);
    const data: Record<string, number> = { a: 1 };
    store.scheduleSave(() => ({ ...data }));
    data.a = 2;
    store.flushNow();
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ a: 2 });
  });

  it("flushNow is a no-op with nothing pending", () => {
    const path = join(dir, "samples.json");
    const store = new JsonFileStore(path);
    store.flushNow();
    expect(existsSync(path)).toBe(false);
  });

  it("creates the data dir on first flush", () => {
    const path = join(dir, "nested", "deep", "samples.json");
    const store = new JsonFileStore(path);
    store.scheduleSave(() => ({ ok: true }));
    store.flushNow();
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ ok: true });
  });

  it("load survives a corrupted file and returns null", () => {
    const path = join(dir, "corrupt.json");
    writeFileSync(path, "{not json", "utf8");
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    expect(new JsonFileStore(path).load()).toBeNull();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("write failure degrades to in-memory without throwing (fail-open)", () => {
    // Writing over an existing directory must fail at the fs layer.
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const badStore = new JsonFileStore(dir);
    badStore.scheduleSave(() => ({ x: 1 }));
    expect(() => badStore.flushNow()).not.toThrow();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe("IVSampleStore persistence", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bybit-mcp-iv-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("restores warmed-up samples across restarts", () => {
    const path = join(dir, "iv-samples.json");
    const file = new JsonFileStore(path);
    const store = new IVSampleStore(file);
    const now = new Date();
    for (let i = 0; i < 25; i++) {
      store.record("BTC", "APR26", 0.4 + i * 0.01, now);
    }
    file.flushNow();

    // Fresh process: a new store backed by the same file needs no warmup.
    const restored = new IVSampleStore(new JsonFileStore(path));
    expect(restored.warmupRemaining("BTC", "APR26")).toBeNull();
    expect(restored.getPercentile("BTC", "APR26", 0.99)).toBe(100);
  });

  it("drops samples past 30-day retention on load", () => {
    const path = join(dir, "iv-samples.json");
    const staleAt = Date.now() - 31 * 24 * 60 * 60 * 1000;
    const freshAt = Date.now() - 1000;
    writeFileSync(path, JSON.stringify({
      "BTC:APR26": [
        { iv: 0.5, at: staleAt },
        { iv: 0.6, at: freshAt },
      ],
    }), "utf8");

    const restored = new IVSampleStore(new JsonFileStore(path));
    // Only the fresh sample survives → still warming up (1 < 20 samples).
    expect(restored.warmupRemaining("BTC", "APR26")).not.toBeNull();
  });

  it("ignores malformed persisted entries", () => {
    const path = join(dir, "iv-samples.json");
    writeFileSync(path, JSON.stringify({
      "BTC:APR26": [{ iv: "bad", at: "worse" }, null, { iv: 0.5, at: Date.now() }],
      "ETH:bogus": "not-an-array",
    }), "utf8");

    const restored = new IVSampleStore(new JsonFileStore(path));
    expect(restored.warmupRemaining("BTC", "APR26")).not.toBeNull(); // 1 valid sample
    expect(restored.warmupRemaining("ETH", "bogus")).not.toBeNull();
  });

  it("works with no backing store (legacy in-memory behaviour)", () => {
    const store = new IVSampleStore();
    store.record("BTC", "APR26", 0.5, new Date());
    expect(store.warmupRemaining("BTC", "APR26")).not.toBeNull();
  });
});
