// Thin, polite client for Community Archive API v1.
// https://analytics.community-archive.org/v1  (Authorization: Bearer cak_...)
// Limits per key: 60 req/min, 20,000/day, 2 in flight. 429/503 carry Retry-After.

export const DEFAULT_BASE_URL = "https://analytics.community-archive.org/v1";

export type Json = any;

export interface Page<T = Json> {
  data: T;
  next_cursor?: string | null;
  next_offset?: number | null;
  request_id?: string;
}

export class CAError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public requestId?: string,
  ) {
    super(message);
    this.name = "CAError";
  }
}

export interface ClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  perMinute?: number;
  maxInFlight?: number;
  maxRetries?: number;
  maxRetryWaitMs?: number;
  cacheTtlMs?: number;
  cacheMax?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

type Params = Record<string, string | number | boolean | undefined | null>;

export class CommunityArchiveClient {
  readonly baseUrl: string;
  private apiKey: string;
  private fetchImpl: typeof fetch;
  private perMinute: number;
  private maxInFlight: number;
  private maxRetries: number;
  private maxRetryWaitMs: number;
  private cacheTtlMs: number;
  private cacheMax: number;
  private sleep: (ms: number) => Promise<void>;
  private now: () => number;

  private stamps: number[] = [];
  private inFlight = 0;
  private waiters: Array<() => void> = [];
  private cache = new Map<string, { at: number; value: Page }>();
  /** Requests actually sent to the API during this process's life. */
  requestsSent = 0;

  constructor(o: ClientOptions) {
    if (!o.apiKey) throw new Error("Community Archive API key is missing.");
    this.apiKey = o.apiKey;
    this.baseUrl = (o.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.perMinute = o.perMinute ?? 58;
    this.maxInFlight = o.maxInFlight ?? 2;
    this.maxRetries = o.maxRetries ?? 4;
    this.maxRetryWaitMs = o.maxRetryWaitMs ?? 60_000;
    this.cacheTtlMs = o.cacheTtlMs ?? 10 * 60_000;
    this.cacheMax = o.cacheMax ?? 500;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = o.now ?? Date.now;
  }

  url(path: string, params: Params = {}): string {
    const u = new URL(this.baseUrl + (path.startsWith("/") ? path : "/" + path));
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === "") continue;
      u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  async get<T = Json>(path: string, params: Params = {}, opts: { cache?: boolean } = {}): Promise<Page<T>> {
    const url = this.url(path, params);
    const useCache = opts.cache !== false;
    if (useCache) {
      const hit = this.cache.get(url);
      if (hit && this.now() - hit.at < this.cacheTtlMs) return hit.value as Page<T>;
    }
    const value = await this.send<T>(url);
    if (useCache) {
      this.cache.set(url, { at: this.now(), value });
      if (this.cache.size > this.cacheMax) this.cache.delete(this.cache.keys().next().value!);
    }
    return value;
  }

  /** Follow next_cursor until null or maxPages reached. */
  async paged<T = Json>(
    path: string,
    params: Params,
    maxPages: number,
  ): Promise<{ items: T[]; next_cursor: string | null; pages: number; request_ids: string[] }> {
    const items: T[] = [];
    const ids: string[] = [];
    let cursor = (params.cursor as string | undefined) ?? undefined;
    let pages = 0;
    for (;;) {
      const page = await this.get<T[]>(path, { ...params, cursor });
      pages++;
      if (page.request_id) ids.push(page.request_id);
      if (Array.isArray(page.data)) items.push(...page.data);
      cursor = page.next_cursor ?? undefined;
      if (!cursor || pages >= maxPages) return { items, next_cursor: cursor ?? null, pages, request_ids: ids };
    }
  }

  private async slot(): Promise<void> {
    // concurrency
    while (this.inFlight >= this.maxInFlight) await new Promise<void>((r) => this.waiters.push(r));
    this.inFlight++;
    // per-minute window
    for (;;) {
      const t = this.now();
      this.stamps = this.stamps.filter((s) => t - s < 60_000);
      if (this.stamps.length < this.perMinute) {
        this.stamps.push(t);
        return;
      }
      await this.sleep(60_000 - (t - this.stamps[0]) + 25);
    }
  }

  private release() {
    this.inFlight--;
    this.waiters.shift()?.();
  }

  private async send<T>(url: string): Promise<Page<T>> {
    for (let attempt = 0; ; attempt++) {
      await this.slot();
      let res: Response;
      try {
        this.requestsSent++;
        res = await this.fetchImpl(url, {
          headers: { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json", "User-Agent": "community-archive-mcp/0.1" },
        });
      } catch (e: any) {
        this.release();
        if (attempt < this.maxRetries) {
          await this.sleep(Math.min(this.maxRetryWaitMs, 1000 * 2 ** attempt));
          continue;
        }
        throw new CAError("network_error", `Could not reach the Community Archive API: ${e?.message ?? e}`, 0);
      }
      this.release();

      if (res.status === 429 || res.status === 503) {
        if (attempt < this.maxRetries) {
          const ra = Number(res.headers.get("retry-after"));
          const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * 2 ** attempt;
          await this.sleep(Math.min(this.maxRetryWaitMs, wait));
          continue;
        }
      }

      let body: any = null;
      const text = await res.text();
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      if (res.ok) return (body ?? { data: null }) as Page<T>;

      const err = body?.error ?? {};
      const rid = body?.request_id;
      const msg = err.message ?? `HTTP ${res.status}`;
      const hint =
        res.status === 401 || res.status === 403
          ? " Check that the API key is valid (create one at https://www.community-archive.org/settings/api-keys)."
          : res.status === 422
            ? " The query exceeded its budget; narrow it, for example with since/until or from_user."
            : res.status === 404
              ? " Not in the archive (deleted, opted out, or never uploaded)."
              : res.status === 429
                ? " Rate limit still exceeded after retries; try again in a minute."
                : "";
      const sep = hint && !/[.!?]$/.test(msg) ? "." : "";
      throw new CAError(err.code ?? `http_${res.status}`, msg + sep + hint, res.status, rid);
    }
  }
}

export function loadDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    out[m[1]] = v;
  }
  return out;
}
