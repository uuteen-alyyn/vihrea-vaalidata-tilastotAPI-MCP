/**
 * Shared data-loading helpers for analytics and retrieval tools.
 * Each function fetches from the PxWeb API (with caching) and returns
 * normalized ElectionRecord arrays.
 */

import { pxwebClient } from '../api/pxweb-client.js';
import { withCache } from '../cache/cache.js';
import { normalizePartyByKunta, normalizeCandidateByAanestysalue } from './normalizer.js';
import { getElectionTables, getDatabasePath, PARLIAMENTARY_TABLES } from './election-tables.js';
import type { ElectionRecord } from './types.js';
import type { PxWebTableMetadata } from '../api/types.js';

export interface LoadResult {
  rows: ElectionRecord[];
  tableId: string;
  cache_hit: boolean;
}

export interface CandidateLoadResult extends LoadResult {
  /** The VP## code for the vaalipiiri aggregate row in this table */
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

/**
 * Load all party results from 13sw for a given parliamentary election year.
 * If areaId provided, filters to that area; otherwise returns all areas.
 * Always fetches gender-total (Sukupuoli=SSS).
 */
/**
 * Find the election table set that contains a party_by_kunta table.
 * The 13sw table covers all parliamentary elections 1983–2023, so we
 * use the 2023 registry entry even when querying older years.
 */
function findPartyTable(): ReturnType<typeof getElectionTables> {
  return PARLIAMENTARY_TABLES.find((t) => t.party_by_kunta);
}

export async function loadPartyResults(
  year: number,
  areaId?: string
): Promise<LoadResult> {
  // Try exact year first; fall back to any entry with party_by_kunta (13sw covers 1983–2023)
  const tables = getElectionTables('parliamentary', year) ?? findPartyTable();
  if (!tables?.party_by_kunta) throw new Error(`No party table for parliamentary ${year}`);
  const dbPath = getDatabasePath(tables);
  const tableId = tables.party_by_kunta;
  const metadata = await fetchMetadataCached(dbPath, tableId);

  const query = {
    query: [
      { code: 'Vuosi', selection: { filter: 'item' as const, values: [String(year)] } },
      { code: 'Sukupuoli', selection: { filter: 'item' as const, values: ['SSS'] } },
      { code: 'Puolue', selection: { filter: 'all' as const, values: ['*'] } },
      {
        code: 'Vaalipiiri ja kunta vaalivuonna',
        selection: areaId
          ? { filter: 'item' as const, values: [areaId] }
          : { filter: 'all' as const, values: ['*'] },
      },
      { code: 'Tiedot', selection: { filter: 'item' as const, values: ['evaa_aanet', 'evaa_osuus_aanista'] } },
    ],
    response: { format: 'json' as const },
  };

  const { value: response, cache_hit } = await withCache(
    `data:${tableId}:${year}:all:${areaId ?? 'all'}`,
    () => pxwebClient.queryTable(dbPath, tableId, query)
  );

  const rows = normalizePartyByKunta(response, metadata, year);
  return { rows, tableId, cache_hit };
}

/**
 * Load candidate results for a specific vaalipiiri.
 * Returns all candidates × all äänestysalueet (+ kunta + vaalipiiri aggregates).
 * Optionally filters by candidateId.
 */
export async function loadCandidateResults(
  year: number,
  vaalipiiriKey: string,
  candidateId?: string
): Promise<CandidateLoadResult> {
  const tables = getElectionTables('parliamentary', year);
  if (!tables?.candidate_by_aanestysalue) throw new Error(`No candidate tables for parliamentary ${year}`);
  const tableId = tables.candidate_by_aanestysalue[vaalipiiriKey];
  if (!tableId) throw new Error(`Unknown vaalipiiri key: ${vaalipiiriKey}`);
  const dbPath = getDatabasePath(tables);
  const metadata = await fetchMetadataCached(dbPath, tableId);

  // Detect variable names — 2023 active and 2019 archive tables differ
  const areaVarCode = metadata.variables.some((v) => v.code === 'Alue/Äänestysalue')
    ? 'Alue/Äänestysalue'
    : 'Äänestysalue';
  const areaVar = metadata.variables.find((v) => v.code === areaVarCode);
  const vaalipiiri_code = areaVar?.values.find((v) => v.startsWith('VP')) ?? '';

  const tiedotVarCode = metadata.variables.some((v) => v.code === 'Tiedot')
    ? 'Tiedot'
    : 'Äänestystiedot';
  const tiedotVar = metadata.variables.find((v) => v.code === tiedotVarCode);
  const votesCode = tiedotVar?.values.find(
    (_, i) => (tiedotVar.valueTexts[i] ?? '').includes('Äänimäärä')
  ) ?? 'evaa_aanet';
  const shareCode = tiedotVar?.values.find(
    (_, i) => (tiedotVar.valueTexts[i] ?? '').toLowerCase().includes('osuus')
  ) ?? 'evaa_osuus_aanista';

  type FilterItem = { code: string; selection: { filter: 'item' | 'all'; values: string[] } };
  const filters: FilterItem[] = [];
  if (metadata.variables.some((v) => v.code === 'Vuosi')) {
    filters.push({ code: 'Vuosi', selection: { filter: 'item', values: [String(year)] } });
  }
  filters.push({ code: areaVarCode, selection: { filter: 'all', values: ['*'] } });
  filters.push({
    code: 'Ehdokas',
    selection: candidateId
      ? { filter: 'item', values: [candidateId] }
      : { filter: 'all', values: ['*'] },
  });
  if (metadata.variables.some((v) => v.code === 'Valintatieto')) {
    filters.push({ code: 'Valintatieto', selection: { filter: 'item', values: ['SSS'] } });
  }
  filters.push({ code: tiedotVarCode, selection: { filter: 'item', values: [votesCode, shareCode] } });

  const query = { query: filters, response: { format: 'json' as const } };

  const cacheKey = `data:${tableId}:${year}:${candidateId ?? 'all'}:all`;
  const { value: response, cache_hit } = await withCache(cacheKey, () =>
    pxwebClient.queryTable(dbPath, tableId, query)
  );

  const rows = normalizeCandidateByAanestysalue(response, metadata, year);
  return { rows, tableId, cache_hit, vaalipiiri_code };
}

export type { ElectionRecord };
