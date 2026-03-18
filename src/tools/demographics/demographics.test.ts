import { describe, it, expect } from 'vitest';
import {
  buildVoterBackgroundAnalysis,
  buildTurnoutDemoAnalysis,
} from './index.js';
import type { VoterBackgroundRow, VoterTurnoutDemographicRow } from '../../data/types.js';

// ── buildVoterBackgroundAnalysis ──────────────────────────────────────────────

describe('buildVoterBackgroundAnalysis', () => {
  const rows: VoterBackgroundRow[] = [
    { election_type: 'parliamentary', year: 2023, group: 'eligible_voters', dimension: 'education',
      category_code: 'kou7_8', category_name: '2.5 Ylempi korkeakouluaste, tutkijakoulutus',
      gender: 'total', count: 680000, share_pct: 24.0 },
    { election_type: 'parliamentary', year: 2023, group: 'eligible_voters', dimension: 'education',
      category_code: 'kou3_4', category_name: '2.2 Toinen aste',
      gender: 'total', count: 1200000, share_pct: 42.5 },
    { election_type: 'parliamentary', year: 2023, group: 'eligible_voters', dimension: 'education',
      category_code: 'kou1_9', category_name: '2.1 Vain perusaste',
      gender: 'total', count: 850000, share_pct: 30.0 },
    // Male rows (should not appear in total analysis)
    { election_type: 'parliamentary', year: 2023, group: 'eligible_voters', dimension: 'education',
      category_code: 'kou3_4', category_name: '2.2 Toinen aste',
      gender: 'male', count: 600000, share_pct: 43.0 },
  ];

  it('returns analysis with markdown table', () => {
    const result = buildVoterBackgroundAnalysis(rows, 'parliamentary', 2023, 'eligible_voters', 'education', 'total', '13su');
    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.mode).toBe('analysis');
    expect(parsed.text).toContain('|');
    expect(parsed.text).toContain('2.2 Toinen aste');
  });

  it('sorts rows by share_pct descending', () => {
    const result = buildVoterBackgroundAnalysis(rows, 'parliamentary', 2023, 'eligible_voters', 'education', 'total', '13su');
    const text = JSON.parse((result.content[0] as { text: string }).text).text as string;
    const tableLines = text.split('\n').filter(l => l.startsWith('| 2.'));
    // Toinen aste (42.5%) should appear before Vain perusaste (30%) before Ylempi (24%)
    expect(tableLines[0]).toContain('Toinen aste');
    expect(tableLines[1]).toContain('perusaste');
    expect(tableLines[2]).toContain('Ylempi');
  });

  it('includes coverage caveat mentioning parliamentary and municipal', () => {
    const result = buildVoterBackgroundAnalysis(rows, 'parliamentary', 2023, 'eligible_voters', 'education', 'total', '13su');
    const text = JSON.parse((result.content[0] as { text: string }).text).text as string;
    expect(text).toMatch(/parliamentary.*municipal/i);
  });

  it('includes income_decile limitation note when dimension is income_decile', () => {
    const decileRows: VoterBackgroundRow[] = [
      { election_type: 'parliamentary', year: 2011, group: 'elected', dimension: 'income_decile',
        category_code: 'des1', category_name: '4.1 Alimpaan tulokymmenykseen kuuluvat',
        gender: 'total', count: 10, share_pct: 2.5 },
      { election_type: 'parliamentary', year: 2011, group: 'elected', dimension: 'income_decile',
        category_code: 'des10', category_name: '4.2 Ylimpään tulokymmenykseen kuuluvat',
        gender: 'total', count: 90, share_pct: 35.0 },
    ];
    const result = buildVoterBackgroundAnalysis(decileRows, 'parliamentary', 2011, 'elected', 'income_decile', 'total', '13su');
    const text = JSON.parse((result.content[0] as { text: string }).text).text as string;
    expect(text).toContain('lowest income decile');
    expect(text.split('\n').filter(l => l.startsWith('| 4.'))).toHaveLength(2);
  });

  it('filters to male rows when gender=male', () => {
    const result = buildVoterBackgroundAnalysis(rows, 'parliamentary', 2023, 'eligible_voters', 'education', 'male', '13su');
    const text = JSON.parse((result.content[0] as { text: string }).text).text as string;
    // Only the male row for kou3_4 should appear
    const tableLines = text.split('\n').filter(l => l.startsWith('| 2.'));
    expect(tableLines).toHaveLength(1);
    expect(tableLines[0]).toContain('Toinen aste');
  });
});

// ── buildTurnoutDemoAnalysis ──────────────────────────────────────────────────

describe('buildTurnoutDemoAnalysis', () => {
  const rows: VoterTurnoutDemographicRow[] = [
    { election_type: 'parliamentary', year: 2023, dimension: 'income_quintile',
      category_code: '01', category_name: 'I', gender: 'total', eligible_voters: 800000, votes_cast: 464000, turnout_pct: 58.0 },
    { election_type: 'parliamentary', year: 2023, dimension: 'income_quintile',
      category_code: '05', category_name: 'V', gender: 'total', eligible_voters: 800000, votes_cast: 680000, turnout_pct: 85.0 },
    { election_type: 'parliamentary', year: 2023, dimension: 'income_quintile',
      category_code: '03', category_name: 'III', gender: 'total', eligible_voters: 800000, votes_cast: 576000, turnout_pct: 72.0 },
    // Male/female rows for gender gap note
    { election_type: 'parliamentary', year: 2023, dimension: 'income_quintile',
      category_code: '01', category_name: 'I', gender: 'male', eligible_voters: 400000, votes_cast: 220000, turnout_pct: 55.0 },
    { election_type: 'parliamentary', year: 2023, dimension: 'income_quintile',
      category_code: '01', category_name: 'I', gender: 'female', eligible_voters: 400000, votes_cast: 244000, turnout_pct: 61.0 },
    { election_type: 'parliamentary', year: 2023, dimension: 'income_quintile',
      category_code: '05', category_name: 'V', gender: 'male', eligible_voters: 400000, votes_cast: 336000, turnout_pct: 84.0 },
    { election_type: 'parliamentary', year: 2023, dimension: 'income_quintile',
      category_code: '05', category_name: 'V', gender: 'female', eligible_voters: 400000, votes_cast: 344000, turnout_pct: 86.0 },
  ];

  it('returns analysis with markdown table sorted by turnout_pct desc', () => {
    const result = buildTurnoutDemoAnalysis(rows, 'parliamentary', 2023, 'income_quintile', 'total', 1, '13yv');
    const text = JSON.parse((result.content[0] as { text: string }).text).text as string;
    expect(text).toContain('|');
    // V (85%) should come before III (72%) before I (58%)
    const tableLines = text.split('\n').filter(l => l.includes('| **'));
    const firstCategory = tableLines[0]?.split('|')[1]?.trim();
    expect(firstCategory).toBe('V');
  });

  it('includes highest and lowest turnout note', () => {
    const result = buildTurnoutDemoAnalysis(rows, 'parliamentary', 2023, 'income_quintile', 'total', 1, '13yv');
    const text = JSON.parse((result.content[0] as { text: string }).text).text as string;
    expect(text).toContain('Highest turnout');
    expect(text).toContain('Lowest');
    expect(text).toContain('85.0');
    expect(text).toContain('58.0');
  });

  it('includes mandatory coverage caveat', () => {
    const result = buildTurnoutDemoAnalysis(rows, 'parliamentary', 2023, 'income_quintile', 'total', 1, '13yv');
    const text = JSON.parse((result.content[0] as { text: string }).text).text as string;
    expect(text).toContain('only available for');
    expect(text).toContain('2023');
    expect(text).toContain('archive enumeration');
  });

  it('includes gender gap note when gender=total', () => {
    const result = buildTurnoutDemoAnalysis(rows, 'parliamentary', 2023, 'income_quintile', 'total', 1, '13yv');
    const text = JSON.parse((result.content[0] as { text: string }).text).text as string;
    expect(text).toContain('gender gap');
    // Q1 has gap of 6.0 pp (61-55), Q5 has gap of 2.0 pp → Q1 is largest gap
    expect(text).toContain('I');
  });

  it('omits gender gap note when gender=male', () => {
    const result = buildTurnoutDemoAnalysis(rows, 'parliamentary', 2023, 'income_quintile', 'male', 1, '13yv');
    const text = JSON.parse((result.content[0] as { text: string }).text).text as string;
    expect(text).not.toContain('gender gap');
  });

  it('includes presidential round note for presidential elections', () => {
    const presRows: VoterTurnoutDemographicRow[] = [
      { election_type: 'presidential', year: 2024, dimension: 'education',
        category_code: 'kou7_8', category_name: 'Master+', gender: 'total',
        eligible_voters: 500000, votes_cast: 385000, turnout_pct: 77.0 },
    ];
    const result = buildTurnoutDemoAnalysis(presRows, 'presidential', 2024, 'education', 'total', 1, '14nl');
    const text = JSON.parse((result.content[0] as { text: string }).text).text as string;
    expect(text).toContain('round 1');
    expect(text).toContain('round=2');
  });
});

// ── Error path tests (loader validation — no API calls needed) ────────────────

import { loadVoterBackground, loadVoterTurnoutByDemographics } from '../../data/loaders.js';

describe('get_voter_background — error paths', () => {
  it('throws for eu_parliament with supported types listed', async () => {
    await expect(
      loadVoterBackground('eu_parliament' as never, 2024, 'eligible_voters', 'education')
    ).rejects.toThrow(/parliamentary.*municipal/);
  });

  it('throws for parliamentary 2007 with available years listed', async () => {
    await expect(
      loadVoterBackground('parliamentary', 2007, 'eligible_voters', 'education')
    ).rejects.toThrow(/2011.*2015.*2019.*2023/);
  });
});

describe('get_voter_turnout_by_demographics — error paths', () => {
  it('throws for regional election with supported types listed', async () => {
    await expect(
      loadVoterTurnoutByDemographics('regional' as never, 2025, 'education')
    ).rejects.toThrow(/parliamentary.*municipal.*eu_parliament.*presidential/);
  });

  it('throws for parliamentary 2019 with correct year (2023) stated', async () => {
    await expect(
      loadVoterTurnoutByDemographics('parliamentary', 2019, 'education')
    ).rejects.toThrow(/2023/);
  });
});
