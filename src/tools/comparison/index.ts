/**
 * Comparison tools — Phase C3
 *
 * compare_across_dimensions: cross-election/cross-area/cross-subject comparisons
 *   with pp-change computation between same-type elections.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { queryElectionData } from '../../data/query-engine.js';
import type { ElectionRecord, ElectionType, AreaLevel } from '../../data/types.js';

// ─── PP-change helper ─────────────────────────────────────────────────────────

/**
 * Given a sorted list of (election_type, year, vote_share_pct) entries for one
 * subject×area series, compute pp_change for each row.
 *
 * PP-change rules:
 * - Only between consecutive elections of the SAME type (sorted by year).
 * - Cross-type transitions → pp_change = null.
 * - First occurrence of any type → pp_change = null.
 */
function attachPpChanges(
  rows: Array<{ election_type: string; year: number; vote_share_pct: number | null }>
): Array<{ election_type: string; year: number; vote_share_pct: number | null; pp_change: number | null }> {
  // Track last seen vote_share_pct per election_type
  const lastShareByType = new Map<string, number | null>();

  return rows.map((row) => {
    const prev = lastShareByType.get(row.election_type);
    let pp_change: number | null = null;
    if (prev !== undefined && prev !== null && row.vote_share_pct !== null) {
      pp_change = Math.round((row.vote_share_pct - prev) * 100) / 100;
    }
    lastShareByType.set(row.election_type, row.vote_share_pct);
    return { ...row, pp_change };
  });
}

// ─── Table builders ───────────────────────────────────────────────────────────

type ElectionSpec = { election_type: ElectionType; year: number };
type AreaCell = { votes: number; vote_share_pct: number | null; pp_change: number | null };
type ElectionRow = {
  election_type: string;
  year: number;
  label: string;
  areas: Record<string, AreaCell>;
  national?: AreaCell;
};

/**
 * Build a vary='election' table: rows = elections (sorted by type then year),
 * columns = areas. PP-change computed per type.
 */
function buildElectionTable(
  rows: ElectionRecord[],
  elections: ElectionSpec[],
  subjectId: string,
  subjectType: 'party' | 'candidate'
): { table: ElectionRow[]; areas_found: string[] } {
  // Index: key = `${election_type}::${year}::${area_id}` → {votes, vote_share}
  const index = new Map<string, { votes: number; share: number | null }>();
  for (const row of rows) {
    const sid = subjectType === 'party' ? row.party_id : row.candidate_id;
    if (sid !== subjectId) continue;
    const key = `${row.election_type}::${row.year}::${row.area_id}`;
    index.set(key, { votes: row.votes, share: row.vote_share ?? null });
  }

  // Collect all unique area_ids found (excluding koko_suomi)
  const areaSet = new Set<string>();
  for (const row of rows) {
    if (row.area_level !== 'koko_suomi') areaSet.add(row.area_id);
  }
  const areas_found = [...areaSet].sort();

  // Build rows in the user-specified election order
  // Group by type for pp-change: track last share per (subjectId, area_id, election_type)
  const lastShareByTypeArea = new Map<string, number | null>();

  const table: ElectionRow[] = elections.map((spec) => {
    const label = `${spec.election_type} ${spec.year}`;
    const areaMap: Record<string, AreaCell> = {};

    for (const areaId of areas_found) {
      const key = `${spec.election_type}::${spec.year}::${areaId}`;
      const cell = index.get(key);
      const lastKey = `${spec.election_type}::${areaId}`;
      const prevShare = lastShareByTypeArea.get(lastKey);

      let pp_change: number | null = null;
      if (cell && prevShare !== undefined && prevShare !== null && cell.share !== null) {
        pp_change = Math.round((cell.share - prevShare) * 100) / 100;
      }
      if (cell) {
        lastShareByTypeArea.set(lastKey, cell.share);
        areaMap[areaId] = { votes: cell.votes, vote_share_pct: cell.share, pp_change };
      }
      // If cell is absent (election had no data for this area), omit from output.
    }

    // National total (koko_suomi)
    const natKey = `${spec.election_type}::${spec.year}::SSS`;
    const natCell = index.get(natKey);
    const natLastKey = `${spec.election_type}::SSS`;
    const prevNatShare = lastShareByTypeArea.get(natLastKey);
    let natPpChange: number | null = null;
    if (natCell && prevNatShare !== undefined && prevNatShare !== null && natCell.share !== null) {
      natPpChange = Math.round((natCell.share - prevNatShare) * 100) / 100;
    }
    if (natCell) lastShareByTypeArea.set(natLastKey, natCell.share);

    const electionRow: ElectionRow = { election_type: spec.election_type, year: spec.year, label, areas: areaMap };
    if (natCell) electionRow.national = { votes: natCell.votes, vote_share_pct: natCell.share, pp_change: natPpChange };
    return electionRow;
  });

  return { table, areas_found };
}

/**
 * Build a vary='subject' table: rows = subjects, with nested areas.
 * PP-change computed per subject per area within the same election type.
 */
function buildSubjectTable(
  rows: ElectionRecord[],
  elections: ElectionSpec[],
  subjectIds: string[],
  subjectType: 'party' | 'candidate'
): object[] {
  // For each subject, build an election-pivoted view
  return subjectIds.map((subjectId) => {
    const subjectRows = rows.filter((r) => {
      const sid = subjectType === 'party' ? r.party_id : r.candidate_id;
      return sid === subjectId;
    });
    const subjectName = subjectType === 'party'
      ? (subjectRows[0]?.party_name ?? subjectId)
      : (subjectRows[0]?.candidate_name ?? subjectId);

    const { table } = buildElectionTable(subjectRows, elections, subjectId, subjectType);
    return { subject_id: subjectId, subject_name: subjectName, elections: table };
  });
}

// ─── Tool registration ────────────────────────────────────────────────────────

export function registerComparisonTools(server: McpServer): void {

  // ── compare_across_dimensions ──────────────────────────────────────────────
  server.tool(
    'compare_across_dimensions',
    'Compare a party or candidate across elections, areas, or subjects. ' +
    'Returns a structured table with pp-change (percentage-point change) computed between ' +
    'consecutive elections of the same type. ' +
    '\n\nvary="election": rows=elections, columns=areas. Best for "how did VIHR do across elections in Pirkanmaa?". ' +
    'vary="subject": rows=subjects, columns=elections. Best for "compare VIHR vs SDP across elections". ' +
    '\n\nPP-change rule: computed only between same election_type pairs sorted by year. ' +
    'E.g. parliamentary:2019→2023 and municipal:2021→2025 are computed independently; ' +
    'no cross-type pp-change (parliamentary→municipal) is ever computed.',
    {
      subject_type: z.enum(['party', 'candidate']).describe('Type of subject to compare.'),
      subject_ids: z.array(z.string()).describe(
        'One or more party/candidate codes (PxWeb codes). ' +
        'For vary="election": typically one subject (e.g. ["VIHR"]). ' +
        'For vary="subject": two or more subjects (e.g. ["VIHR", "SDP", "VAS"]). ' +
        'Use resolve_party or resolve_candidate first to get correct codes.'
      ),
      elections: z.array(z.object({
        election_type: z.enum(['parliamentary', 'municipal', 'eu_parliament', 'presidential', 'regional']),
        year: z.number(),
      })).describe(
        'List of elections to include. Order determines table row order. ' +
        'Example: [{"election_type":"parliamentary","year":2019},{"election_type":"parliamentary","year":2023}]'
      ),
      vary: z.enum(['election', 'subject']).describe(
        'What changes between rows. ' +
        '"election": rows=elections, columns=areas. Use when comparing one subject over time. ' +
        '"subject": rows=subjects, columns=elections. Use when comparing multiple parties/candidates.'
      ),
      area_level: z.enum(['koko_suomi', 'vaalipiiri', 'kunta', 'aanestysalue', 'hyvinvointialue']).describe(
        'Geographic granularity. Required. ' +
        'vaalipiiri is most common for cross-election comparisons. ' +
        'koko_suomi for national totals only.'
      ),
      area_ids: z.array(z.string()).optional().describe(
        'Filter to specific area codes. Omit for all areas at the requested level. ' +
        'Example: ["VP01","VP06"] for Helsinki and Pirkanmaa vaalipiiri.'
      ),
      output_mode: z.enum(['rows', 'analysis']).optional().describe(
        'rows = raw ElectionRecord rows. analysis = structured table with pp-changes (default: analysis).'
      ),
    },
    async ({ subject_type, subject_ids, elections, vary, area_level, area_ids, output_mode }) => {
      try {
        // Deduplicate elections for the query engine
        const uniqueTypes = [...new Set(elections.map((e) => e.election_type))];
        const uniqueYears = [...new Set(elections.map((e) => e.year))];
        const electionSpecs = elections as ElectionSpec[];

        const result = await queryElectionData({
          subject_type,
          subject_ids,
          election_types: uniqueTypes,
          years: uniqueYears,
          area_level: area_level as AreaLevel,
          area_ids,
        });

        const allRows = result.rows;

        const mode = output_mode ?? 'analysis';
        const source = {
          table_ids: result.table_ids,
          query_timestamp: new Date().toISOString(),
          skipped_elections: result.skipped_elections,
        };

        if (mode === 'rows') {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ mode: 'rows', rows: allRows, source }, null, 2) }],
          };
        }

        // Analysis mode — build table based on `vary`
        let tableData: unknown;

        if (vary === 'election') {
          if (subject_ids.length !== 1) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({
                error: 'vary="election" requires exactly one subject_id. ' +
                       'For multiple subjects, use vary="subject".',
              }) }],
            };
          }
          const subjectId = subject_ids[0]!;
          const { table, areas_found } = buildElectionTable(allRows, electionSpecs, subjectId, subject_type);
          const subjectName = subject_type === 'party'
            ? (allRows.find((r) => r.party_id === subjectId)?.party_name ?? subjectId)
            : (allRows.find((r) => r.candidate_id === subjectId)?.candidate_name ?? subjectId);

          tableData = {
            mode: 'analysis',
            subject: { type: subject_type, id: subjectId, name: subjectName },
            vary: 'election',
            area_level,
            areas_included: areas_found,
            table,
            method: {
              description: 'Each row is one election. vote_share_pct from Tilastokeskus official figures. ' +
                           'pp_change = current - previous same-type election (null if no prior of same type).',
              pp_change_rule: 'Computed only between same election_type, sorted by year in your elections list. ' +
                              'Cross-type pp-changes (parliamentary→municipal) are never computed.',
            },
            source,
          };

        } else { // vary === 'subject'
          const subjectTable = buildSubjectTable(allRows, electionSpecs, subject_ids, subject_type);

          tableData = {
            mode: 'analysis',
            vary: 'subject',
            area_level,
            elections: elections.map((e) => `${e.election_type} ${e.year}`),
            table: subjectTable,
            method: {
              description: 'Each row is one subject (party or candidate). ' +
                           'Nested election rows show vote_share_pct and pp_change within each subject.',
            },
            source,
          };
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(tableData, null, 2) }],
        };

      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }] };
      }
    }
  );

}
