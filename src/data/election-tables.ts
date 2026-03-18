import type { ElectionType } from './types.js';

/**
 * Registry of known Tilastokeskus table IDs for each election type.
 *
 * KEY ARCHITECTURAL NOTE:
 * The PxWeb API has no single "list elections" endpoint. This registry is
 * the authoritative source for which tables exist for which elections.
 * It must be updated manually when new elections are published.
 *
 * MULTI-YEAR PARTY TABLES:
 * Several party tables cover multiple years in a single PxWeb table:
 *   13sw  (parliamentary): 1983–2023
 *   14z7  (municipal):     1976–2025
 *   14y4  (regional):      2022–2025
 *   14gv  (EU):            1996–2024
 * These are registered once on the most recent election entry and found
 * via findPartyTableForType() fallback for older years.
 *
 * CANDIDATE DATA ARCHITECTURE:
 * Parliamentary/municipal:  13 per-vaalipiiri tables, one per electoral district.
 * Regional:                 21 per-hyvinvointialue tables, one per welfare area.
 * EU / Presidential:        Single national table (candidate_national field).
 */

export const DATABASE = {
  active:  'StatFin',
  archive: 'StatFin_Passiivi',
} as const;

// ─── Schema types ─────────────────────────────────────────────────────────────

/**
 * Describes the variable names and codes needed to query and normalize
 * a party-votes-by-area table. Required because these differ across election types.
 */
export interface PartyTableSchema {
  /** PxWeb variable code for the area dimension */
  area_var: string;
  /** PxWeb variable code for the party dimension */
  party_var: string;
  /** PxWeb variable code for the measure dimension (Tiedot, Puolueiden kannatus, …) */
  measure_var: string;
  /** Value code within measure_var representing total votes */
  votes_code: string;
  /** Value code within measure_var representing vote share */
  share_code: string;
  /** Party code to filter out (aggregate / total row) — 'SSS' or '00' */
  party_total_code: string;
  /** Optional gender variable — filter to gender_total_code when present */
  gender_var?: string;
  gender_total_code?: string;
  /**
   * Area code format:
   *   'six_digit'    — 6-digit codes; national_code=national, ending-0000=aggregate, else=kunta
   *   'vp_prefix'    — VP##=aggregate, 3-digit=kunta, national_code=national
   *   'five_digit'   — 5-digit codes; 00000=national, ending-000=aggregate, else=kunta (EU)
   *   'vp_ku_prefix' — SSS=national, VP##=vaalipiiri, KU###=kunta, else=äänestysalue
   *                    Used by year-specific all-areas tables (13t2, 14vm, 14h2).
   */
  area_code_format: 'six_digit' | 'vp_prefix' | 'five_digit' | 'vp_ku_prefix';
  /** Area code that represents the national total */
  national_code: string;
  /** What geographic level does the per-4000 aggregate row represent? */
  aggregate_area_level: 'vaalipiiri' | 'hyvinvointialue';
}

// ─── ElectionTableSet ──────────────────────────────────────────────────────────

export interface ElectionTableSet {
  election_type: ElectionType;
  year: number;
  database: string;
  /** Multi-year party votes by area table (kunta breakdown) */
  party_by_kunta?: string;
  /** Schema describing how to query and normalize the party table */
  party_schema?: PartyTableSchema;
  /** Turnout by voting area */
  turnout_by_aanestysalue?: string;
  /** National candidate summary (no area breakdown) — used for EU and presidential */
  candidate_national?: string;
  /** Per-vaalipiiri OR per-hyvinvointialue candidate tables with äänestysalue breakdown */
  candidate_by_aanestysalue?: Record<string, string>;
  /**
   * Type of geographic unit used as the top-level key in candidate_by_aanestysalue.
   * 'vaalipiiri' for parliamentary/municipal, 'hyvinvointialue' for regional.
   */
  geographic_unit_type?: 'vaalipiiri' | 'hyvinvointialue' | 'national';
  /** Results analysis / comparison to prior election */
  results_analysis?: string;

  /**
   * Year-specific party table containing all area levels (national → vaalipiiri → kunta →
   * äänestysalue) in one query. Used when areaId is omitted to avoid the 403 cell-count
   * limit on multi-year tables (e.g. 13sw fetched for all areas exceeds ~12 000 cells).
   * Tables: parliamentary 2023 → 13t2, municipal 2025 → 14vm, EU 2024 → 14h2.
   */
  party_by_aanestysalue?: string;
  /** Schema for the year-specific all-areas party table. */
  party_by_aanestysalue_schema?: PartyTableSchema;

  /** EU-specific: candidate votes by vaalipiiri (14gx). All candidates, 14 areas. */
  candidate_by_vaalipiiri?: string;
  /**
   * EU-specific: candidate votes by äänestysalue (14gw).
   * Requires candidate_id filter — 247 candidates × 2079 areas exceeds cell limit.
   */
  candidate_by_aanestysalue_eu?: string;

  /**
   * Presidential/multi-year: candidate votes by vaalipiiri across years (14db).
   * Enables cross-year presidential candidate comparisons at vaalipiiri level.
   */
  candidate_multiyr_vaalipiiri?: string;

  /**
   * Background characteristics of eligible voters, candidates & elected.
   * Multi-year table — registered on the most recent entry only.
   * All background dimensions (employment, education, employer_sector,
   * income_decile, language, origin) live in a single PxWeb variable
   * (Taustamuuttujat). Loaded via findVoterBackgroundTableForType()
   * fallback for older years, mirroring the findPartyTableForType() pattern.
   */
  voter_background?: string;

  /**
   * Turnout by demographic dimension — keyed by dimension name.
   * Only present on the single election entry where this data exists.
   * age_group uses near-individual-age tables (13ys, 152q, 14ha, 14nk)
   * that require aggregation to standard 7 groups in the normalizer.
   */
  voter_turnout_by_demographics?: Partial<Record<
    'age_group' | 'education' | 'income_quintile' | 'origin_language' | 'activity',
    string
  >>;
}

// ─── Party schemas ─────────────────────────────────────────────────────────────

const PARLIAMENTARY_PARTY_SCHEMA: PartyTableSchema = {
  area_var:             'Vaalipiiri ja kunta vaalivuonna',
  party_var:            'Puolue',
  measure_var:          'Tiedot',
  votes_code:           'evaa_aanet',
  share_code:           'evaa_osuus_aanista',
  party_total_code:     'SSS',
  gender_var:           'Sukupuoli',
  gender_total_code:    'SSS',
  area_code_format:     'six_digit',
  national_code:        'SSS',
  aggregate_area_level: 'vaalipiiri',
};

const MUNICIPAL_PARTY_SCHEMA: PartyTableSchema = {
  area_var:             'Alue',
  party_var:            'Puolue',
  measure_var:          'Tiedot',
  votes_code:           'aanet_yht',
  share_code:           'osuus_aanista',
  party_total_code:     'SSS',
  // No gender variable in 14z7
  area_code_format:     'six_digit',
  national_code:        'SSS',
  aggregate_area_level: 'vaalipiiri',
};

const REGIONAL_PARTY_SCHEMA: PartyTableSchema = {
  area_var:             'Alue',
  party_var:            'Puolue',
  measure_var:          'Tiedot',
  votes_code:           'aanet_yht',
  share_code:           'osuus_aanista',
  party_total_code:     'SSS',
  gender_var:           'Ehdokkaan sukupuoli',
  gender_total_code:    'SSS',
  area_code_format:     'six_digit',
  national_code:        'SSS',
  aggregate_area_level: 'hyvinvointialue',
};

const EU_PARTY_SCHEMA: PartyTableSchema = {
  area_var:             'Vaalipiiri ja kunta vaalivuonna',
  party_var:            'Puolue',
  measure_var:          'Tiedot',
  votes_code:           'euvaa_aanet',
  share_code:           'euvaa_osuus_aanista',
  party_total_code:     '00',
  gender_var:           'Sukupuoli',
  gender_total_code:    'SSS',   // 'Kaikki ehdokkaat'
  area_code_format:     'five_digit',
  national_code:        '00000',
  aggregate_area_level: 'vaalipiiri',
};

// ─── Year-specific all-areas party schemas ────────────────────────────────────
//
// These schemas describe tables that contain all area levels (national → vaalipiiri →
// kunta → äänestysalue) in one PxWeb table. Used for all-areas queries to avoid the
// 403 cell-count limit on multi-year tables. Area codes use the 'vp_ku_prefix' format:
//   SSS = national, VP## = vaalipiiri, KU### = kunta, rest = äänestysalue.

const PARLIAMENTARY_YEAR_PARTY_SCHEMA: PartyTableSchema = {
  area_var:             'Alue/Äänestysalue',
  party_var:            'Puolue',
  measure_var:          'Tiedot',
  votes_code:           'evaa_aanet',
  share_code:           'evaa_osuus_aanista',
  party_total_code:     'SSS',
  gender_var:           'Ehdokkaan sukupuoli',
  gender_total_code:    'SSS',
  area_code_format:     'vp_ku_prefix',
  national_code:        'SSS',
  aggregate_area_level: 'vaalipiiri',
};

const MUNICIPAL_YEAR_PARTY_SCHEMA: PartyTableSchema = {
  area_var:             'Äänestysalue',
  party_var:            'Puolue',
  measure_var:          'Tiedot',
  votes_code:           'aanet_yht',
  share_code:           'osuus_aanista',
  party_total_code:     'SSS',
  gender_var:           'Ehdokkaan sukupuoli',
  gender_total_code:    'SSS',
  area_code_format:     'vp_ku_prefix',
  national_code:        'SSS',
  aggregate_area_level: 'vaalipiiri',
};

const EU_YEAR_PARTY_SCHEMA: PartyTableSchema = {
  area_var:             'Äänestysalue',
  party_var:            'Puolue',
  measure_var:          'Tiedot',
  votes_code:           'euvaa_aanet',
  share_code:           'euvaa_osuus_aanista',
  party_total_code:     '00',
  gender_var:           'Sukupuoli',
  gender_total_code:    'SSS',
  area_code_format:     'vp_ku_prefix',
  national_code:        'SSS',
  aggregate_area_level: 'vaalipiiri',
};

// ─── Parliamentary elections (Eduskuntavaalit) ────────────────────────────────
// Base path: StatFin/evaa/  (archive: StatFin_Passiivi/evaa/)

export const PARLIAMENTARY_TABLES: ElectionTableSet[] = [
  {
    election_type: 'parliamentary',
    year: 2023,
    database: DATABASE.active,
    party_by_kunta:   'statfin_evaa_pxt_13sw',     // 1983–2023
    party_schema:     PARLIAMENTARY_PARTY_SCHEMA,
    // Year-specific all-areas table: use when areaId is omitted to avoid 403 on 13sw
    party_by_aanestysalue:        'statfin_evaa_pxt_13t2',
    party_by_aanestysalue_schema: PARLIAMENTARY_YEAR_PARTY_SCHEMA,
    turnout_by_aanestysalue: 'statfin_evaa_pxt_13sx',
    geographic_unit_type: 'vaalipiiri',
    candidate_by_aanestysalue: {
      'helsinki':       'statfin_evaa_pxt_13t6',
      'uusimaa':        'statfin_evaa_pxt_13t7',
      'lounais-suomi':  'statfin_evaa_pxt_13t8',
      'satakunta':      'statfin_evaa_pxt_13t9',
      'hame':           'statfin_evaa_pxt_13ta',
      'pirkanmaa':      'statfin_evaa_pxt_13tb',
      'kaakkois-suomi': 'statfin_evaa_pxt_13tc',
      'savo-karjala':   'statfin_evaa_pxt_13td',
      'vaasa':          'statfin_evaa_pxt_13te',
      'keski-suomi':    'statfin_evaa_pxt_13tf',
      'oulu':           'statfin_evaa_pxt_13tg',
      'lappi':          'statfin_evaa_pxt_13th',
      'ahvenanmaa':     'statfin_evaa_pxt_13ti',
    },
    results_analysis: 'statfin_evaa_pxt_13yh',
    voter_background: 'statfin_evaa_pxt_13su',          // 2011–2023, multi-year
    voter_turnout_by_demographics: {
      age_group:       'statfin_evaa_pxt_13ys',          // 18/19 + 5-yr bins → aggregate to 7 groups
      education:       'statfin_evaa_pxt_13yt',
      origin_language: 'statfin_evaa_pxt_13yu',
      income_quintile: 'statfin_evaa_pxt_13yv',
      activity:        'statfin_evaa_pxt_13yw',
    },
  },
  {
    election_type: 'parliamentary',
    year: 2019,
    database: DATABASE.archive,
    // party_by_kunta: covered by 13sw (1983–2023) via 2023 entry fallback
    geographic_unit_type: 'vaalipiiri',
    candidate_by_aanestysalue: {
      // Variable codes differ from 2023: area codes 'VP##'/'###', measure 'Äänestystiedot' (Sar1/Sar2)
      'helsinki':       '170_evaa_2019_tau_170',
      'uusimaa':        '171_evaa_2019_tau_171',
      'lounais-suomi':  '172_evaa_2019_tau_172',
      'satakunta':      '173_evaa_2019_tau_173',
      'hame':           '174_evaa_2019_tau_174',
      'pirkanmaa':      '175_evaa_2019_tau_175',
      'kaakkois-suomi': '176_evaa_2019_tau_176',
      'savo-karjala':   '177_evaa_2019_tau_177',
      'vaasa':          '178_evaa_2019_tau_178',
      'keski-suomi':    '179_evaa_2019_tau_179',
      'oulu':           '180_evaa_2019_tau_180',
      'lappi':          '181_evaa_2019_tau_181',
      'ahvenanmaa':     '182_evaa_2019_tau_182',
    },
    results_analysis: '810_evaa_2019_tau_153',
  },
  {
    election_type: 'parliamentary',
    year: 2015,
    database: DATABASE.archive,
    // party_by_kunta: covered by 13sw (1983–2023) via 2023 entry fallback
    geographic_unit_type: 'vaalipiiri',
    candidate_by_aanestysalue: {
      // Same 13-vaalipiiri boundaries as 2019. Format: Äänestysalue + Äänestystiedot (Sar1=votes, Sar2=share)
      'helsinki':       '170_evaa_tau_170',
      'uusimaa':        '171_evaa_tau_171',
      'lounais-suomi':  '172_evaa_tau_172',   // Varsinais-Suomen vaalipiiri
      'satakunta':      '173_evaa_tau_173',
      'hame':           '174_evaa_tau_174',
      'pirkanmaa':      '175_evaa_tau_175',
      'kaakkois-suomi': '176_evaa_tau_176',
      'savo-karjala':   '177_evaa_tau_177',
      'vaasa':          '178_evaa_tau_178',
      'keski-suomi':    '179_evaa_tau_179',
      'oulu':           '180_evaa_tau_180',
      'lappi':          '181_evaa_tau_181',
      'ahvenanmaa':     '182_evaa_tau_182',
    },
  },
  {
    election_type: 'parliamentary',
    year: 2011,
    database: DATABASE.archive,
    // party_by_kunta: covered by 13sw (1983–2023) via 2023 entry fallback
    geographic_unit_type: 'vaalipiiri',
    candidate_by_aanestysalue: {
      // NOTE: Finland had 15 vaalipiiri before the 2012 boundary reform.
      // Three merged pairs:
      //   kymi + mikkeli → kaakkois-suomi (2015+)
      //   etela-savo + pohjois-savo + pohjois-karjala → savo-karjala (2015+)
      // Use the old district names as keys; callers must use these keys for 2011/2007.
      // Format: Äänestysalue + Äänestystiedot (Sar1=votes, Sar2=share)
      'helsinki':        '170_evaa_tau_170_fi',
      'uusimaa':         '171_evaa_tau_171_fi',
      'lounais-suomi':   '172_evaa_tau_172_fi',   // Varsinais-Suomen vaalipiiri
      'satakunta':       '173_evaa_tau_173_fi',
      'hame':            '174_evaa_tau_174_fi',
      'pirkanmaa':       '175_evaa_tau_175_fi',
      'kymi':            '176_evaa_tau_176_fi',    // Kymen vaalipiiri (→ kaakkois-suomi 2015)
      'etela-savo':      '177_evaa_tau_177_fi',    // Etelä-Savon vaalipiiri (→ savo-karjala 2015)
      'pohjois-savo':    '178_evaa_tau_178_fi',    // Pohjois-Savon vaalipiiri (→ savo-karjala 2015)
      'pohjois-karjala': '179_evaa_tau_179_fi',    // Pohjois-Karjalan vaalipiiri (→ savo-karjala 2015)
      'vaasa':           '180_evaa_tau_180_fi',
      'keski-suomi':     '181_evaa_tau_181_fi',
      'oulu':            '182_evaa_tau_182_fi',
      'lappi':           '183_evaa_tau_183_fi',
      'ahvenanmaa':      '184_evaa_tau_184_fi',
    },
  },
  {
    election_type: 'parliamentary',
    year: 2007,
    database: DATABASE.archive,
    // party_by_kunta: covered by 13sw (1983–2023) via 2023 entry fallback
    geographic_unit_type: 'vaalipiiri',
    candidate_by_aanestysalue: {
      // Same 15-vaalipiiri boundaries as 2011. Format: Alue + Äänestystiedot (Sar3=votes, Sar4=share)
      // Note: area variable code is 'Alue' (not 'Äänestysalue') — handled automatically by loader.
      'helsinki':        'oi57_statfin_ehdok01_2007_fi',
      'uusimaa':         'oi57_statfin_ehdok02_2007_fi',
      'lounais-suomi':   'oi57_statfin_ehdok03_2007_fi',   // Varsinais-Suomen vaalipiiri
      'satakunta':       'oi57_statfin_ehdok04_2007_fi',
      'ahvenanmaa':      'oi57_statfin_ehdok05_2007_fi',
      'hame':            'oi57_statfin_ehdok06_2007_fi',
      'pirkanmaa':       'oi57_statfin_ehdok07_2007_fi',
      'kymi':            'oi57_statfin_ehdok08_2007_fi',    // Kymen vaalipiiri (→ kaakkois-suomi 2015)
      'etela-savo':      'oi57_statfin_ehdok09_2007_fi',   // Etelä-Savon vaalipiiri (→ savo-karjala 2015)
      'pohjois-savo':    'oi57_statfin_ehdok10_2007_fi',   // Pohjois-Savon vaalipiiri (→ savo-karjala 2015)
      'pohjois-karjala': 'oi57_statfin_ehdok11_2007_fi',   // Pohjois-Karjalan vaalipiiri (→ savo-karjala 2015)
      'vaasa':           'oi57_statfin_ehdok12_2007_fi',
      'keski-suomi':     'oi57_statfin_ehdok13_2007_fi',
      'oulu':            'oi57_statfin_ehdok14_2007_fi',
      'lappi':           'oi57_statfin_ehdok15_2007_fi',
    },
  },
];

// ─── Municipal elections (Kuntavaalit) ────────────────────────────────────────
// Base path: StatFin/kvaa/

export const MUNICIPAL_TABLES: ElectionTableSet[] = [
  {
    election_type: 'municipal',
    year: 2025,
    database: DATABASE.active,
    party_by_kunta: 'statfin_kvaa_pxt_14z7',       // 1976–2025, covers all municipal years
    party_schema:   MUNICIPAL_PARTY_SCHEMA,
    // Year-specific all-areas table: use when areaId is omitted to avoid 403 on 14z7
    party_by_aanestysalue:        'statfin_kvaa_pxt_14vm',
    party_by_aanestysalue_schema: MUNICIPAL_YEAR_PARTY_SCHEMA,
    turnout_by_aanestysalue: 'statfin_kvaa_pxt_14vl',
    geographic_unit_type: 'vaalipiiri',
    candidate_by_aanestysalue: {
      // 12 vaalipiirit (no Ahvenanmaa for municipal elections)
      'helsinki':       'statfin_kvaa_pxt_14v9',
      'uusimaa':        'statfin_kvaa_pxt_14va',
      'lounais-suomi':  'statfin_kvaa_pxt_14vb',
      'satakunta':      'statfin_kvaa_pxt_14vc',
      'hame':           'statfin_kvaa_pxt_14vd',
      'pirkanmaa':      'statfin_kvaa_pxt_14ve',
      'kaakkois-suomi': 'statfin_kvaa_pxt_14vf',
      'savo-karjala':   'statfin_kvaa_pxt_14vg',
      'vaasa':          'statfin_kvaa_pxt_14vh',
      'keski-suomi':    'statfin_kvaa_pxt_14vi',
      'oulu':           'statfin_kvaa_pxt_14vj',
      'lappi':          'statfin_kvaa_pxt_14vk',
    },
    results_analysis: 'statfin_kvaa_pxt_14yb',
    voter_background: 'statfin_kvaa_pxt_14w4',          // 2012–2025, multi-year
    voter_turnout_by_demographics: {
      age_group:       'statfin_kvaa_pxt_152q',          // Alue=SSS → Manner-Suomi
      education:       'statfin_kvaa_pxt_152r',
      origin_language: 'statfin_kvaa_pxt_152s',
      income_quintile: 'statfin_kvaa_pxt_152t',
      activity:        'statfin_kvaa_pxt_152u',
    },
  },
  {
    election_type: 'municipal',
    year: 2021,
    database: DATABASE.archive,
    // party_by_kunta: covered by 14z7 (1976–2025) via 2025 entry fallback
    geographic_unit_type: 'vaalipiiri',
    candidate_by_aanestysalue: {
      // Content-column format with Tiedot variable: aanet_yht=votes, osuus_aanista=share.
      // Area variable is 'Äänestysalue'; kunta aggregate uses 3-digit codes (e.g. '091' for Helsinki).
      // No Ahvenanmaa (municipal elections exclude Åland).
      'helsinki':       'statfinpas_kvaa_pxt_12vs_2021',
      'uusimaa':        'statfinpas_kvaa_pxt_12wj_2021',
      'lounais-suomi':  'statfinpas_kvaa_pxt_12wk_2021',   // Varsinais-Suomen vaalipiiri
      'satakunta':      'statfinpas_kvaa_pxt_12wl_2021',
      'hame':           'statfinpas_kvaa_pxt_12wm_2021',
      'pirkanmaa':      'statfinpas_kvaa_pxt_12wn_2021',
      'kaakkois-suomi': 'statfinpas_kvaa_pxt_12wp_2021',
      'savo-karjala':   'statfinpas_kvaa_pxt_12wq_2021',
      'vaasa':          'statfinpas_kvaa_pxt_12wr_2021',
      'keski-suomi':    'statfinpas_kvaa_pxt_12ws_2021',
      'oulu':           'statfinpas_kvaa_pxt_12wt_2021',
      'lappi':          'statfinpas_kvaa_pxt_12wu_2021',
    },
  },
];

// ─── Regional elections (Aluevaalit) ─────────────────────────────────────────
// Base path: StatFin/alvaa/  (archive: StatFin_Passiivi/alvaa/)

export const REGIONAL_TABLES: ElectionTableSet[] = [
  {
    election_type: 'regional',
    year: 2025,
    database: DATABASE.active,
    party_by_kunta: 'statfin_alvaa_pxt_14y4',       // 2022–2025, covers both regional years
    party_schema:   REGIONAL_PARTY_SCHEMA,
    geographic_unit_type: 'hyvinvointialue',
    candidate_by_aanestysalue: {
      // 21 hyvinvointialue, one table each
      'ita-uusimaa':        'statfin_alvaa_pxt_14zu',
      'keski-uusimaa':      'statfin_alvaa_pxt_14zv',
      'lansi-uusimaa':      'statfin_alvaa_pxt_14zw',
      'vantaa-kerava':      'statfin_alvaa_pxt_14zx',
      'varsinais-suomi':    'statfin_alvaa_pxt_14zy',
      'satakunta':          'statfin_alvaa_pxt_14zz',
      'kanta-hame':         'statfin_alvaa_pxt_151a',
      'pirkanmaa':          'statfin_alvaa_pxt_151b',
      'paijat-hame':        'statfin_alvaa_pxt_151c',
      'kymenlaakso':        'statfin_alvaa_pxt_151d',
      'etela-karjala':      'statfin_alvaa_pxt_151e',
      'etela-savo':         'statfin_alvaa_pxt_151f',
      'pohjois-savo':       'statfin_alvaa_pxt_151g',
      'pohjois-karjala':    'statfin_alvaa_pxt_151h',
      'keski-suomi':        'statfin_alvaa_pxt_151i',
      'etela-pohjanmaa':    'statfin_alvaa_pxt_151j',
      'pohjanmaa':          'statfin_alvaa_pxt_151k',
      'keski-pohjanmaa':    'statfin_alvaa_pxt_151l',
      'pohjois-pohjanmaa':  'statfin_alvaa_pxt_151m',
      'kainuu':             'statfin_alvaa_pxt_151n',
      'lappi':              'statfin_alvaa_pxt_151p',
    },
  },
  {
    election_type: 'regional',
    year: 2022,
    database: DATABASE.active,
    // party_by_kunta: covered by 14y4 (2022–2025) via 2025 entry fallback
    // No per-äänestysalue candidate tables available in archive for 2022
  },
];

// ─── EU Parliament elections (Europarlamenttivaalit) ─────────────────────────
// Base path: StatFin/euvaa/  (archive: StatFin_Passiivi/euvaa/)

export const EU_TABLES: ElectionTableSet[] = [
  {
    election_type: 'eu_parliament',
    year: 2024,
    database: DATABASE.active,
    party_by_kunta:    'statfin_euvaa_pxt_14gv',    // 1996–2024, covers all EU years
    party_schema:      EU_PARTY_SCHEMA,
    // Year-specific all-areas table: use when areaId is omitted to avoid 403 on 14gv
    party_by_aanestysalue:        'statfin_euvaa_pxt_14h2',
    party_by_aanestysalue_schema: EU_YEAR_PARTY_SCHEMA,
    candidate_national: 'statfin_euvaa_pxt_14gy',   // all candidates, national totals only
    // EU candidate tables by area (A2)
    candidate_by_vaalipiiri:         'statfin_euvaa_pxt_14gx',  // all candidates, 14 vaalipiirit
    candidate_by_aanestysalue_eu:    'statfin_euvaa_pxt_14gw',  // requires candidate_id filter
    geographic_unit_type: 'national',
    voter_turnout_by_demographics: {
      age_group:       'statfin_euvaa_pxt_14ha',
      education:       'statfin_euvaa_pxt_14hb',
      origin_language: 'statfin_euvaa_pxt_14hc',
      income_quintile: 'statfin_euvaa_pxt_14hd',
      activity:        'statfin_euvaa_pxt_14he',
    },
  },
  {
    election_type: 'eu_parliament',
    year: 2019,
    database: DATABASE.archive,
    // party_by_kunta: covered by 14gv (1996–2024) via 2024 entry fallback
    candidate_national: '430_euvaa_2019_tau_105',   // Sar-dimension measure format
    geographic_unit_type: 'national',
  },
];

// ─── Presidential elections (Presidentinvaalit) ───────────────────────────────
// Base path: StatFin/pvaa/

export const PRESIDENTIAL_TABLES: ElectionTableSet[] = [
  {
    election_type: 'presidential',
    year: 2024,
    database: DATABASE.active,
    // No party dimension in presidential elections
    // All areas (national + vaalipiiri + kunta + äänestysalue) in one table
    candidate_national: 'statfin_pvaa_pxt_14d5',
    // Multi-year vaalipiiri table: candidate votes by vaalipiiri, 1994–2024 (A3)
    candidate_multiyr_vaalipiiri: 'statfin_pvaa_pxt_14db',
    geographic_unit_type: 'national',
    turnout_by_aanestysalue: 'statfin_pvaa_pxt_14d6',
    voter_turnout_by_demographics: {
      age_group:       'statfin_pvaa_pxt_14nk',     // has Kierros var — loader filters to round 1
      education:       'statfin_pvaa_pxt_14nl',
      origin_language: 'statfin_pvaa_pxt_14nm',
      income_quintile: 'statfin_pvaa_pxt_14nn',
      activity:        'statfin_pvaa_pxt_14np',
    },
  },
];

// ─── Combined registry ────────────────────────────────────────────────────────

export const ALL_ELECTION_TABLES: ElectionTableSet[] = [
  ...PARLIAMENTARY_TABLES,
  ...MUNICIPAL_TABLES,
  ...REGIONAL_TABLES,
  ...EU_TABLES,
  ...PRESIDENTIAL_TABLES,
];

export function getElectionTables(
  type: ElectionType,
  year: number
): ElectionTableSet | undefined {
  return ALL_ELECTION_TABLES.find(
    (t) => t.election_type === type && t.year === year
  );
}

/**
 * Find the most-recent entry for an election type that has a party_by_kunta table.
 * Used as fallback when querying older years whose party data is in a multi-year table.
 */
export function findPartyTableForType(
  type: ElectionType
): ElectionTableSet | undefined {
  return ALL_ELECTION_TABLES.find(
    (t) => t.election_type === type && t.party_by_kunta
  );
}

/**
 * Find the entry for an election type that has a voter_background table.
 * Used as fallback for older years — the multi-year table (13su / 14w4)
 * is registered only on the most recent entry and covers all years via
 * server-side Vuosi filtering in the loader.
 */
export function findVoterBackgroundTableForType(
  type: ElectionType
): ElectionTableSet | undefined {
  return ALL_ELECTION_TABLES.find(
    (t) => t.election_type === type && t.voter_background
  );
}

/** Returns the database path prefix for a table set */
export function getDatabasePath(tables: ElectionTableSet): string {
  const dbCode: Record<ElectionType, string> = {
    parliamentary: 'evaa',
    municipal:     'kvaa',
    eu_parliament: 'euvaa',
    presidential:  'pvaa',
    regional:      'alvaa',
  };
  return `${tables.database}/${dbCode[tables.election_type]}`;
}
