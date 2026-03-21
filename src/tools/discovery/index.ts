import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ALL_ELECTION_TABLES, findPartyTableForType } from '../../data/election-tables.js';
import type { AreaLevel, ElectionType } from '../../data/types.js';

export function registerDiscoveryTools(server: McpServer): void {

  server.tool(
    'list_elections',
    'List all available elections in the system. Returns election type, year, available area levels, and whether candidate-level data exists.',
    {},
    async () => {
      const elections = ALL_ELECTION_TABLES.map((t) => {
        const hasParty = !!(t.party_by_kunta ?? findPartyTableForType(t.election_type));
        const hasCandidate = !!(t.candidate_by_aanestysalue || t.candidate_national);

        const availableAreaLevels: AreaLevel[] = ['koko_suomi'];
        if (t.party_by_kunta ?? findPartyTableForType(t.election_type)) {
          // Parliamentary/municipal/EU use vaalipiiri; regional uses hyvinvointialue
          if (t.election_type === 'regional') {
            availableAreaLevels.push('hyvinvointialue');
          } else {
            availableAreaLevels.push('vaalipiiri');
          }
        }
        if (t.party_by_kunta) availableAreaLevels.push('kunta');
        if (t.candidate_by_aanestysalue || t.turnout_by_aanestysalue) {
          availableAreaLevels.push('aanestysalue');
        }
        // Presidential candidate_national (14d5) covers vaalipiiri + kunta + äänestysalue
        if (t.election_type === 'presidential' && t.candidate_national) {
          for (const lvl of ['vaalipiiri', 'kunta', 'aanestysalue'] as AreaLevel[]) {
            if (!availableAreaLevels.includes(lvl)) availableAreaLevels.push(lvl);
          }
        }
        return {
          election_type: t.election_type,
          year: t.year,
          available_area_levels: [...new Set(availableAreaLevels)],
          candidate_data_available: hasCandidate,
          party_data_available: hasParty,
        };
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ elections }, null, 2) }],
      };
    }
  );

  server.tool(
    'list_area_levels',
    'List the supported geographic area levels for Finnish election data, from finest to coarsest.',
    {},
    async () => {
      const levels = [
        {
          level: 'aanestysalue',
          fi: 'Äänestysalue',
          description: 'Voting district / polling precinct — the smallest unit by which votes are counted in Finland.',
        },
        {
          level: 'kunta',
          fi: 'Kunta',
          description: 'Municipality — contains multiple äänestysalueet.',
        },
        {
          level: 'vaalipiiri',
          fi: 'Vaalipiiri',
          description: 'Electoral district — contains multiple kuntas. There are 13 vaalipiirit in Finland (parliamentary, municipal, EU elections).',
        },
        {
          level: 'hyvinvointialue',
          fi: 'Hyvinvointialue',
          description: 'Welfare area — used in regional (aluevaalit) elections. There are 21 hyvinvointialueet in Finland.',
        },
        {
          level: 'koko_suomi',
          fi: 'Koko Suomi',
          description: 'National total.',
        },
      ];

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ area_levels: levels }, null, 2) }],
      };
    }
  );

  server.tool(
    'describe_election',
    'Returns detailed metadata for a specific election.',
    {
      election_type: z.enum(['parliamentary', 'municipal', 'eu_parliament', 'presidential', 'regional'])
        .describe('The type of election.'),
      year: z.number().describe('The election year.'),
    },
    async ({ election_type, year }) => {
      const tables = ALL_ELECTION_TABLES.find(
        (t) => t.election_type === election_type && t.year === year
      );

      if (!tables) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: `No data found for ${election_type} election in ${year}.`,
              available: ALL_ELECTION_TABLES.map((t) => ({ election_type: t.election_type, year: t.year })),
            }, null, 2),
          }],
        };
      }

      const fallbackParty = findPartyTableForType(tables.election_type);
      const hasParty = !!(tables.party_by_kunta ?? fallbackParty?.party_by_kunta);
      const hasCandidate = !!(tables.candidate_by_aanestysalue || tables.candidate_national);

      const caveats: string[] = [];
      if (tables.candidate_by_aanestysalue) {
        const unitLabel = tables.election_type === 'regional' ? 'hyvinvointialue' : 'vaalipiiri';
        const unitCount = Object.keys(tables.candidate_by_aanestysalue).length;
        caveats.push(
          `Candidate data with äänestysalue breakdown is stored in separate tables per ${unitLabel}. ` +
          `Fetching national candidate results requires querying all ${unitCount} ${unitLabel} tables.`
        );
      }
      if (!tables.party_by_kunta && fallbackParty) {
        caveats.push(
          `Party data for ${tables.election_type} ${tables.year} is served from the multi-year table ` +
          `(${fallbackParty.party_by_kunta}) registered on year ${fallbackParty.year}.`
        );
      }
      if (tables.candidate_national) {
        const note = tables.election_type === 'presidential'
          ? 'Presidential candidate data (14d5) covers all area levels: koko_suomi, vaalipiiri, kunta, äänestysalue — in a single table. Use round parameter to filter by round.'
          : 'Candidate data is available as a single national table (no per-unit breakdown).';
        caveats.push(note);
      }
      if (tables.election_type === 'presidential') {
        caveats.push('Presidential elections have two rounds. Use the round parameter (1 or 2) to filter.');
      }
      if (tables.election_type === 'parliamentary' && (tables.year === 2011 || tables.year === 2007)) {
        caveats.push(
          `Finland had 15 vaalipiiri in ${tables.year} (before the 2012 boundary reform). ` +
          'The old districts kymi, etela-savo, pohjois-savo, and pohjois-karjala were later merged ' +
          'into kaakkois-suomi and savo-karjala (2015+). Use the 2011/2007 keys listed in ' +
          'candidate_vaalipiirit when querying this election.'
        );
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            election_type: tables.election_type,
            year: tables.year,
            database: tables.database,
            party_data_available: hasParty,
            candidate_data_available: hasCandidate,
            candidate_units: tables.candidate_by_aanestysalue
              ? Object.keys(tables.candidate_by_aanestysalue)
              : [],
            candidate_national_table: tables.candidate_national ?? null,
            caveats,
          }, null, 2),
        }],
      };
    }
  );

  // ── describe_available_data ───────────────────────────────────────────────
  server.tool(
    'describe_available_data',
    'Given an election type, year, and subject type, returns exactly what data can be fetched and at what geographic granularity. Use this before calling query_election_data or get_party_results to avoid 403 errors and understand what area levels are supported.',
    {
      election_type: z.enum(['parliamentary', 'municipal', 'eu_parliament', 'presidential', 'regional'])
        .describe('The type of election.'),
      year: z.number().describe('The election year.'),
      subject_type: z.enum(['party', 'candidate']).optional()
        .describe('Whether you want party or candidate data. Omit to describe both.'),
    },
    async ({ election_type, year, subject_type }) => {
      const elType = election_type as ElectionType;
      const tables = ALL_ELECTION_TABLES.find((t) => t.election_type === elType && t.year === year);
      const fallback = findPartyTableForType(elType);

      if (!tables && !fallback) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: `No data found for ${election_type} ${year}.`,
              available_elections: ALL_ELECTION_TABLES.map((t) => ({ election_type: t.election_type, year: t.year })),
            }),
          }],
        };
      }

      const entry = tables ?? fallback!;
      const result: Record<string, unknown> = {
        election_type,
        year,
      };

      // ── Party data ───────────────────────────────────────────────────────
      if (!subject_type || subject_type === 'party') {
        const partyLevels: string[] = [];
        const partyCaveats: string[] = [];

        if (entry.party_by_kunta ?? fallback?.party_by_kunta) {
          partyLevels.push('koko_suomi');
          if (election_type === 'regional') {
            partyLevels.push('hyvinvointialue');
          } else {
            partyLevels.push('vaalipiiri');
          }
          partyLevels.push('kunta');
        }
        if (entry.party_by_aanestysalue) {
          if (!partyLevels.includes('koko_suomi')) partyLevels.push('koko_suomi');
          partyLevels.push('aanestysalue');
          partyCaveats.push(
            `Year-specific äänestysalue table (${entry.party_by_aanestysalue}) available — ` +
            'use this when fetching all areas at once to avoid 403 cell-count errors.'
          );
        }
        if (!entry.party_by_kunta && fallback?.party_by_kunta) {
          partyCaveats.push(
            `Party data served from multi-year table (${fallback.party_by_kunta}) registered on year ${fallback.year}.`
          );
        }

        result['party'] = {
          available: partyLevels.length > 0,
          area_levels: partyLevels,
          caveats: partyCaveats,
        };
      }

      // ── Candidate data ───────────────────────────────────────────────────
      if (!subject_type || subject_type === 'candidate') {
        const candidateLevels: string[] = [];
        const candidateCaveats: string[] = [];

        if (entry.candidate_national) {
          candidateLevels.push('koko_suomi');
          candidateCaveats.push(`National candidate table: ${entry.candidate_national}.`);
        }
        if (entry.candidate_by_vaalipiiri) {
          if (!candidateLevels.includes('koko_suomi')) candidateLevels.push('koko_suomi');
          candidateLevels.push('vaalipiiri');
          candidateCaveats.push(`Candidate results by vaalipiiri: ${entry.candidate_by_vaalipiiri}.`);
        }
        if (entry.candidate_by_aanestysalue) {
          const unitType = entry.geographic_unit_type ?? 'vaalipiiri';
          const unitCount = Object.keys(entry.candidate_by_aanestysalue).length;
          if (!candidateLevels.includes('koko_suomi')) candidateLevels.push('koko_suomi');
          candidateLevels.push('aanestysalue');
          candidateCaveats.push(
            `Candidate data spread across ${unitCount} per-${unitType} tables. ` +
            `Use unit_hint to target a single ${unitType} and avoid ${unitCount} parallel API calls.`
          );
        }
        if (entry.candidate_by_aanestysalue_eu) {
          candidateLevels.push('aanestysalue');
          candidateCaveats.push(
            `EU äänestysalue candidate table (${entry.candidate_by_aanestysalue_eu}) requires candidate_id filter — ` +
            '247 candidates × 2079 areas exceeds cell limit without it.'
          );
        }
        if (entry.candidate_multiyr_vaalipiiri) {
          if (!candidateLevels.includes('vaalipiiri')) candidateLevels.push('vaalipiiri');
          candidateCaveats.push(
            `Multi-year vaalipiiri candidate table (${entry.candidate_multiyr_vaalipiiri}) covers multiple years in one query.`
          );
        }
        if (election_type === 'regional' && year === 2022) {
          candidateCaveats.push('No candidate-level data for regional 2022. Only party aggregates are available.');
        }

        result['candidate'] = {
          available: candidateLevels.length > 0,
          area_levels: [...new Set(candidateLevels)],
          caveats: candidateCaveats,
        };
      }

      // ── Turnout data ─────────────────────────────────────────────────────
      if (entry.voter_turnout_by_demographics) {
        result['turnout_demographics'] = {
          available: true,
          dimensions: Object.keys(entry.voter_turnout_by_demographics),
        };
      } else {
        result['turnout_demographics'] = { available: false };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    'get_area_hierarchy',
    'Returns the parent-child hierarchy of Finnish election geographic levels.',
    {},
    async () => {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            hierarchy: [
              { level: 'aanestysalue', parent: 'kunta', fi: 'Äänestysalue', elections: ['parliamentary', 'municipal', 'regional', 'eu_parliament', 'presidential'] },
              { level: 'kunta', parent: 'vaalipiiri', fi: 'Kunta', elections: ['parliamentary', 'municipal', 'eu_parliament'] },
              { level: 'vaalipiiri', parent: 'koko_suomi', fi: 'Vaalipiiri', elections: ['parliamentary', 'municipal', 'eu_parliament', 'presidential'] },
              { level: 'hyvinvointialue', parent: 'koko_suomi', fi: 'Hyvinvointialue', elections: ['regional'] },
              { level: 'koko_suomi', parent: null, fi: 'Koko Suomi', elections: ['parliamentary', 'municipal', 'regional', 'eu_parliament', 'presidential'] },
            ],
          }, null, 2),
        }],
      };
    }
  );

  // ── list_unit_keys ────────────────────────────────────────────────────────
  server.tool(
    'list_unit_keys',
    'Returns the valid unit_key values for a given election type and year. ' +
    'Call this before resolve_candidate or get_candidate_results whenever you are unsure which unit_key to use. ' +
    'Parliamentary and municipal elections use vaalipiiri keys (e.g. "helsinki", "uusimaa"). ' +
    'Regional elections use hyvinvointialue keys (e.g. "pirkanmaa", "varsinais-suomi"). ' +
    'EU parliament and presidential elections use a single national table — no unit_key needed. ' +
    'Keys are derived live from the registry and are always up to date.',
    {
      election_type: z.enum(['parliamentary', 'municipal', 'eu_parliament', 'presidential', 'regional'])
        .describe('The type of election.'),
      year: z.number().describe('The election year (e.g. 2023 for parliamentary, 2025 for regional).'),
    },
    async ({ election_type, year }) => {
      const elType = election_type as ElectionType;
      const tables = ALL_ELECTION_TABLES.find((t) => t.election_type === elType && t.year === year);

      if (!tables) {
        const available = ALL_ELECTION_TABLES
          .filter((t) => t.election_type === elType)
          .map((t) => t.year);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: `No tables registered for ${election_type} ${year}.`,
              available_years: available,
            }),
          }],
        };
      }

      if (elType === 'eu_parliament' || elType === 'presidential') {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              election_type,
              year,
              unit_key_required: false,
              note: `${election_type} elections use a single national candidate table. Pass unit_key="national" or omit it entirely.`,
            }),
          }],
        };
      }

      if (!tables.candidate_by_aanestysalue) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: `No per-unit candidate tables registered for ${election_type} ${year}. Candidate data may not be available.`,
            }),
          }],
        };
      }

      const unitType = tables.geographic_unit_type ?? (elType === 'regional' ? 'hyvinvointialue' : 'vaalipiiri');
      const keys = Object.keys(tables.candidate_by_aanestysalue);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            election_type,
            year,
            unit_type: unitType,
            unit_key_required: true,
            unit_keys: keys,
            usage: `Pass one of these as unit_key in resolve_candidate or get_candidate_results.`,
          }),
        }],
      };
    }
  );
}
