/**
 * query_election_data — unified query engine
 *
 * Phase C2 — core flexible tool that subsumes get_party_results and
 * get_candidate_results. Supports any combination of:
 *   - subject_type: 'party' | 'candidate'
 *   - election_types: any subset of the five Finnish election types
 *   - years: one or more election years
 *   - area_level: any geographic granularity
 *   - subject_ids / area_ids: optional filters
 *
 * Candidate routing by election type:
 *   parliamentary / municipal / regional:
 *     Fan-out to per-unit tables (vaalipiiri / hyvinvointialue).
 *     Optimization: if area_ids are all VP## codes, only load matching units.
 *   eu_parliament:
 *     vaalipiiri / koko_suomi → 14gx (candidate_by_vaalipiiri)
 *     aanestysalue → 14gw (candidate_by_aanestysalue_eu), requires subject_ids
 *     kunta → error (requires Phase D3 aggregation, not yet implemented)
 *   presidential:
 *     All area levels in one table (14d5). Filter after load.
 */

import { getElectionTables } from './election-tables.js';
import {
  loadPartyResults,
  loadCandidateResults,
  loadEUCandidateByVaalipiiri,
  loadEUCandidateByAanestysalue,
} from './loaders.js';
import { VAALIPIIRI_PREFIX_MAP } from './area-hierarchy.js';
import type { ElectionRecord, ElectionType, AreaLevel } from './types.js';

export interface QueryElectionDataParams {
  subject_type: 'candidate' | 'party';
  /** Filter to specific candidate or party IDs (PxWeb codes). Empty = all. */
  subject_ids?: string[];
  election_types: ElectionType[];
  years: number[];
  area_level: AreaLevel;
  /** Filter to specific area_id codes. Empty = all. */
  area_ids?: string[];
  /** Presidential round: 1 = first round, 2 = runoff. Undefined = all rounds. */
  round?: number;
}

export interface QueryElectionDataResult {
  rows: ElectionRecord[];
  table_ids: string[];
  /** Number of elections (type × year combinations) that had no data and were skipped. */
  skipped_elections: string[];
}

// ─── Party fetcher ─────────────────────────────────────────────────────────────

async function fetchPartyRows(
  year: number,
  electionType: ElectionType,
  area_level: AreaLevel,
  subject_ids?: string[],
  area_ids?: string[],
): Promise<{ rows: ElectionRecord[]; table_id: string; error?: string }> {
  try {
    const { rows: allRows, tableId } = await loadPartyResults(year, undefined, electionType);

    let rows = allRows.filter((r) => r.area_level === area_level);
    if (subject_ids?.length) rows = rows.filter((r) => subject_ids.includes(r.party_id!));
    if (area_ids?.length)    rows = rows.filter((r) => area_ids.includes(r.area_id));

    return { rows, table_id: tableId };
  } catch (err) {
    return { rows: [], table_id: '', error: String(err) };
  }
}

// ─── Candidate fetcher ─────────────────────────────────────────────────────────

async function fetchCandidateRows(
  year: number,
  electionType: ElectionType,
  area_level: AreaLevel,
  subject_ids?: string[],
  area_ids?: string[],
  round?: number,
): Promise<{ rows: ElectionRecord[]; table_ids: string[]; error?: string }> {
  try {
    // ── EU parliament ──────────────────────────────────────────────────────────
    if (electionType === 'eu_parliament') {
      if (area_level === 'vaalipiiri' || area_level === 'koko_suomi') {
        // 14gx: all candidates × 14 vaalipiiri + national (~3500 cells)
        const singleId = subject_ids?.length === 1 ? subject_ids[0] : undefined;
        const result = await loadEUCandidateByVaalipiiri(year, singleId);
        let rows = result.rows.filter((r) => r.area_level === area_level);
        if (subject_ids && subject_ids.length > 1) rows = rows.filter((r) => subject_ids.includes(r.candidate_id!));
        if (area_ids?.length) rows = rows.filter((r) => area_ids.includes(r.area_id));
        return { rows, table_ids: [result.tableId] };

      } else if (area_level === 'aanestysalue') {
        // 14gw: requires candidate_id (247 candidates × 2079 areas = cell limit exceeded)
        if (!subject_ids?.length) {
          return {
            rows: [],
            table_ids: [],
            error: 'candidate_id required for EU parliament äänestysalue-level queries. ' +
                   'Specify subject_ids with at least one candidate code, or use area_level="vaalipiiri".',
          };
        }
        const results = await Promise.allSettled(
          subject_ids.map((cid) => loadEUCandidateByAanestysalue(year, cid))
        );
        const rows: ElectionRecord[] = [];
        const table_ids: string[] = [];
        for (const r of results) {
          if (r.status === 'fulfilled') {
            let unitRows = r.value.rows;
            if (area_ids?.length) unitRows = unitRows.filter((row) => area_ids.includes(row.area_id));
            rows.push(...unitRows);
            if (!table_ids.includes(r.value.tableId)) table_ids.push(r.value.tableId);
          }
        }
        return { rows, table_ids };

      } else if (area_level === 'kunta') {
        return {
          rows: [],
          table_ids: [],
          error: 'EU parliament candidate data at kunta level requires aggregation ' +
                 '(Phase D3, not yet implemented). Use area_level="vaalipiiri" or "aanestysalue" instead.',
        };
      } else {
        return {
          rows: [],
          table_ids: [],
          error: `area_level '${area_level}' is not supported for EU parliament candidate queries.`,
        };
      }
    }

    // ── Presidential ──────────────────────────────────────────────────────────
    if (electionType === 'presidential') {
      // 14d5 has all area levels (national + vaalipiiri + kunta + äänestysalue)
      const { rows: allRows, tableId } = await loadCandidateResults(
        year, 'national', undefined, 'presidential', round
      );
      let rows = allRows.filter((r) => r.area_level === area_level);
      if (subject_ids?.length) rows = rows.filter((r) => subject_ids.includes(r.candidate_id!));
      if (area_ids?.length)    rows = rows.filter((r) => area_ids.includes(r.area_id));
      return { rows, table_ids: [tableId] };
    }

    // ── Parliamentary / municipal / regional (per-unit tables) ────────────────
    const tables = getElectionTables(electionType, year);
    if (!tables?.candidate_by_aanestysalue) {
      return {
        rows: [],
        table_ids: [],
        error: `No candidate tables for ${electionType} ${year}`,
      };
    }

    const allUnitKeys = Object.keys(tables.candidate_by_aanestysalue);

    // Optimization: if area_ids are all VP## codes, only load the matching units.
    // For KU### or äänestysalue codes we must load all units (can't pre-filter).
    let unitKeys = allUnitKeys;
    if (area_ids?.length && area_ids.every((id) => id.startsWith('VP'))) {
      const mappedKeys = area_ids
        .map((id) => VAALIPIIRI_PREFIX_MAP[id.slice(2)])
        .filter((key): key is string => key !== undefined && allUnitKeys.includes(key));
      if (mappedKeys.length > 0) unitKeys = [...new Set(mappedKeys)];
    }

    // Fan-out to all relevant unit tables in parallel.
    // Load all candidates (no PxWeb-side filter) — results are filtered client-side.
    // Cache hits make subsequent calls cheap; first call for a unit takes one API call.
    const results = await Promise.allSettled(
      unitKeys.map((unitKey) => loadCandidateResults(year, unitKey, undefined, electionType))
    );

    const rows: ElectionRecord[] = [];
    const table_ids: string[] = [];
    for (const r of results) {
      if (r.status === 'rejected') continue; // skip missing/error units silently
      let unitRows = r.value.rows.filter((row) => row.area_level === area_level);
      if (subject_ids?.length) unitRows = unitRows.filter((row) => subject_ids.includes(row.candidate_id!));
      if (area_ids?.length)    unitRows = unitRows.filter((row) => area_ids.includes(row.area_id));
      rows.push(...unitRows);
      if (!table_ids.includes(r.value.tableId)) table_ids.push(r.value.tableId);
    }
    return { rows, table_ids };

  } catch (err) {
    return { rows: [], table_ids: [], error: String(err) };
  }
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Unified query engine — fetch election data across any combination of
 * election types, years, and area levels.
 *
 * All fetches run in parallel (one per election_type × year combination).
 * Results are merged into a single flat row list.
 */
export async function queryElectionData(
  params: QueryElectionDataParams
): Promise<QueryElectionDataResult> {
  const combinations = params.election_types.flatMap((et) =>
    params.years.map((y) => ({ election_type: et, year: y }))
  );

  const settled = await Promise.allSettled(
    combinations.map(({ election_type, year }) => {
      if (params.subject_type === 'party') {
        return fetchPartyRows(year, election_type, params.area_level, params.subject_ids, params.area_ids)
          .then((r) => ({ ...r, election_type, year }));
      } else {
        return fetchCandidateRows(year, election_type, params.area_level, params.subject_ids, params.area_ids, params.round)
          .then((r) => ({ ...r, election_type, year }));
      }
    })
  );

  const allRows: ElectionRecord[] = [];
  const allTableIds = new Set<string>();
  const skipped: string[] = [];

  for (let i = 0; i < settled.length; i++) {
    const combo = combinations[i]!;
    const label = `${combo.election_type}:${combo.year}`;
    const result = settled[i]!;

    if (result.status === 'rejected') {
      skipped.push(`${label}: ${String(result.reason)}`);
      continue;
    }

    const { rows, error } = result.value;
    const tableIds = 'table_id' in result.value
      ? [result.value.table_id as string]
      : (result.value as { table_ids: string[] }).table_ids;

    if (error) {
      skipped.push(`${label}: ${error}`);
      continue;
    }

    allRows.push(...rows);
    for (const tid of tableIds) if (tid) allTableIds.add(tid);
  }

  return {
    rows: allRows,
    table_ids: [...allTableIds],
    skipped_elections: skipped,
  };
}
