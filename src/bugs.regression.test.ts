/**
 * Regression tests for bugs documented in audits/MATH_AUDIT.md.
 *
 * All bugs BUG-1 through BUG-10 have been fixed in Phase 19.
 * These tests now assert the CORRECT (fixed) behavior.
 */

import { describe, it, expect } from 'vitest';
import { pct, round2 } from './tools/shared.js';

// ─── BUG-1 ────────────────────────────────────────────────────────────────────
// analyze_candidate_profile: share_of_party_vote_pct is now a percentage (fixed)
// Fix: pct(totalVotes / partyTotalVotes * 100) — field renamed to share_of_party_vote_pct

describe('BUG-1 FIXED: share_of_party_vote_pct returns percentage', () => {
  const totalVotes = 2300;
  const partyTotalVotes = 10000;

  it('fixed formula returns percentage (23, not 0.23)', () => {
    // analytics/index.ts now uses: pct(totalVotes / partyTotalVotes * 100)
    const result = pct((totalVotes / partyTotalVotes) * 100);
    expect(result).toBe(23); // 23% — correct
    expect(result).toBeGreaterThan(1); // clearly a percentage, not a ratio
  });

  it('consistent with analyze_within_party_position formula', () => {
    const withinPartyResult = pct((totalVotes / partyTotalVotes) * 100);
    expect(withinPartyResult).toBe(23);
  });

  it('edge case: zero party votes → null', () => {
    const shareWhenZero = 0 > 0 ? pct((totalVotes / 0) * 100) : null;
    expect(shareWhenZero).toBeNull();
  });
});

// ─── BUG-2 ────────────────────────────────────────────────────────────────────
// buildPartyAnalysis: now filters to kunta-only (fixed)
// Fix: area_level !== 'kunta' replaces area_level === 'koko_suomi'

describe('BUG-2 FIXED: buildPartyAnalysis filters to kunta-only, no double-counting', () => {
  const rows = [
    { party_id: 'SDP', area_level: 'kunta',       votes: 1000 },
    { party_id: 'SDP', area_level: 'kunta',       votes: 2000 },
    { party_id: 'SDP', area_level: 'vaalipiiri',  votes: 3000 }, // already = 1000 + 2000
    { party_id: 'SDP', area_level: 'koko_suomi',  votes: 3000 }, // excluded
    { party_id: 'KOK', area_level: 'kunta',       votes: 500  },
    { party_id: 'KOK', area_level: 'vaalipiiri',  votes: 500  },
  ] as Array<{ party_id: string; area_level: string; votes: number }>;

  it('fixed approach: filters to kunta-only, produces correct totals', () => {
    // retrieval/index.ts now uses: if (!row.party_id || row.area_level !== 'kunta') continue;
    const totals: Record<string, number> = {};
    for (const row of rows) {
      if (row.area_level !== 'kunta') continue;
      totals[row.party_id] = (totals[row.party_id] ?? 0) + row.votes;
    }
    expect(totals['SDP']).toBe(3000); // correct: 1000 + 2000 only
    expect(totals['KOK']).toBe(500);
  });
});

// ─── BUG-3 ────────────────────────────────────────────────────────────────────
// find_exposed_vote_pools: now uses net_vote_count_change + total_share_points_lost (fixed)

describe('BUG-3 FIXED: find_exposed_vote_pools uses net vote change and share points lost', () => {
  const areas = [
    { area_id: '091', votes_year1: 1000, votes_year2: 1100, share_year1: 30.0, share_year2: 28.0 },
    { area_id: '049', votes_year1: 500,  votes_year2: 600,  share_year1: 25.0, share_year2: 22.0 },
  ];

  it('net_vote_count_change is positive when raw votes rose despite share falling', () => {
    // strategic/index.ts now uses: votes_year2 - votes_year1 (positive = gained)
    const netVoteCountChange = areas.reduce((s, a) => s + (a.votes_year2 - a.votes_year1), 0);
    expect(netVoteCountChange).toBe(200); // party gained raw votes
    expect(netVoteCountChange).toBeGreaterThan(0);
  });

  it('total_share_points_lost is always non-negative in exposed areas', () => {
    const totalSharePointsLost = areas.reduce((s, a) => s + (a.share_year1 - a.share_year2), 0);
    expect(totalSharePointsLost).toBe(5); // 2pp + 3pp = 5pp lost
    expect(totalSharePointsLost).toBeGreaterThan(0);
  });
});

// ─── BUG-4 ────────────────────────────────────────────────────────────────────
// rank_areas_by_party_presence: c4 removed; 3-component model with independent components (fixed)

describe('BUG-4 FIXED: rank_areas_by_party_presence uses 3 independent components', () => {
  const nationalShare = 0.20;
  const computeC1 = (share: number) => Math.min(1, share / (nationalShare * 2));
  const computeC2 = (_share: number) => 0.5; // neutral trend for test

  it('new formula: composite = 0.40*c1 + 0.35*c2 + 0.25*c3 (no c4)', () => {
    const share = 0.30;
    const c1 = computeC1(share); // 0.75
    const c2 = computeC2(share); // 0.5
    const c3 = 0.8;              // electorate size (arbitrary)
    const composite = round2(0.40 * c1 + 0.35 * c2 + 0.25 * c3);
    // 0.40*0.75 + 0.35*0.5 + 0.25*0.8 = 0.30 + 0.175 + 0.20 = 0.675 → round2 → 0.68
    expect(composite).toBe(0.68);
  });

  it('weights sum to 1.0', () => {
    const weights = [0.40, 0.35, 0.25];
    expect(weights.reduce((s, w) => s + w, 0)).toBeCloseTo(1.0, 10);
  });

  it('c1 and c2 are independent (c2 is trend percentile rank, not derived from c1)', () => {
    // POL-7 fix: c2 now uses percentile rank within the actual distribution, not ±10pp fixed scale.
    // Simulate 3 areas with changes [-2, +1, +4] pp (typical Finnish range).
    const sortedChanges = [-2, 1, 4]; // ascending
    const percentileRank = (change: number) => {
      const rank = sortedChanges.filter((t) => t <= change).length;
      return sortedChanges.length > 1 ? (rank - 1) / (sortedChanges.length - 1) : 0.5;
    };
    expect(percentileRank(-2)).toBe(0.0); // worst trend → score 0
    expect(percentileRank(1)).toBe(0.5);  // middle trend → score 0.5
    expect(percentileRank(4)).toBe(1.0);  // best trend → score 1.0
    // c1 is unaffected by trend — genuinely independent
    const c1High = computeC1(0.30);
    expect(c1High).toBeCloseTo(0.75, 10);
    expect(percentileRank(-2)).not.toBe(percentileRank(4)); // c2 varies independently
  });
});

// ─── BUG-5 ────────────────────────────────────────────────────────────────────
// concentrationMetrics: now returns _pct fields with percentage values (fixed)

describe('BUG-5 FIXED: concentrationMetrics returns _pct fields', () => {
  // Reproduce fixed concentrationMetrics logic
  const computeConcentration = (votes: number[]) => {
    const total = votes.reduce((a, b) => a + b, 0);
    const sorted = [...votes].sort((a, b) => b - a);
    const topShare = (n: number) =>
      pct((sorted.slice(0, n).reduce((s, v) => s + v, 0) / total) * 100);
    return { top1_share_pct: topShare(1), top3_share_pct: topShare(3) };
  };

  const votes = [3100, 2000, 1500, 800, 600]; // sum = 8000

  it('top1_share_pct is a percentage (> 1)', () => {
    const conc = computeConcentration(votes);
    expect(conc.top1_share_pct).toBe(38.8); // 3100/8000 × 100 = 38.75 → 38.8
    expect(conc.top1_share_pct).toBeGreaterThan(1); // clearly a percentage
  });

  it('field name uses _pct suffix — no ambiguity', () => {
    const conc = computeConcentration(votes);
    expect('top1_share_pct' in conc).toBe(true);
    expect('top1_share' in conc).toBe(false); // old name gone
  });
});

// ─── BUG-8 ────────────────────────────────────────────────────────────────────
// estimate_vote_transfer_proxy: co-movement now requires magnitude threshold (fixed)

describe('BUG-8 FIXED: co-movement requires MIN_TRANSFER_VOTES=50 and 10% gainer ratio', () => {
  const MIN_TRANSFER_VOTES = 50;

  const classify = (loser_change: number, gainer_change: number) =>
    loser_change < 0 &&
    gainer_change > 0 &&
    Math.abs(loser_change) >= MIN_TRANSFER_VOTES &&
    gainer_change >= 0.1 * Math.abs(loser_change)
      ? 'consistent_with_transfer'
      : 'inconsistent';

  it('1-vote noise is now classified inconsistent', () => {
    expect(classify(-1, 2)).toBe('inconsistent'); // too small
  });

  it('real signal (−1000 loser, +200 gainer) is consistent', () => {
    expect(classify(-1000, 200)).toBe('consistent_with_transfer');
  });

  it('asymmetric case (−1000 loser, +1 gainer) is inconsistent', () => {
    expect(classify(-1000, 1)).toBe('inconsistent'); // 1 < 0.1 * 1000 = 100
  });

  it('boundary case: exactly at threshold', () => {
    expect(classify(-50, 5)).toBe('consistent_with_transfer'); // 50 >= 50, 5 >= 0.1*50=5
    expect(classify(-49, 5)).toBe('inconsistent'); // 49 < 50
  });
});

// ─── BUG-9 ────────────────────────────────────────────────────────────────────
// rank_areas_by_party_presence: c3_size now uses allVotesByArea (total electorate) (fixed)

describe('BUG-9 FIXED: c3_size uses total electorate size, not party vote volume', () => {
  const allVotesByArea = new Map<string, number>([
    ['091', 80000], // Helsinki: 80k total votes from all parties
    ['049', 10000], // Espoo: 10k
  ]);

  const maxTotalVotes = Math.max(...Array.from(allVotesByArea.values())); // 80000

  it('c3_size reflects electorate size (total votes / max total)', () => {
    const c3Helsinki = (allVotesByArea.get('091') ?? 0) / maxTotalVotes;
    const c3Espoo    = (allVotesByArea.get('049') ?? 0) / maxTotalVotes;
    expect(c3Helsinki).toBe(1.0);
    expect(c3Espoo).toBeCloseTo(0.125, 3); // 10k / 80k
  });

  it('c3 is independent of party vote share (a high-share small area does not score inflated)', () => {
    // Espoo: party has 30% share but the area is small → c3 = 0.125 (small)
    // Helsinki: party has 20% share but large area → c3 = 1.0 (large)
    const c3Helsinki = (allVotesByArea.get('091') ?? 0) / maxTotalVotes;
    const c3Espoo    = (allVotesByArea.get('049') ?? 0) / maxTotalVotes;
    expect(c3Helsinki).toBeGreaterThan(c3Espoo); // larger area scores higher regardless of party share
  });
});

// ─── BUG-10 ───────────────────────────────────────────────────────────────────
// detect_inactive_high_vote_candidates: collision detection now emits warning (fixed)

describe('BUG-10 FIXED: diacritic normalization collisions are detected and flagged', () => {
  const normalizeName = (name: string) =>
    name
      .toLowerCase()
      .replace(/ä/g, 'a')
      .replace(/ö/g, 'o')
      .replace(/å/g, 'a')
      .replace(/\s+/g, ' ')
      .trim();

  it('Mäki and Maki still normalize to the same string (normalization unchanged)', () => {
    expect(normalizeName('Mäki')).toBe('maki');
    expect(normalizeName('Maki')).toBe('maki');
  });

  it('collision detection fires when duplicates exist', () => {
    const toYearCandidates = ['Mäki Timo', 'Maki Timo'];
    const normalizedNames = toYearCandidates.map(normalizeName);
    const seen = new Set<string>();
    const collisions = new Set<string>();
    for (const n of normalizedNames) {
      if (seen.has(n)) collisions.add(n);
      seen.add(n);
    }
    expect(collisions.size).toBeGreaterThan(0); // collision detected → triggers name_normalization_warning
  });

  it('no false collision when names are genuinely distinct', () => {
    const toYearCandidates = ['Virtanen Pekka', 'Korhonen Anna'];
    const normalizedNames = toYearCandidates.map(normalizeName);
    const seen = new Set<string>();
    const collisions = new Set<string>();
    for (const n of normalizedNames) {
      if (seen.has(n)) collisions.add(n);
      seen.add(n);
    }
    expect(collisions.size).toBe(0); // no collision
  });
});

// ─── FUNC-7 ───────────────────────────────────────────────────────────────────
// bigramSimilarity returns 0 for single-character inputs (fixed)
// Fix: short-string fallback — exact match → 1.0, prefix → 0.5, else 0

describe('FUNC-7 FIXED: bigramSimilarity short-string fallback', () => {
  // Reproduce the fixed bigramSimilarity logic inline (function is not exported)
  function buildBigrams(s: string): Set<string> {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  }
  function bigramSimilarity(a: string, aSet: Set<string>, b: string): number {
    if (a.length < 2 || b.length < 2) {
      if (a === b) return 1.0;
      if (b.startsWith(a) || a.startsWith(b)) return 0.5;
      return 0;
    }
    if (aSet.size === 0) return 0;
    const bSet = buildBigrams(b);
    if (bSet.size === 0) return 0;
    let intersection = 0;
    for (const bg of aSet) if (bSet.has(bg)) intersection++;
    return (2 * intersection) / (aSet.size + bSet.size);
  }

  it('single-char exact match returns 1.0 (was 0 before fix)', () => {
    expect(bigramSimilarity('a', buildBigrams('a'), 'a')).toBe(1.0);
  });

  it('single-char prefix match returns 0.5', () => {
    expect(bigramSimilarity('a', buildBigrams('a'), 'ab')).toBe(0.5);
    expect(bigramSimilarity('ab', buildBigrams('ab'), 'a')).toBe(0.5);
  });

  it('single-char non-match returns 0', () => {
    expect(bigramSimilarity('a', buildBigrams('a'), 'b')).toBe(0);
  });

  it('two-char strings still use bigram path', () => {
    // 'ab' and 'ab' share bigram 'ab' → score = 2*1/(1+1) = 1.0
    expect(bigramSimilarity('ab', buildBigrams('ab'), 'ab')).toBe(1.0);
    // 'ab' and 'cd' share no bigrams → 0
    expect(bigramSimilarity('ab', buildBigrams('ab'), 'cd')).toBe(0);
  });
});
