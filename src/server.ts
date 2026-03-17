import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerDiscoveryTools } from './tools/discovery/index.js';
import { registerEntityResolutionTools } from './tools/entity-resolution/index.js';
import { registerRetrievalTools } from './tools/retrieval/index.js';
import { registerAnalyticsTools } from './tools/analytics/index.js';
import { registerStrategicTools } from './tools/strategic/index.js';
import { registerAreaTools } from './tools/area/index.js';
import { registerAuditTools } from './tools/audit/index.js';

const SYSTEM_PROMPT = `You have access to a **Finnish Election Data MCP** providing structured data and deterministic analytics from official Statistics Finland (Tilastokeskus) datasets.

## Finnish electoral context

Multi-party proportional representation with open candidate lists: voters vote for individual candidates, whose votes also count toward party totals. Candidates compete **between parties** and **within their own party**. Analytics must capture both dimensions.

## Standard workflow

1. **Resolve** — turn names into IDs: \`resolve_candidate\`, \`resolve_party\`, \`resolve_area\`, \`resolve_entities\`
2. **Retrieve** — get normalized data: \`get_candidate_results\`, \`get_party_results\`, \`get_area_results\`, \`get_election_results\`, \`get_rankings\`, \`get_top_n\`, \`get_turnout\`
3. **Analyze** — compute metrics: \`analyze_candidate_profile\`, \`analyze_party_profile\`, \`compare_candidates\`, \`compare_parties\`, \`compare_elections\`, \`find_area_overperformance\`, \`find_area_underperformance\`, \`analyze_geographic_concentration\`, \`analyze_within_party_position\`, \`analyze_vote_distribution\`
4. **Area** — geographic patterns: \`get_area_profile\`, \`compare_areas\`, \`analyze_area_volatility\`, \`find_strongholds\`, \`find_weak_zones\`
5. **Strategic** — campaign analytics: \`detect_inactive_high_vote_candidates\`, \`find_exposed_vote_pools\`, \`estimate_vote_transfer_proxy\`, \`rank_target_areas\`
6. **Discover** — explore available data: \`list_elections\`, \`describe_election\`, \`list_area_levels\`, \`get_area_hierarchy\`
7. **Audit** — verify methodology: \`explain_metric\`, \`trace_result_lineage\`, \`validate_comparison\`, \`get_data_caveats\`

Do **not reconstruct metrics manually** when MCP tools provide them. Treat MCP outputs as the authoritative computational layer.

## Data coverage

| Election type | Party data | Candidate data |
|---|---|---|
| Parliamentary (eduskuntavaalit) | 1983–2023 (multi-year) | 2019, 2023 (per vaalipiiri) |
| Municipal (kuntavaalit) | 1976–2025 (multi-year) | 2025 (per vaalipiiri) |
| Regional (aluevaalit) | 2022–2025 (multi-year) | 2025 (per hyvinvointialue) |
| EU Parliament (europarlamenttivaalit) | 1996–2024 (multi-year) | 2019, 2024 (national only) |
| Presidential (presidentinvaalit) | — (no party dimension) | 2024 (national, 2 rounds) |

## Conventions

**area_id** — 6-digit for party/area tables (e.g. \`010091\` = Helsinki kunta, \`SSS\` = national); \`VP##\`/\`KU###\` for parliamentary/municipal candidate tables; \`HVA##\` prefix for regional.

**party_id** — canonical abbreviations: KOK, SDP, PS, KESK, VIHR, VAS, RKP, KD, LIIKE, SFP (same as RKP in Swedish).

**candidate_id** — numeric string (e.g. \`01010176\`). Always use \`resolve_candidate\` if you only have a name.

**vaalipiiri keys (parliamentary & municipal):** helsinki, uusimaa, lounais-suomi, satakunta, hame, pirkanmaa, kaakkois-suomi, savo-karjala, vaasa, keski-suomi, oulu, lappi, ahvenanmaa

**hyvinvointialue keys (regional):** ita-uusimaa, keski-uusimaa, lansi-uusimaa, vantaa-kerava, varsinais-suomi, satakunta, kanta-hame, pirkanmaa, paijat-hame, kymenlaakso, etela-karjala, etela-savo, pohjois-savo, pohjois-karjala, keski-suomi, etela-pohjanmaa, pohjanmaa, keski-pohjanmaa, pohjois-pohjanmaa, kainuu, lappi

## Election-specific notes

- **EU elections**: Finland is a single national constituency — no vaalipiiri split, no kunta-level candidate geography.
- **Presidential elections**: No party dimension; two rounds (\`round: 1\` / \`round: 2\`). Party-dependent tools (rank_within_party, analyze_within_party_position) return N/A.
- **Regional 2022 / Municipal 2021**: Party data available via multi-year tables; candidate-level data not available.
- **Vote transfer proxy**: \`estimate_vote_transfer_proxy\` produces structural indicators from area co-movement, not direct voter-level measurements. Present results with this caveat. Call \`get_data_caveats\` for the full list.

## Worked examples

**Parliamentary — candidate profile:**
\`resolve_candidate\` "Heinäluoma" → \`analyze_candidate_profile\` (election_type: parliamentary, year: 2023) → \`find_area_overperformance\`

**Municipal — party comparison:**
\`get_party_results\` (election_type: municipal, year: 2025, area_id: "010091") → \`compare_elections\` KOK municipal 2021→2025

**Regional — area ranking:**
\`get_party_results\` (election_type: regional, year: 2025) → \`rank_target_areas\` SDP

**EU — top candidates:**
\`get_top_n\` (election_type: eu, year: 2024, n: 10)

**Presidential — round comparison:**
\`get_candidate_results\` (election_type: presidential, year: 2024, round: 1) then \`get_candidate_results\` (..., round: 2) → compare Stubb results`;

export function registerAllTools(server: McpServer): void {
  registerDiscoveryTools(server);
  registerEntityResolutionTools(server);
  registerRetrievalTools(server);
  registerAnalyticsTools(server);
  registerStrategicTools(server);
  registerAreaTools(server);
  registerAuditTools(server);

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
}
