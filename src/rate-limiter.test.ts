/**
 * Unit tests for the per-IP sliding-window rate limiter logic.
 * The rate limiter state (ipTimestamps Map) is local to server-http.ts
 * so we test the extracted logic here in isolation.
 */

import { describe, it, expect, beforeEach } from 'vitest';

// ─── Extracted rate-limiter logic (mirrors server-http.ts) ───────────────────

function makeRateLimiter(maxRequests: number, windowMs: number) {
  const ipTimestamps = new Map<string, number[]>();

  function checkRateLimit(ip: string, now: number = Date.now()): boolean {
    const ts     = ipTimestamps.get(ip) ?? [];
    const recent = ts.filter((t) => now - t < windowMs);
    if (recent.length >= maxRequests) {
      ipTimestamps.set(ip, recent);
      return false;
    }
    recent.push(now);
    ipTimestamps.set(ip, recent);
    return true;
  }

  function evict(now: number = Date.now()): void {
    for (const [ip, ts] of ipTimestamps) {
      const recent = ts.filter((t) => now - t < windowMs);
      if (recent.length === 0) ipTimestamps.delete(ip);
      else ipTimestamps.set(ip, recent);
    }
  }

  function size(): number { return ipTimestamps.size; }

  return { checkRateLimit, evict, size };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('per-IP sliding-window rate limiter', () => {
  const LIMIT     = 30;
  const WINDOW_MS = 60_000;

  let rl: ReturnType<typeof makeRateLimiter>;

  beforeEach(() => {
    rl = makeRateLimiter(LIMIT, WINDOW_MS);
  });

  it('allows requests up to the limit', () => {
    const now = Date.now();
    for (let i = 0; i < LIMIT; i++) {
      expect(rl.checkRateLimit('1.2.3.4', now + i)).toBe(true);
    }
  });

  it('rejects the (limit + 1)th request within the window', () => {
    const now = Date.now();
    for (let i = 0; i < LIMIT; i++) rl.checkRateLimit('1.2.3.4', now + i);
    expect(rl.checkRateLimit('1.2.3.4', now + LIMIT)).toBe(false);
  });

  it('allows requests again after the window elapses', () => {
    const t0 = Date.now();
    // Fill up the window
    for (let i = 0; i < LIMIT; i++) rl.checkRateLimit('1.2.3.4', t0 + i);
    expect(rl.checkRateLimit('1.2.3.4', t0 + LIMIT)).toBe(false);

    // Advance time past the window — all old timestamps expire
    const t1 = t0 + WINDOW_MS + 1;
    expect(rl.checkRateLimit('1.2.3.4', t1)).toBe(true);
  });

  it('tracks different IPs independently', () => {
    const now = Date.now();
    // Exhaust IP A
    for (let i = 0; i < LIMIT; i++) rl.checkRateLimit('1.1.1.1', now + i);
    expect(rl.checkRateLimit('1.1.1.1', now + LIMIT)).toBe(false);

    // IP B is unaffected
    expect(rl.checkRateLimit('2.2.2.2', now + LIMIT)).toBe(true);
  });

  it('sliding window: allows new request when oldest timestamp just left the window', () => {
    const t0 = Date.now();
    // Fill window at t0
    for (let i = 0; i < LIMIT; i++) rl.checkRateLimit('1.2.3.4', t0);
    // At t0 + WINDOW_MS the first batch of timestamps have just expired
    const t1 = t0 + WINDOW_MS;
    expect(rl.checkRateLimit('1.2.3.4', t1)).toBe(true);
  });

  it('evict() removes IPs with no recent timestamps', () => {
    const t0 = Date.now();
    rl.checkRateLimit('1.2.3.4', t0);
    expect(rl.size()).toBe(1);
    // Advance past window
    rl.evict(t0 + WINDOW_MS + 1);
    expect(rl.size()).toBe(0);
  });

  it('evict() keeps IPs that still have recent timestamps', () => {
    const t0 = Date.now();
    rl.checkRateLimit('1.2.3.4', t0);
    rl.checkRateLimit('5.6.7.8', t0);
    // Only advance past half the window
    rl.evict(t0 + WINDOW_MS / 2);
    expect(rl.size()).toBe(2); // both still active
  });

  it('responds correctly to exactly-at-limit burst followed by steady requests', () => {
    const t0 = Date.now();
    // 30 requests at t=0
    for (let i = 0; i < LIMIT; i++) rl.checkRateLimit('1.2.3.4', t0);
    // Request at t=0 is rejected
    expect(rl.checkRateLimit('1.2.3.4', t0)).toBe(false);
    // At t=WINDOW_MS+1 the first 30 have expired, 1 new request is allowed
    expect(rl.checkRateLimit('1.2.3.4', t0 + WINDOW_MS + 1)).toBe(true);
  });
});
