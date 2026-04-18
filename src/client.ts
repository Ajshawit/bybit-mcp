import { buildAuthHeaders } from "./auth";

export class BybitError extends Error {
  constructor(public retCode: number, public retMsg: string) {
    super(`Bybit error ${retCode}: ${retMsg}`);
    this.name = "BybitError";
  }
}

const PASSTHROUGH_CODES = new Set([110043]); // leverage not modified

export class BybitClient {
  private lastGetMs = 0;
  private lastPostMs = 0;

  constructor(
    private apiKey: string,
    private secret: string,
    private baseUrl: string
  ) {}

  private async throttle(isPost: boolean): Promise<void> {
    const minGap = isPost ? 300 : 100;
    const last = isPost ? this.lastPostMs : this.lastGetMs;
    const elapsed = Date.now() - last;
    if (elapsed < minGap) await sleep(minGap - elapsed);
    if (isPost) this.lastPostMs = Date.now();
    else this.lastGetMs = Date.now();
  }

  private async execute<T>(
    urlStr: string,
    options: RequestInit,
    isPost: boolean,
    attempt = 0
  ): Promise<T> {
    await this.throttle(isPost);
    const res = await fetch(urlStr, options);
    const body = await res.json() as { retCode: number; retMsg: string; result: T };

    if (body.retCode === 10006 && attempt < 3) {
      await sleep(500 + Math.random() * 1000);
      return this.execute(urlStr, options, isPost, attempt + 1);
    }

    if (body.retCode !== 0 && !PASSTHROUGH_CODES.has(body.retCode)) {
      throw new BybitError(body.retCode, body.retMsg);
    }

    return body.result;
  }

  async publicGet<T>(path: string, params: Record<string, string>): Promise<T> {
    const qs = new URLSearchParams(params).toString();
    const url = qs ? `${this.baseUrl}${path}?${qs}` : `${this.baseUrl}${path}`;
    return this.execute<T>(url, { method: "GET" }, false);
  }

  async signedGet<T>(path: string, params: Record<string, string>): Promise<T> {
    const qs = new URLSearchParams(params).toString();
    const ts = String(Date.now());
    const headers = buildAuthHeaders(this.apiKey, this.secret, ts, "5000", qs);
    const url = qs ? `${this.baseUrl}${path}?${qs}` : `${this.baseUrl}${path}`;
    return this.execute<T>(url, { method: "GET", headers }, false);
  }

  async signedPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const bodyStr = JSON.stringify(body);
    const ts = String(Date.now());
    const headers = {
      ...buildAuthHeaders(this.apiKey, this.secret, ts, "5000", bodyStr),
      "Content-Type": "application/json",
    };
    return this.execute<T>(
      `${this.baseUrl}${path}`,
      { method: "POST", headers, body: bodyStr },
      true
    );
  }
}

function sleep(ms: number): Promise<void> {
  const delay = process.env.NODE_ENV === "test" ? 0 : ms;
  return new Promise((r) => setTimeout(r, delay));
}
