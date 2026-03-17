/**
 * Shared helpers and constants used across all tool category modules.
 * Import from here instead of defining locally to avoid duplication.
 */

import { z } from 'zod';
import type { ElectionRecord, ElectionType, AreaLevel } from '../data/types.js';

// ─── Shared Zod schema ────────────────────────────────────────────────────────

export const ELECTION_TYPE_PARAM = z.enum(['parliamentary', 'municipal', 'eu_parliament', 'presidential', 'regional'])
  .optional()
  .describe('Election type. Defaults to "parliamentary".');

// ─── Election-type helpers ────────────────────────────────────────────────────

/** Returns the finest sub-national area level with kunta-like breakdown for each election type. */
export function subnatLevel(type: ElectionType): AreaLevel {
  if (type === 'regional') return 'hyvinvointialue';
  if (type === 'eu_parliament' || type === 'presidential') return 'vaalipiiri';
  return 'kunta';
}

// ─── Party matching ───────────────────────────────────────────────────────────

/**
 * Match a party row by either its numeric code (party_id) or text label (party_name).
 * party_name in 13sw rows is the full text like "Kansallinen Kokoomus" or abbreviated "KOK".
 */
export function matchesParty(row: ElectionRecord, query: string): boolean {
  const q = query.toLowerCase().trim();
  return row.party_id === query || row.party_name?.toLowerCase() === q;
}

// ─── Math helpers ─────────────────────────────────────────────────────────────

/** Round to 1 decimal place (for percentage points) */
export function pct(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Round to 2 decimal places */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─── MCP response builders ────────────────────────────────────────────────────

export function mcpText(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }] };
}

export function errResult(msg: string) {
  return mcpText({ error: msg });
}
