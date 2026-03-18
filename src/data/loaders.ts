/**
 * Shared data-loading helpers used by all tools.
 *
 * Each function accepts an optional `electionType` parameter (defaulting to
 * 'parliamentary') so all existing callers continue working without changes.
 * New callers pass the election type explicitly.
 */

import { pxwebClient } from '../api/pxweb-client.js';
import { withCache } from '../cache/cache.js';
import { normalizePartyTable, normalizeCandidateByAanestysalue } from './normalizer.js';
import {
  normalizeVoterBackground,
  normalizeVoterTurnoutByDemographics,
  BACKGROUND_DIMENSION_CODES,
  groupPxWebCode,
  genderVarName,
} from './demographics-normalizer.js';
import {
  getElectionTables,
  findPartyTableForType,
  findVoterBackgroundTableForType,
  getDatabasePath,
} from './election-tables.js';
import type { ElectionRecord, ElectionType, VoterBackgroundRow, VoterTurnoutDemographicRow } from './types.js';
import type { PxWebResponse, PxWebTableMetadata } from '../api/types.js';

/**
 * Filter a PxWeb response to rows matching a specific year.
 * Used after a multi-year cache retrieval to hand the normalizer
 * a year-homogeneous slice without repeating an API call.
 *
 * Exported for unit testing.
 */
export function filterResponseByYear(response: PxWebResponse, year: number): PxWebResponse {
  const keyColumns = response.columns.filter((c) => c.type === 'd' || c.type === 't');
  const vuosiKeyIdx = keyColumns.findIndex((c) => c.code === 'Vuosi');
  if (vuosiKeyIdx < 0) return response;
  return {
    ...response,
    data: response.data.filter((row) => row.key[vuosiKeyIdx] === String(year)),
  };
}

export interface LoadResult {
  rows: ElectionRecord[];
  tableId: string;
  cache_hit: boolean;
}

export interface CandidateLoadResult extends LoadResult {
  /** The VP## or HV## code for the geographic-unit aggregate row in this table */
  unit_code: string;
}

export async function fetchMetadataCached(
  database: string,
  tableId: string
): Promise<PxWebTableMetadata> {
  return withCache(`meta:${tableId}`, () =>
    pxwebClient.getTableMetadata(database, tableId)
  ).then((r) => r.value);
}

// ─── Party results ─────────────────────────────────────────────────────────────

/**
 * Load party results for any election type and year.
 *
 * For election types that use a multi-year party table (parliamentary 13sw,
 * municipal 14z7, regional 14y4, EU 14gv), the function falls back to the
 * most-recent entry's table when the exact year has no registered party table.
 *
 * @param year         Election year
 * @param areaId       Optional area code to filter (omit for all areas)
 * @param electionType Election type (defaults to 'parliamentary')
 */
export async function loadPartyResults(
  year: number,
  areaId?: string,
  electionType: ElectionType = 'parliamentary'
): Promise<LoadResult> {
  // If the exact year entry has no party table, fall back to the multi-year table
  // registered on the most recent entry (e.g. 14z7 covers all municipal years).
  const exact = getElectionTables(electionType, year);
  const tables = (exact?.party_by_kunta ? exact : null) ?? findPartyTableForType(electionType);
  if (!tables?.party_by_kunta || !tables.party_schema) {
    throw new Error(`No party table for ${electionType} ${year}`);
  }

  const schema = tables.party_schema;
  const dbPath = getDatabasePath(tables);
  const tableId = tables.party_by_kunta;
  const metadata = await fetchMetadataCached(dbPath, tableId);

  // Detect multi-year table: Vuosi variable present with more than one value.
  // Multi-year tables (13sw, 14z7, 14y4, 14gv) cover multiple elections in one PxWeb
  // table. We cache the full response (all years) so compare_elections can serve
  // additional years as cache hits — zero extra API calls.
  const vuosiVar = metadata.variables.find((v) => v.code === 'Vuosi');
  const isMultiYear = (vuosiVar?.values.length ?? 0) > 1;

  type FilterItem = { code: string; selection: { filter: 'item' | 'all'; values: string[] } };
  const filters: FilterItem[] = [];

  // Year filter — only for single-year tables; multi-year tables fetch all years
  // and filter post-cache (see filterResponseByYear below).
  if (vuosiVar && !isMultiYear) {
    filters.push({ code: 'Vuosi', selection: { filter: 'item', values: [String(year)] } });
  }

  // Gender filter — select total only when variable is present
  if (schema.gender_var && schema.gender_total_code) {
    filters.push({
      code: schema.gender_var,
      selection: { filter: 'item', values: [schema.gender_total_code] },
    });
  }

  // Party filter (all parties)
  filters.push({ code: schema.party_var, selection: { filter: 'all', values: ['*'] } });

  // Area filter — translate generic 'SSS'/'national' to the schema's native national code
  const resolvedAreaId = areaId === 'SSS' || areaId === 'national'
    ? schema.national_code
    : areaId;
  filters.push({
    code: schema.area_var,
    selection: resolvedAreaId
      ? { filter: 'item', values: [resolvedAreaId] }
      : { filter: 'all', values: ['*'] },
  });

  // Measure filter
  filters.push({
    code: schema.measure_var,
    selection: { filter: 'item', values: [schema.votes_code, schema.share_code] },
  });

  const query = { query: filters, response: { format: 'json' as const } };

  // Multi-year tables: cache key excludes year — one entry serves all years.
  // Single-year tables: keep year in key (existing behaviour, no regression).
  const cacheKey = isMultiYear
    ? `data:${tableId}:all_years:${areaId ?? 'all'}`
    : `data:${tableId}:${electionType}:${year}:${areaId ?? 'all'}`;

  const { value: rawResponse, cache_hit } = await withCache(cacheKey, () =>
    pxwebClient.queryTable(dbPath, tableId, query)
  );

  // For multi-year tables, slice the cached all-years response down to the
  // requested year before passing to the normalizer.
  const response = isMultiYear ? filterResponseByYear(rawResponse, year) : rawResponse;

  const rows = normalizePartyTable(response, metadata, year, electionType, schema);
  return { rows, tableId, cache_hit };
}

// ─── Candidate results ────────────────────────────────────────────────────────

/**
 * Load candidate results for a given election year and geographic unit.
 *
 * For parliamentary/municipal elections, `unitKey` is a vaalipiiri key
 * (e.g. 'helsinki', 'uusimaa').
 * For regional elections, `unitKey` is a hyvinvointialue key
 * (e.g. 'ita-uusimaa', 'pirkanmaa').
 * For EU and presidential elections, pass unitKey=undefined or 'national' —
 * the single national table is used.
 *
 * @param year         Election year
 * @param unitKey      Geographic unit key, or undefined/'national' for EU/presidential
 * @param candidateId  Optional candidate value code to filter
 * @param electionType Election type (defaults to 'parliamentary')
 * @param roundFilter  For presidential: 1=first round, 2=second round, undefined=all
 */
export async function loadCandidateResults(
  year: number,
  unitKey: string | undefined,
  candidateId?: string,
  electionType: ElectionType = 'parliamentary',
  roundFilter?: number
): Promise<CandidateLoadResult> {
  const tables = getElectionTables(electionType, year);
  if (!tables) throw new Error(`No tables registered for ${electionType} ${year}`);

  const isNational = !unitKey || unitKey === 'national';
  let tableId: string;

  if (isNational && tables.candidate_national) {
    tableId = tables.candidate_national;
  } else if (!isNational && tables.candidate_by_aanestysalue) {
    const found = tables.candidate_by_aanestysalue[unitKey!];
    if (!found) throw new Error(`Unknown unit key '${unitKey}' for ${electionType} ${year}`);
    tableId = found;
  } else {
    throw new Error(`No candidate table available for ${electionType} ${year} (unitKey=${unitKey})`);
  }

  const dbPath  = getDatabasePath(tables);
  const metadata = await fetchMetadataCached(dbPath, tableId);

  // Detect area variable
  const AREA_VAR_CANDIDATES = ['Alue/Äänestysalue', 'Äänestysalue', 'Alue'];
  const areaVarCode = metadata.variables.find(
    (v) => AREA_VAR_CANDIDATES.includes(v.code)
  )?.code ?? null;

  // Find the geographic-unit aggregate code (VP## or HV##)
  const unit_code = areaVarCode
    ? (metadata.variables
        .find((v) => v.code === areaVarCode)
        ?.values.find((v) => v.startsWith('VP') || v.startsWith('HV')) ?? '')
    : '';

  // Detect measure variable and its vote/share codes
  const tiedotVar = metadata.variables.find(
    (v) => v.code === 'Tiedot' || v.code === 'Äänestystiedot' || v.code === 'Puolueiden kannatus'
  );
  const tiedotVarCode = tiedotVar?.code ?? 'Tiedot';
  const votesCode = tiedotVar?.values.find(
    (_, i) =>
      (tiedotVar.valueTexts[i] ?? '').toLowerCase().includes('äänimäärä') ||
      (tiedotVar.valueTexts[i] ?? '').toLowerCase().includes('äänet')
  ) ?? 'evaa_aanet';
  const shareCode = tiedotVar?.values.find(
    (_, i) => (tiedotVar.valueTexts[i] ?? '').toLowerCase().includes('osuus')
  ) ?? 'evaa_osuus_aanista';

  type FilterItem = { code: string; selection: { filter: 'item' | 'all'; values: string[] } };
  const filters: FilterItem[] = [];

  if (metadata.variables.some((v) => v.code === 'Vuosi')) {
    filters.push({ code: 'Vuosi', selection: { filter: 'item', values: [String(year)] } });
  }
  if (areaVarCode) {
    filters.push({ code: areaVarCode, selection: { filter: 'all', values: ['*'] } });
  }
  filters.push({
    code: 'Ehdokas',
    selection: candidateId
      ? { filter: 'item', values: [candidateId] }
      : { filter: 'all', values: ['*'] },
  });
  if (metadata.variables.some((v) => v.code === 'Valintatieto')) {
    filters.push({ code: 'Valintatieto', selection: { filter: 'item', values: ['SSS'] } });
  }
  // Round variable (presidential) — fetch all rounds, filter in normalizer
  if (metadata.variables.some((v) => v.code === 'Kierros')) {
    filters.push({ code: 'Kierros', selection: { filter: 'all', values: ['*'] } });
  }
  filters.push({
    code: tiedotVarCode,
    selection: { filter: 'item', values: [votesCode, shareCode] },
  });

  const query = { query: filters, response: { format: 'json' as const } };
  const cacheKey = `data:${tableId}:${electionType}:${year}:${candidateId ?? 'all'}:${unitKey ?? 'national'}`;

  const { value: response, cache_hit } = await withCache(cacheKey, () =>
    pxwebClient.queryTable(dbPath, tableId, query)
  );

  const rows = normalizeCandidateByAanestysalue(
    response, metadata, year, electionType, roundFilter
  );

  return { rows, tableId, cache_hit, unit_code };
}

export type { ElectionRecord };

// ── Voter demographics helpers ────────────────────────────────────────────────

const VOTER_BACKGROUND_YEARS: Partial<Record<ElectionType, number[]>> = {
  parliamentary: [2011, 2015, 2019, 2023],
  municipal:     [2012, 2017, 2021, 2025],
};

const VOTER_TURNOUT_DEMO_VALID_YEAR: Partial<Record<ElectionType, number>> = {
  parliamentary: 2023,
  municipal:     2025,
  eu_parliament: 2024,
  presidential:  2024,
};

// ── loadVoterBackground ───────────────────────────────────────────────────────

/**
 * Load socioeconomic composition of eligible voters, candidates, or elected
 * officials for parliamentary or municipal elections.
 *
 * Returns rows for all three genders. Callers can filter by gender if needed.
 */
export async function loadVoterBackground(
  electionType: ElectionType,
  year: number,
  group: 'eligible_voters' | 'candidates' | 'elected',
  dimension: 'employment' | 'education' | 'employer_sector' | 'income_decile' | 'language' | 'origin',
): Promise<VoterBackgroundRow[]> {
  const validYears = VOTER_BACKGROUND_YEARS[electionType];
  if (!validYears) {
    throw new Error(
      `get_voter_background is not available for ${electionType}. ` +
      `Supported: parliamentary (2011/2015/2019/2023), municipal (2012/2017/2021/2025).`
    );
  }
  if (!validYears.includes(year)) {
    throw new Error(
      `No voter background data for ${electionType} ${year}. ` +
      `Available years: ${validYears.join(', ')}.`
    );
  }

  const tables = findVoterBackgroundTableForType(electionType);
  if (!tables?.voter_background) {
    throw new Error(`No voter background table registered for ${electionType}`);
  }

  const tableId = tables.voter_background;
  const dbPath  = getDatabasePath(tables);
  const metadata = await fetchMetadataCached(dbPath, tableId);

  const dimCodes = BACKGROUND_DIMENSION_CODES[dimension];
  if (!dimCodes) throw new Error(`Unknown background dimension: ${dimension}`);

  const groupCode  = groupPxWebCode(electionType, group);
  const genderVar  = genderVarName(electionType);
  const groupVar   = 'Äänioikeutetut, ehdokkaat ja valitut';

  type FilterItem = { code: string; selection: { filter: 'item' | 'all'; values: string[] } };
  const filters: FilterItem[] = [
    { code: 'Vuosi',       selection: { filter: 'item', values: [String(year)] } },
    { code: genderVar,     selection: { filter: 'all',  values: ['*'] } },
    { code: groupVar,      selection: { filter: 'item', values: [groupCode] } },
    { code: 'Taustamuuttujat', selection: { filter: 'item', values: dimCodes } },
    { code: 'Tiedot',     selection: { filter: 'item', values: ['lkm1', 'pros'] } },
  ];

  const query = { query: filters, response: { format: 'json' as const } };
  const cacheKey = `data:${tableId}:${electionType}:${year}:${group}:${dimension}`;

  const { value: response } = await withCache(cacheKey, () =>
    pxwebClient.queryTable(dbPath, tableId, query)
  );

  return normalizeVoterBackground(response, metadata, electionType, year, group, dimension);
}

// ── loadVoterTurnoutByDemographics ────────────────────────────────────────────

/**
 * Load actual voter participation rate broken down by a demographic dimension.
 * Returns national-level rows for all three genders.
 *
 * @param round  Presidential elections only — 1=first round (default), 2=runoff.
 */
export async function loadVoterTurnoutByDemographics(
  electionType: ElectionType,
  year: number,
  dimension: 'age_group' | 'education' | 'income_quintile' | 'origin_language' | 'activity',
  round = 1,
): Promise<VoterTurnoutDemographicRow[]> {
  const validYear = VOTER_TURNOUT_DEMO_VALID_YEAR[electionType];
  if (validYear === undefined) {
    throw new Error(
      `get_voter_turnout_by_demographics is not available for ${electionType}. ` +
      `Supported: parliamentary (2023), municipal (2025), eu_parliament (2024), presidential (2024).`
    );
  }
  if (year !== validYear) {
    throw new Error(
      `Turnout-by-demographics for ${electionType} elections is only available for ${validYear}. ` +
      `No data exists for ${year} — this has been verified by full archive enumeration.`
    );
  }

  const tables = getElectionTables(electionType, year);
  const tableId = tables?.voter_turnout_by_demographics?.[dimension];
  if (!tableId) {
    throw new Error(`No turnout-by-demographics table for ${electionType} ${year} ${dimension}`);
  }

  const dbPath  = getDatabasePath(tables!);
  const metadata = await fetchMetadataCached(dbPath, tableId);

  type FilterItem = { code: string; selection: { filter: 'item' | 'all'; values: string[] } };
  const filters: FilterItem[] = [
    { code: 'Sukupuoli', selection: { filter: 'all', values: ['*'] } },
    { code: 'Alue',      selection: { filter: 'item', values: ['SSS'] } },
  ];

  // Dimension variable: fetch all values, normalizer handles stripping
  const dimVarCode = metadata.variables.find(
    (v) => v.code !== 'Sukupuoli' && v.code !== 'Alue' && v.code !== 'Kierros' &&
           v.code !== 'Vuosi' && v.code !== 'Tiedot'
  )?.code;
  if (dimVarCode) {
    filters.push({ code: dimVarCode, selection: { filter: 'all', values: ['*'] } });
  }

  // Presidential: filter to the requested round
  if (metadata.variables.some((v) => v.code === 'Kierros')) {
    filters.push({ code: 'Kierros', selection: { filter: 'item', values: [String(round)] } });
  }

  // Tiedot: fetch eligible voters (area), votes cast (area), and turnout %
  const suffix = ({ parliamentary: 'evaa', municipal: 'kvaa', eu_parliament: 'euvaa', presidential: 'pvaa' } as Record<string, string>)[electionType]!;
  filters.push({
    code: 'Tiedot',
    selection: { filter: 'item', values: [`aoiky_al_${suffix}`, `a_al_${suffix}`, `pros_al_${suffix}`] },
  });

  const query = { query: filters, response: { format: 'json' as const } };
  const cacheKey = `data:${tableId}:${electionType}:${year}:${dimension}:r${round}`;

  const { value: response } = await withCache(cacheKey, () =>
    pxwebClient.queryTable(dbPath, tableId, query)
  );

  return normalizeVoterTurnoutByDemographics(response, metadata, electionType, year, dimension, round);
}
