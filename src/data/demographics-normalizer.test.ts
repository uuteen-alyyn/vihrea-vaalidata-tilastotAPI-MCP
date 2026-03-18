import { describe, it, expect } from 'vitest';
import {
  normalizeVoterBackground,
  normalizeVoterTurnoutByDemographics,
} from './demographics-normalizer.js';
import type { PxWebResponse, PxWebTableMetadata } from '../api/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMeta(variables: PxWebTableMetadata['variables']): PxWebTableMetadata {
  return { title: 'test', variables };
}

// ── normalizeVoterBackground ──────────────────────────────────────────────────

describe('normalizeVoterBackground', () => {
  const meta = makeMeta([
    {
      code: 'Vuosi', text: 'Vuosi',
      values: ['2023'], valueTexts: ['2023'], time: true,
    },
    {
      code: 'Sukupuoli', text: 'Sukupuoli',
      values: ['SSS', '1', '2'],
      valueTexts: ['Yhteensä', 'Miehet', 'Naiset'],
      elimination: true,
    },
    {
      code: 'Äänioikeutetut, ehdokkaat ja valitut', text: '...',
      values: ['00S1'], valueTexts: ['Suomessa asuvat äänioikeutetut'],
    },
    {
      code: 'Taustamuuttujat', text: '...',
      values: ['kouSSS', 'kou1_9', 'kou3_4', 'kou5', 'kou6', 'kou7_8'],
      valueTexts: [
        '2 Koulutus yhteensä', '2.1 Vain perusaste', '2.2 Toinen aste',
        '2.3 Alin korkea-aste', '2.4 Alempi korkeakouluaste',
        '2.5 Ylempi korkeakouluaste, tutkijakoulutus',
      ],
    },
    {
      code: 'Tiedot', text: 'Tiedot',
      values: ['lkm1', 'pros'], valueTexts: ['Lukumäärä', 'Osuus (%)'],
    },
  ]);

  const response: PxWebResponse = {
    columns: [
      { code: 'Vuosi', text: 'Year', type: 't' },
      { code: 'Sukupuoli', text: 'Gender', type: 'd' },
      { code: 'Äänioikeutetut, ehdokkaat ja valitut', text: 'Group', type: 'd' },
      { code: 'Taustamuuttujat', text: 'Background', type: 'd' },
      { code: 'lkm1', text: 'Count', type: 'c' },
      { code: 'pros', text: 'Share', type: 'c' },
    ],
    data: [
      // Total education row — should be stripped (kouSSS is a total)
      { key: ['2023', 'SSS', '00S1', 'kouSSS'], values: ['2000000', '100.0'] },
      // Basic only — total gender
      { key: ['2023', 'SSS', '00S1', 'kou1_9'], values: ['600000', '30.0'] },
      // Secondary — male
      { key: ['2023', '1', '00S1', 'kou3_4'], values: ['400000', '40.0'] },
      // Bachelor — female
      { key: ['2023', '2', '00S1', 'kou6'], values: ['300000', '35.0'] },
    ],
  };

  it('strips aggregate total rows (kouSSS)', () => {
    const rows = normalizeVoterBackground(response, meta, 'parliamentary', 2023, 'eligible_voters', 'education');
    expect(rows.find(r => r.category_code === 'kouSSS')).toBeUndefined();
  });

  it('returns correct VoterBackgroundRow fields', () => {
    const rows = normalizeVoterBackground(response, meta, 'parliamentary', 2023, 'eligible_voters', 'education');
    const row = rows.find(r => r.category_code === 'kou1_9' && r.gender === 'total');
    expect(row).toBeDefined();
    expect(row!.election_type).toBe('parliamentary');
    expect(row!.year).toBe(2023);
    expect(row!.group).toBe('eligible_voters');
    expect(row!.dimension).toBe('education');
    expect(row!.category_name).toBe('2.1 Vain perusaste');
    expect(row!.count).toBe(600000);
    expect(row!.share_pct).toBe(30.0);
  });

  it('maps gender codes correctly', () => {
    const rows = normalizeVoterBackground(response, meta, 'parliamentary', 2023, 'eligible_voters', 'education');
    expect(rows.find(r => r.gender === 'male')?.category_code).toBe('kou3_4');
    expect(rows.find(r => r.gender === 'female')?.category_code).toBe('kou6');
  });

  it('uses Ehdokkaan sukupuoli variable for municipal', () => {
    const municipalMeta = makeMeta([
      { code: 'Vuosi', text: 'Vuosi', values: ['2025'], valueTexts: ['2025'], time: true },
      {
        code: 'Ehdokkaan sukupuoli', text: 'Gender',
        values: ['SSS', '1', '2'], valueTexts: ['Yhteensä', 'Miehet', 'Naiset'],
      },
      {
        code: 'Äänioikeutetut, ehdokkaat ja valitut', text: 'Group',
        values: ['0001'], valueTexts: ['Äänioikeutetut'],
      },
      {
        code: 'Taustamuuttujat', text: 'Background',
        values: ['kou1_9'], valueTexts: ['2.1 Vain perusaste'],
      },
      { code: 'Tiedot', text: 'Tiedot', values: ['lkm1', 'pros'], valueTexts: ['Count', 'Share'] },
    ]);
    const municipalResponse: PxWebResponse = {
      columns: [
        { code: 'Vuosi', text: 'Year', type: 't' },
        { code: 'Ehdokkaan sukupuoli', text: 'Gender', type: 'd' },
        { code: 'Äänioikeutetut, ehdokkaat ja valitut', text: 'Group', type: 'd' },
        { code: 'Taustamuuttujat', text: 'Background', type: 'd' },
        { code: 'lkm1', text: 'Count', type: 'c' },
        { code: 'pros', text: 'Share', type: 'c' },
      ],
      data: [
        { key: ['2025', 'SSS', '0001', 'kou1_9'], values: ['500000', '28.0'] },
      ],
    };
    const rows = normalizeVoterBackground(municipalResponse, municipalMeta, 'municipal', 2025, 'eligible_voters', 'education');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.gender).toBe('total');
    expect(rows[0]!.count).toBe(500000);
  });
});

// ── normalizeVoterTurnoutByDemographics (income_quintile) ─────────────────────

describe('normalizeVoterTurnoutByDemographics — income_quintile', () => {
  const meta = makeMeta([
    { code: 'Vuosi', text: 'Vuosi', values: ['2023'], valueTexts: ['2023'], time: true },
    { code: 'Sukupuoli', text: 'Gender', values: ['SSS', '1', '2'], valueTexts: ['Yhteensä', 'Miehet', 'Naiset'] },
    {
      code: 'Tulokvintiili', text: 'Quintile',
      values: ['SSS', '01', '02', '03', '04', '05', '09'],
      valueTexts: ['Yhteensä', 'I', 'II', 'III', 'IV', 'V', 'Tuntematon'],
    },
    { code: 'Alue', text: 'Area', values: ['SSS'], valueTexts: ['Koko maa'] },
    {
      code: 'Tiedot', text: 'Tiedot',
      values: ['aoiky_al_evaa', 'a_al_evaa', 'pros_al_evaa'],
      valueTexts: ['Äänioikeutetut', 'Äänestäneet', 'Äänestysprosentti'],
    },
  ]);

  const response: PxWebResponse = {
    columns: [
      { code: 'Vuosi', text: 'Year', type: 't' },
      { code: 'Sukupuoli', text: 'Gender', type: 'd' },
      { code: 'Tulokvintiili', text: 'Quintile', type: 'd' },
      { code: 'Alue', text: 'Area', type: 'd' },
      { code: 'aoiky_al_evaa', text: 'Eligible', type: 'c' },
      { code: 'a_al_evaa', text: 'Votes', type: 'c' },
      { code: 'pros_al_evaa', text: 'Turnout%', type: 'c' },
    ],
    data: [
      // SSS (total) — should be stripped
      { key: ['2023', 'SSS', 'SSS', 'SSS'], values: ['4000000', '2800000', '70.0'] },
      // I quintile total
      { key: ['2023', 'SSS', '01', 'SSS'], values: ['800000', '464000', '58.0'] },
      // V quintile total
      { key: ['2023', 'SSS', '05', 'SSS'], values: ['800000', '680000', '85.0'] },
      // 09 Tuntematon — should be stripped
      { key: ['2023', 'SSS', '09', 'SSS'], values: ['50000', '30000', '60.0'] },
      // male I quintile
      { key: ['2023', '1', '01', 'SSS'], values: ['400000', '220000', '55.0'] },
    ],
  };

  it('strips SSS total and Tuntematon (09) rows', () => {
    const rows = normalizeVoterTurnoutByDemographics(response, meta, 'parliamentary', 2023, 'income_quintile');
    expect(rows.find(r => r.category_code === 'SSS')).toBeUndefined();
    expect(rows.find(r => r.category_code === '09')).toBeUndefined();
  });

  it('returns 5 quintile rows for gender=total', () => {
    const rows = normalizeVoterTurnoutByDemographics(response, meta, 'parliamentary', 2023, 'income_quintile');
    const totalRows = rows.filter(r => r.gender === 'total');
    expect(totalRows).toHaveLength(2); // only I and V in mock; real data has 5
    const q1 = totalRows.find(r => r.category_code === '01')!;
    expect(q1.eligible_voters).toBe(800000);
    expect(q1.votes_cast).toBe(464000);
    expect(q1.turnout_pct).toBe(58.0);
  });

  it('returns correct category_name from metadata', () => {
    const rows = normalizeVoterTurnoutByDemographics(response, meta, 'parliamentary', 2023, 'income_quintile');
    const q5 = rows.find(r => r.category_code === '05' && r.gender === 'total')!;
    expect(q5.category_name).toBe('V');
  });

  it('includes male rows', () => {
    const rows = normalizeVoterTurnoutByDemographics(response, meta, 'parliamentary', 2023, 'income_quintile');
    const maleQ1 = rows.find(r => r.category_code === '01' && r.gender === 'male')!;
    expect(maleQ1).toBeDefined();
    expect(maleQ1.votes_cast).toBe(220000);
  });
});

// ── normalizeVoterTurnoutByDemographics (age_group aggregation) ───────────────

describe('normalizeVoterTurnoutByDemographics — age_group aggregation', () => {
  const meta = makeMeta([
    { code: 'Vuosi', text: 'Vuosi', values: ['2023'], valueTexts: ['2023'], time: true },
    {
      code: 'Ikäluokka', text: 'Age',
      values: ['SSS', '018', '019', '20-24', '25-29', '30-34'],
      valueTexts: ['Yhteensä', '18', '19', '20 - 24', '25 - 29', '30 - 34'],
    },
    { code: 'Sukupuoli', text: 'Gender', values: ['SSS', '1', '2'], valueTexts: ['Yhteensä', 'Miehet', 'Naiset'] },
    { code: 'Alue', text: 'Area', values: ['SSS'], valueTexts: ['Koko maa'] },
    {
      code: 'Tiedot', text: 'Tiedot',
      values: ['aoiky_al_evaa', 'a_al_evaa', 'pros_al_evaa'],
      valueTexts: ['Eligible', 'Votes', 'Turnout%'],
    },
  ]);

  const response: PxWebResponse = {
    columns: [
      { code: 'Ikäluokka', text: 'Age', type: 'd' },
      { code: 'Sukupuoli', text: 'Gender', type: 'd' },
      { code: 'Alue', text: 'Area', type: 'd' },
      { code: 'aoiky_al_evaa', text: 'Eligible', type: 'c' },
      { code: 'a_al_evaa', text: 'Votes', type: 'c' },
      { code: 'pros_al_evaa', text: 'Turnout%', type: 'c' },
    ],
    data: [
      // 018: 50000 eligible, 30000 voted
      { key: ['018', 'SSS', 'SSS'], values: ['50000', '30000', '60.0'] },
      // 019: 52000 eligible, 31200 voted
      { key: ['019', 'SSS', 'SSS'], values: ['52000', '31200', '60.0'] },
      // 20-24: 200000 eligible, 130000 voted
      { key: ['20-24', 'SSS', 'SSS'], values: ['200000', '130000', '65.0'] },
      // 25-29: 220000 eligible, 154000 voted
      { key: ['25-29', 'SSS', 'SSS'], values: ['220000', '154000', '70.0'] },
      // 30-34: 210000 eligible, 147000 voted
      { key: ['30-34', 'SSS', 'SSS'], values: ['210000', '147000', '70.0'] },
    ],
  };

  it('aggregates 018+019+20-24 into 18-24 group using counts', () => {
    const rows = normalizeVoterTurnoutByDemographics(response, meta, 'parliamentary', 2023, 'age_group');
    const group1824 = rows.find(r => r.category_code === '18-24' && r.gender === 'total')!;
    expect(group1824).toBeDefined();
    // eligible: 50000 + 52000 + 200000 = 302000
    expect(group1824.eligible_voters).toBe(302000);
    // votes: 30000 + 31200 + 130000 = 191200
    expect(group1824.votes_cast).toBe(191200);
    // turnout: 191200 / 302000 = 63.31...% → rounded to 63.3
    expect(group1824.turnout_pct).toBeCloseTo(63.3, 1);
  });

  it('aggregates 25-29+30-34 into 25-34 group', () => {
    const rows = normalizeVoterTurnoutByDemographics(response, meta, 'parliamentary', 2023, 'age_group');
    const group2534 = rows.find(r => r.category_code === '25-34' && r.gender === 'total')!;
    expect(group2534).toBeDefined();
    expect(group2534.eligible_voters).toBe(430000);
    expect(group2534.votes_cast).toBe(301000);
  });

  it('does not aggregate SSS (total) age code into any group', () => {
    const rows = normalizeVoterTurnoutByDemographics(response, meta, 'parliamentary', 2023, 'age_group');
    expect(rows.find(r => r.category_code === 'SSS')).toBeUndefined();
  });

  it('does not include groups with no data', () => {
    const rows = normalizeVoterTurnoutByDemographics(response, meta, 'parliamentary', 2023, 'age_group');
    // 35-44, 45-54 etc. have no data in mock
    expect(rows.find(r => r.category_code === '35-44')).toBeUndefined();
  });
});

// ── loadVoterBackground — error path tests (no real API) ─────────────────────

import { loadVoterBackground, loadVoterTurnoutByDemographics } from './loaders.js';

describe('loadVoterBackground — error validation', () => {
  it('throws for unsupported election type', async () => {
    await expect(
      loadVoterBackground('eu_parliament' as never, 2024, 'eligible_voters', 'education')
    ).rejects.toThrow(/parliamentary.*municipal/);
  });

  it('throws for unsupported year with available years listed', async () => {
    await expect(
      loadVoterBackground('parliamentary', 2007, 'eligible_voters', 'education')
    ).rejects.toThrow(/2011.*2015.*2019.*2023/);
  });
});

describe('loadVoterTurnoutByDemographics — error validation', () => {
  it('throws for unsupported election type', async () => {
    await expect(
      loadVoterTurnoutByDemographics('regional' as never, 2025, 'education')
    ).rejects.toThrow(/parliamentary.*municipal.*eu_parliament.*presidential/);
  });

  it('throws for wrong year with correct year stated', async () => {
    await expect(
      loadVoterTurnoutByDemographics('parliamentary', 2019, 'education')
    ).rejects.toThrow(/2023/);
  });
});
