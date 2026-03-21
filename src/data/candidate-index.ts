/**
 * Candidate lookup helpers — shared by entity-resolution and trajectory tools.
 *
 * Loads candidate name lists from metadata (no vote data) so callers can
 * fuzzy-match a query name to a candidate_id before fetching actual results.
 */

import { getElectionTables, getDatabasePath } from './election-tables.js';
import { fetchMetadataCached } from './loaders.js';
import type { ElectionType } from './types.js';

export interface CandidateEntry {
  candidate_id: string;
  candidate_name: string;
  party: string;
  /** Human-readable unit name (vaalipiiri or hyvinvointialue name, or 'national') */
  vaalipiiri_name: string;
  /** Unit key used in candidate_by_aanestysalue map, or 'national' */
  vaalipiiri_key: string;
  table_id: string;
}

/** Load candidates from a per-unit table (parliamentary/municipal/regional). */
export async function getCandidateListForUnit(
  year: number,
  unitKey: string,
  electionType: ElectionType
): Promise<CandidateEntry[]> {
  const tables = getElectionTables(electionType, year);
  if (!tables?.candidate_by_aanestysalue) {
    throw new Error(`No per-unit candidate tables for ${electionType} ${year}`);
  }
  const tableId = tables.candidate_by_aanestysalue[unitKey];
  if (!tableId) {
    const validKeys = Object.keys(tables.candidate_by_aanestysalue).join(', ');
    throw new Error(`No candidate table for unit '${unitKey}' in ${electionType} ${year}. Valid unit keys: ${validKeys}`);
  }
  const dbPath = getDatabasePath(tables);
  const metadata = await fetchMetadataCached(dbPath, tableId);
  const candidateVar = metadata.variables.find((v) => v.code === 'Ehdokas');
  if (!candidateVar) throw new Error('Ehdokas variable not found in candidate table metadata');

  return candidateVar.values.map((code, i) => {
    const text = candidateVar.valueTexts[i] ?? code;
    const parts = text.split(' / ');
    return {
      candidate_id: code,
      candidate_name: parts[0]?.trim() ?? text,
      party: parts[1]?.trim() ?? '',
      vaalipiiri_name: parts[2]?.trim() ?? unitKey,
      vaalipiiri_key: unitKey,
      table_id: tableId,
    };
  });
}

/**
 * Load candidates from the national table (EU parliament and presidential).
 * EU: uses candidate_national (14gy). Presidential: 14d5.
 */
export async function getCandidatesFromNationalTable(
  year: number,
  electionType: ElectionType
): Promise<CandidateEntry[]> {
  const tables = getElectionTables(electionType, year);
  if (!tables?.candidate_national) {
    throw new Error(`No national candidate table for ${electionType} ${year}`);
  }
  const tableId = tables.candidate_national;
  const dbPath = getDatabasePath(tables);
  const metadata = await fetchMetadataCached(dbPath, tableId);
  const candidateVar = metadata.variables.find((v) => v.code === 'Ehdokas');
  if (!candidateVar) throw new Error('Ehdokas variable not found in national candidate table');

  const SKIP_CODES = new Set(['00', '11']);
  const entries: CandidateEntry[] = [];
  candidateVar.values.forEach((code, i) => {
    if (SKIP_CODES.has(code)) return;
    const text = candidateVar.valueTexts[i] ?? code;
    const parts = text.split(' / ');
    entries.push({
      candidate_id: code,
      candidate_name: parts[0]?.trim() ?? text,
      party: parts[1]?.trim() ?? '',
      vaalipiiri_name: 'national',
      vaalipiiri_key: 'national',
      table_id: tableId,
    });
  });
  return entries;
}

/**
 * Load all candidates for any election type.
 * EU/presidential: fetches from single national table.
 * Parliamentary/municipal/regional: fans out to all unit tables in parallel.
 */
export async function getCandidatesAllUnits(
  year: number,
  electionType: ElectionType
): Promise<CandidateEntry[]> {
  if (electionType === 'eu_parliament' || electionType === 'presidential') {
    return getCandidatesFromNationalTable(year, electionType);
  }
  const tables = getElectionTables(electionType, year);
  if (!tables?.candidate_by_aanestysalue) {
    throw new Error(`No candidate tables for ${electionType} ${year}`);
  }
  const keys = Object.keys(tables.candidate_by_aanestysalue);
  const results = await Promise.all(keys.map((k) => getCandidateListForUnit(year, k, electionType)));
  return results.flat();
}
