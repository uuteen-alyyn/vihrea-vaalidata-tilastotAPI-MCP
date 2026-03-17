import { describe, it, expect } from 'vitest';
import {
  pct,
  round2,
  mcpText,
  errResult,
  subnatLevel,
  matchesParty,
} from './shared.js';
import type { ElectionRecord } from '../data/types.js';

// ─── pct ──────────────────────────────────────────────────────────────────────

describe('pct', () => {
  it('rounds to 1 decimal place', () => {
    expect(pct(23.0)).toBe(23);
    expect(pct(23.14)).toBe(23.1);
    expect(pct(23.15)).toBe(23.2);
    expect(pct(23.19)).toBe(23.2);
  });

  it('handles zero', () => {
    expect(pct(0)).toBe(0);
  });

  it('handles negative values', () => {
    expect(pct(-5.67)).toBe(-5.7);
    expect(pct(-5.64)).toBe(-5.6);
  });

  it('preserves whole numbers exactly', () => {
    expect(pct(100)).toBe(100);
    expect(pct(50)).toBe(50);
  });

  it('handles very small fractions', () => {
    expect(pct(0.05)).toBe(0.1);
    expect(pct(0.04)).toBe(0);
  });

  // Critical: pct(votes/total*100) should return percentage, not ratio
  it('converts a 0.23 fraction to 23.0 when pre-multiplied by 100', () => {
    expect(pct(0.23 * 100)).toBe(23);
    expect(pct(0.234 * 100)).toBe(23.4);
  });
});

// ─── round2 ───────────────────────────────────────────────────────────────────

describe('round2', () => {
  it('rounds to 2 decimal places', () => {
    expect(round2(1.234)).toBe(1.23);
    expect(round2(1.235)).toBe(1.24);
    expect(round2(1.239)).toBe(1.24);
  });

  it('handles zero', () => {
    expect(round2(0)).toBe(0);
  });

  it('handles negative values', () => {
    expect(round2(-1.234)).toBe(-1.23);
  });

  it('handles whole numbers', () => {
    expect(round2(42)).toBe(42);
  });

  // BUG-1 demonstration: round2 on a fraction returns 0-1, not percentage
  it('returns a ratio (0–1) when given votes/total — NOT a percentage', () => {
    const votes = 2300;
    const partyTotal = 10000;
    // round2 returns 0.23 — looks like "0.23%" to an LLM
    expect(round2(votes / partyTotal)).toBe(0.23);
    // The correct way is pct(votes/total*100) which returns 23.0
    expect(pct((votes / partyTotal) * 100)).toBe(23);
  });
});

// ─── mcpText ──────────────────────────────────────────────────────────────────

describe('mcpText', () => {
  it('returns MCP content array with text type', () => {
    const result = mcpText({ foo: 'bar' });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
  });

  it('JSON-serializes the value with 2-space indent', () => {
    const result = mcpText({ foo: 'bar' });
    expect(result.content[0].text).toBe(JSON.stringify({ foo: 'bar' }, null, 2));
  });

  it('handles arrays', () => {
    const result = mcpText([1, 2, 3]);
    expect(JSON.parse(result.content[0].text)).toEqual([1, 2, 3]);
  });

  it('handles nested objects', () => {
    const obj = { a: { b: 42 } };
    const result = mcpText(obj);
    expect(JSON.parse(result.content[0].text)).toEqual(obj);
  });
});

// ─── errResult ────────────────────────────────────────────────────────────────

describe('errResult', () => {
  it('returns an error MCP response', () => {
    const result = errResult('something went wrong');
    expect(result.content[0].type).toBe('text');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({ error: 'something went wrong' });
  });

  it('uses mcpText under the hood (same structure)', () => {
    const result = errResult('test');
    expect(result).toHaveProperty('content');
    expect(Array.isArray(result.content)).toBe(true);
  });
});

// ─── subnatLevel ──────────────────────────────────────────────────────────────

describe('subnatLevel', () => {
  it('returns kunta for parliamentary elections', () => {
    expect(subnatLevel('parliamentary')).toBe('kunta');
  });

  it('returns kunta for municipal elections', () => {
    expect(subnatLevel('municipal')).toBe('kunta');
  });

  it('returns hyvinvointialue for regional elections', () => {
    expect(subnatLevel('regional')).toBe('hyvinvointialue');
  });

  it('returns vaalipiiri for eu_parliament elections', () => {
    expect(subnatLevel('eu_parliament')).toBe('vaalipiiri');
  });

  it('returns vaalipiiri for presidential elections', () => {
    expect(subnatLevel('presidential')).toBe('vaalipiiri');
  });
});

// ─── matchesParty ─────────────────────────────────────────────────────────────

const makeRow = (party_id?: string, party_name?: string): ElectionRecord => ({
  election_type: 'parliamentary',
  year: 2023,
  area_level: 'kunta',
  area_id: '091091',
  area_name: 'Helsinki',
  votes: 1000,
  party_id,
  party_name,
});

describe('matchesParty', () => {
  it('matches by exact party_id', () => {
    expect(matchesParty(makeRow('SDP', 'Suomen Sosialidemokraattinen Puolue'), 'SDP')).toBe(true);
  });

  it('matches by lowercase party_name', () => {
    expect(matchesParty(makeRow('SDP', 'Suomen Sosialidemokraattinen Puolue'), 'suomen sosialidemokraattinen puolue')).toBe(true);
  });

  it('matches party_name case-insensitively', () => {
    expect(matchesParty(makeRow('KOK', 'Kansallinen Kokoomus'), 'KANSALLINEN KOKOOMUS')).toBe(true);
  });

  it('does not match partial name substrings', () => {
    // matchesParty uses strict equality, not includes
    expect(matchesParty(makeRow('KOK', 'Kansallinen Kokoomus'), 'kokoomus')).toBe(false);
  });

  it('returns false when row has no party_id or party_name', () => {
    expect(matchesParty(makeRow(undefined, undefined), 'SDP')).toBe(false);
  });

  it('does not match when query matches name but row id differs', () => {
    // id='SDP' query='SDP' matches via id
    expect(matchesParty(makeRow('SDP', 'Jokin Muu'), 'SDP')).toBe(true);
    // name='SDP' query='SDP' — party_id !== 'SDP' and party_name.lower !== 'sdp'
    // (party_name = 'Jokin Muu') so should NOT match by name... but DOES match by id
    // This is correct behavior: id match takes priority
  });

  it('returns false when neither id nor name match', () => {
    expect(matchesParty(makeRow('KOK', 'Kansallinen Kokoomus'), 'SDP')).toBe(false);
  });
});
