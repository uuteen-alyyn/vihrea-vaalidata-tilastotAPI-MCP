import type { PxWebNode, PxWebTableMetadata, PxWebQuery, PxWebResponse } from './types.js';

// ─── Runtime shape guards ─────────────────────────────────────────────────────

function assertPxWebResponse(raw: unknown, url: string): PxWebResponse {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`PxWeb response from ${url} is not an object (got ${typeof raw})`);
  }
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r['columns'])) {
    throw new Error(`PxWeb response from ${url} missing "columns" array (schema may have changed)`);
  }
  if (!Array.isArray(r['data'])) {
    throw new Error(`PxWeb response from ${url} missing "data" array (schema may have changed)`);
  }
  return raw as PxWebResponse;
}

function assertPxWebMetadata(raw: unknown, url: string): PxWebTableMetadata {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`PxWeb metadata from ${url} is not an object (got ${typeof raw})`);
  }
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r['variables'])) {
    throw new Error(`PxWeb metadata from ${url} missing "variables" array (schema may have changed)`);
  }
  return raw as PxWebTableMetadata;
}

// Client-side pacing. The published figure is 10 requests per 10-second sliding
// window, but that is not the whole policy: measured 27.08.2026, twenty *node
// listing* requests in 2.8 s all succeeded, while twenty *metadata* requests
// (442 KB) were blocked at the twentieth. The limit is evidently weighted by
// response size, not request count, so no single request rate is safe.
//
// Hence pacing is a courtesy, and `retryOn429` below is the actual protection:
// blocks were measured to clear in 10–15 s, so retrying works where guessing a
// rate does not.
const RATE_LIMIT_REQUESTS = 10;
const RATE_LIMIT_WINDOW_MS = 10_000;

/** How many times to retry a 429 before giving up. */
const RATE_LIMIT_RETRIES = 3;
/** Base backoff; measured recovery was 10–15 s, so start there rather than at 1 s. */
const RATE_LIMIT_BACKOFF_MS = 12_000;

const BASE_URL = 'https://pxdata.stat.fi/PXWeb/api/v1';

export class PxWebClient {
  private requestTimestamps: number[] = [];

  /** Wait if needed to stay within rate limits (iterative — no stack growth) */
  private async throttle(): Promise<void> {
    while (true) {
      const now = Date.now();
      this.requestTimestamps = this.requestTimestamps.filter(
        (t) => now - t < RATE_LIMIT_WINDOW_MS
      );
      if (this.requestTimestamps.length < RATE_LIMIT_REQUESTS) {
        this.requestTimestamps.push(Date.now());
        return;
      }
      const oldest = this.requestTimestamps[0]!;
      const waitMs = RATE_LIMIT_WINDOW_MS - (now - oldest) + 50;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  /** List nodes (sublevels and tables) at a database path */
  async listNodes(database: string, ...levels: string[]): Promise<PxWebNode[]> {
    const path = [database, ...levels].join('/');
    return this.get<PxWebNode[]>(`${BASE_URL}/fi/${path}`);
  }

  /** Fetch table metadata (variables and their possible values) */
  async getTableMetadata(
    database: string,
    tableId: string,
    ...levels: string[]
  ): Promise<PxWebTableMetadata> {
    const path = [database, ...levels, withPx(tableId)].join('/');
    const url = `${BASE_URL}/fi/${path}`;
    const raw = await this.get<unknown>(url);
    return assertPxWebMetadata(raw, url);
  }

  /** Query a table for data (POST) */
  async queryTable(
    database: string,
    tableId: string,
    query: PxWebQuery,
    ...levels: string[]
  ): Promise<PxWebResponse> {
    const path = [database, ...levels, withPx(tableId)].join('/');
    const url = `${BASE_URL}/fi/${path}`;
    const raw = await this.post<unknown>(url, query);
    return assertPxWebResponse(raw, url);
  }

  /**
   * Issue one request, retrying on 429.
   *
   * The error message deliberately carries the method, the URL, the status and
   * PxWeb's own response body. The previous message was
   * `Upstream data source returned 400` and nothing else, which reads as "the
   * source is down" when in fact 400 means *we* sent something malformed. That
   * wording is why the July 2026 contract change was diagnosed as a Statistics
   * Finland outage and left unfixed for eight weeks.
   */
  private async request<T>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await this.throttle();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30_000);
      try {
        const res = await fetch(url, {
          method,
          headers: body === undefined
            ? { Accept: 'application/json' }
            : { 'Content-Type': 'application/json', Accept: 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: controller.signal,
        });

        if (res.status === 429 && attempt < RATE_LIMIT_RETRIES) {
          const retryAfter = Number(res.headers.get('retry-after'));
          const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : RATE_LIMIT_BACKOFF_MS * (attempt + 1);
          console.error(`PxWeb ${method} ${url} → 429, retrying in ${waitMs} ms (attempt ${attempt + 1}/${RATE_LIMIT_RETRIES})`);
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          continue;
        }

        if (!res.ok) {
          const detail = (await res.text().catch(() => '')).slice(0, 500).trim();
          console.error(`PxWeb ${method} ${url} → ${res.status} ${res.statusText} ${detail}`);
          throw new Error(
            `PxWeb ${method} ${url} failed: ${res.status} ${res.statusText}` +
            (detail ? ` — ${detail}` : '') +
            (res.status === 400
              ? '. A 400 means the request was malformed, not that the source is down — ' +
                'usually a table id or variable code that no longer exists upstream.'
              : '')
          );
        }

        return res.json() as Promise<T>;
      } finally {
        clearTimeout(timeoutId);
      }
    }
  }

  private get<T>(url: string): Promise<T> {
    return this.request<T>('GET', url);
  }

  private post<T>(url: string, body: unknown): Promise<T> {
    return this.request<T>('POST', url, body);
  }
}

export const pxwebClient = new PxWebClient();

/**
 * PxWeb requires the .px extension on table IDs for both GET and POST.
 *
 * Table IDs in the registry are the short codes Statistics Finland has used
 * since 2026-07-01 (`13sw`, not `statfin_evaa_pxt_13sw`). No translation happens
 * here on purpose: the old names return 404 upstream and appear nowhere in the
 * live listings, so a compatibility shim would only keep false strings alive in
 * the registry — including the ones `tools/audit` publishes as documentation.
 */
function withPx(tableId: string): string {
  return tableId.endsWith('.px') ? tableId : `${tableId}.px`;
}
