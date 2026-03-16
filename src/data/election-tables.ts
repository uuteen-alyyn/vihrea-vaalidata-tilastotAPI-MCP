import type { ElectionType } from './types.js';

/**
 * Registry of known Tilastokeskus table IDs for each election type.
 *
 * KEY ARCHITECTURAL NOTE:
 * The PxWeb API has no single "list elections" endpoint. This registry is
 * the authoritative source for which tables exist for which elections.
 * It must be updated manually when new elections are published.
 *
 * CANDIDATE DATA ARCHITECTURE:
 * For parliamentary elections (2023), candidate-level data with voting-area
 * (äänestysalue) breakdown is split across 13 separate tables — one per
 * vaalipiiri. Fetching national candidate results requires querying all 13
 * and merging. With a 10 req/10s rate limit, this must be done carefully.
 *
 * Older elections may be in the archive database: StatFin_Passiivi
 * (needs investigation in Phase 2).
 */

export const DATABASE = {
  active: 'StatFin',
  archive: 'StatFin_Passiivi',
} as const;

export interface ElectionTableSet {
  election_type: ElectionType;
  year: number;
  database: string;
  /** Party votes by municipality (kunta), multi-year table */
  party_by_kunta?: string;
  /** Turnout by voting area (äänestysalue) */
  turnout_by_aanestysalue?: string;
  /** Single national candidate summary (vaalipiiri level, no voting area breakdown) */
  candidate_national_summary?: string;
  /** Per-vaalipiiri candidate tables with voting-area breakdown */
  candidate_by_aanestysalue?: Record<string, string>;
  /** Results analysis / comparison to prior election */
  results_analysis?: string;
}

// Parliamentary elections (Eduskuntavaalit)
// Base path: StatFin/evaa/

export const PARLIAMENTARY_TABLES: ElectionTableSet[] = [
  {
    election_type: 'parliamentary',
    year: 2023,
    database: DATABASE.active,
    party_by_kunta: 'statfin_evaa_pxt_13sw',       // Party support by municipality, 1983–2023
    turnout_by_aanestysalue: 'statfin_evaa_pxt_13sx',
    candidate_national_summary: 'statfin_evaa_pxt_13t3',
    candidate_by_aanestysalue: {
      // 13 vaalipiirit, one table each
      'helsinki':        'statfin_evaa_pxt_13t6',
      'uusimaa':         'statfin_evaa_pxt_13t7',
      'lounais-suomi':   'statfin_evaa_pxt_13t8',
      'satakunta':       'statfin_evaa_pxt_13t9',
      'hame':            'statfin_evaa_pxt_13ta',
      'pirkanmaa':       'statfin_evaa_pxt_13tb',
      'kaakkois-suomi':  'statfin_evaa_pxt_13tc',
      'savo-karjala':    'statfin_evaa_pxt_13td',
      'vaasa':           'statfin_evaa_pxt_13te',
      'keski-suomi':     'statfin_evaa_pxt_13tf',
      'oulu':            'statfin_evaa_pxt_13tg',
      'lappi':           'statfin_evaa_pxt_13th',
      'ahvenanmaa':      'statfin_evaa_pxt_13ti',
    },
    results_analysis: 'statfin_evaa_pxt_13yh',     // Comparison 2019–2023
  },
  {
    election_type: 'parliamentary',
    year: 2019,
    database: DATABASE.archive,
    // party_by_kunta: covered by 13sw (1983–2023) via 2023 registry entry fallback
    // turnout: 120_evaa_2019_tau_102 exists but uses different variable codes — mapped separately if needed
    candidate_by_aanestysalue: {
      // 13 vaalipiirit — tables 170–182 in StatFin_Passiivi/evaa/
      // Variable codes differ from 2023: Äänestysalue, Äänestystiedot (Sar1/Sar2), no Vuosi/Valintatieto
      // Area code format: VP## (vaalipiiri), ### (3-digit kunta), ##kunta###letter (äänestysalue)
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
];

// Municipal elections (Kuntavaalit)
// Base path: StatFin/kvaa/

export const MUNICIPAL_TABLES: ElectionTableSet[] = [
  {
    election_type: 'municipal',
    year: 2025,
    database: DATABASE.active,
    results_analysis: 'statfin_kvaa_pxt_14yb',
    // TODO: map remaining kvaa tables for 2025
  },
  // TODO: Add 2021, 2017 elections
];

// EU Parliament elections (Europarlamenttivaalit)
// Base path: StatFin/euvaa/
export const EU_TABLES: ElectionTableSet[] = [
  // TODO: Map euvaa tables
];

// Presidential elections (Presidentinvaalit)
// Base path: StatFin/pvaa/
export const PRESIDENTIAL_TABLES: ElectionTableSet[] = [
  // TODO: Map pvaa tables
];

// Regional elections (Aluevaalit)
// Base path: StatFin/alvaa/
export const REGIONAL_TABLES: ElectionTableSet[] = [
  // TODO: Map alvaa tables
];

export const ALL_ELECTION_TABLES: ElectionTableSet[] = [
  ...PARLIAMENTARY_TABLES,
  ...MUNICIPAL_TABLES,
  ...EU_TABLES,
  ...PRESIDENTIAL_TABLES,
  ...REGIONAL_TABLES,
];

export function getElectionTables(
  type: ElectionType,
  year: number
): ElectionTableSet | undefined {
  return ALL_ELECTION_TABLES.find(
    (t) => t.election_type === type && t.year === year
  );
}

/** Returns the database path prefix for a table set */
export function getDatabasePath(tables: ElectionTableSet): string {
  const dbCode: Record<ElectionType, string> = {
    parliamentary: 'evaa',
    municipal: 'kvaa',
    eu_parliament: 'euvaa',
    presidential: 'pvaa',
    regional: 'alvaa',
  };
  return `${tables.database}/${dbCode[tables.election_type]}`;
}
