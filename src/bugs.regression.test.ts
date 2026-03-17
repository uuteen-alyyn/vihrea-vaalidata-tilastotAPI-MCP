/**
 * Regression tests for bugs documented in audits/MATH_AUDIT.md.
 *
 * These tests use pure math / data structures — no API calls, no MCP wiring.
 * Each test describes the current (buggy) behavior AND the correct behavior,
 * so they serve as both documentation and a checklist for fixes.
 *
 * Tests marked with "CURRENTLY FAILING" describe behavior that needs fixing.
 * Tests marked with "CURRENTLY PASSING" document known-good behavior.
 */

import { describe, it, expect } from 'vitest';
import { pct, round2 } from './tools/shared.js';

// ─── BUG-1 ────────────────────────────────────────────────────────────────────
// analyze_candidate_profile: share_of_party_vote returns ratio (0–1), not pct
// Severity: 🔴 Critical

describe('BUG-1: share_of_party_vote ratio vs percentage', () => {
  const totalVotes = 2300;
  const partyTotalVotes = 10000;

  it('[CURRENTLY FAILING] buggy formula returns 0-1 ratio instead of percentage', () => {
    // Current code in analytics/index.ts:133:
    //   const shareOfPartyVote = partyTotalVotes > 0 ? round2(totalVotes / partyTotalVotes) : null;
    const buggyResult = round2(totalVotes / partyTotalVotes);
    // Returns 0.23 — looks like "0.23 percent" to an LLM
    expect(buggyResult).toBe(0.23); // this documents the bug
    expect(buggyResult).not.toBe(23); // not a percentage
  });

  it('[CORRECT FIX] correct formula returns percentage', () => {
    // Fix: pct(totalVotes / partyTotalVotes * 100)
    const correctResult = pct((totalVotes / partyTotalVotes) * 100);
    expect(correctResult).toBe(23); // 23.0% — correct
  });

  it('[CORRECT FIX] consistent with analyze_within_party_position formula', () => {
    // analyze_within_party_position (line 789) correctly uses:
    //   pct(targetRow.votes / partyTotalVotes * 100)
    const withinPartyResult = pct((totalVotes / partyTotalVotes) * 100);
    expect(withinPartyResult).toBe(23);
    // Both tools must agree on the same value
  });

  it('edge case: zero party votes → null', () => {
    const shareWhenZero = 0 > 0 ? pct((totalVotes / 0) * 100) : null;
    expect(shareWhenZero).toBeNull();
  });
});

// ─── BUG-2 ────────────────────────────────────────────────────────────────────
// buildPartyAnalysis: double-counts votes by summing kunta AND vaalipiiri rows
// Severity: 🔴 Critical

describe('BUG-2: buildPartyAnalysis double-counts votes across area levels', () => {
  // Mock rows at kunta and vaalipiiri level (vaalipiiri = sum of kunta rows for that party)
  const rows = [
    { party_id: 'SDP', area_level: 'kunta',       votes: 1000 },
    { party_id: 'SDP', area_level: 'kunta',       votes: 2000 },
    { party_id: 'SDP', area_level: 'vaalipiiri',  votes: 3000 }, // already = 1000 + 2000
    { party_id: 'SDP', area_level: 'koko_suomi',  votes: 3000 }, // excluded explicitly
    { party_id: 'KOK', area_level: 'kunta',       votes: 500  },
    { party_id: 'KOK', area_level: 'vaalipiiri',  votes: 500  }, // already = 500
  ] as Array<{ party_id: string; area_level: string; votes: number }>;

  it('[CURRENTLY FAILING] buggy approach: excludes koko_suomi but still sums vaalipiiri rows', () => {
    // Current code in retrieval/index.ts:
    //   if (!row.party_id || row.area_level === 'koko_suomi') continue;
    //   existing.total_votes += row.votes;
    const totals: Record<string, number> = {};
    for (const row of rows) {
      if (row.area_level === 'koko_suomi') continue;
      totals[row.party_id] = (totals[row.party_id] ?? 0) + row.votes;
    }
    // SDP: 1000 + 2000 + 3000 = 6000 (double-counted!)
    expect(totals['SDP']).toBe(6000);
    expect(totals['SDP']).not.toBe(3000); // demonstrates the bug
  });

  it('[CORRECT FIX] filter to kunta-only before summing', () => {
    // Fix: if (!row.party_id || row.area_level !== 'kunta') continue;
    const totals: Record<string, number> = {};
    for (const row of rows) {
      if (row.area_level !== 'kunta') continue;
      totals[row.party_id] = (totals[row.party_id] ?? 0) + row.votes;
    }
    expect(totals['SDP']).toBe(3000); // correct: 1000 + 2000
    expect(totals['KOK']).toBe(500);  // correct
  });
});

// ─── BUG-3 ────────────────────────────────────────────────────────────────────
// find_exposed_vote_pools: total_estimated_lost_votes can be negative when share
// drops but raw count rises (e.g., overall turnout increased)
// Severity: 🔴 Critical

describe('BUG-3: find_exposed_vote_pools misleading negative "lost votes"', () => {
  // Scenario: party loses vote share in an area, but raw votes actually increased
  const areas = [
    { area_id: '091', votes_year1: 1000, votes_year2: 1100, share_year1: 30.0, share_year2: 28.0 },
    { area_id: '049', votes_year1: 500,  votes_year2: 600,  share_year1: 25.0, share_year2: 22.0 },
  ];

  it('[CURRENTLY FAILING] buggy formula: raw vote difference is negative when turnout rose', () => {
    // Current code:
    //   const totalLostVotes = exposed.reduce((s, a) => s + ((a.votes_year1 ?? 0) - (a.votes_year2 ?? 0)), 0);
    const totalLostVotes = areas.reduce(
      (s, a) => s + (a.votes_year1 - a.votes_year2),
      0
    );
    // 1000-1100 + 500-600 = -100 + (-100) = -200
    // This is "negative lost votes" = party actually gained raw votes
    expect(totalLostVotes).toBe(-200);
    expect(totalLostVotes).toBeLessThan(0); // documents the bug
  });

  it('[CORRECT FIX] better metric: share_points_lost (always non-negative in exposed areas)', () => {
    // Fix: rename to net_vote_count_change_in_exposed_areas + add share_points_lost
    const netVoteCountChange = areas.reduce(
      (s, a) => s + (a.votes_year2 - a.votes_year1),
      0
    ); // positive = gained raw votes
    expect(netVoteCountChange).toBe(200);

    const totalSharePointsLost = areas.reduce(
      (s, a) => s + (a.share_year1 - a.share_year2),
      0
    );
    expect(totalSharePointsLost).toBe(5); // 2 + 3 = 5pp lost across exposed areas
  });
});

// ─── BUG-4 ────────────────────────────────────────────────────────────────────
// rank_target_areas: c1 (support) and c4 (upside) are perfectly anti-correlated
// Severity: 🟠 High

describe('BUG-4: rank_target_areas c1 and c4 are anti-correlated (not independent)', () => {
  const nationalShare = 0.20; // 20% nationally

  // Formula from strategic/index.ts (before clamping):
  const computeC1 = (share: number) => Math.min(1, share / (nationalShare * 2));
  const computeC4 = (share: number) => Math.max(0, Math.min(1, 0.5 + (nationalShare - share) / (nationalShare * 2)));

  it('c4 = 1 - c1 for shares in [0, 2*nationalShare] — anti-correlation', () => {
    const testShares = [0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.35];
    for (const share of testShares) {
      const c1 = computeC1(share);
      const c4 = computeC4(share);
      // Before clamping: c4 = 0.5 + (nationalShare - share) / (2 * nationalShare)
      //                      = 1 - share / (2 * nationalShare) = 1 - c1
      // After clamping both at [0,1], still perfectly anti-correlated in normal range
      expect(c4).toBeCloseTo(1 - c1, 5);
    }
  });

  it('composite 0.35*c1 + 0.20*c4 = 0.20 + 0.15*c1 (c4 just rescales c1)', () => {
    const testShares = [0.05, 0.15, 0.25, 0.35];
    for (const share of testShares) {
      const c1 = computeC1(share);
      const c4 = computeC4(share);
      const combined = 0.35 * c1 + 0.20 * c4;
      const expectedRescaled = 0.20 + 0.15 * c1;
      expect(combined).toBeCloseTo(expectedRescaled, 5);
    }
  });

  it('effective c1 weight is 0.15, not the claimed 0.35', () => {
    // Two areas: high-share vs low-share
    const highShare = 0.30;
    const lowShare  = 0.05;
    const c1High = computeC1(highShare); // 0.75
    const c4High = computeC4(highShare); // 0.25
    const c1Low  = computeC1(lowShare);  // 0.125
    const c4Low  = computeC4(lowShare);  // 0.875

    const compositeHigh = 0.35 * c1High + 0.20 * c4High;
    const compositeLow  = 0.35 * c1Low  + 0.20 * c4Low;

    // The difference in composite score from c1+c4 combined
    const actualDiff   = compositeHigh - compositeLow;
    const c1Contribution = c1High - c1Low; // = 0.625
    // With net weight 0.15: expected diff ≈ 0.15 * 0.625 = 0.09375
    expect(actualDiff).toBeCloseTo(0.15 * c1Contribution, 5);
  });
});

// ─── BUG-5 ────────────────────────────────────────────────────────────────────
// concentrationMetrics: returns 0-1 fractions, but fields lack unit context
// Severity: 🟠 High

describe('BUG-5: concentration fractions returned without unit labeling', () => {
  // Reproduce concentrationMetrics logic
  const computeConcentration = (votes: number[]) => {
    const total = votes.reduce((a, b) => a + b, 0);
    const sorted = [...votes].sort((a, b) => b - a);
    const topShare = (n: number) =>
      Math.round((sorted.slice(0, n).reduce((s, v) => s + v, 0) / total) * 1000) / 1000;
    return { top1_share: topShare(1), top3_share: topShare(3) };
  };

  const votes = [3100, 2000, 1500, 800, 600]; // sum = 8000

  it('top1_share is a fraction (0-1), not a percentage', () => {
    const conc = computeConcentration(votes);
    // computeConcentration rounds to 3 decimal places: Math.round(0.3875*1000)/1000 = 0.388
    expect(conc.top1_share).toBe(0.388);
    expect(conc.top1_share).toBeLessThan(1); // it's a fraction, not %
  });

  it('conversion to percentage requires ×100', () => {
    const conc = computeConcentration(votes);
    const pctValue = pct(conc.top1_share * 100);
    expect(pctValue).toBe(38.8); // 38.8% — what should be shown
  });

  it('[CORRECT FIX] renaming to _pct and multiplying resolves ambiguity', () => {
    const conc = computeConcentration(votes);
    const top1_share_pct = pct(conc.top1_share * 100);
    // Now unambiguous
    expect(top1_share_pct).toBe(38.8);
    expect(top1_share_pct).toBeGreaterThan(1); // clearly a percentage
  });
});

// ─── BUG-8 ────────────────────────────────────────────────────────────────────
// estimate_vote_transfer_proxy: co-movement ignores magnitude — 1 vote qualifies
// Severity: 🟡 Medium

describe('BUG-8: co-movement classification ignores magnitude', () => {
  type Area = { loser_change: number; gainer_change: number };

  // Current logic from strategic/index.ts:
  const classifyBuggy = (area: Area) =>
    area.loser_change < 0 && area.gainer_change > 0
      ? 'consistent_with_transfer'
      : 'inconsistent';

  // Proposed fix: require meaningful magnitude
  const classifyFixed = (area: Area, minVotes = 50) =>
    Math.abs(area.loser_change) >= minVotes &&
    area.gainer_change >= 0.1 * Math.abs(area.loser_change)
      ? 'consistent_with_transfer'
      : 'inconsistent';

  it('[CURRENTLY FAILING] 1 vote of loser_change classifies as consistent_with_transfer', () => {
    const noiseArea = { loser_change: -1, gainer_change: 2 };
    expect(classifyBuggy(noiseArea)).toBe('consistent_with_transfer'); // bug: noise classified as signal
  });

  it('[CORRECT FIX] magnitude threshold filters out noise', () => {
    const noiseArea   = { loser_change: -1,    gainer_change: 2 };
    const signalArea  = { loser_change: -1000, gainer_change: 200 };

    expect(classifyFixed(noiseArea)).toBe('inconsistent'); // noise filtered out
    expect(classifyFixed(signalArea)).toBe('consistent_with_transfer'); // real signal kept
  });

  it('[CURRENTLY FAILING] gainer gains 1 vote while loser lost 1000 → classified as consistent', () => {
    // Asymmetric case: real loss, trivial gain
    const asymmetricArea = { loser_change: -1000, gainer_change: 1 };
    expect(classifyBuggy(asymmetricArea)).toBe('consistent_with_transfer'); // bug
    expect(classifyFixed(asymmetricArea)).toBe('inconsistent'); // 1 < 0.1 * 1000 = 100
  });
});

// ─── BUG-9 ────────────────────────────────────────────────────────────────────
// rank_target_areas: allVotesByArea computed but c3 uses party votes instead
// Severity: 🔵 Low

describe('BUG-9: allVotesByArea computed but unused in c3_size', () => {
  const allVotesByArea = new Map<string, number>([
    ['091', 80000], // Helsinki: 80k total votes from all parties
    ['049', 10000], // Espoo: 10k
  ]);

  // Party rows
  const partyRows = [
    { area_id: '091', votes: 16000 }, // SDP: 20% in Helsinki
    { area_id: '049', votes: 3000  }, // SDP: 30% in Espoo
  ];

  const maxPartyVotes = Math.max(...partyRows.map((r) => r.votes)); // 16000
  const maxTotalVotes = Math.max(...Array.from(allVotesByArea.values())); // 80000

  it('[CURRENTLY FAILING] c3_size uses party votes relative to party peak, not electorate size', () => {
    // Current code: c3_size = r.votes / maxVotes (where maxVotes = max party votes)
    const c3Helsinki = partyRows[0]!.votes / maxPartyVotes; // 16000/16000 = 1.0
    const c3Espoo    = partyRows[1]!.votes / maxPartyVotes; // 3000/16000 = 0.1875

    // This measures "party vote volume" not "electorate size"
    // Helsinki scores 1.0 — just because it has the most party votes
    expect(c3Helsinki).toBe(1.0);
    // Espoo scores 0.19 — small absolute party votes, even though it's sizable
    expect(c3Espoo).toBeCloseTo(0.1875, 3);
  });

  it('[CORRECT FIX] using allVotesByArea measures actual electorate size', () => {
    // Fix: c3_size = allVotesByArea.get(r.area_id) / maxTotalVotesByArea
    const c3Helsinki = (allVotesByArea.get('091') ?? 0) / maxTotalVotes; // 80000/80000 = 1.0
    const c3Espoo    = (allVotesByArea.get('049') ?? 0) / maxTotalVotes; // 10000/80000 = 0.125

    // Now c3 reflects electorate size, not party dominance
    expect(c3Helsinki).toBe(1.0); // largest area = 1.0 (correct)
    expect(c3Espoo).toBeCloseTo(0.125, 3); // 12.5% of largest area

    // Key difference from buggy version: Espoo's c3 changes from 0.1875 to 0.125
    // because allVotesByArea is not correlated with party vote volume
  });
});

// ─── BUG-10 ───────────────────────────────────────────────────────────────────
// detect_inactive_high_vote_candidates: name normalization (ä→a) causes false collisions
// Severity: 🔵 Low

describe('BUG-10: name normalization false collisions with Finnish diacritics', () => {
  // Current normalization logic from strategic/index.ts
  const normalizeName = (name: string) =>
    name
      .toLowerCase()
      .replace(/ä/g, 'a')
      .replace(/ö/g, 'o')
      .replace(/å/g, 'a')
      .replace(/[^a-z0-9 ]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

  it('[CURRENTLY FAILING] Mäki and Maki normalize to the same string', () => {
    expect(normalizeName('Mäki')).toBe('maki');
    expect(normalizeName('Maki')).toBe('maki');
    // These are two different surnames in Finnish but normalize identically
    expect(normalizeName('Mäki')).toBe(normalizeName('Maki'));
  });

  it('[CURRENTLY FAILING] Törmä and Torma normalize to the same string', () => {
    expect(normalizeName('Törmä')).toBe('torma');
    expect(normalizeName('Torma')).toBe('torma');
    expect(normalizeName('Törmä')).toBe(normalizeName('Torma'));
  });

  it('[CURRENTLY FAILING] Hämäläinen and Hamalainen normalize to the same string', () => {
    expect(normalizeName('Hämäläinen')).toBe('hamalainen');
    expect(normalizeName('Hamalainen')).toBe('hamalainen');
    expect(normalizeName('Hämäläinen')).toBe(normalizeName('Hamalainen'));
  });

  it('[CORRECT FIX] collisions could be detected by counting before/after normalization', () => {
    // The fix is not to change normalization, but to detect when multiple candidates
    // in the to-year map have the same normalized name, and emit a caution flag.
    // Use same given name so only the ä/a difference creates the collision
    const toYearCandidates = ['Mäki Timo', 'Maki Timo'];
    const normalizedNames = toYearCandidates.map(normalizeName);
    // Both normalize to 'maki timo' — a collision
    expect(normalizedNames[0]).toBe(normalizedNames[1]);
    const duplicates = normalizedNames.filter(
      (n, i) => normalizedNames.indexOf(n) !== i
    );
    expect(duplicates.length).toBeGreaterThan(0); // collision detected
    // When duplicates.length > 0, emit a caution in the tool output
  });
});
