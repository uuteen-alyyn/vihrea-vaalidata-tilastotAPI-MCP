import type { PxWebNode, PxWebTableMetadata, PxWebQuery, PxWebResponse } from './types.js';

// Rate limit: 10 requests per 10-second sliding window (HTTP 429 on excess)
const RATE_LIMIT_REQUESTS = 10;
const RATE_LIMIT_WINDOW_MS = 10_000;

const BASE_URL = 'https://pxdata.stat.fi/PXWeb/api/v1';

export class PxWebClient {
  private requestTimestamps: number[] = [];

  /** Wait if needed to stay within rate limits */
  private async throttle(): Promise<void> {
    const now = Date.now();
    this.requestTimestamps = this.requestTimestamps.filter(
      (t) => now - t < RATE_LIMIT_WINDOW_MS
    );
    if (this.requestTimestamps.length >= RATE_LIMIT_REQUESTS) {
      const oldest = this.requestTimestamps[0];
      const waitMs = RATE_LIMIT_WINDOW_MS - (now - oldest) + 50;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return this.throttle();
    }
    this.requestTimestamps.push(Date.now());
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
    return this.get<PxWebTableMetadata>(`${BASE_URL}/fi/${path}`);
  }

  /** Query a table for data (POST) */
  async queryTable(
    database: string,
    tableId: string,
    query: PxWebQuery,
    ...levels: string[]
  ): Promise<PxWebResponse> {
    const path = [database, ...levels, withPx(tableId)].join('/');
    return this.post<PxWebResponse>(`${BASE_URL}/fi/${path}`, query);
  }

  private async get<T>(url: string): Promise<T> {
    await this.throttle();
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`PxWeb GET ${url} → ${res.status} ${res.statusText}`);
    return res.json() as Promise<T>;
  }

  private async post<T>(url: string, body: unknown): Promise<T> {
    await this.throttle();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`PxWeb POST ${url} → ${res.status} ${res.statusText}`);
    return res.json() as Promise<T>;
  }
}

export const pxwebClient = new PxWebClient();

/** PxWeb requires the .px extension on table IDs for both GET and POST */
function withPx(tableId: string): string {
  return tableId.endsWith('.px') ? tableId : `${tableId}.px`;
}
