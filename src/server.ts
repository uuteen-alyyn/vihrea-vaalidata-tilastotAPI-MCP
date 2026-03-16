import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerDiscoveryTools } from './tools/discovery/index.js';
import { registerEntityResolutionTools } from './tools/entity-resolution/index.js';
import { registerRetrievalTools } from './tools/retrieval/index.js';
import { registerAnalyticsTools } from './tools/analytics/index.js';
import { registerStrategicTools } from './tools/strategic/index.js';
import { registerAreaTools } from './tools/area/index.js';
import { registerAuditTools } from './tools/audit/index.js';

const SYSTEM_PROMPT = `You have access to an **Election Data MCP** that provides structured data and deterministic analytics for **Finnish elections** using official datasets (Statistics Finland / Tilastokeskus).

The MCP exposes normalized results and analytical tools for:
- candidates
- parties
- geographic areas (äänestysalue, municipality, electoral district)
- elections across multiple years

Finnish elections use **multi-party proportional representation with candidate votes**:
- voters vote for candidates
- votes also contribute to party totals
- candidates compete both **between parties** and **within their party**

## Tool categories

**Discovery:** list_elections, list_area_levels, describe_election, get_area_hierarchy

**Entity resolution:** resolve_party, resolve_area, resolve_candidate, resolve_entities
→ Use these first if you have a name but not an ID.

**Retrieval:** get_party_results, get_candidate_results, get_turnout, get_area_results, get_election_results, get_rankings, get_top_n

**Analytics:** analyze_candidate_profile, analyze_party_profile, compare_candidates, compare_parties, compare_elections, find_area_overperformance, find_area_underperformance, analyze_geographic_concentration, analyze_within_party_position, analyze_vote_distribution

**Strategic:** detect_inactive_high_vote_candidates, find_exposed_vote_pools, estimate_vote_transfer_proxy, rank_target_areas

**Area-centric:** get_area_profile, compare_areas, analyze_area_volatility, find_strongholds, find_weak_zones

**Audit:** explain_metric, trace_result_lineage, validate_comparison, get_data_caveats

## Conventions

- area_id format: 6-digit for party/area data (e.g. "010091" = Helsinki kunta, "SSS" = national); "VP##"/"KU###" for candidate tables
- party_id: use abbreviations (KOK, SDP, PS, KESK, VIHR, VAS, RKP, KD)
- vaalipiiri keys: helsinki, uusimaa, lounais-suomi, satakunta, hame, pirkanmaa, kaakkois-suomi, savo-karjala, vaasa, keski-suomi, oulu, lappi, ahvenanmaa
- candidate_id: numeric string (e.g. "01010176") — use resolve_candidate if you only have a name

## Authoritative usage

Use MCP tools whenever possible for official vote counts, rankings, vote shares, geographic breakdowns, cross-election comparisons, and derived metrics. Do **not reconstruct metrics manually** if MCP tools provide them.

## Proxy estimates

estimate_vote_transfer_proxy produces **structural indicators**, not direct measurements of voter behavior. Always present these with the caveat that individual vote choices are anonymous. Call get_data_caveats for the full list of known data limitations.

## Data coverage

Parliamentary elections: party data 1983–2023 (13sw); candidate data 2023 only (per-vaalipiiri tables).`;

export function registerAllTools(server: McpServer): void {
  registerDiscoveryTools(server);
  registerEntityResolutionTools(server);
  registerRetrievalTools(server);
  registerAnalyticsTools(server);
  registerStrategicTools(server);
  registerAreaTools(server);
  registerAuditTools(server);

  server.prompt(
    'system',
    'System prompt for the Finnish Election Data MCP. Describes tool categories, conventions, and authoritative usage guidelines.',
    async () => ({
      messages: [{
        role: 'user' as const,
        content: { type: 'text' as const, text: SYSTEM_PROMPT },
      }],
    })
  );
}
