import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { pxwebClient } from '../../api/pxweb-client.js';
import { withCache } from '../../cache/cache.js';
import {
  normalizePartyByKunta,
  normalizeCandidateByAanestysalue,
} from '../../data/normalizer.js';
import {
  getElectionTables,
  getDatabasePath,
} from '../../data/election-tables.js';
import {
  loadPartyResults,
  loadCandidateResults,
} from '../../data/loaders.js';
import { parseOutputMode } from '../../utils/output-mode.js';
import type { ElectionRecord, ElectionType } from '../../data/types.js';
import type { PxWebTableMetadata } from '../../api/types.js';
import { ELECTION_TYPE_PARAM } from '../shared.js';

// ─── Shared fetch helpers ───────────────────────────────────────────────────

async function fetchTableMetadata(
  database: string,
  tableId: string
): Promise<PxWebTableMetadata> {
  return withCache(`meta:${tableId}`, () =>
    pxwebClient.getTableMetadata(database, tableId)
  ).then((r) => r.value);
}

// ─── Tool registration ──────────────────────────────────────────────────────

export function registerRetrievalTools(server: McpServer): void {

  // ── get_party_results ────────────────────────────────────────────────────
  server.tool(
    'get_party_results',
    'Returns party vote results for any Finnish election type and year. Supports parliamentary (1983–2023), municipal (1976–2025), regional (2022–2025), EU parliament (1996–2024), and presidential (2024).',
    {
      year: z.number().describe('Election year.'),
      election_type: ELECTION_TYPE_PARAM,
      area_id: z.string().optional().describe(
        'Area code to filter to. Omit for all areas. ' +
        'Parliamentary/municipal: 6-digit (e.g. "010091" for Helsinki kunta, "SSS" for national). ' +
        'Regional: HV##-format (e.g. "HV01"). EU: 5-digit. Presidential: VP##.'
      ),
      output_mode: z.enum(['data', 'analysis']).optional().describe('data = normalized rows, analysis = summary with methodology.'),
    },
    async ({ year, election_type, area_id, output_mode }) => {
      const electionType: ElectionType = election_type ?? 'parliamentary';
      try {
        const { rows, tableId } = await loadPartyResults(year, area_id, electionType);
        const source = { table_ids: [tableId], query_timestamp: new Date().toISOString() };
        const mode = parseOutputMode(output_mode);
        if (mode === 'analysis') return buildPartyAnalysis(rows, year, source);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ mode: 'data', rows, source }, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }] };
      }
    }
  );

  // ── get_candidate_results ────────────────────────────────────────────────
  server.tool(
    'get_candidate_results',
    'Returns candidate vote results for any Finnish election type. ' +
    'Parliamentary/municipal: provide unit_key (vaalipiiri, e.g. "helsinki", "uusimaa"). ' +
    'Regional: provide unit_key (hyvinvointialue, e.g. "pirkanmaa", "varsinais-suomi"). ' +
    'EU/presidential: omit unit_key or pass "national" — single national table is used. ' +
    'Presidential: use round=1 or round=2 to filter by round.',
    {
      year: z.number().describe('Election year.'),
      election_type: ELECTION_TYPE_PARAM,
      unit_key: z.string().optional().describe(
        'Geographic unit key. Parliamentary/municipal: vaalipiiri (e.g. "helsinki", "uusimaa", "pirkanmaa"). ' +
        'Regional: hyvinvointialue (e.g. "varsinais-suomi", "pirkanmaa", "keski-uusimaa"). ' +
        'EU/presidential: omit or pass "national".'
      ),
      candidate_id: z.string().optional().describe('Candidate code to filter to. Omit to get all candidates.'),
      round: z.number().optional().describe('Presidential elections only: 1 = first round, 2 = second round. Omit for all rounds.'),
      output_mode: z.enum(['data', 'analysis']).optional().describe('data = normalized rows, analysis = summary.'),
    },
    async ({ year, election_type, unit_key, candidate_id, round, output_mode }) => {
      const electionType: ElectionType = election_type ?? 'parliamentary';
      try {
        const { rows, tableId } = await loadCandidateResults(
          year, unit_key, candidate_id, electionType, round
        );
        const source = { table_ids: [tableId], query_timestamp: new Date().toISOString() };
        const mode = parseOutputMode(output_mode);
        if (mode === 'analysis') return buildCandidateAnalysis(rows, year, source);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ mode: 'data', rows, source }, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }] };
      }
    }
  );

  // ── get_turnout ──────────────────────────────────────────────────────────
  server.tool(
    'get_turnout',
    'Returns voter turnout statistics for an election.',
    {
      year: z.number().describe('Election year.'),
      election_type: ELECTION_TYPE_PARAM,
      area_id: z.string().optional().describe('Area code to filter to. Omit for all areas.'),
    },
    async ({ year, election_type, area_id }) => {
      const electionType: ElectionType = election_type ?? 'parliamentary';
      const tables = getElectionTables(electionType, year);
      if (!tables?.turnout_by_aanestysalue) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: `No turnout data found for ${electionType} election ${year}.` }),
          }],
        };
      }

      const dbPath = getDatabasePath(tables);
      const tableId = tables.turnout_by_aanestysalue;
      const metadata = await fetchTableMetadata(dbPath, tableId);

      const query = {
        query: [
          { code: 'Vuosi', selection: { filter: 'item' as const, values: [String(year)] } },
          { code: 'Sukupuoli', selection: { filter: 'item' as const, values: ['SSS'] } },
          {
            code: 'Alue',
            selection: area_id
              ? { filter: 'item' as const, values: [area_id] }
              : { filter: 'all' as const, values: ['*'] },
          },
          // Request all Tiedot values to get full turnout picture
          { code: 'Tiedot', selection: { filter: 'all' as const, values: ['*'] } },
        ],
        response: { format: 'json' as const },
      };

      const { value: response } = await withCache(
        `data:${tableId}:${year}:${area_id ?? 'all'}`,
        () => pxwebClient.queryTable(dbPath, tableId, query)
      );

      const source = {
        table_ids: [tableId],
        query_timestamp: new Date().toISOString(),
      };

      // Return raw with column descriptions for turnout (it has many Tiedot measures)
      const tiedotVar = metadata.variables.find((v) => v.code === 'Tiedot');
      const measureDescriptions = Object.fromEntries(
        (tiedotVar?.values ?? []).map((v, i) => [v, tiedotVar?.valueTexts[i] ?? v])
      );

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            mode: 'data',
            measure_descriptions: measureDescriptions,
            columns: response.columns,
            data: response.data.slice(0, 500), // cap for large responses
            source,
          }, null, 2),
        }],
      };
    }
  );

  // ── get_area_results ─────────────────────────────────────────────────────
  server.tool(
    'get_area_results',
    'Returns all party results for a specific geographic area. Optionally also fetches candidate results. Supports all election types.',
    {
      year: z.number().describe('Election year.'),
      election_type: ELECTION_TYPE_PARAM,
      area_id: z.string().describe(
        'Area code. Parliamentary/municipal: 6-digit (e.g. "010091" Helsinki kunta, "010000" VP01 vaalipiiri, "SSS" national). ' +
        'Regional: HV##-format. EU: 5-digit. Municipal: e.g. "011091".'
      ),
      include_candidates: z.boolean().optional().describe('Also fetch candidate results. Requires unit_key.'),
      unit_key: z.string().optional().describe('Unit key for candidate lookup (vaalipiiri/hyvinvointialue). Required when include_candidates=true.'),
      output_mode: z.enum(['data', 'analysis']).optional(),
    },
    async ({ year, election_type, area_id, include_candidates, unit_key, output_mode }) => {
      const electionType: ElectionType = election_type ?? 'parliamentary';
      try {
        const { rows: partyRows, tableId } = await loadPartyResults(year, area_id, electionType);
        const allRows: ElectionRecord[] = [...partyRows];
        const tableIds = [tableId];

        if (include_candidates && unit_key) {
          try {
            const { rows: candRows, tableId: candId } = await loadCandidateResults(year, unit_key, undefined, electionType);
            allRows.push(...candRows.filter(r => r.area_id === area_id || r.area_id.startsWith(area_id)));
            tableIds.push(candId);
          } catch (_) { /* candidates optional */ }
        }

        const source = { table_ids: tableIds, query_timestamp: new Date().toISOString() };
        const mode = parseOutputMode(output_mode);

        if (mode === 'analysis') {
          const parties = partyRows
            .filter(r => r.party_id !== 'SSS')
            .sort((a, b) => b.votes - a.votes)
            .map((r, i) => ({ rank: i + 1, party_id: r.party_id, party_name: r.party_name, votes: r.votes, vote_share: r.vote_share }));
          return { content: [{ type: 'text' as const, text: JSON.stringify({
            mode: 'analysis',
            summary: { year, election_type: electionType, area_id, total_parties: parties.length },
            tables: { party_rankings: parties },
            method: { description: 'All parties in area, sorted by votes descending.', source_table: tableId },
            source,
          }, null, 2) }] };
        }

        return { content: [{ type: 'text' as const, text: JSON.stringify({ mode: 'data', rows: allRows, source }, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }] };
      }
    }
  );

  // ── get_election_results ─────────────────────────────────────────────────
  server.tool(
    'get_election_results',
    'Returns the full party result dataset for an election, optionally filtered to a specific area level. Supports all election types.',
    {
      year: z.number().describe('Election year.'),
      election_type: ELECTION_TYPE_PARAM,
      area_level: z.enum(['kunta', 'vaalipiiri', 'hyvinvointialue', 'koko_suomi']).optional().describe('Filter results to this area level. Omit for all levels.'),
      output_mode: z.enum(['data', 'analysis']).optional(),
    },
    async ({ year, election_type, area_level, output_mode }) => {
      const electionType: ElectionType = election_type ?? 'parliamentary';
      try {
        const { rows: allRows, tableId } = await loadPartyResults(year, undefined, electionType);
        const rows = area_level ? allRows.filter(r => r.area_level === area_level) : allRows;
        const source = { table_ids: [tableId], query_timestamp: new Date().toISOString() };
        const mode = parseOutputMode(output_mode);
        if (mode === 'analysis') return buildPartyAnalysis(rows, year, source);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ mode: 'data', rows, source }, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }] };
      }
    }
  );

  // ── get_rankings ─────────────────────────────────────────────────────────
  server.tool(
    'get_rankings',
    'Returns ranked list of parties or candidates within a defined scope. Supports all election types.',
    {
      year: z.number().describe('Election year.'),
      election_type: ELECTION_TYPE_PARAM,
      subject: z.enum(['parties', 'candidates']).describe('Rank parties or candidates.'),
      area_id: z.string().optional().describe('Area code to rank parties within. Omit for national. Use SSS/national for national party rankings.'),
      unit_key: z.string().optional().describe('For candidate rankings: vaalipiiri/hyvinvointialue key. Required unless EU/presidential.'),
      limit: z.number().optional().describe('Return only the top N results. Omit for all.'),
    },
    async (args) => computeRankings(args)
  );

  // ── get_top_n ────────────────────────────────────────────────────────────
  server.tool(
    'get_top_n',
    'Convenience tool: returns the top N parties or candidates by votes within a scope.',
    {
      year: z.number().describe('Election year.'),
      election_type: ELECTION_TYPE_PARAM,
      subject: z.enum(['parties', 'candidates']).describe('Rank parties or candidates.'),
      n: z.number().describe('Number of top results to return.'),
      area_id: z.string().optional().describe('Area code to rank within.'),
      unit_key: z.string().optional().describe('For candidate rankings: vaalipiiri/hyvinvointialue key.'),
    },
    async ({ year, election_type, subject, n, area_id, unit_key }) =>
      computeRankings({ year, election_type, subject, area_id, unit_key, limit: n })
  );

}

// ─── computeRankings (shared by get_rankings and get_top_n) ─────────────────

async function computeRankings({
  year, election_type, subject, area_id, unit_key, limit,
}: {
  year: number;
  election_type?: string;
  subject: 'parties' | 'candidates';
  area_id?: string;
  unit_key?: string;
  limit?: number;
}) {
  const electionType: ElectionType = (election_type as ElectionType) ?? 'parliamentary';
  type RankedRow = { rank: number; votes: number; vote_share?: number; [k: string]: unknown };

  try {
    if (subject === 'parties') {
      const { rows, tableId } = await loadPartyResults(year, area_id ?? 'SSS', electionType);
      let ranked: RankedRow[] = rows
        .filter(r => r.party_id !== 'SSS' && r.party_id !== '00')
        .sort((a, b) => b.votes - a.votes)
        .map((r, i) => ({ rank: i + 1, party_id: r.party_id, party_name: r.party_name, votes: r.votes, vote_share: r.vote_share }));
      if (limit) ranked = ranked.slice(0, limit);
      return { content: [{ type: 'text' as const, text: JSON.stringify({
        subject, year, election_type: electionType,
        scope: area_id ?? 'national',
        rankings: ranked,
        source: { table_ids: [tableId], query_timestamp: new Date().toISOString() },
      }, null, 2) }] };

    } else {
      const { rows, tableId, unit_code } = await loadCandidateResults(year, unit_key, undefined, electionType);
      // Rank at unit-level aggregate (vaalipiiri / hyvinvointialue / koko_suomi)
      const unitAreaLevel = electionType === 'regional' ? 'hyvinvointialue'
        : (electionType === 'eu_parliament' || electionType === 'presidential') ? 'koko_suomi'
        : 'vaalipiiri';
      let ranked: RankedRow[] = rows
        .filter(r => r.area_level === unitAreaLevel)
        .sort((a, b) => b.votes - a.votes)
        .map((r, i) => ({ rank: i + 1, candidate_id: r.candidate_id, candidate_name: r.candidate_name, party_id: r.party_id, votes: r.votes, vote_share: r.vote_share }));
      if (limit) ranked = ranked.slice(0, limit);
      return { content: [{ type: 'text' as const, text: JSON.stringify({
        subject, year, election_type: electionType,
        scope: unit_key ?? unit_code ?? 'national',
        rankings: ranked,
        source: { table_ids: [tableId], query_timestamp: new Date().toISOString() },
      }, null, 2) }] };
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }] };
  }
}

// ─── Analysis mode builders ─────────────────────────────────────────────────

function buildPartyAnalysis(
  rows: ElectionRecord[],
  year: number,
  source: { table_ids: string[]; query_timestamp: string }
) {
  const byParty = new Map<string, { party_name: string; total_votes: number; areas: number }>();

  for (const row of rows) {
    if (!row.party_id || row.area_level === 'koko_suomi') continue;
    const existing = byParty.get(row.party_id);
    if (existing) {
      existing.total_votes += row.votes;
      existing.areas++;
    } else {
      byParty.set(row.party_id, { party_name: row.party_name ?? row.party_id, total_votes: row.votes, areas: 1 });
    }
  }

  const partyTable = [...byParty.entries()]
    .map(([id, d]) => ({ party_id: id, party_name: d.party_name, total_votes: d.total_votes }))
    .sort((a, b) => b.total_votes - a.total_votes);

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        mode: 'analysis',
        summary: { year, total_parties: byParty.size, total_rows: rows.length },
        tables: { party_totals: partyTable },
        method: {
          description: 'Summed votes from party-by-kunta table (13sw). Excludes koko_suomi rows to avoid double-counting.',
          source_table: source.table_ids[0],
        },
        source,
      }, null, 2),
    }],
  };
}

function buildCandidateAnalysis(
  rows: ElectionRecord[],
  year: number,
  source: { table_ids: string[]; query_timestamp: string }
) {
  const byCandidate = new Map<string, { name: string; party: string; total_votes: number }>();

  for (const row of rows) {
    if (!row.candidate_id || row.area_level !== 'aanestysalue') continue;
    const existing = byCandidate.get(row.candidate_id);
    if (existing) {
      existing.total_votes += row.votes;
    } else {
      byCandidate.set(row.candidate_id, {
        name: row.candidate_name ?? row.candidate_id,
        party: row.party_id ?? '',
        total_votes: row.votes,
      });
    }
  }

  const candidateTable = [...byCandidate.entries()]
    .map(([id, d]) => ({ candidate_id: id, candidate_name: d.name, party: d.party, total_votes: d.total_votes }))
    .sort((a, b) => b.total_votes - a.total_votes);

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        mode: 'analysis',
        summary: { year, total_candidates: byCandidate.size, total_rows: rows.length },
        tables: { candidate_totals: candidateTable },
        method: {
          description: 'Summed äänestysalue-level rows per candidate. Only äänestysalue rows used to avoid double-counting.',
          source_tables: source.table_ids,
        },
        source,
      }, null, 2),
    }],
  };
}
