/**
 * MCP Resources for the Finnish Election Data server.
 *
 * Resources expose structured reference data the LLM can read on demand,
 * without bloating tool descriptions or system prompts.
 *
 * Registered resources:
 *   election://coverage    — data availability by election type and year
 *   election://unit-keys   — valid unit_key values by election type and year
 *   election://metrics     — definitions and formulas for all computed metrics
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ALL_ELECTION_TABLES } from '../data/election-tables.js';

// ─── election://coverage ─────────────────────────────────────────────────────

function buildCoverageText(): string {
  const lines: string[] = [
    '# Finnish Election Data — Coverage',
    '',
    'This resource lists which data types are available for each election.',
    'Call this before querying an election/year combination you are unsure about.',
    '',
    '## Legend',
    '- party_data: party vote results are available',
    '- candidate_data: individual candidate results are available',
    '- unit_keys: unit_key values accepted by resolve_candidate / get_candidate_results',
    '  (call election://unit-keys for the full list per election)',
    '',
    '## Coverage by election type',
    '',
  ];

  const byType: Record<string, typeof ALL_ELECTION_TABLES> = {};
  for (const t of ALL_ELECTION_TABLES) {
    if (!byType[t.election_type]) byType[t.election_type] = [];
    byType[t.election_type]!.push(t);
  }

  for (const [electionType, tables] of Object.entries(byType)) {
    lines.push(`### ${electionType}`);
    for (const t of tables.sort((a, b) => a.year - b.year)) {
      const hasParty = !!(t.party_by_kunta);
      const hasCandidate = !!(t.candidate_by_aanestysalue || t.candidate_national);
      const unitCount = t.candidate_by_aanestysalue
        ? Object.keys(t.candidate_by_aanestysalue).length
        : t.candidate_national ? 1 : 0;
      const unitType = t.geographic_unit_type ?? 'national';

      const parts: string[] = [];
      if (hasParty) parts.push('party_data=yes');
      // Note: multi-year party tables are shared — clarify
      if (!t.party_by_kunta) parts.push('party_data=via_multiyear_fallback');
      if (hasCandidate) {
        parts.push(`candidate_data=yes (${unitCount} ${unitType} unit${unitCount !== 1 ? 's' : ''})`);
      } else {
        parts.push('candidate_data=no');
      }

      lines.push(`- ${t.year}: ${parts.join(', ')}`);
    }
    lines.push('');
  }

  lines.push('## Notes');
  lines.push('- Parliamentary party data: multi-year table 13sw covers 1983–2023.');
  lines.push('- Municipal party data: multi-year table 14z7 covers 1976–2025.');
  lines.push('- Regional party data: multi-year table 14y4 covers 2022–2025.');
  lines.push('- EU party data: multi-year table 14gv covers 1996–2024.');
  lines.push('- Voter background (get_voter_background): parliamentary 2011/2015/2019/2023; municipal 2012/2017/2021/2025 only.');
  lines.push('- Voter turnout by demographics: parliamentary 2023, municipal 2025, EU 2024, presidential 2024 only.');

  return lines.join('\n');
}

// ─── election://unit-keys ─────────────────────────────────────────────────────

function buildUnitKeysText(): string {
  const lines: string[] = [
    '# Finnish Election Data — Valid Unit Keys',
    '',
    'Use these unit_key values in resolve_candidate and get_candidate_results.',
    'Parliamentary and municipal: unit_key = vaalipiiri (electoral district).',
    'Regional: unit_key = hyvinvointialue (welfare area).',
    'EU parliament and presidential: no unit_key needed (single national table).',
    '',
    '## unit_key lists by election type and year',
    '',
  ];

  const byType: Record<string, typeof ALL_ELECTION_TABLES> = {};
  for (const t of ALL_ELECTION_TABLES) {
    if (!byType[t.election_type]) byType[t.election_type] = [];
    byType[t.election_type]!.push(t);
  }

  for (const [electionType, tables] of Object.entries(byType)) {
    const unitTables = tables.filter((t) => t.candidate_by_aanestysalue);
    if (unitTables.length === 0) {
      lines.push(`### ${electionType}`);
      lines.push('No per-unit candidate tables. Use unit_key="national" or omit.');
      lines.push('');
      continue;
    }

    lines.push(`### ${electionType}`);
    for (const t of unitTables.sort((a, b) => a.year - b.year)) {
      const keys = Object.keys(t.candidate_by_aanestysalue!);
      const unitType = t.geographic_unit_type ?? 'vaalipiiri';
      lines.push(`#### ${t.year} (${unitType})`);
      lines.push(keys.join(', '));
      lines.push('');
    }
  }

  lines.push('## Common pitfalls');
  lines.push('- Parliamentary: use "hame" not "häme"; "lounais-suomi" not "varsinais-suomi".');
  lines.push('- Parliamentary 2007/2011 used 15 vaalipiiri; keys differ (kymi, etela-savo, pohjois-savo, pohjois-karjala instead of kaakkois-suomi/savo-karjala).');
  lines.push('- Regional: "varsinais-suomi" is a hyvinvointialue key for regional elections but NOT a vaalipiiri key for parliamentary.');

  return lines.join('\n');
}

// ─── election://metrics ──────────────────────────────────────────────────────

const METRICS_TEXT = `# Finnish Election Data — Metric Definitions

All metrics computed by this MCP server. Use explain_metric(key) for full detail.

## ENP — Effective Number of Parties
Formula: ENP = 1 / Σ(pi²)  where pi = party vote share as fraction (0–1)
Used in: analyze_party_profile (election_enp), get_area_profile (area_enp)
Interpretation: Finnish parliamentary elections typically 5–7. Below 3 = two-party dominance.
Source: Laakso-Taagepera (1979).

## Pedersen Volatility Index
Formula: Pedersen = Σ|share_t - share_{t-1}| / 2
Unit: percentage points (pp)
Used in: get_area_profile, analyze_area_volatility
Interpretation: 0 = identical results; Finnish elections typically 8–15pp; above 15 = high volatility.
Note: pedersen_index is the standard published value. pedersen_normalized_heuristic divides by
(years_between/4) — this is a non-standard heuristic, not comparable to academic literature.

## Vote Share
Formula: vote_share = subject_votes / total_valid_votes_in_area
Unit: percent (0–100)
Sourced directly from Tilastokeskus (not recomputed). All vote_share_pct fields in tool output.

## Rank Within Party
Formula: ordinal position among party candidates in vaalipiiri, sorted by votes descending.
Used in: analyze_candidate_profile
Caveat: rank_within_party is intra-party only. It does NOT determine seat allocation.
Seats are allocated by D'Hondt across the whole party list.

## Share of Party Vote
Formula: (candidate_votes_in_vaalipiiri / sum_party_candidate_votes_in_vaalipiiri) × 100
Unit: percent (0–100)
Used in: analyze_candidate_profile (share_of_party_vote_pct)

## Overperformance (pp)
Formula: overperformance_pp = area_vote_share - baseline_vote_share
Baseline for parties: national vote share. Baseline for candidates: vaalipiiri vote share.
Used in: find_area_overperformance (direction='over')
Positive = performed better than baseline in this area.

## Top-N Area Share (Geographic Concentration)
Formula: top_n_share = sum(votes_in_top_N_areas) / total_votes
Unit: ratio (0–1)
Used in: analyze_geographic_concentration, analyze_candidate_profile
For parties: kunta level. For candidates: äänestysalue level.

## Party Presence Composite Score
Formula: composite = 0.40×c1 + 0.35×c2 + 0.25×c3
  c1 = min(area_share / (3 × national_share), 1)   [current support above national avg]
  c2 = percentile rank of (area_share_now − area_share_trend_year)  [trend]
  c3 = area_total_votes / max_area_total_votes  [electorate size]
Used in: rank_areas_for_party
Warning: weights are heuristic, not empirically calibrated.

## Vote Transfer Proxy
Not a standard metric. Classifies areas by co-movement between a party's decline and
another party's gain. Output is a structural indicator, NOT evidence of actual voter movement.
Individual-level transfer data is not available in aggregate statistics.
Used in: estimate_vote_transfer_proxy
`;

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerResources(server: McpServer): void {
  server.resource(
    'election-coverage',
    'election://coverage',
    { description: 'Data availability by election type and year. Lists which elections have party data, candidate data, and how many unit keys.' },
    async (_uri) => ({
      contents: [{
        uri: 'election://coverage',
        mimeType: 'text/plain',
        text: buildCoverageText(),
      }],
    })
  );

  server.resource(
    'election-unit-keys',
    'election://unit-keys',
    { description: 'Valid unit_key values for resolve_candidate and get_candidate_results, by election type and year. Derived live from the registry.' },
    async (_uri) => ({
      contents: [{
        uri: 'election://unit-keys',
        mimeType: 'text/plain',
        text: buildUnitKeysText(),
      }],
    })
  );

  server.resource(
    'election-metrics',
    'election://metrics',
    { description: 'Definitions and formulas for all computed metrics: ENP, Pedersen index, vote share, overperformance, composite score, and more.' },
    async (_uri) => ({
      contents: [{
        uri: 'election://metrics',
        mimeType: 'text/plain',
        text: METRICS_TEXT,
      }],
    })
  );
}
