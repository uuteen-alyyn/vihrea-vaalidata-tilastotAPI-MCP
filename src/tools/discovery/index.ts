import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ALL_ELECTION_TABLES, findPartyTableForType } from '../../data/election-tables.js';
import type { AreaLevel } from '../../data/types.js';

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
        caveats.push('Candidate data is available as a single national table (no per-vaalipiiri breakdown).');
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
            candidate_vaalipiirit: tables.candidate_by_aanestysalue
              ? Object.keys(tables.candidate_by_aanestysalue)
              : [],
            candidate_national_table: tables.candidate_national ?? null,
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
}
