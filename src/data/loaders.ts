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
  getElectionTables,
  findPartyTableForType,
  getDatabasePath,
} from './election-tables.js';
import type { ElectionRecord, ElectionType } from './types.js';
import type { PxWebTableMetadata } from '../api/types.js';

export interface LoadResult {
  rows: ElectionRecord[];
  tableId: string;
  cache_hit: boolean;
}

export interface CandidateLoadResult extends LoadResult {
  /** The VP## or HV## code for the geographic-unit aggregate row in this table */
  unit_code: string;
  /** @deprecated Use unit_code instead */
  vaalipiiri_code: string;
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

  type FilterItem = { code: string; selection: { filter: 'item' | 'all'; values: string[] } };
  const filters: FilterItem[] = [];

  // Year filter (all multi-year tables have a Vuosi variable)
  if (metadata.variables.some((v) => v.code === 'Vuosi')) {
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
  const cacheKey = `data:${tableId}:${electionType}:${year}:${areaId ?? 'all'}`;

  const { value: response, cache_hit } = await withCache(cacheKey, () =>
    pxwebClient.queryTable(dbPath, tableId, query)
  );

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

  return { rows, tableId, cache_hit, unit_code, vaalipiiri_code: unit_code };
}

export type { ElectionRecord };
