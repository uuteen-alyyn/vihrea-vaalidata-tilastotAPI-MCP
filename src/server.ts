import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerDiscoveryTools } from './tools/discovery/index.js';
import { registerEntityResolutionTools } from './tools/entity-resolution/index.js';
import { registerRetrievalTools } from './tools/retrieval/index.js';
import { registerAnalyticsTools } from './tools/analytics/index.js';
import { registerStrategicTools } from './tools/strategic/index.js';
import { registerAreaTools } from './tools/area/index.js';
import { registerAuditTools } from './tools/audit/index.js';
import { registerDemographicsTools } from './tools/demographics/index.js';
import { registerComparisonTools } from './tools/comparison/index.js';
import { registerResources } from './resources/index.js';

const SYSTEM_PROMPT = `You have access to a **Finnish Election Data MCP** providing structured data and deterministic analytics from official Statistics Finland (Tilastokeskus) datasets.

## Finnish electoral context

Multi-party proportional representation with open candidate lists: voters vote for individual candidates, whose votes also count toward party totals. Candidates compete **between parties** and **within their own party**. Analytics must capture both dimensions.

## Reference resources (read on demand)

- \`election://coverage\` — which elections have party/candidate data and how many units
- \`election://unit-keys\` — valid unit_key values by election type and year
- \`election://metrics\` — definitions and formulas for all computed metrics

Read these resources when you need to check data availability, validate unit keys, or understand a metric — do not guess.

## Standard workflow

1. **Discover** — check coverage if unsure: \`list_elections\`, \`describe_available_data\`, or read \`election://coverage\`
2. **Resolve** — turn names into IDs: \`resolve_candidate\`, \`resolve_party\`, \`resolve_area\`, \`resolve_entities\`
   - If unsure of unit_key: call \`list_unit_keys(election_type, year)\` or read \`election://unit-keys\`
   - Always resolve candidate names before calling \`get_candidate_results\` — do not guess candidate_id
3. **Retrieve** — get normalized data: \`query_election_data\` (unified — use first for cross-election queries), \`get_candidate_results\`, \`get_party_results\`, \`get_area_results\`, \`get_rankings\`, \`get_turnout\`
4. **Compare** — cross-election analysis: \`compare_across_dimensions\` (party/candidate across elections/areas/subjects with pp-change), \`get_candidate_trajectory\` (candidate career timeline)
5. **Analyze** — compute metrics: \`analyze_candidate_profile\`, \`analyze_party_profile\`, \`compare_candidates\`, \`compare_parties\`, \`find_area_overperformance\`, \`analyze_geographic_concentration\`
6. **Area** — geographic patterns: \`get_area_profile\`, \`compare_areas\`, \`analyze_area_volatility\`, \`find_strongholds\` (direction='weak_zones' for worst areas), \`find_comparable_areas\`
7. **Strategic** — campaign analytics: \`detect_inactive_high_vote_candidates\`, \`find_vote_decline_areas\`, \`estimate_vote_transfer_proxy\`, \`rank_areas_for_party\`
8. **Audit** — verify methodology: \`explain_metric\`, \`trace_result_lineage\`, \`validate_comparison\`, \`get_data_caveats\`

Do **not reconstruct metrics manually** when MCP tools provide them. Treat MCP outputs as the authoritative computational layer.

## Data coverage (summary — read election://coverage for full detail)

| Election type | Party data | Candidate data |
|---|---|---|
| Parliamentary (eduskuntavaalit) | 1983–2023 (multi-year) | 2007, 2011, 2015, 2019, 2023 (per vaalipiiri) |
| Municipal (kuntavaalit) | 1976–2025 (multi-year) | 2021, 2025 (per vaalipiiri) |
| Regional (aluevaalit) | 2022–2025 (multi-year) | 2025 (per hyvinvointialue) |
| EU Parliament (europarlamenttivaalit) | 1996–2024 (multi-year) | 2019, 2024 (national only) |
| Presidential (presidentinvaalit) | — (no party dimension) | 2024 (national, 2 rounds) |

## Conventions

**area_id** — 6-digit for party/area tables (e.g. \`010091\` = Helsinki kunta, \`SSS\` = national).

**Helsinki ≠ Uusimaa vaalipiiri** — Helsinki is its own vaalipiiri (unit_key \`"helsinki"\`). Uusimaa vaalipiiri (unit_key \`"uusimaa"\`) does NOT include Helsinki. Never combine their results when analyzing one or the other.

**party_id** — canonical abbreviations: KOK, SDP, PS, KESK, VIHR, VAS, RKP, KD, LIIK.

**candidate_id** — numeric string (e.g. \`01010176\`). Always use \`resolve_candidate\` first.

**unit_key** — read \`election://unit-keys\` or call \`list_unit_keys\` if unsure. Common pitfall: parliamentary uses "hame" not "häme", "lounais-suomi" not "varsinais-suomi".

## Election-specific notes

- **EU elections**: Finland is a single national constituency — no per-vaalipiiri candidate geography.
- **Presidential**: No party dimension; two rounds (\`round: 1\` / \`round: 2\`).
- **Regional 2022**: Party data available; candidate-level data not available.
- **Parliamentary 2011 / 2007**: 15-vaalipiiri boundary (pre-2012 reform). Use \`kymi\`, \`etela-savo\`, \`pohjois-savo\`, \`pohjois-karjala\` instead of \`kaakkois-suomi\` / \`savo-karjala\`.
- **Vote transfer proxy**: structural indicator from area co-movement, not direct voter-level measurement.

## Voter demographics tools — coverage

- \`get_voter_background\`: parliamentary 2011/2015/2019/2023; municipal 2012/2017/2021/2025 only.
- \`get_voter_turnout_by_demographics\`: parliamentary 2023, municipal 2025, EU 2024, presidential 2024 only. No earlier years.`;

export function registerAllTools(server: McpServer): void {
  registerDiscoveryTools(server);
  registerEntityResolutionTools(server);
  registerRetrievalTools(server);
  registerAnalyticsTools(server);
  registerStrategicTools(server);
  registerAreaTools(server);
  registerAuditTools(server);
  registerDemographicsTools(server);
  registerComparisonTools(server);
  registerResources(server);

  server.registerPrompt(
    'system',
    {
      title: 'Finnish Election Data MCP — system prompt',
      description: 'Describes tool categories, data coverage, conventions, and usage guidelines for the Finnish Election Data MCP.',
    },
    async () => ({
      messages: [{
        role: 'user' as const,
        content: { type: 'text' as const, text: SYSTEM_PROMPT },
      }],
    })
  );

  server.registerPrompt(
    'analyze_candidate',
    {
      title: 'Analyze candidate — full profile workflow',
      description: 'Step-by-step workflow to look up, retrieve, and analyze a Finnish election candidate. Resolves the candidate name to an ID, fetches their results, and runs a full profile analysis.',
      argsSchema: {
        candidate_name: z.string().describe('Full name of the candidate (e.g. "Santeri Leinonen")'),
        election_type: z.string().describe('Election type: parliamentary, municipal, regional, eu_parliament, presidential'),
        year: z.string().describe('Election year (e.g. "2023")'),
        unit_key: z.string().optional().describe('Vaalipiiri or hyvinvointialue key (e.g. "uusimaa"). If unsure, omit and the workflow will look it up.'),
      },
    },
    async ({ candidate_name, election_type, year, unit_key }) => {
      const name = candidate_name;
      const electionType = election_type;
      const unitKeyNote = unit_key
        ? `Unit key provided: "${unit_key}".`
        : 'No unit_key provided — call list_unit_keys first to find the correct key.';

      const text = `You are analyzing a Finnish election candidate. Follow these steps in order:

## Step 1 — Find the unit key (skip if already known)
${unitKeyNote}
If unit_key is unknown, call: list_unit_keys(election_type="${electionType}", year=${year})
Pick the correct vaalipiiri or hyvinvointialue key from the result.

## Step 2 — Resolve the candidate
Call: resolve_candidate(name="${name}", election_type="${electionType}", year=${year}${unit_key ? `, unit_key="${unit_key}"` : ''})
This returns the confirmed candidate_id and unit_key. Do not proceed without a confirmed candidate_id.

## Step 3 — Retrieve candidate results
Call: get_candidate_results(year=${year}, election_type="${electionType}", unit_key=<from step 2>, candidate_id=<from step 2>)

## Step 4 — Analyze candidate profile
Call: analyze_candidate_profile(candidate_id=<from step 2>, election_type="${electionType}", year=${year}, unit_key=<from step 2>)

## Step 5 — Present the analysis
Report: candidate name, party, vaalipiiri/unit, total votes, vote share, rank within party, share of party vote, geographic concentration (top areas), and any notable observations.
If the candidate ran in multiple elections, offer to call get_candidate_trajectory for a career timeline.`;

      return {
        messages: [{
          role: 'user' as const,
          content: { type: 'text' as const, text },
        }],
      };
    }
  );

  server.registerPrompt(
    'compare_parties',
    {
      title: 'Compare parties across elections — workflow',
      description: 'Workflow to compare two or more parties across elections, years, or geographic areas. Uses compare_across_dimensions and analyze_party_profile.',
      argsSchema: {
        party_ids: z.string().describe('Comma-separated party abbreviations (e.g. "SDP,KOK,PS")'),
        election_type: z.string().describe('Election type: parliamentary, municipal, regional, eu_parliament'),
        years: z.string().describe('Comma-separated years to compare (e.g. "2015,2019,2023")'),
        focus: z.string().optional().describe('What to focus on: vote_share, volatility, geographic_concentration, enp'),
      },
    },
    async ({ party_ids, election_type, years, focus }) => {
      const parties = party_ids;
      const electionType = election_type;
      const focusLabel = focus ?? 'vote_share';

      const text = `You are comparing Finnish political parties across elections. Follow these steps:

## Step 1 — Check data availability
Read election://coverage if unsure whether party data exists for the requested years.

## Step 2 — Cross-election comparison
Call: compare_across_dimensions(
  subject_type="party",
  subject_ids=[${parties.split(',').map((p: string) => `"${p.trim()}"`).join(', ')}],
  election_type="${electionType}",
  years=[${years.split(',').map((y: string) => y.trim()).join(', ')}]
)
This returns vote shares and pp-changes for all parties across all years.

## Step 3 — Party profiles (run for each party)
For each party, call: analyze_party_profile(party_id=<party>, election_type="${electionType}", year=<most recent year>)
This gives ENP, volatility, and geographic concentration for each.

## Step 4 — Present comparison
Focus: ${focusLabel}
Report: vote share trend per party (with pp changes), ENP across years, key geographic shifts, and interpretation of the overall competitive dynamics.`;

      return {
        messages: [{
          role: 'user' as const,
          content: { type: 'text' as const, text },
        }],
      };
    }
  );
}
