/**
 * In-memory TTL cache with LRU eviction and optional disk persistence.
 *
 * - Max 500 entries. Oldest (LRU) entry evicted when full.
 * - TTL: 1 hour. Expired entries are removed lazily on read.
 * - Disk persistence: entries are loaded from CACHE_FILE on startup and
 *   written back asynchronously after every cacheSet(). This survives
 *   process restarts and avoids cold-start API costs.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_ENTRIES = 500;
const CACHE_FILE = resolve(process.env.CACHE_FILE ?? './cache-store.json');

interface CacheEntry<T = unknown> {
  value: T;
  expiresAt: number;
}

// Map preserves insertion order — used as LRU queue (oldest = first)
const store = new Map<string, CacheEntry>();

// ─── LRU helpers ──────────────────────────────────────────────────────────────

function lruTouch(key: string, entry: CacheEntry): void {
  // Re-insert to move to end (most recently used)
  store.delete(key);
  store.set(key, entry);
}

function lruEvict(): void {
  // Delete the first (oldest) entry
  const firstKey = store.keys().next().value;
  if (firstKey !== undefined) store.delete(firstKey);
}

// ─── Disk persistence ─────────────────────────────────────────────────────────

let persistPending = false;

function persistAsync(): void {
  if (persistPending) return; // coalesce rapid writes
  persistPending = true;
  setImmediate(async () => {
    persistPending = false;
    try {
      const now = Date.now();
      const snapshot: Record<string, CacheEntry> = {};
      for (const [key, entry] of store) {
        if (entry.expiresAt > now) snapshot[key] = entry; // skip expired
      }
      await writeFile(CACHE_FILE, JSON.stringify(snapshot), 'utf8');
    } catch (err) {
      console.error('[cache] failed to persist cache to disk:', err);
    }
  });
}

async function loadFromDisk(): Promise<void> {
  if (!existsSync(CACHE_FILE)) return;
  try {
    const raw = await readFile(CACHE_FILE, 'utf8');
    const snapshot = JSON.parse(raw) as Record<string, CacheEntry>;
    const now = Date.now();
    let loaded = 0;
    for (const [key, entry] of Object.entries(snapshot)) {
      if (entry.expiresAt > now) {
        store.set(key, entry);
        loaded++;
      }
    }
    console.log(`[cache] loaded ${loaded} entries from disk (${CACHE_FILE})`);
  } catch (err) {
    console.error('[cache] failed to load cache from disk:', err);
  }
}

// Load persisted cache on module init (non-blocking)
loadFromDisk().catch(() => { /* already logged inside */ });

// ─── Public API ───────────────────────────────────────────────────────────────

export function cacheGet<T>(key: string): T | undefined {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return undefined;
  }
  lruTouch(key, entry); // mark as recently used
  return entry.value as T;
}

export function cacheSet<T>(key: string, value: T, ttlMs = DEFAULT_TTL_MS): void {
  if (store.size >= MAX_ENTRIES && !store.has(key)) lruEvict();
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
  persistAsync();
}

export function cacheDelete(key: string): void {
  store.delete(key);
}

export function cacheClear(): void {
  store.clear();
}

/** Wraps an async loader with cache-aside logic */
export async function withCache<T>(
  key: string,
  loader: () => Promise<T>,
  ttlMs = DEFAULT_TTL_MS
): Promise<{ value: T; cache_hit: boolean }> {
  const cached = cacheGet<T>(key);
  if (cached !== undefined) return { value: cached, cache_hit: true };
  const value = await loader();
  cacheSet(key, value, ttlMs);
  return { value, cache_hit: false };
}
