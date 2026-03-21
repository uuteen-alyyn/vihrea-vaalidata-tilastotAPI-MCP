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
  PRESIDENTIAL_TABLES,
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

/**
 * Returns the appropriate cache TTL for election data.
 * Historical elections (year < current calendar year) are immutable — cache for 7 days.
 * Current year data may still be updated — use the default 1-hour TTL.
 *
 * Can be overridden with env CACHE_TTL_HISTORICAL_MS (milliseconds).
 */
const HISTORICAL_TTL_MS =
  process.env.CACHE_TTL_HISTORICAL_MS
    ? parseInt(process.env.CACHE_TTL_HISTORICAL_MS, 10)
    : 7 * 24 * 60 * 60 * 1000; // 7 days

function electionTtl(year: number): number | undefined {
  return year < new Date().getFullYear() ? HISTORICAL_TTL_MS : undefined; // undefined = default (1h)
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
  const exact = getElectionTables(electionType, year);

  // A1 routing: when areaId is omitted (all-areas query) and a year-specific table
  // exists, use it to avoid the 403 cell-count limit on multi-year tables.
  // Multi-year tables (13sw, 14z7, 14gv) with all areas at once exceed PxWeb's limit
  // (~305 areas × 20 parties × 2 measures ≈ 12 000+ cells). Year-specific tables
  // (13t2, 14vm, 14h2) contain all area levels within the cell budget.
  if (!areaId && exact?.party_by_aanestysalue && exact.party_by_aanestysalue_schema) {
    const schema    = exact.party_by_aanestysalue_schema;
    const dbPath    = getDatabasePath(exact);
    const tableId   = exact.party_by_aanestysalue;
    const metadata  = await fetchMetadataCached(dbPath, tableId);

    type FilterItem = { code: string; selection: { filter: 'item' | 'all'; values: string[] } };
    const filters: FilterItem[] = [];

    if (schema.gender_var && schema.gender_total_code) {
      filters.push({ code: schema.gender_var, selection: { filter: 'item', values: [schema.gender_total_code] } });
    }
    filters.push({ code: schema.party_var, selection: { filter: 'all', values: ['*'] } });
    filters.push({ code: schema.area_var,  selection: { filter: 'all', values: ['*'] } });
    filters.push({ code: schema.measure_var, selection: { filter: 'item', values: [schema.votes_code, schema.share_code] } });

    // Year filter if table has Vuosi variable
    if (metadata.variables.some((v) => v.code === 'Vuosi')) {
      filters.push({ code: 'Vuosi', selection: { filter: 'item', values: [String(year)] } });
    }

    const query    = { query: filters, response: { format: 'json' as const } };
    const cacheKey = `data:${tableId}:${electionType}:${year}:all`;

    const { value: response, cache_hit } = await withCache(cacheKey, () =>
      pxwebClient.queryTable(dbPath, tableId, query),
      electionTtl(year)
    );

    const rows = normalizePartyTable(response, metadata, year, electionType, schema);
    return { rows, tableId, cache_hit };
  }

  // Standard path: use multi-year table (filtered to one area, or with year filter)
  // If the exact year entry has no party table, fall back to the multi-year table
  // registered on the most recent entry (e.g. 14z7 covers all municipal years).
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
    pxwebClient.queryTable(dbPath, tableId, query),
    electionTtl(year)
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
    if (!found) {
      const validKeys = Object.keys(tables.candidate_by_aanestysalue).join(', ');
      throw new Error(`Unknown unit key '${unitKey}' for ${electionType} ${year}. Valid unit keys: ${validKeys}`);
    }
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
    // Fetch individual outcome codes (1=elected, 2=varalla, 3=not_elected) instead of SSS aggregate.
    // Each candidate belongs to exactly one outcome category, so vote counts are equivalent to SSS.
    filters.push({ code: 'Valintatieto', selection: { filter: 'item', values: ['1', '2', '3'] } });
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
    pxwebClient.queryTable(dbPath, tableId, query),
    electionTtl(year)
  );

  const rows = normalizeCandidateByAanestysalue(
    response, metadata, year, electionType, roundFilter
  );

  return { rows, tableId, cache_hit, unit_code };
}

export type { ElectionRecord };

// ─── Presidential multi-year vaalipiiri loader ────────────────────────────────

/**
 * Load presidential candidate results by vaalipiiri from the multi-year table (14db).
 * Covers all presidential elections 1994–2024.
 *
 * Uses the same cache-all-years pattern as the party multi-year loaders (13sw etc.):
 * the full table is fetched and cached once; subsequent calls for other years are
 * served from cache after year-filtering client-side.
 *
 * @param year        Presidential election year (1994, 2000, 2006, 2012, 2018, 2024)
 * @param candidateId Optional candidate code for a filtered (smaller) query
 */
export async function loadPresidentialByVaalipiiri(
  year: number,
  candidateId?: string,
): Promise<CandidateLoadResult> {
  const tables = PRESIDENTIAL_TABLES.find((t) => t.candidate_multiyr_vaalipiiri);
  if (!tables?.candidate_multiyr_vaalipiiri) {
    throw new Error('No presidential candidate_multiyr_vaalipiiri table (14db) registered');
  }
  const tableId = tables.candidate_multiyr_vaalipiiri;
  const dbPath  = getDatabasePath(tables);
  const metadata = await fetchMetadataCached(dbPath, tableId);

  type FilterItem = { code: string; selection: { filter: 'item' | 'all'; values: string[] } };
  const filters: FilterItem[] = [];

  // Fetch all years — cache the full multi-year response; filter per-request below
  filters.push({ code: 'Vaalipiiri', selection: { filter: 'all', values: ['*'] } });
  filters.push({
    code: 'Ehdokas',
    selection: candidateId
      ? { filter: 'item', values: [candidateId] }
      : { filter: 'all', values: ['*'] },
  });
  // Include Kierros if present (presidential rounds)
  if (metadata.variables.some((v) => v.code === 'Kierros')) {
    filters.push({ code: 'Kierros', selection: { filter: 'all', values: ['*'] } });
  }

  const tiedotVar = metadata.variables.find((v) => v.code === 'Tiedot');
  const votesCode = tiedotVar?.values.find(
    (_, i) => (tiedotVar.valueTexts[i] ?? '').toLowerCase().includes('äänimäärä') ||
              (tiedotVar.valueTexts[i] ?? '').toLowerCase().includes('äänet')
  ) ?? 'pvaa_aanet';
  const shareCode = tiedotVar?.values.find(
    (_, i) => (tiedotVar.valueTexts[i] ?? '').toLowerCase().includes('osuus')
  ) ?? 'pvaa_osuus_aanista';
  filters.push({ code: 'Tiedot', selection: { filter: 'item', values: [votesCode, shareCode] } });

  const query = { query: filters, response: { format: 'json' as const } };
  // Cache key without year — the full multi-year table is cached in one call
  const cacheKey = `data:${tableId}:presidential:all${candidateId ? `:${candidateId}` : ''}`;

  const { value: rawResponse, cache_hit } = await withCache(cacheKey, () =>
    pxwebClient.queryTable(dbPath, tableId, query)
  );

  // Slice to the requested year before normalizing
  const response = filterResponseByYear(rawResponse, year);
  const rows = normalizeCandidateByAanestysalue(response, metadata, year, 'presidential');
  return { rows, tableId, cache_hit, unit_code: 'SSS' };
}

// ─── EU candidate loaders ─────────────────────────────────────────────────────

/**
 * Load EU parliament candidate results by vaalipiiri (14gx).
 * Returns all candidates × 14 vaalipiiri + national. No filter needed
 * unless filtering to a specific candidate (~3500 cells — within limit).
 *
 * Uses `normalizeCandidateByAanestysalue` which now handles:
 *   - `Vaalipiiri` as the area variable
 *   - `Puolue ja ehdokas` as the candidate variable (mixed with party aggregates)
 *   - Skips non-numeric codes (party aggregate rows like VIHR, SDP)
 *
 * @param year        EU election year (currently 2024 only)
 * @param candidateId Optional candidate code to filter to (more efficient)
 */
export async function loadEUCandidateByVaalipiiri(
  year: number,
  candidateId?: string
): Promise<CandidateLoadResult> {
  const tables = getElectionTables('eu_parliament', year);
  if (!tables?.candidate_by_vaalipiiri) {
    throw new Error(`No EU candidate_by_vaalipiiri table for year ${year}`);
  }
  const tableId = tables.candidate_by_vaalipiiri;
  const dbPath  = getDatabasePath(tables);
  const metadata = await fetchMetadataCached(dbPath, tableId);

  type FilterItem = { code: string; selection: { filter: 'item' | 'all'; values: string[] } };
  const filters: FilterItem[] = [];

  if (metadata.variables.some((v) => v.code === 'Vuosi')) {
    filters.push({ code: 'Vuosi', selection: { filter: 'item', values: [String(year)] } });
  }

  filters.push({
    code: 'Puolue ja ehdokas',
    selection: candidateId
      ? { filter: 'item', values: [candidateId] }
      : { filter: 'all', values: ['*'] },
  });

  filters.push({ code: 'Vaalipiiri', selection: { filter: 'all', values: ['*'] } });

  // Detect Tiedot variable and vote/share codes
  const tiedotVar = metadata.variables.find((v) => v.code === 'Tiedot');
  const votesCode = tiedotVar?.values.find(
    (_, i) => (tiedotVar.valueTexts[i] ?? '').toLowerCase().includes('äänimäärä') ||
              (tiedotVar.valueTexts[i] ?? '').toLowerCase().includes('äänet')
  ) ?? 'euvaa_aanet';
  const shareCode = tiedotVar?.values.find(
    (_, i) => (tiedotVar.valueTexts[i] ?? '').toLowerCase().includes('osuus')
  ) ?? 'euvaa_osuus_aanista';
  filters.push({ code: 'Tiedot', selection: { filter: 'item', values: [votesCode, shareCode] } });

  const query    = { query: filters, response: { format: 'json' as const } };
  const cacheKey = `data:${tableId}:eu_parliament:${year}:${candidateId ?? 'all'}:vaalipiiri`;

  const { value: response, cache_hit } = await withCache(cacheKey, () =>
    pxwebClient.queryTable(dbPath, tableId, query)
  );

  const rows = normalizeCandidateByAanestysalue(response, metadata, year, 'eu_parliament');
  const unit_code = 'SSS';
  return { rows, tableId, cache_hit, unit_code };
}

/**
 * Load EU parliament candidate results by äänestysalue for a specific candidate (14gw).
 * Requires candidateId — without it 247 candidates × 2079 areas exceeds PxWeb cell limit.
 *
 * @param year        EU election year (currently 2024 only)
 * @param candidateId Required candidate code
 */
export async function loadEUCandidateByAanestysalue(
  year: number,
  candidateId: string
): Promise<CandidateLoadResult> {
  const tables = getElectionTables('eu_parliament', year);
  if (!tables?.candidate_by_aanestysalue_eu) {
    throw new Error(`No EU candidate_by_aanestysalue_eu table for year ${year}`);
  }
  const tableId = tables.candidate_by_aanestysalue_eu;
  const dbPath  = getDatabasePath(tables);
  const metadata = await fetchMetadataCached(dbPath, tableId);

  // Detect area variable (may be 'Äänestysalue' or 'Alue/Äänestysalue')
  const areaVarCandidates = ['Alue/Äänestysalue', 'Äänestysalue', 'Alue'];
  const areaVarCode = metadata.variables.find((v) => areaVarCandidates.includes(v.code))?.code;

  type FilterItem = { code: string; selection: { filter: 'item' | 'all'; values: string[] } };
  const filters: FilterItem[] = [];

  if (metadata.variables.some((v) => v.code === 'Vuosi')) {
    filters.push({ code: 'Vuosi', selection: { filter: 'item', values: [String(year)] } });
  }
  if (areaVarCode) {
    filters.push({ code: areaVarCode, selection: { filter: 'all', values: ['*'] } });
  }
  filters.push({ code: 'Ehdokas', selection: { filter: 'item', values: [candidateId] } });

  const tiedotVar = metadata.variables.find(
    (v) => v.code === 'Tiedot' || v.code === 'Äänestystiedot'
  );
  const tiedotVarCode = tiedotVar?.code ?? 'Tiedot';
  const votesCode = tiedotVar?.values.find(
    (_, i) => (tiedotVar.valueTexts[i] ?? '').toLowerCase().includes('äänimäärä') ||
              (tiedotVar.valueTexts[i] ?? '').toLowerCase().includes('äänet')
  ) ?? 'euvaa_aanet';
  const shareCode = tiedotVar?.values.find(
    (_, i) => (tiedotVar.valueTexts[i] ?? '').toLowerCase().includes('osuus')
  ) ?? 'euvaa_osuus_aanista';
  filters.push({ code: tiedotVarCode, selection: { filter: 'item', values: [votesCode, shareCode] } });

  const query    = { query: filters, response: { format: 'json' as const } };
  const cacheKey = `data:${tableId}:eu_parliament:${year}:${candidateId}:all`;

  const { value: response, cache_hit } = await withCache(cacheKey, () =>
    pxwebClient.queryTable(dbPath, tableId, query)
  );

  const rows = normalizeCandidateByAanestysalue(response, metadata, year, 'eu_parliament');
  const unit_code = 'SSS';
  return { rows, tableId, cache_hit, unit_code };
}

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
