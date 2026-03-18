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

// Rate limit: 10 requests per 10-second sliding window (HTTP 429 on excess)
const RATE_LIMIT_REQUESTS = 10;
const RATE_LIMIT_WINDOW_MS = 10_000;

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

  private async get<T>(url: string): Promise<T> {
    await this.throttle();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!res.ok) {
        console.error(`PxWeb GET ${url} → ${res.status} ${res.statusText}`);
        throw new Error(`Upstream data source returned ${res.status}`);
      }
      return res.json() as Promise<T>;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async post<T>(url: string, body: unknown): Promise<T> {
    await this.throttle();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        console.error(`PxWeb POST ${url} → ${res.status} ${res.statusText}`);
        throw new Error(`Upstream data source returned ${res.status}`);
      }
      return res.json() as Promise<T>;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

export const pxwebClient = new PxWebClient();

/** PxWeb requires the .px extension on table IDs for both GET and POST */
function withPx(tableId: string): string {
  return tableId.endsWith('.px') ? tableId : `${tableId}.px`;
}
