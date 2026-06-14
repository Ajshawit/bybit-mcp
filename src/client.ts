import { buildAuthHeaders } from "./auth";

export class BybitError extends Error {
  constructor(public retCode: number, public retMsg: string) {
    super(`Bybit error ${retCode}: ${retMsg}`);
    this.name = "BybitError";
  }
}

const PASSTHROUGH_CODES = new Set([110043]); // leverage not modified

// Hard cap per request: Bybit normally answers well under a second, and a
// hung trade request must never block the MCP session indefinitely.
const REQUEST_TIMEOUT_MS = 15_000;

export class BybitClient {
  private lastGetMs = 0;
  private lastPostMs = 0;

  constructor(
    private apiKey: string,
    private secret: string,
    private baseUrl: string
  ) {}

  // Reserve the next slot synchronously BEFORE awaiting, so two concurrent
  // calls can't both read the same `last` value and skip the gap (the
  // read-modify-write race across await points).
  private async throttle(isPost: boolean): Promise<void> {
    const minGap = isPost ? 300 : 100;
    const now = Date.now();
    const last = isPost ? this.lastPostMs : this.lastGetMs;
    const scheduled = Math.max(now, last + minGap);
    if (isPost) this.lastPostMs = scheduled;
    else this.lastGetMs = scheduled;
    if (scheduled > now) await sleep(scheduled - now);
  }

  // `makeOptions` is a factory, not a value: retries must re-sign with a
  // fresh timestamp, or the retry backoff pushes the original signature past
  // recv_window and turns a rate-limit into a timestamp rejection.
  private async execute<T>(
    urlStr: string,
    makeOptions: () => RequestInit,
    isPost: boolean,
    attempt = 0
  ): Promise<T> {
    await this.throttle(isPost);
    let res: Response;
    try {
      res = await fetch(urlStr, {
        ...makeOptions(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err: unknown) {
      // A timeout can fire AFTER the request reached Bybit — a POST may have
      // executed. Surface that ambiguity instead of a bare AbortError, so
      // nobody blind-retries a possibly-filled order.
      const name = err instanceof Error ? err.name : "";
      if (name === "AbortError" || name === "TimeoutError") {
        throw new Error(
          `Bybit request timed out after ${REQUEST_TIMEOUT_MS / 1000}s.` +
          (isPost
            ? " The request may or may not have been processed — verify open orders/positions before retrying."
            : " Retry the request.")
        );
      }
      throw err;
    }

    let body: { retCode: number; retMsg: string; result: T };
    try {
      body = await res.json() as { retCode: number; retMsg: string; result: T };
    } catch {
      throw new Error(
        `Bybit returned an unparseable response (HTTP ${res.status ?? "?"}) — possible gateway error or outage. ` +
        `The request may or may not have been processed; verify open orders/positions before retrying.`
      );
    }
    if (body == null || typeof body.retCode !== "number") {
      throw new Error(`Bybit returned an unexpected response shape (HTTP ${res.status ?? "?"}).`);
    }

    if (body.retCode === 10006 && attempt < 3) {
      await sleep(500 + Math.random() * 1000);
      return this.execute(urlStr, makeOptions, isPost, attempt + 1);
    }

    if (body.retCode !== 0 && !PASSTHROUGH_CODES.has(body.retCode)) {
      if (body.retCode === 10002) {
        throw new BybitError(10002, "Timestamp expired — system clock may have drifted. Retry the request.");
      }
      throw new BybitError(body.retCode, this.redact(body.retMsg));
    }

    return body.result;
  }

  // Bybit signature-error messages can echo request headers — never let the
  // API key reach tool output. (The secret is never sent, only the key.)
  private redact(msg: string): string {
    return this.apiKey && msg ? msg.split(this.apiKey).join("[REDACTED_API_KEY]") : msg;
  }

  async publicGet<T>(path: string, params: Record<string, string>): Promise<T> {
    const qs = new URLSearchParams(params).toString();
    const url = qs ? `${this.baseUrl}${path}?${qs}` : `${this.baseUrl}${path}`;
    return this.execute<T>(url, () => ({ method: "GET" }), false);
  }

  async signedGet<T>(path: string, params: Record<string, string>): Promise<T> {
    const qs = new URLSearchParams(params).toString();
    const url = qs ? `${this.baseUrl}${path}?${qs}` : `${this.baseUrl}${path}`;
    return this.execute<T>(
      url,
      () => {
        const ts = String(Date.now());
        return { method: "GET", headers: buildAuthHeaders(this.apiKey, this.secret, ts, "5000", qs) };
      },
      false
    );
  }

  async signedPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const bodyStr = JSON.stringify(body);
    return this.execute<T>(
      `${this.baseUrl}${path}`,
      () => {
        const ts = String(Date.now());
        return {
          method: "POST",
          headers: {
            ...buildAuthHeaders(this.apiKey, this.secret, ts, "5000", bodyStr),
            "Content-Type": "application/json",
          },
          body: bodyStr,
        };
      },
      true
    );
  }
}

function sleep(ms: number): Promise<void> {
  const delay = process.env.NODE_ENV === "test" ? 0 : ms;
  return new Promise((r) => setTimeout(r, delay));
}
