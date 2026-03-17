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

const ELECTION_TYPE_PARAM = z.enum(['parliamentary', 'municipal', 'eu_parliament', 'presidential', 'regional'])
  .optional()
  .describe('Election type. Defaults to "parliamentary".');

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
        const { rows, tableId, cache_hit } = await loadPartyResults(year, area_id, electionType);
        const source = { table_ids: [tableId], query_timestamp: new Date().toISOString(), cache_hit };
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
        const { rows, tableId, cache_hit } = await loadCandidateResults(
          year, unit_key, candidate_id, electionType, round
        );
        const source = { table_ids: [tableId], query_timestamp: new Date().toISOString(), cache_hit };
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
    'Returns voter turnout statistics for a parliamentary election.',
    {
      year: z.number().describe('Election year.'),
      area_id: z.string().optional().describe('Area code to filter to. Omit for all areas.'),
    },
    async ({ year, area_id }) => {
      const tables = getElectionTables('parliamentary', year);
      if (!tables?.turnout_by_aanestysalue) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: `No turnout data found for parliamentary election ${year}.` }),
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

      const { value: response, cache_hit } = await withCache(
        `data:${tableId}:${year}:${area_id ?? 'all'}`,
        () => pxwebClient.queryTable(dbPath, tableId, query)
      );

      const source = {
        table_ids: [tableId],
        query_timestamp: new Date().toISOString(),
        cache_hit,
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
    'Returns all party results (and optionally candidate results) for a specific geographic area in an election.',
    {
      year: z.number().describe('Election year.'),
      area_id: z.string().describe('Area code. For 13sw party table: 6-digit format e.g. "010091" (Helsinki kunta), "010000" (VP01 vaalipiiri), "SSS" (national). For candidate tables: "KU091" (kunta), "VP01" (vaalipiiri).'),
      include_candidates: z.boolean().optional().describe('Also fetch candidate results for this area (only works for parliamentary 2023, requires vaalipiiri parameter).'),
      vaalipiiri: z.string().optional().describe('Required when include_candidates=true. Which vaalipiiri table to query (e.g. "helsinki").'),
      output_mode: z.enum(['data', 'analysis']).optional(),
    },
    async ({ year, area_id, include_candidates, vaalipiiri, output_mode }) => {
      const tables = getElectionTables('parliamentary', year);
      if (!tables?.party_by_kunta) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `No data for parliamentary ${year}.` }) }] };
      }

      const dbPath = getDatabasePath(tables);
      const tableId = tables.party_by_kunta;
      const metadata = await fetchTableMetadata(dbPath, tableId);

      const partyQuery = {
        query: [
          { code: 'Vuosi', selection: { filter: 'item' as const, values: [String(year)] } },
          { code: 'Sukupuoli', selection: { filter: 'item' as const, values: ['SSS'] } },
          { code: 'Puolue', selection: { filter: 'all' as const, values: ['*'] } },
          { code: 'Vaalipiiri ja kunta vaalivuonna', selection: { filter: 'item' as const, values: [area_id] } },
          { code: 'Tiedot', selection: { filter: 'item' as const, values: ['evaa_aanet', 'evaa_osuus_aanista'] } },
        ],
        response: { format: 'json' as const },
      };

      const { value: partyResponse, cache_hit } = await withCache(
        `data:${tableId}:${year}:all:${area_id}`,
        () => pxwebClient.queryTable(dbPath, tableId, partyQuery)
      );

      const partyRows = normalizePartyByKunta(partyResponse, metadata, year);
      const allRows: ElectionRecord[] = [...partyRows];
      const tableIds = [tableId];

      if (include_candidates && vaalipiiri && tables.candidate_by_aanestysalue) {
        const candTableId = tables.candidate_by_aanestysalue[vaalipiiri];
        if (candTableId) {
          const candMeta = await fetchTableMetadata(dbPath, candTableId);
          const candQuery = {
            query: [
              { code: 'Vuosi', selection: { filter: 'item' as const, values: [String(year)] } },
              { code: 'Alue/Äänestysalue', selection: { filter: 'item' as const, values: [area_id.startsWith('KU') ? area_id : `KU${area_id}`] } },
              { code: 'Ehdokas', selection: { filter: 'all' as const, values: ['*'] } },
              { code: 'Valintatieto', selection: { filter: 'item' as const, values: ['SSS'] } },
              { code: 'Tiedot', selection: { filter: 'item' as const, values: ['evaa_aanet', 'evaa_osuus_aanista'] } },
            ],
            response: { format: 'json' as const },
          };
          const { value: candResponse } = await withCache(
            `data:${candTableId}:${year}:all:${area_id}`,
            () => pxwebClient.queryTable(dbPath, candTableId, candQuery)
          );
          allRows.push(...normalizeCandidateByAanestysalue(candResponse, candMeta, year));
          tableIds.push(candTableId);
        }
      }

      const source = { table_ids: tableIds, query_timestamp: new Date().toISOString(), cache_hit };
      const mode = parseOutputMode(output_mode);

      if (mode === 'analysis') {
        const parties = partyRows
          .filter(r => r.party_id !== 'SSS')
          .sort((a, b) => b.votes - a.votes)
          .map((r, i) => ({ rank: i + 1, party_id: r.party_id, party_name: r.party_name, votes: r.votes, vote_share: r.vote_share }));

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              mode: 'analysis',
              summary: { year, area_id, total_parties: parties.length },
              tables: { party_rankings: parties },
              method: { description: 'All parties in area, sorted by votes descending.', source_table: tableId },
              source,
            }, null, 2),
          }],
        };
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify({ mode: 'data', rows: allRows, source }, null, 2) }] };
    }
  );

  // ── get_election_results ─────────────────────────────────────────────────
  server.tool(
    'get_election_results',
    'Returns the full party result dataset for an election, optionally filtered to a specific area level. Use this for broad overviews; use get_party_results or get_area_results for targeted queries.',
    {
      year: z.number().describe('Election year.'),
      area_level: z.enum(['kunta', 'vaalipiiri', 'koko_suomi']).optional().describe('Filter results to this area level. Omit for all levels.'),
      output_mode: z.enum(['data', 'analysis']).optional(),
    },
    async ({ year, area_level, output_mode }) => {
      const tables = getElectionTables('parliamentary', year);
      if (!tables?.party_by_kunta) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `No data for parliamentary ${year}.` }) }] };
      }

      const dbPath = getDatabasePath(tables);
      const tableId = tables.party_by_kunta;
      const metadata = await fetchTableMetadata(dbPath, tableId);

      const query = {
        query: [
          { code: 'Vuosi', selection: { filter: 'item' as const, values: [String(year)] } },
          { code: 'Sukupuoli', selection: { filter: 'item' as const, values: ['SSS'] } },
          { code: 'Puolue', selection: { filter: 'all' as const, values: ['*'] } },
          { code: 'Vaalipiiri ja kunta vaalivuonna', selection: { filter: 'all' as const, values: ['*'] } },
          { code: 'Tiedot', selection: { filter: 'item' as const, values: ['evaa_aanet', 'evaa_osuus_aanista'] } },
        ],
        response: { format: 'json' as const },
      };

      const { value: response, cache_hit } = await withCache(
        `data:${tableId}:${year}:all:all`,
        () => pxwebClient.queryTable(dbPath, tableId, query)
      );

      let rows = normalizePartyByKunta(response, metadata, year);

      if (area_level) {
        rows = rows.filter(r => r.area_level === area_level);
      }

      const source = { table_ids: [tableId], query_timestamp: new Date().toISOString(), cache_hit };
      const mode = parseOutputMode(output_mode);

      if (mode === 'analysis') return buildPartyAnalysis(rows, year, source);

      return { content: [{ type: 'text' as const, text: JSON.stringify({ mode: 'data', rows, source }, null, 2) }] };
    }
  );

  // ── get_rankings ─────────────────────────────────────────────────────────
  server.tool(
    'get_rankings',
    'Returns ranked list of parties or candidates within a defined scope (area and election). Ranks by total votes descending.',
    {
      year: z.number().describe('Election year.'),
      subject: z.enum(['parties', 'candidates']).describe('Rank parties or candidates.'),
      area_id: z.string().optional().describe('Area code to rank within. Omit for national ranking. For parties use 13sw format (e.g. "010091"). For candidates, specify vaalipiiri instead.'),
      vaalipiiri: z.string().optional().describe('For candidate rankings: which vaalipiiri to query (e.g. "helsinki"). Required when subject=candidates.'),
      limit: z.number().optional().describe('Return only the top N results. Omit for all.'),
    },
    async (args) => computeRankings(args)
  );

  // ── get_top_n ────────────────────────────────────────────────────────────
  server.tool(
    'get_top_n',
    'Convenience tool: returns the top N parties or candidates by votes within a scope. Equivalent to get_rankings with a limit.',
    {
      year: z.number().describe('Election year.'),
      subject: z.enum(['parties', 'candidates']).describe('Rank parties or candidates.'),
      n: z.number().describe('Number of top results to return.'),
      area_id: z.string().optional().describe('Area code to rank within.'),
      vaalipiiri: z.string().optional().describe('Required when subject=candidates.'),
    },
    async ({ year, subject, n, area_id, vaalipiiri }) =>
      computeRankings({ year, subject, area_id, vaalipiiri, limit: n })
  );

}

// ─── computeRankings (shared by get_rankings and get_top_n) ─────────────────

async function computeRankings({
  year, subject, area_id, vaalipiiri, limit,
}: {
  year: number;
  subject: 'parties' | 'candidates';
  area_id?: string;
  vaalipiiri?: string;
  limit?: number;
}) {
  const tables = getElectionTables('parliamentary', year);
  if (!tables) {
    return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `No data for parliamentary ${year}.` }) }] };
  }

  const dbPath = getDatabasePath(tables);
  type RankedRow = { rank: number; votes: number; vote_share?: number; [k: string]: unknown };
  let ranked: RankedRow[] = [];
  const tableIds: string[] = [];

  if (subject === 'parties') {
    const tableId = tables.party_by_kunta!;
    tableIds.push(tableId);
    const metadata = await fetchTableMetadata(dbPath, tableId);
    const query = {
      query: [
        { code: 'Vuosi', selection: { filter: 'item' as const, values: [String(year)] } },
        { code: 'Sukupuoli', selection: { filter: 'item' as const, values: ['SSS'] } },
        { code: 'Puolue', selection: { filter: 'all' as const, values: ['*'] } },
        {
          code: 'Vaalipiiri ja kunta vaalivuonna',
          selection: area_id
            ? { filter: 'item' as const, values: [area_id] }
            : { filter: 'item' as const, values: ['SSS'] },
        },
        { code: 'Tiedot', selection: { filter: 'item' as const, values: ['evaa_aanet', 'evaa_osuus_aanista'] } },
      ],
      response: { format: 'json' as const },
    };
    const { value: response } = await withCache(
      `data:${tableId}:${year}:all:${area_id ?? 'SSS'}`,
      () => pxwebClient.queryTable(dbPath, tableId, query)
    );
    ranked = normalizePartyByKunta(response, metadata, year)
      .filter(r => r.party_id !== 'SSS')
      .sort((a, b) => b.votes - a.votes)
      .map((r, i) => ({ rank: i + 1, party_id: r.party_id, party_name: r.party_name, votes: r.votes, vote_share: r.vote_share }));

  } else {
    if (!vaalipiiri || !tables.candidate_by_aanestysalue) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'vaalipiiri is required for candidate rankings.' }) }] };
    }
    const tableId = tables.candidate_by_aanestysalue[vaalipiiri];
    if (!tableId) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Unknown vaalipiiri: ${vaalipiiri}` }) }] };
    }
    tableIds.push(tableId);
    const metadata = await fetchTableMetadata(dbPath, tableId);

    // Use VP code from metadata if no area_id given (vaalipiiri total)
    const areaVar = metadata.variables.find(v => v.code === 'Alue/Äänestysalue');
    const vpCode = areaVar?.values.find(v => v.startsWith('VP')) ?? '';
    const resolvedArea = area_id ?? vpCode;

    const query = {
      query: [
        { code: 'Vuosi', selection: { filter: 'item' as const, values: [String(year)] } },
        { code: 'Alue/Äänestysalue', selection: { filter: 'item' as const, values: [resolvedArea] } },
        { code: 'Ehdokas', selection: { filter: 'all' as const, values: ['*'] } },
        { code: 'Valintatieto', selection: { filter: 'item' as const, values: ['SSS'] } },
        { code: 'Tiedot', selection: { filter: 'item' as const, values: ['evaa_aanet', 'evaa_osuus_aanista'] } },
      ],
      response: { format: 'json' as const },
    };
    const { value: response } = await withCache(
      `data:${tableId}:${year}:all:${resolvedArea}`,
      () => pxwebClient.queryTable(dbPath, tableId, query)
    );

    const targetLevel = resolvedArea.startsWith('KU') ? 'kunta' : resolvedArea.startsWith('VP') ? 'vaalipiiri' : 'aanestysalue';
    ranked = normalizeCandidateByAanestysalue(response, metadata, year)
      .filter(r => r.area_level === targetLevel)
      .sort((a, b) => b.votes - a.votes)
      .map((r, i) => ({
        rank: i + 1,
        candidate_id: r.candidate_id,
        candidate_name: r.candidate_name,
        party_id: r.party_id,
        votes: r.votes,
        vote_share: r.vote_share,
      }));
  }

  if (limit) ranked = ranked.slice(0, limit);

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        subject,
        year,
        scope: area_id ?? (subject === 'candidates' ? vaalipiiri : 'national'),
        rankings: ranked,
        source: { table_ids: tableIds, query_timestamp: new Date().toISOString() },
      }, null, 2),
    }],
  };
}

// ─── Analysis mode builders ─────────────────────────────────────────────────

function buildPartyAnalysis(
  rows: ElectionRecord[],
  year: number,
  source: { table_ids: string[]; query_timestamp: string; cache_hit: boolean }
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
  source: { table_ids: string[]; query_timestamp: string; cache_hit: boolean }
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
