/** Simple in-memory TTL cache to avoid redundant API requests */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour — election data is static

const store = new Map<string, CacheEntry<unknown>>();

export function cacheGet<T>(key: string): T | undefined {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return undefined;
  }
  return entry.value as T;
}

export function cacheSet<T>(key: string, value: T, ttlMs = DEFAULT_TTL_MS): void {
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
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
