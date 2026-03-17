import { describe, it, expect } from 'vitest';
import {
  buildKeyIndex,
  buildValueIndex,
  buildValueTextMap,
  inferAreaLevelFromCandidateCode,
  inferPartyAreaLevel,
  parseCandidateValueText,
  normalizePartyTable,
  normalizeCandidateByAanestysalue,
} from './normalizer.js';
import type { PxWebColumn, PxWebResponse, PxWebTableMetadata } from '../api/types.js';
import type { PartyTableSchema } from './election-tables.js';

// ─── buildKeyIndex ────────────────────────────────────────────────────────────

describe('buildKeyIndex', () => {
  it('indexes only dimension (d) and time (t) columns', () => {
    const cols: PxWebColumn[] = [
      { code: 'Alue', text: 'Area', type: 'd' },
      { code: 'Puolue', text: 'Party', type: 'd' },
      { code: 'Tiedot', text: 'Data', type: 'c' },
    ];
    expect(buildKeyIndex(cols)).toEqual({ Alue: 0, Puolue: 1 });
  });

  it('excludes content (c) columns from index', () => {
    const cols: PxWebColumn[] = [
      { code: 'evaa_aanet', text: 'Votes', type: 'c' },
    ];
    expect(buildKeyIndex(cols)).toEqual({});
  });

  it('assigns sequential indices 0, 1, 2…', () => {
    const cols: PxWebColumn[] = [
      { code: 'A', text: 'A', type: 'd' },
      { code: 'B', text: 'B', type: 't' },
      { code: 'C', text: 'C', type: 'd' },
    ];
    expect(buildKeyIndex(cols)).toEqual({ A: 0, B: 1, C: 2 });
  });
});

// ─── buildValueIndex ──────────────────────────────────────────────────────────

describe('buildValueIndex', () => {
  it('indexes only content (c) columns', () => {
    const cols: PxWebColumn[] = [
      { code: 'Alue', text: 'Area', type: 'd' },
      { code: 'evaa_aanet', text: 'Votes', type: 'c' },
      { code: 'evaa_osuus_aanista', text: 'Share', type: 'c' },
    ];
    expect(buildValueIndex(cols)).toEqual({ evaa_aanet: 0, evaa_osuus_aanista: 1 });
  });

  it('assigns sequential indices for multiple content columns', () => {
    const cols: PxWebColumn[] = [
      { code: 'd1', text: 'D', type: 'd' },
      { code: 'c1', text: 'C1', type: 'c' },
      { code: 'c2', text: 'C2', type: 'c' },
    ];
    expect(buildValueIndex(cols)).toEqual({ c1: 0, c2: 1 });
  });
});

// ─── buildValueTextMap ────────────────────────────────────────────────────────

describe('buildValueTextMap', () => {
  const metadata: PxWebTableMetadata = {
    title: 'Test',
    variables: [
      {
        code: 'Puolue',
        text: 'Party',
        values: ['SDP', 'KOK', 'PS'],
        valueTexts: ['Sosialidemokraatit', 'Kokoomus', 'Perussuomalaiset'],
      },
    ],
  };

  it('builds a code→text map for a known variable', () => {
    const map = buildValueTextMap(metadata, 'Puolue');
    expect(map.get('SDP')).toBe('Sosialidemokraatit');
    expect(map.get('KOK')).toBe('Kokoomus');
    expect(map.get('PS')).toBe('Perussuomalaiset');
  });

  it('returns an empty map for an unknown variable', () => {
    const map = buildValueTextMap(metadata, 'NonExistent');
    expect(map.size).toBe(0);
  });

  it('falls back to code when valueTexts is shorter', () => {
    const m: PxWebTableMetadata = {
      title: 'Test',
      variables: [
        { code: 'X', text: 'X', values: ['A', 'B'], valueTexts: ['Alpha'] },
      ],
    };
    const map = buildValueTextMap(m, 'X');
    expect(map.get('A')).toBe('Alpha');
    expect(map.get('B')).toBe('B'); // fallback to code
  });
});

// ─── inferAreaLevelFromCandidateCode ─────────────────────────────────────────

describe('inferAreaLevelFromCandidateCode', () => {
  it('maps SSS to koko_suomi', () => {
    expect(inferAreaLevelFromCandidateCode('SSS')).toBe('koko_suomi');
  });

  it('maps VP## codes to vaalipiiri', () => {
    expect(inferAreaLevelFromCandidateCode('VP01')).toBe('vaalipiiri');
    expect(inferAreaLevelFromCandidateCode('VP13')).toBe('vaalipiiri');
  });

  it('maps KU### codes to kunta', () => {
    expect(inferAreaLevelFromCandidateCode('KU091')).toBe('kunta');
    expect(inferAreaLevelFromCandidateCode('KU835')).toBe('kunta');
  });

  it('maps HV## codes to hyvinvointialue', () => {
    expect(inferAreaLevelFromCandidateCode('HV08')).toBe('hyvinvointialue');
    expect(inferAreaLevelFromCandidateCode('HV01')).toBe('hyvinvointialue');
  });

  it('maps 3-digit numeric codes to kunta (archive format)', () => {
    expect(inferAreaLevelFromCandidateCode('091')).toBe('kunta');
    expect(inferAreaLevelFromCandidateCode('049')).toBe('kunta');
  });

  it('maps anything else to aanestysalue', () => {
    expect(inferAreaLevelFromCandidateCode('010091')).toBe('aanestysalue');
    expect(inferAreaLevelFromCandidateCode('12345678')).toBe('aanestysalue');
    expect(inferAreaLevelFromCandidateCode('Tuntematon')).toBe('aanestysalue');
  });
});

// ─── inferPartyAreaLevel ──────────────────────────────────────────────────────

describe('inferPartyAreaLevel', () => {
  const sixDigitSchema: PartyTableSchema = {
    area_var: 'Vaalipiiri ja kunta vaalivuonna',
    party_var: 'Puolue',
    measure_var: 'Tiedot',
    votes_code: 'evaa_aanet',
    share_code: 'evaa_osuus_aanista',
    party_total_code: 'SSS',
    area_code_format: 'six_digit',
    national_code: 'SSS',
    aggregate_area_level: 'vaalipiiri',
  };

  it('maps national_code to koko_suomi (six_digit schema)', () => {
    expect(inferPartyAreaLevel('SSS', sixDigitSchema)).toBe('koko_suomi');
  });

  it('maps 6-digit code ending in 0000 to vaalipiiri (six_digit schema)', () => {
    expect(inferPartyAreaLevel('010000', sixDigitSchema)).toBe('vaalipiiri');
    expect(inferPartyAreaLevel('020000', sixDigitSchema)).toBe('vaalipiiri');
  });

  it('maps regular 6-digit code to kunta (six_digit schema)', () => {
    expect(inferPartyAreaLevel('010091', sixDigitSchema)).toBe('kunta');
    expect(inferPartyAreaLevel('020049', sixDigitSchema)).toBe('kunta');
  });

  const vpSchema: PartyTableSchema = {
    area_var: 'Vaalipiiri',
    party_var: 'Puolue',
    measure_var: 'Tiedot',
    votes_code: 'evaa_aanet',
    share_code: 'evaa_osuus_aanista',
    party_total_code: 'SSS',
    area_code_format: 'vp_prefix',
    national_code: 'SSS',
    aggregate_area_level: 'vaalipiiri',
  };

  it('maps VP-prefixed code to vaalipiiri (vp_prefix schema)', () => {
    expect(inferPartyAreaLevel('VP01', vpSchema)).toBe('vaalipiiri');
  });

  it('maps 3-digit code to kunta (vp_prefix schema)', () => {
    expect(inferPartyAreaLevel('091', vpSchema)).toBe('kunta');
  });

  const fiveDigitSchema: PartyTableSchema = {
    area_var: 'Kunta',
    party_var: 'Puolue',
    measure_var: 'Tiedot',
    votes_code: 'aanet_yht',
    share_code: 'osuus_aanista',
    party_total_code: 'SSS',
    area_code_format: 'five_digit',
    national_code: '00000',
    aggregate_area_level: 'vaalipiiri',
  };

  it('maps 00000 to koko_suomi (five_digit schema)', () => {
    expect(inferPartyAreaLevel('00000', fiveDigitSchema)).toBe('koko_suomi');
  });

  it('maps 5-digit code ending in 000 to vaalipiiri (five_digit schema)', () => {
    expect(inferPartyAreaLevel('01000', fiveDigitSchema)).toBe('vaalipiiri');
  });

  it('maps regular 5-digit code to kunta (five_digit schema)', () => {
    expect(inferPartyAreaLevel('00091', fiveDigitSchema)).toBe('kunta');
  });
});

// ─── parseCandidateValueText ──────────────────────────────────────────────────

describe('parseCandidateValueText', () => {
  it('parses full parliamentary format: name / party / unit', () => {
    const result = parseCandidateValueText('Harakka Timo / SDP / Helsingin vaalipiiri');
    expect(result.name).toBe('Harakka Timo');
    expect(result.party).toBe('SDP');
    expect(result.unit).toBe('Helsingin vaalipiiri');
  });

  it('parses EU format: name / party (no unit)', () => {
    const result = parseCandidateValueText('Aaltola Mika / KOK');
    expect(result.name).toBe('Aaltola Mika');
    expect(result.party).toBe('KOK');
    expect(result.unit).toBe('');
  });

  it('parses presidential format: name only', () => {
    const result = parseCandidateValueText('Alexander Stubb');
    expect(result.name).toBe('Alexander Stubb');
    expect(result.party).toBe('');
    expect(result.unit).toBe('');
  });

  it('parses municipal format with slash separators', () => {
    const result = parseCandidateValueText('Sazonov Daniel / KOK / Helsinki');
    expect(result.name).toBe('Sazonov Daniel');
    expect(result.party).toBe('KOK');
    expect(result.unit).toBe('Helsinki');
  });

  it('trims whitespace around parts', () => {
    const result = parseCandidateValueText('  Mäkinen Jussi  /  PS  /  Uusimaa  ');
    expect(result.name).toBe('Mäkinen Jussi');
    expect(result.party).toBe('PS');
    expect(result.unit).toBe('Uusimaa');
  });
});

// ─── normalizePartyTable — content-column format ──────────────────────────────

describe('normalizePartyTable (content-column format)', () => {
  const schema: PartyTableSchema = {
    area_var: 'Vaalipiiri ja kunta vaalivuonna',
    party_var: 'Puolue',
    measure_var: 'Tiedot',
    votes_code: 'evaa_aanet',
    share_code: 'evaa_osuus_aanista',
    party_total_code: 'SSS',
    area_code_format: 'six_digit',
    national_code: 'SSS',
    aggregate_area_level: 'vaalipiiri',
  };

  const columns: PxWebColumn[] = [
    { code: 'Vaalipiiri ja kunta vaalivuonna', text: 'Area', type: 'd' },
    { code: 'Puolue', text: 'Party', type: 'd' },
    { code: 'evaa_aanet', text: 'Votes', type: 'c' },
    { code: 'evaa_osuus_aanista', text: 'Share', type: 'c' },
  ];

  const metadata: PxWebTableMetadata = {
    title: 'Test',
    variables: [
      {
        code: 'Vaalipiiri ja kunta vaalivuonna',
        text: 'Area',
        values: ['010000', '010091'],
        valueTexts: ['Helsingin vaalipiiri', 'Helsinki'],
      },
      {
        code: 'Puolue',
        text: 'Party',
        values: ['SDP', 'KOK', 'SSS'],
        valueTexts: ['Sosialidemokraatit', 'Kokoomus', 'Kaikki puolueet'],
      },
    ],
  };

  const response: PxWebResponse = {
    columns,
    data: [
      { key: ['010091', 'SDP'], values: ['5000', '30.5'] },
      { key: ['010091', 'KOK'], values: ['4000', '24.4'] },
      { key: ['010091', 'SSS'], values: ['16382', '100.0'] }, // party_total_code — must be excluded
      { key: ['010000', 'SDP'], values: ['15000', '28.0'] }, // vaalipiiri aggregate
    ],
  };

  it('excludes party_total_code (SSS) rows', () => {
    const records = normalizePartyTable(response, metadata, 2023, 'parliamentary', schema);
    expect(records.every((r) => r.party_id !== 'SSS')).toBe(true);
  });

  it('produces correct votes and vote_share', () => {
    const records = normalizePartyTable(response, metadata, 2023, 'parliamentary', schema);
    const sdpKunta = records.find((r) => r.area_id === '010091' && r.party_id === 'SDP');
    expect(sdpKunta).toBeDefined();
    expect(sdpKunta!.votes).toBe(5000);
    expect(sdpKunta!.vote_share).toBe(30.5);
  });

  it('infers correct area levels from codes', () => {
    const records = normalizePartyTable(response, metadata, 2023, 'parliamentary', schema);
    const kuntaRow = records.find((r) => r.area_id === '010091');
    const vpRow    = records.find((r) => r.area_id === '010000');
    expect(kuntaRow?.area_level).toBe('kunta');
    expect(vpRow?.area_level).toBe('vaalipiiri');
  });

  it('resolves area_name from metadata valueTexts', () => {
    const records = normalizePartyTable(response, metadata, 2023, 'parliamentary', schema);
    const kuntaRow = records.find((r) => r.area_id === '010091');
    expect(kuntaRow?.area_name).toBe('Helsinki');
  });

  it('sets election_type and year on every record', () => {
    const records = normalizePartyTable(response, metadata, 2023, 'parliamentary', schema);
    expect(records.every((r) => r.election_type === 'parliamentary' && r.year === 2023)).toBe(true);
  });

  it('produces 3 records (SSS excluded)', () => {
    const records = normalizePartyTable(response, metadata, 2023, 'parliamentary', schema);
    expect(records).toHaveLength(3);
  });
});

// ─── normalizeCandidateByAanestysalue ─────────────────────────────────────────

describe('normalizeCandidateByAanestysalue (content-column format)', () => {
  const columns: PxWebColumn[] = [
    { code: 'Alue/Äänestysalue', text: 'Area', type: 'd' },
    { code: 'Ehdokas', text: 'Candidate', type: 'd' },
    { code: 'evaa_aanet', text: 'Votes', type: 'c' },
    { code: 'evaa_osuus_aanista', text: 'Share', type: 'c' },
  ];

  const metadata: PxWebTableMetadata = {
    title: 'Test',
    variables: [
      {
        code: 'Alue/Äänestysalue',
        text: 'Area',
        values: ['010091001', '010091002'],
        valueTexts: ['Helsinki äänestysalue 1', 'Helsinki äänestysalue 2'],
      },
      {
        code: 'Ehdokas',
        text: 'Candidate',
        values: ['01010001', '01010002', '00'],
        valueTexts: [
          'Harakka Timo / SDP / Helsingin vaalipiiri',
          'Rantanen Elina / KOK / Helsingin vaalipiiri',
          'Yhteensä',
        ],
      },
      {
        code: 'Tiedot',
        text: 'Data',
        values: ['evaa_aanet', 'evaa_osuus_aanista'],
        valueTexts: ['Äänimäärä', 'Osuus äänistä (%)'],
      },
    ],
  };

  const response: PxWebResponse = {
    columns,
    data: [
      { key: ['010091001', '01010001'], values: ['1200', '12.5'] },
      { key: ['010091001', '01010002'], values: ['900',  '9.4'] },
      { key: ['010091001', '00'],       values: ['9600', '100.0'] }, // code 00 — skip
      { key: ['010091002', '01010001'], values: ['800',  '11.2'] },
    ],
  };

  it('excludes candidate code "00" (summary row)', () => {
    const records = normalizeCandidateByAanestysalue(response, metadata, 2023);
    expect(records.every((r) => r.candidate_id !== '00')).toBe(true);
  });

  it('parses candidate name and party from valueText', () => {
    const records = normalizeCandidateByAanestysalue(response, metadata, 2023);
    const harakka = records.find((r) => r.candidate_id === '01010001' && r.area_id === '010091001');
    expect(harakka?.candidate_name).toBe('Harakka Timo');
    expect(harakka?.party_id).toBe('SDP');
    expect(harakka?.party_name).toBe('SDP');
  });

  it('produces correct votes and vote_share', () => {
    const records = normalizeCandidateByAanestysalue(response, metadata, 2023);
    const harakka = records.find((r) => r.candidate_id === '01010001' && r.area_id === '010091001');
    expect(harakka?.votes).toBe(1200);
    expect(harakka?.vote_share).toBe(12.5);
  });

  it('infers aanestysalue area level for 9-digit codes', () => {
    const records = normalizeCandidateByAanestysalue(response, metadata, 2023);
    expect(records.every((r) => r.area_level === 'aanestysalue')).toBe(true);
  });

  it('produces 3 records (00 excluded)', () => {
    const records = normalizeCandidateByAanestysalue(response, metadata, 2023);
    expect(records).toHaveLength(3);
  });

  it('sets election_type and year on every record', () => {
    const records = normalizeCandidateByAanestysalue(response, metadata, 2023);
    expect(records.every((r) => r.election_type === 'parliamentary' && r.year === 2023)).toBe(true);
  });
});
