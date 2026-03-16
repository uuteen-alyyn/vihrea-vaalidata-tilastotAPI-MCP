import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ALL_ELECTION_TABLES } from '../../data/election-tables.js';
import type { AreaLevel } from '../../data/types.js';

export function registerDiscoveryTools(server: McpServer): void {

  server.tool(
    'list_elections',
    'List all available elections in the system. Returns election type, year, available area levels, and whether candidate-level data exists.',
    {},
    async () => {
      const elections = ALL_ELECTION_TABLES.map((t) => {
        const availableAreaLevels: AreaLevel[] = ['vaalipiiri', 'koko_suomi'];
        if (t.party_by_kunta) availableAreaLevels.push('kunta');
        if (t.candidate_by_aanestysalue || t.turnout_by_aanestysalue) {
          availableAreaLevels.push('aanestysalue');
        }
        return {
          election_type: t.election_type,
          year: t.year,
          available_area_levels: [...new Set(availableAreaLevels)],
          candidate_data_available: !!t.candidate_by_aanestysalue,
          party_data_available: !!t.party_by_kunta,
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
          description: 'Electoral district — contains multiple kuntas. There are 13 vaalipiirit in Finland.',
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

      const caveats: string[] = [];
      if (tables.candidate_by_aanestysalue) {
        caveats.push(
          'Candidate data with äänestysalue breakdown is stored in separate tables per vaalipiiri. ' +
          'Fetching national candidate results requires querying all 13 vaalipiiri tables.'
        );
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            election_type: tables.election_type,
            year: tables.year,
            database: tables.database,
            party_data_available: !!tables.party_by_kunta,
            candidate_data_available: !!tables.candidate_by_aanestysalue,
            candidate_vaalipiirit: tables.candidate_by_aanestysalue
              ? Object.keys(tables.candidate_by_aanestysalue)
              : [],
            caveats,
          }, null, 2),
        }],
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
              { level: 'aanestysalue', parent: 'kunta', fi: 'Äänestysalue' },
              { level: 'kunta', parent: 'vaalipiiri', fi: 'Kunta' },
              { level: 'vaalipiiri', parent: 'koko_suomi', fi: 'Vaalipiiri' },
              { level: 'koko_suomi', parent: null, fi: 'Koko Suomi' },
            ],
          }, null, 2),
        }],
      };
    }
  );
}
