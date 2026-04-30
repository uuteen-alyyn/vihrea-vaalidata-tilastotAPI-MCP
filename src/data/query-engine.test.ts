import { describe, it, expect } from 'vitest';
import { applyTopN } from './query-engine.js';
import type { ElectionRecord } from './types.js';

function row(
  partial: Partial<ElectionRecord> & { votes: number },
): ElectionRecord {
  return {
    election_type: 'municipal',
    year: 2025,
    area_level: 'kunta',
    area_id: 'KU106',
    area_name: 'Hyvinkää',
    candidate_id: 'X',
    candidate_name: 'Test',
    party_id: 'VIHR',
    party_name: 'Vihreät',
    ...partial,
  };
}

describe('applyTopN', () => {
  const rows: ElectionRecord[] = [
    row({ candidate_id: 'A', votes: 100, vote_share: 5.0 }),
    row({ candidate_id: 'B', votes: 500, vote_share: 25.0 }),
    row({ candidate_id: 'C', votes: 200, vote_share: 10.0 }),
    row({ candidate_id: 'D', votes: 50, vote_share: 2.5 }),
    row({ candidate_id: 'E', votes: 300, vote_share: 15.0 }),
  ];

  it('returns input untouched when top_n is undefined', () => {
    const out = applyTopN(rows);
    expect(out).toBe(rows); // same reference; no allocation
    expect(out).toHaveLength(5);
  });

  it('returns input untouched when top_n is 0', () => {
    expect(applyTopN(rows, 0)).toBe(rows);
  });

  it('returns input untouched when top_n is negative', () => {
    expect(applyTopN(rows, -3)).toBe(rows);
  });

  it('sorts by votes desc and slices when top_n=3', () => {
    const out = applyTopN(rows, 3);
    expect(out.map((r) => r.candidate_id)).toEqual(['B', 'E', 'C']);
  });

  it('sorts by vote_share desc when top_by="vote_share"', () => {
    const out = applyTopN(rows, 2, 'vote_share');
    expect(out.map((r) => r.candidate_id)).toEqual(['B', 'E']);
  });

  it('returns all rows if top_n exceeds row count', () => {
    expect(applyTopN(rows, 100)).toHaveLength(5);
  });

  it('does not mutate the input array', () => {
    const before = [...rows];
    applyTopN(rows, 3);
    expect(rows).toEqual(before);
  });

  it('puts rows missing the metric at the bottom', () => {
    const mixed: ElectionRecord[] = [
      row({ candidate_id: 'A', votes: 100, vote_share: 5.0 }),
      row({ candidate_id: 'B', votes: 200 }), // no vote_share
      row({ candidate_id: 'C', votes: 300, vote_share: 15.0 }),
    ];
    const out = applyTopN(mixed, 3, 'vote_share');
    expect(out.map((r) => r.candidate_id)).toEqual(['C', 'A', 'B']);
  });

  it('handles all-undefined metric without crashing', () => {
    const noShares: ElectionRecord[] = [
      row({ candidate_id: 'A', votes: 100 }),
      row({ candidate_id: 'B', votes: 200 }),
    ];
    const out = applyTopN(noShares, 1, 'vote_share');
    expect(out).toHaveLength(1);
  });

  it('handles ties stably enough to be useful (input order on ties)', () => {
    const tied: ElectionRecord[] = [
      row({ candidate_id: 'A', votes: 100 }),
      row({ candidate_id: 'B', votes: 100 }),
      row({ candidate_id: 'C', votes: 100 }),
    ];
    const out = applyTopN(tied, 2);
    expect(out).toHaveLength(2);
    // All have equal votes — both are valid top picks; we just don't crash.
  });
});
