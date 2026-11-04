// Minimal JSON-over-HTTPS client for REST APIs (Jupiter), with timeouts and retries.

export class HttpError extends Error {
  readonly status: number | undefined;
  readonly body: string | undefined;
  constructor(message: string, status?: number, body?: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

export interface HttpOptions {
  timeoutMs?: number;
  maxRetries?: number;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export function assertSecureUrl(url: string): URL {
  const u = new URL(url);
  if (u.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) {
    throw new Error(`${u.host}: https is required (plain http only for localhost)`);
  }
  return u;
}

export class JsonClient {
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(baseUrl: string, options: HttpOptions = {}) {
    assertSecureUrl(baseUrl);
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.headers = options.headers ?? {};
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get host(): string {
    return new URL(this.baseUrl).host;
  }

  async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const url = this.baseUrl + path;
    let last: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await this.sleep(Math.min(8_000, 500 * 2 ** (attempt - 1)));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(url, {
          method,
          headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...this.headers },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: controller.signal,
        });
        const text = await res.text();
        if (RETRYABLE.has(res.status)) {
          last = new HttpError(`${method} ${this.host}${path.split('?')[0]} -> HTTP ${res.status}`, res.status, text.slice(0, 500));
          continue;
        }
        if (!res.ok) throw new HttpError(`${method} ${this.host}${path.split('?')[0]} -> HTTP ${res.status}: ${text.slice(0, 300)}`, res.status, text.slice(0, 2000));
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new HttpError(`${method} ${this.host}${path.split('?')[0]}: response is not JSON`, res.status, text.slice(0, 500));
        }
      } catch (e) {
        if (e instanceof HttpError && e.status !== undefined && !RETRYABLE.has(e.status)) throw e;
        last = e;
      } finally {
        clearTimeout(timer);
      }
    }
    const msg = last instanceof Error ? last.message : String(last);
    const cause = last instanceof Error ? (last.cause as { message?: string; code?: string } | undefined) : undefined;
    throw new HttpError(`${method} ${this.host}${path.split('?')[0]} failed after ${this.maxRetries + 1} attempts: ${msg}${cause ? ` (${cause.message ?? cause.code})` : ''}`);
  }
}
