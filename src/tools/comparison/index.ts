/**
 * Comparison tools — Phase C3 + C5
 *
 * compare_across_dimensions: cross-election/cross-area/cross-subject comparisons
 *   with pp-change computation between same-type elections.
 *
 * get_candidate_trajectory: cross-election candidate tracking via fuzzy name matching.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { queryElectionData } from '../../data/query-engine.js';
import { getCandidatesAllUnits, type CandidateEntry } from '../../data/candidate-index.js';
import { normalizeStr, buildBigrams, scoreMatchFast, confidenceLabel } from '../../utils/fuzzy-match.js';
import type { ElectionRecord, ElectionType, AreaLevel } from '../../data/types.js';

// ─── Candidate years with data ─────────────────────────────────────────────────

const CANDIDATE_YEARS_BY_TYPE: Record<ElectionType, number[]> = {
  parliamentary:  [2007, 2011, 2015, 2019, 2023],
  municipal:      [2021, 2025],
  regional:       [2025],
  eu_parliament:  [2019, 2024],
  presidential:   [2024],
};

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
        year: z.coerce.number(),
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

  // ── get_candidate_trajectory ────────────────────────────────────────────
  server.tool(
    'get_candidate_trajectory',
    'Find all elections a candidate has appeared in and return their results as a timeline. ' +
    'Uses fuzzy name matching across election-specific candidate tables — candidate IDs are reissued ' +
    'each election so cross-election identity relies on name matching. ' +
    '\n\nFor "which elections did X run in" questions: pass all 5 election types — results are cached, so ' +
    'the first call is slow (~30s) but subsequent calls are instant. ' +
    'Only narrow election_types when you already know the candidate is exclusively parliamentary or EU etc. ' +
    '\n\nMatching rules: score ≥ 0.95 = confirmed (included automatically). ' +
    'score 0.55–0.95 = ambiguous (returned with flag for LLM review, not included in results). ' +
    'score < 0.55 = not found.',
    {
      query: z.string().describe(
        'Candidate name to search for (fuzzy matched). ' +
        'Use the Finnish name format: "Harjanne Atte" or "Atte Harjanne" both work. ' +
        'Or pass a candidate_id (numeric string) for exact lookup.'
      ),
      election_types: z.array(
        z.enum(['parliamentary', 'municipal', 'eu_parliament', 'presidential', 'regional'])
      ).min(1).describe(
        'Election types to search. Required — must be specified explicitly. ' +
        'For "which elections did X run in" questions: pass all 5 types ' +
        '["parliamentary","municipal","regional","eu_parliament","presidential"]. ' +
        'Available candidate data: parliamentary 2007/2011/2015/2019/2023, ' +
        'municipal 2021/2025, regional 2025, eu_parliament 2019/2024, presidential 2024.'
      ),
      years: z.array(z.coerce.number()).optional().describe(
        'Optional year filter. If omitted, searches all years with candidate data for each type. ' +
        'Example: [2023, 2024] to limit to recent elections only.'
      ),
      area_level: z.enum(['koko_suomi', 'vaalipiiri', 'kunta', 'aanestysalue', 'hyvinvointialue']).describe(
        'Geographic level to return results at. ' +
        'vaalipiiri is the most useful for parliamentary/municipal trajectory analysis. ' +
        'koko_suomi for national totals only (presidential/EU). Required.'
      ),
      include_party_context: z.boolean().optional().describe(
        'If true, also include how the candidate\'s party performed in the same areas and elections. ' +
        'Adds one extra queryElectionData call per confirmed election. Default: false.'
      ),
    },
    async ({ query, election_types, years, area_level, include_party_context }) => {
      try {
        // Pre-compute query normalizations for fast matching
        const qLow = query.toLowerCase().trim();
        const qNorm = normalizeStr(query);
        const qBigrams = buildBigrams(qNorm);
        const isIdQuery = /^\d+$/.test(query.trim());

        // Build list of (election_type, year) combos to search
        const combos: Array<{ election_type: ElectionType; year: number }> = [];
        for (const elType of election_types) {
          const defaultYears = CANDIDATE_YEARS_BY_TYPE[elType];
          const targetYears = years
            ? years.filter((y) => defaultYears.includes(y))
            : defaultYears;
          for (const year of targetYears) {
            combos.push({ election_type: elType as ElectionType, year });
          }
        }

        if (combos.length === 0) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              error: 'No valid (election_type, year) combinations. ' +
                     'Check that the years filter overlaps with years that have candidate data.',
            }) }],
          };
        }

        // Step 1: Load candidate lists and fuzzy match — all combos in parallel
        type MatchResult = {
          election_type: ElectionType;
          year: number;
          confirmed: CandidateEntry[];           // score >= 0.95
          ambiguous: Array<{ entry: CandidateEntry; score: number }>; // 0.55–0.95
          load_error?: string;
        };

        const matchResults: MatchResult[] = await Promise.all(
          combos.map(async ({ election_type, year }) => {
            try {
              const candidates = await getCandidatesAllUnits(year, election_type);
              const confirmed: CandidateEntry[] = [];
              const ambiguous: Array<{ entry: CandidateEntry; score: number }> = [];

              for (const c of candidates) {
                let score: number;
                if (isIdQuery) {
                  // Exact ID match
                  score = c.candidate_id === query.trim() ? 1.0 : 0;
                } else {
                  const cLow = c.candidate_name.toLowerCase().trim();
                  const cNorm = normalizeStr(c.candidate_name);
                  score = scoreMatchFast(qLow, qNorm, qBigrams, cLow, cNorm);
                }

                if (score >= 0.95) {
                  confirmed.push(c);
                } else if (score >= 0.55) {
                  ambiguous.push({ entry: c, score });
                }
              }

              // Keep top 3 ambiguous by score
              ambiguous.sort((a, b) => b.score - a.score);
              return { election_type, year, confirmed, ambiguous: ambiguous.slice(0, 3) };
            } catch (err) {
              return {
                election_type,
                year,
                confirmed: [],
                ambiguous: [],
                load_error: err instanceof Error ? err.message : String(err),
              };
            }
          })
        );

        // Step 2: For confirmed matches, fetch results via queryElectionData
        // Run in parallel, one call per (election_type, year, candidate_id)
        type TrajectoryEntry = {
          election_type: ElectionType;
          year: number;
          candidate_id: string;
          candidate_name: string;
          party: string;
          vaalipiiri_key: string;
          match_confidence: 'exact' | 'high' | 'medium' | 'low';
          results: ElectionRecord[];
          party_context?: ElectionRecord[];
        };

        const trajectoryPromises: Array<Promise<TrajectoryEntry>> = [];

        for (const mr of matchResults) {
          for (const c of mr.confirmed) {
            trajectoryPromises.push((async () => {
              const resultData = await queryElectionData({
                subject_type: 'candidate',
                subject_ids: [c.candidate_id],
                election_types: [mr.election_type],
                years: [mr.year],
                area_level: area_level as AreaLevel,
              });

              let partyCtx: ElectionRecord[] | undefined;
              if (include_party_context && c.party) {
                try {
                  const partyData = await queryElectionData({
                    subject_type: 'party',
                    subject_ids: [c.party],
                    election_types: [mr.election_type],
                    years: [mr.year],
                    area_level: area_level as AreaLevel,
                  });
                  partyCtx = partyData.rows;
                } catch {
                  // Party context is best-effort
                }
              }

              const confidence = confidenceLabel(
                isIdQuery ? 1.0
                  : scoreMatchFast(
                      qLow, qNorm, qBigrams,
                      c.candidate_name.toLowerCase().trim(),
                      normalizeStr(c.candidate_name)
                    )
              );

              return {
                election_type: mr.election_type,
                year: mr.year,
                candidate_id: c.candidate_id,
                candidate_name: c.candidate_name,
                party: c.party,
                vaalipiiri_key: c.vaalipiiri_key,
                match_confidence: confidence,
                results: resultData.rows,
                ...(partyCtx ? { party_context: partyCtx } : {}),
              };
            })());
          }
        }

        const trajectoryEntries = await Promise.all(trajectoryPromises);

        // Sort timeline: election_type alphabetically then year ascending
        trajectoryEntries.sort((a, b) => {
          if (a.election_type !== b.election_type) return a.election_type.localeCompare(b.election_type);
          return a.year - b.year;
        });

        // Build not-found and ambiguous summaries
        const not_found = matchResults
          .filter((mr) => mr.confirmed.length === 0 && mr.ambiguous.length === 0 && !mr.load_error)
          .map(({ election_type, year }) => ({ election_type, year, reason: 'no match above threshold' }));

        const load_errors = matchResults
          .filter((mr) => mr.load_error)
          .map(({ election_type, year, load_error }) => ({ election_type, year, error: load_error }));

        const ambiguous_matches = matchResults
          .filter((mr) => mr.confirmed.length === 0 && mr.ambiguous.length > 0)
          .map(({ election_type, year, ambiguous }) => ({
            election_type,
            year,
            candidates: ambiguous.map((a) => ({
              candidate_id: a.entry.candidate_id,
              candidate_name: a.entry.candidate_name,
              party: a.entry.party,
              vaalipiiri_key: a.entry.vaalipiiri_key,
              match_score: Math.round(a.score * 100) / 100,
              match_confidence: confidenceLabel(a.score),
            })),
          }));

        const output = {
          query,
          elections_searched: combos.length,
          elections_found: trajectoryEntries.length,
          area_level,
          trajectory: trajectoryEntries.map((t) => ({
            election_type: t.election_type,
            year: t.year,
            candidate_id: t.candidate_id,
            candidate_name: t.candidate_name,
            party: t.party,
            vaalipiiri_key: t.vaalipiiri_key,
            match_confidence: t.match_confidence,
            results: t.results,
            ...(t.party_context ? { party_context: t.party_context } : {}),
          })),
          ...(not_found.length > 0 ? { not_found } : {}),
          ...(ambiguous_matches.length > 0 ? { ambiguous_matches } : {}),
          ...(load_errors.length > 0 ? { load_errors } : {}),
          method: {
            matching: 'Dice-coefficient bigram similarity on normalized names. ' +
                      'score ≥ 0.95 = confirmed; 0.55–0.95 = ambiguous (not included in trajectory); < 0.55 = not found.',
            identity: 'Candidate IDs are reissued each election — cross-election identity via name match only.',
            rate_limit_note: 'Parliamentary searches fan out to 13 vaalipiiri tables per year (cached after first call).',
          },
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
        };

      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }] };
      }
    }
  );

}
