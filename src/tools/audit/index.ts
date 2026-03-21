import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { mcpText } from '../shared.js';

// ─── Metric definitions ───────────────────────────────────────────────────────

const METRIC_REGISTRY: Record<string, {
  name: string;
  used_in: string[];
  definition: string;
  formula: string;
  unit: string;
  notes: string[];
}> = {
  enp: {
    name: 'Effective Number of Parties',
    used_in: ['analyze_party_profile (field: election_enp)', 'get_area_profile (field: area_enp)'],
    definition: 'Measures the effective (vote-weighted) number of parties in an election. A higher value means votes are spread across more parties; a lower value means one or two parties dominate.',
    formula: 'ENP = 1 / Σ(pi²) where pi = party vote share as fraction (0–1)',
    unit: 'dimensionless',
    notes: [
      'Laakso-Taagepera (1979). The standard measure in comparative electoral research.',
      'Finnish parliamentary elections typically produce ENP 5–7.',
      'ENP < 3 indicates strong two-party or one-party dominance.',
      'Computed from party-level vote_share values (koko_suomi for election_enp; area-level for area_enp). SSS aggregate rows are excluded.',
    ],
  },
  pedersen_index: {
    name: 'Pedersen Volatility Index',
    used_in: ['get_area_profile', 'analyze_area_volatility'],
    definition: 'Measures total electoral change between two elections. Sums the absolute change in vote share for each party and halves the result (to avoid double-counting gains and losses). A value of 10 means 10 percentage points of vote share moved between parties.',
    formula: 'Pedersen = Σ |share_party_t - share_party_{t-1}| / 2',
    unit: 'percentage points (pp)',
    notes: [
      'Range: 0 (identical results) to 100 (complete turnover of parties).',
      'Finnish parliamentary elections typically show 8–15pp. Values above 15 indicate high volatility.',
      'Computed from 13sw party vote shares at the specified area level.',
      'New and disappeared parties contribute their full share to the index.',
      'pedersen_index is the standard published value (Pedersen 1979). pedersen_normalized_heuristic divides by (years_between/4) to adjust for election gap — this normalization is non-standard and not published in comparative literature; treat as indicative only.',
    ],
  },
  vote_share: {
    name: 'Vote Share',
    used_in: ['all retrieval and analytics tools'],
    definition: 'A party\'s or candidate\'s votes as a fraction of all valid votes cast in the area. Sourced directly from Tilastokeskus (evaa_osuus_aanista field).',
    formula: 'vote_share = candidate_or_party_votes / total_valid_votes_in_area',
    unit: 'percent (%) — values 0–100',
    notes: [
      'Tilastokeskus computes this directly; this MCP reports it as provided.',
      'For candidates: denominator is all valid votes in the area (not just within-party votes).',
      'For parties: denominator is all valid votes in the area.',
      'Advance votes and election-day votes are combined.',
    ],
  },
  rank_within_party: {
    name: 'Rank Within Party',
    used_in: ['analyze_candidate_profile', 'analyze_within_party_position'],
    definition: 'A candidate\'s ordinal position among all candidates from the same party in the same vaalipiiri, ranked by total votes descending. Rank 1 = highest-voted party candidate.',
    formula: 'rank_within_party = position in [party candidates sorted by votes_in_vaalipiiri DESC]',
    unit: 'ordinal integer (1 = best)',
    notes: [
      'Computed at vaalipiiri level using the VP## aggregate row.',
      'Ties broken by the order returned by the API (stable sort).',
      'Does not reflect who actually got elected — seats are allocated by d\'Hondt method across all party candidates.',
    ],
  },
  share_of_party_vote: {
    name: 'Share of Party Vote',
    used_in: ['analyze_candidate_profile (field: share_of_party_vote_pct)', 'analyze_within_party_position (field: share_of_party_vote_pct)'],
    definition: 'A candidate\'s votes as a percentage of their party\'s total votes in the vaalipiiri. Measures how dominant the candidate is within their own party\'s support.',
    formula: 'share_of_party_vote_pct = (candidate_votes_in_vaalipiiri / sum(all_party_candidates_votes_in_vaalipiiri)) × 100',
    unit: 'percentage (0–100)',
    notes: [
      'Vaalipiiri-level values only (VP## row).',
      'A value of 50 means the candidate accounts for half of their party\'s total vote in the district.',
    ],
  },
  overperformance_pp: {
    name: 'Overperformance (percentage points)',
    used_in: ['find_area_overperformance'],
    definition: 'The difference between a subject\'s vote share in a specific area and their baseline vote share. Positive = performed better than baseline in this area.',
    formula: 'overperformance_pp = area_vote_share - baseline_vote_share',
    unit: 'percentage points (pp)',
    notes: [
      'Baseline for parties: national vote share (koko_suomi row in 13sw).',
      'Baseline for candidates: their vote share at the vaalipiiri level (VP## row).',
      'Baselines are stated explicitly in every tool output\'s method field.',
    ],
  },
  underperformance_pp: {
    name: 'Underperformance (percentage points)',
    used_in: ['find_area_underperformance'],
    definition: 'The difference between a subject\'s baseline vote share and their vote share in a specific area. Positive = performed worse than baseline in this area.',
    formula: 'underperformance_pp = baseline_vote_share - area_vote_share',
    unit: 'percentage points (pp)',
    notes: [
      'Mirror metric of overperformance_pp.',
      'Baseline definitions are identical to overperformance_pp.',
    ],
  },
  top_n_share: {
    name: 'Top-N Area Share (Geographic Concentration)',
    used_in: ['analyze_geographic_concentration', 'analyze_candidate_profile'],
    definition: 'The fraction of a subject\'s total votes held by their top N geographic areas. Measures how geographically concentrated the vote is.',
    formula: 'top_n_share = sum(votes_in_top_n_areas) / total_votes',
    unit: 'ratio (0–1)',
    notes: [
      'top1_share, top3_share, top5_share, top10_share reported.',
      'A value close to 1 means nearly all votes come from very few areas (highly concentrated).',
      'For parties: computed at kunta level. For candidates: at äänestysalue level.',
      'Uses raw vote counts (not vote shares) to determine top areas.',
    ],
  },
  composite_score: {
    name: 'Party Presence Composite Score',
    used_in: ['rank_areas_for_party'],
    definition: 'A weighted composite of three independent components scoring a municipality by historical party presence. All components are normalized to [0, 1]. Ranks areas by where the party already has support — not by persuasion opportunity.',
    formula: 'composite = 0.40×c1_current_support + 0.35×c2_trend + 0.25×c3_size',
    unit: 'dimensionless score (0–1)',
    notes: [
      'c1_current_support: current vote share relative to national average (above-average = higher score).',
      'c2_trend: vote share change since trend_year, normalized. 0.5 if no trend year provided.',
      'c3_size: total votes cast in area relative to the largest area (electorate size, not party vote volume).',
      'Weights are heuristic and not empirically calibrated. Scores are relative to this party\'s own distribution, not cross-party.',
      'Full component breakdown is returned in every rank_areas_for_party output.',
    ],
  },
  vote_transfer_proxy: {
    name: 'Vote Transfer Proxy (Co-Movement)',
    used_in: ['estimate_vote_transfer_proxy'],
    definition: 'A structural proxy estimating whether votes moved from one party to another between two elections. Measured by the fraction of municipalities where Party A lost votes AND Party B gained votes simultaneously.',
    formula: 'co_movement_pct = count(areas where loser_change < 0 AND gainer_change > 0) / count(all areas analysed)',
    unit: 'percent (%) of areas showing consistent co-movement',
    notes: [
      'IMPORTANT: This is NOT a measured voter transfer. Individual vote choices are anonymous.',
      'proxy_method is always "election result inference".',
      'confidence is always "structural indicator".',
      'Alternative explanations always apply: differential turnout, new voters, three-way movement.',
      'A high co-movement rate increases the structural plausibility of a transfer pattern but does not confirm it.',
    ],
  },
};

// ─── Source table registry ────────────────────────────────────────────────────

const TABLE_DESCRIPTIONS: Record<string, {
  table_id: string;
  title: string;
  coverage: string;
  variables: string[];
  area_code_format: string;
  used_by: string[];
}> = {
  statfin_evaa_pxt_13sw: {
    table_id: 'statfin_evaa_pxt_13sw',
    title: 'Party votes by municipality (vaalipiiri ja kunta vaalivuonna), parliamentary elections',
    coverage: 'All parliamentary elections 1983–2023. All municipalities. National, vaalipiiri, and kunta levels.',
    variables: ['Vuosi (year)', 'Sukupuoli (gender — use SSS for total)', 'Puolue (party)', 'Vaalipiiri ja kunta vaalivuonna (area)', 'Tiedot (measures: evaa_aanet votes, evaa_osuus_aanista vote share, etc.)'],
    area_code_format: 'SSS = national total, {vp:02}{kunta:03} e.g. 010091 = Helsinki (VP01 + KU091), {vp:02}0000 = vaalipiiri total',
    used_by: ['get_party_results', 'get_area_results', 'get_election_results', 'get_rankings', 'analyze_party_profile', 'compare_parties', 'compare_elections', 'find_area_overperformance', 'find_area_underperformance', 'analyze_geographic_concentration', 'analyze_vote_distribution', 'find_vote_decline_areas', 'estimate_vote_transfer_proxy', 'rank_areas_for_party', 'get_area_profile', 'compare_areas', 'analyze_area_volatility', 'find_strongholds', 'find_weak_zones'],
  },
  statfin_evaa_pxt_13sx: {
    table_id: 'statfin_evaa_pxt_13sx',
    title: 'Voter turnout by voting area (äänestysalue), parliamentary elections',
    coverage: '2023 parliamentary election. All äänestysalueet. Includes advance votes and election-day votes.',
    variables: ['Vuosi (year)', 'Sukupuoli (gender)', 'Alue (area)', 'Tiedot (measures: turnout %, eligible voters, votes cast, etc.)'],
    area_code_format: 'Same as candidate tables: VP## (vaalipiiri), KU### (kunta), alphanumeric (äänestysalue)',
    used_by: ['get_turnout'],
  },
  'statfin_evaa_pxt_13t6–13ti': {
    table_id: 'statfin_evaa_pxt_13t6 through statfin_evaa_pxt_13ti (13 tables)',
    title: 'Candidate votes by äänestysalue per vaalipiiri, 2023 parliamentary election',
    coverage: '2023 parliamentary election only. One table per vaalipiiri (13 total). All candidates × all äänestysalueet.',
    variables: ['Vuosi (year)', 'Alue/Äänestysalue (area)', 'Ehdokas (candidate — valueText: "Name / Party / Vaalipiiri")', 'Valintatieto (election result — use SSS for total)', 'Tiedot (evaa_aanet votes, evaa_osuus_aanista share)'],
    area_code_format: 'VP## = vaalipiiri aggregate, KU### = kunta aggregate, alphanumeric = äänestysalue',
    used_by: ['get_candidate_results', 'get_rankings (candidates)', 'get_top_n (candidates)', 'analyze_candidate_profile', 'compare_candidates', 'find_area_overperformance (candidate)', 'analyze_geographic_concentration (candidate)', 'analyze_within_party_position', 'analyze_vote_distribution (candidate)', 'find_strongholds (candidate)', 'find_weak_zones (candidate)', 'detect_inactive_high_vote_candidates'],
  },
};

// ─── Known caveats registry ───────────────────────────────────────────────────

const CAVEATS: Record<string, {
  id: string;
  severity: 'critical' | 'moderate' | 'minor';
  affects: string[];
  description: string;
  workaround?: string;
}> = {
  candidate_data_2023_only: {
    id: 'candidate_data_2023_only',
    severity: 'critical',
    affects: ['get_candidate_results', 'analyze_candidate_profile', 'compare_candidates', 'analyze_within_party_position', 'detect_inactive_high_vote_candidates', 'find_strongholds (candidate)', 'find_weak_zones (candidate)'],
    description: 'Candidate-level data with äänestysalue breakdown is only available for the 2023 parliamentary election. The 2019 and older candidate tables are in the StatFin_Passiivi archive database and have not yet been mapped in this MCP\'s registry.',
    workaround: 'For historical candidate analysis, use party-level data from 13sw (covers 1983–2023). detect_inactive_high_vote_candidates requires both from_year and to_year to be in the registry.',
  },
  vote_transfer_proxy_only: {
    id: 'vote_transfer_proxy_only',
    severity: 'critical',
    affects: ['estimate_vote_transfer_proxy'],
    description: 'Vote transfer estimates are structural inferences from aggregate area-level data only. Finnish election data does not include individual voter choices. Any "transfer" figure is a proxy based on co-movement of party vote totals in the same area between elections.',
    workaround: 'Always report proxy_method: "election result inference" and confidence: "structural indicator" when using these estimates. Consider alternative explanations (differential turnout, new voters, three-way movements).',
  },
  municipality_boundary_changes: {
    id: 'municipality_boundary_changes',
    severity: 'moderate',
    affects: ['compare_elections', 'analyze_area_volatility', 'find_vote_decline_areas', 'estimate_vote_transfer_proxy'],
    description: 'Finnish municipality boundaries have changed significantly since 1983 due to mergers and reorganizations. Area codes in 13sw use the boundary definitions as of the election year (vaalivuosi). Comparing the same area_id across elections may include different geographic units.',
    workaround: 'For long-range historical comparisons, focus on stable municipalities or vaalipiiri-level data. Use validate_comparison to check specific pairs.',
  },
  party_id_numeric_codes: {
    id: 'party_id_numeric_codes',
    severity: 'minor',
    affects: ['all tools returning party_id'],
    description: 'The party_id field in normalized ElectionRecord rows uses PxWeb numeric codes (e.g. "03" for KESK, "04" for KOK) — NOT the Finnish abbreviations. The party_name field contains the abbreviation (e.g. "KOK"). All analytics tools in this MCP accept both the numeric code and the abbreviation via matchesParty() logic.',
    workaround: 'Use the abbreviation (KOK, SDP, etc.) when calling tools. Use resolve_party if unsure of the correct identifier.',
  },
  national_candidate_query_slow: {
    id: 'national_candidate_query_slow',
    severity: 'minor',
    affects: ['get_candidate_results (all vaalipiirit)', 'resolve_candidate (no vaalipiiri)'],
    description: 'Fetching candidate data for all 13 vaalipiirit requires 13 sequential API calls due to the per-vaalipiiri table structure. With a 10 req/10s rate limit, a full national candidate query takes approximately 15–30 seconds. Results are cached after first fetch.',
    workaround: 'Always specify vaalipiiri when possible. Cache TTL is 1 hour — repeated queries within that window are instant.',
  },
  vote_share_from_tilastokeskus: {
    id: 'vote_share_from_tilastokeskus',
    severity: 'minor',
    affects: ['all tools using vote_share'],
    description: 'Vote share values (evaa_osuus_aanista) are computed by Tilastokeskus and reported as-is. The denominator is all valid votes cast in the area. Blank votes and invalid votes are excluded from the denominator.',
    workaround: 'None needed — this is the standard electoral vote share definition.',
  },
  sss_party_total_row: {
    id: 'sss_party_total_row',
    severity: 'minor',
    affects: ['tools reading 13sw without SSS filter'],
    description: 'The 13sw Puolue variable includes a total row with party_id "SSS" (Puolueiden äänet yhteensä, 100% vote share). All area-centric and party-ranking tools in this MCP filter this row out. Raw data mode (output_mode=data) includes it.',
    workaround: 'Filter rows where party_id === "SSS" when processing raw data output.',
  },
  // ── Open analytical framing issues (POL-series) ──────────────────────────
  rank_within_party_no_seat_data: {
    id: 'rank_within_party_no_seat_data',
    severity: 'critical',
    affects: ['analyze_candidate_profile', 'analyze_within_party_position'],
    description: 'rank_within_party is an intra-party ordering by votes only. A candidate ranked #1 in their party may or may not have won a seat — seat allocation depends on the party\'s total vote count and the d\'Hondt divisor calculation across all competing parties. This MCP does not model seat allocation and contains no seat outcome data.',
    workaround: 'Do not infer seat outcomes from rank_within_party alone. Seat data must be obtained from an external source (e.g. eduskunta.fi). Every output containing rank_within_party includes a rank_within_party_caveat field stating this explicitly.',
  },
  c2_trend_percentile_scale: {
    id: 'c2_trend_percentile_scale',
    severity: 'moderate',
    affects: ['rank_areas_for_party'],
    description: 'The c2_trend component of the composite area score is a percentile rank of vote share change across the actual distribution of changes for the selected party/election pair. All scores are relative — an area scoring c2=0.8 has a larger vote share increase than 80% of scored areas, but the absolute change may be small. c2 does not generalize across different party/election combinations.',
    workaround: 'Inspect trend_change_pp in each area\'s data block for absolute magnitude. Compare across parties with care — percentile rank is relative to each party\'s own distribution.',
  },
  pedersen_period_length: {
    id: 'pedersen_period_length',
    severity: 'moderate',
    affects: ['get_area_profile', 'analyze_area_volatility'],
    description: 'The Pedersen volatility index is computed between two consecutive elections but is not normalized for the length of the inter-election period. A 4-year gap and an 8-year gap produce incomparable Pedersen values for the same underlying rate of change. Finnish parliamentary elections are typically 4 years apart but snap elections and EU election gaps vary.',
    workaround: 'Use years_between in the output to assess comparability. For cross-election-type comparisons, treat Pedersen values as indicative only. Divide by years_between to approximate per-year volatility rate (not provided directly).',
  },
  compare_across_elections_eu_second_order: {
    id: 'compare_across_elections_eu_second_order',
    severity: 'moderate',
    affects: ['compare_across_elections'],
    description: 'EU Parliament elections are second-order elections (Reif & Schmitt 1980): turnout is typically 40% vs 70–75% in Finnish parliamentary elections. The EU electorate is self-selected and not representative of the parliamentary-election electorate. Vote shares and trends from EU elections are structurally incomparable to national elections. Municipal elections further differ by allowing all residents 18+ (including non-citizens) to vote, unlike parliamentary elections which require Finnish citizenship.',
    workaround: 'Always include the election_type field when reporting cross-election comparisons. Cross-type comparability_notes are provided in compare_across_elections output. Treat EU-to-parliamentary trend as directional indicator only, not a direct vote-share comparison.',
  },
  valintatieto_outcome_coverage: {
    id: 'valintatieto_outcome_coverage',
    severity: 'moderate',
    affects: ['analyze_candidate_profile (field: election_outcome)'],
    description: 'election_outcome (elected / varalla / not_elected) is sourced from the Valintatieto dimension in Tilastokeskus tables — this is the official, authoritative election outcome as declared by Tilastokeskus. It is available for parliamentary 2023, municipal 2025, and regional 2025. It is null for EU parliament and presidential elections (no Valintatieto dimension in those tables).',
    workaround: 'For EU elections, a candidate\'s elected status can be inferred from table 14gz (elected MEPs only). For presidential elections, the round-2 winner has >50% of votes. Use election_outcome === null as a signal to check election_type before drawing conclusions.',
  },
  incumbent_flag_limited: {
    id: 'incumbent_flag_limited',
    severity: 'minor',
    affects: ['analyze_candidate_profile'],
    description: 'The incumbent flag (was the candidate a sitting councillor / aluevaltuutettu at the time of the election?) is available in Tilastokeskus tables for municipal (kvaa_kunnanvalt) and regional (alvaa_aluevalt) elections. It is not published for parliamentary elections. The flag is not yet exposed as a field in analyze_candidate_profile output.',
    workaround: 'For parliamentary incumbency, cross-reference with eduskunta.fi manually. Municipal/regional incumbent data will be added in a future update.',
  },
  enp_votes_not_seats: {
    id: 'enp_votes_not_seats',
    severity: 'minor',
    affects: ['analyze_party_profile (field: election_enp)', 'get_area_profile (field: area_enp)'],
    description: 'ENP (Effective Number of Parties) in this MCP is computed from vote shares, not seat shares (vote-ENP). In a proportional system, vote-ENP and seat-ENP differ because smaller parties may win votes but no seats. Finnish parliamentary vote-ENP is typically 5–7; seat-ENP is lower due to the threshold effect of the D\'Hondt system.',
    workaround: 'When discussing party system fragmentation in terms of parliamentary power, note that seat allocation reduces ENP relative to the vote share figure. Seat data is not available in this MCP.',
  },
};

// ─── Tool registration ────────────────────────────────────────────────────────

export function registerAuditTools(server: McpServer): void {

  // ── explain_metric ────────────────────────────────────────────────────────
  server.tool(
    'explain_metric',
    'Returns the definition, formula, unit, and methodology notes for any metric used in this MCP\'s analytics outputs. Use this to understand what a number means before presenting it to a user.',
    {
      metric: z.string().describe('Metric name to look up. Known metrics: enp, pedersen_index, vote_share, rank_within_party, share_of_party_vote_pct, overperformance_pp, underperformance_pp, top_n_share, composite_score, vote_transfer_proxy. Partial name matching is supported.'),
    },
    async ({ metric }) => {
      const key = metric.toLowerCase().replace(/[^a-z0-9_]/g, '_');

      // Exact match first
      if (METRIC_REGISTRY[key]) {
        return mcpText({ metric: key, ...METRIC_REGISTRY[key] });
      }

      // Partial match
      const matches = Object.entries(METRIC_REGISTRY).filter(([k, v]) =>
        k.includes(key) || v.name.toLowerCase().includes(metric.toLowerCase())
      );

      if (matches.length === 1) {
        const [matchKey, def] = matches[0]!;
        return mcpText({ metric: matchKey, ...def });
      }

      if (matches.length > 1) {
        return mcpText({
          message: `Multiple metrics match "${metric}". Please specify:`,
          matches: matches.map(([k, v]) => ({ key: k, name: v.name, used_in: v.used_in })),
        });
      }

      return mcpText({
        error: `Metric "${metric}" not found.`,
        available_metrics: Object.entries(METRIC_REGISTRY).map(([k, v]) => ({ key: k, name: v.name })),
      });
    }
  );

  // ── trace_result_lineage ──────────────────────────────────────────────────
  server.tool(
    'trace_result_lineage',
    'Returns the data provenance for a tool\'s output: which Tilastokeskus source table was used, what variables were queried, how the data was normalized, and what transformations were applied. Use this to verify methodology or audit a specific result.',
    {
      tool_name: z.string().describe('Name of the MCP tool to trace (e.g. "analyze_candidate_profile", "compare_elections", "estimate_vote_transfer_proxy").'),
    },
    async ({ tool_name }) => {
      const lineage: Record<string, unknown> = {
        tool_name,
        source_tables: [] as string[],
        query_filters: [] as string[],
        normalization: [] as string[],
        transformations: [] as string[],
        caveats: [] as string[],
      };

      // Tool → lineage map
      const entries: Record<string, {
        source_tables: string[];
        query_filters: string[];
        normalization: string[];
        transformations: string[];
        caveats: string[];
      }> = {
        get_party_results: {
          source_tables: ['statfin_evaa_pxt_13sw'],
          query_filters: ['Vuosi = year', 'Sukupuoli = SSS (gender total)', 'Puolue = party_id or all', 'Vaalipiiri ja kunta vaalivuonna = area_id or all', 'Tiedot = evaa_aanet, evaa_osuus_aanista'],
          normalization: ['normalizePartyByKunta()', 'area_level inferred from 6-digit code format (SSS → koko_suomi, XX0000 → vaalipiiri, XXXXXX → kunta)', 'party_name from valueTexts'],
          transformations: ['None — raw normalized rows returned in data mode', 'In analysis mode: sorted by votes, ranked'],
          caveats: ['party_id_numeric_codes'],
        },
        get_candidate_results: {
          source_tables: ['statfin_evaa_pxt_13t6–13ti (one or all 13 depending on vaalipiiri parameter)'],
          query_filters: ['Vuosi = year', 'Alue/Äänestysalue = area_id or all', 'Ehdokas = candidate_id or all', 'Valintatieto = SSS (total)', 'Tiedot = evaa_aanet, evaa_osuus_aanista'],
          normalization: ['normalizeCandidateByAanestysalue()', 'area_level inferred (VP## → vaalipiiri, KU### → kunta, else → aanestysalue)', 'candidate name/party/vaalipiiri parsed from valueText "Name / Party / Vaalipiiri"'],
          transformations: ['Multiple vaalipiiri tables merged when no vaalipiiri filter specified'],
          caveats: ['candidate_data_2023_only', 'national_candidate_query_slow'],
        },
        analyze_candidate_profile: {
          source_tables: ['statfin_evaa_pxt_13t6–13ti (one per specified vaalipiiri)'],
          query_filters: ['All rows for the vaalipiiri loaded; filtered to candidate_id after fetch'],
          normalization: ['normalizeCandidateByAanestysalue()'],
          transformations: ['Rank computed from sorted vaalipiiri-level (VP##) rows', 'rank_within_party: sorted party candidates at VP level', 'share_of_party_vote_pct: (candidate_votes / sum(all party candidate votes at VP level)) × 100', 'Geographic analysis uses äänestysalue rows only (no double-counting)'],
          caveats: ['candidate_data_2023_only'],
        },
        compare_elections: {
          source_tables: ['statfin_evaa_pxt_13sw (single table, queried once per year)'],
          query_filters: ['Vuosi = year (per election)', 'Sukupuoli = SSS', 'Puolue = all', 'Area = area_id or SSS'],
          normalization: ['normalizePartyByKunta()', 'Party matched by party_id or party_name (case-insensitive)'],
          transformations: ['Vote change = votes_year2 - votes_year1', 'Vote share change = share_year2 - share_year1 (in pp)', 'Rank change = rank_year1 - rank_year2 (positive = improved)'],
          caveats: ['municipality_boundary_changes', 'party_id_numeric_codes'],
        },
        estimate_vote_transfer_proxy: {
          source_tables: ['statfin_evaa_pxt_13sw (queried twice: year1 and year2)'],
          query_filters: ['All parties and areas loaded per year', 'Filtered to losing_party and gaining_party after fetch'],
          normalization: ['normalizePartyByKunta()'],
          transformations: ['For each kunta: compute loser_change = votes2 - votes1, gainer_change = votes2 - votes1', 'co_movement = "consistent_with_transfer" if loser_change < 0 AND gainer_change > 0'],
          caveats: ['vote_transfer_proxy_only', 'municipality_boundary_changes'],
        },
        find_area_overperformance: {
          source_tables: ['Party: statfin_evaa_pxt_13sw', 'Candidate: statfin_evaa_pxt_13t6–13ti'],
          query_filters: ['Party: filtered by subject_id at kunta level', 'Candidate: all rows for vaalipiiri, then filtered to candidate_id'],
          normalization: ['normalizePartyByKunta() / normalizeCandidateByAanestysalue()'],
          transformations: ['overperformance_pp = area_vote_share - baseline', 'Party baseline = national vote share (koko_suomi row)', 'Candidate baseline = vaalipiiri vote share (VP## row)'],
          caveats: [],
        },
        analyze_area_volatility: {
          source_tables: ['statfin_evaa_pxt_13sw (queried once per year)'],
          query_filters: ['area_id filter applied; all parties returned'],
          normalization: ['normalizePartyByKunta()', 'SSS party total row excluded from computation'],
          transformations: ['Pedersen index computed per consecutive year pair', 'biggest_gainer / biggest_loser = max/min absolute change'],
          caveats: ['municipality_boundary_changes', 'sss_party_total_row'],
        },
        rank_areas_for_party: {
          source_tables: ['statfin_evaa_pxt_13sw (queried once per reference_year, once per trend_year if provided)'],
          query_filters: ['All parties and areas loaded; filtered to subject party after fetch'],
          normalization: ['normalizePartyByKunta()'],
          transformations: ['4-component composite score. See explain_metric(composite_score) for full formula.'],
          caveats: ['municipality_boundary_changes', 'party_id_numeric_codes'],
        },
      };

      const found = entries[tool_name];
      if (!found) {
        const available = Object.keys(entries);
        return mcpText({
          error: `No lineage entry for tool "${tool_name}".`,
          available_tools: available,
          note: 'For tools not listed, the source table is indicated in every tool response\'s method.source_table field.',
        });
      }

      return mcpText({
        tool_name,
        ...found,
        caveats_detail: found.caveats.map(id => CAVEATS[id]).filter(Boolean),
      });
    }
  );

  // ── validate_comparison ───────────────────────────────────────────────────
  server.tool(
    'validate_comparison',
    'Checks whether a proposed comparison is methodologically valid and flags known issues. Returns warnings, the validity assessment, and recommended alternatives where applicable.',
    {
      comparison_type: z.enum([
        'candidate_across_vaalipiirit',
        'party_across_years',
        'candidate_across_years',
        'area_across_years',
        'candidate_vs_party',
        'different_area_levels',
      ]).describe('Type of comparison to validate.'),
      details: z.record(z.string(), z.string()).optional().describe('Optional context for the comparison (e.g. { from_year: "2015", to_year: "2023", area_id: "010091" }).'),
    },
    async ({ comparison_type, details }) => {
      const validations: Record<string, {
        validity: 'valid' | 'valid_with_caveats' | 'invalid';
        warnings: string[];
        recommendations: string[];
      }> = {
        candidate_across_vaalipiirit: {
          validity: 'invalid',
          warnings: [
            'Comparing candidates from different vaalipiirit is not valid. Each vaalipiiri has different electorate size, number of seats, party competition dynamics, and vote totals.',
            'A candidate with 5,000 votes in Lappi vaalipiiri may be ranked #1 while 5,000 votes in Uusimaa vaalipiiri ranks #20+.',
            'Vote shares are also not directly comparable due to different numbers of candidates and parties per vaalipiiri.',
          ],
          recommendations: [
            'Compare within a single vaalipiiri using compare_candidates.',
            'To compare candidates from different vaalipiirit, use rank_within_party and rank_overall relative to their own vaalipiiri context.',
          ],
        },
        party_across_years: {
          validity: 'valid_with_caveats',
          warnings: [
            'Municipality (kunta) boundaries have changed significantly since 1983. Area codes are defined as of the election year (vaalivuosi). The same area_id may cover different geographic units in different elections.',
            'Some parties have changed names, merged, or split. Party codes in PxWeb may not be consistent across all years.',
            'National totals and vaalipiiri-level comparisons are generally more stable than kunta-level comparisons across long time spans.',
          ],
          recommendations: [
            'For long-range comparisons, prefer vaalipiiri or koko_suomi level.',
            'Use compare_elections which documents boundary years in its method field.',
            'For kunta-level comparisons spanning >10 years, note that municipality mergers may affect results.',
          ],
        },
        candidate_across_years: {
          validity: 'valid_with_caveats',
          warnings: [
            'Candidate-level data with äänestysalue breakdown is currently only available for 2023 in this MCP. Historical candidate comparison is not yet supported.',
            'If StatFin_Passiivi tables are added in the future, vaalipiiri boundaries and candidate numbering may differ between elections.',
          ],
          recommendations: [
            'Use party-level data from 13sw for historical comparison of a party\'s support in an area.',
            'Check the detect_inactive_high_vote_candidates tool for candidate presence/absence between elections (once multi-year data is added).',
          ],
        },
        area_across_years: {
          validity: 'valid_with_caveats',
          warnings: [
            'Area codes in 13sw are defined as of the vaalivuosi (election year). Municipality mergers can cause an area_id to disappear or change meaning between elections.',
            'Example: Jyväskylä, Jyväskylän maalaiskunta, and Korpilahti merged in 2009 — comparing any of these codes before and after the merger is problematic.',
          ],
          recommendations: [
            'Prefer vaalipiiri-level comparisons for long time spans.',
            'When comparing kunta data, verify the municipality has stable boundaries in the years being compared.',
          ],
        },
        candidate_vs_party: {
          validity: 'valid_with_caveats',
          warnings: [
            'A candidate\'s vote share and a party\'s vote share use the same denominator (total valid votes in area) but measure different things.',
            'Candidate vote share cannot be summed to get party vote share because candidates from the same party do not add up exactly (rounding, empty votes, etc.).',
          ],
          recommendations: [
            'Use share_of_party_vote_pct (from analyze_candidate_profile) to understand a candidate\'s contribution to their party\'s total.',
            'Do not compare candidate vote shares to party vote shares without this context.',
          ],
        },
        different_area_levels: {
          validity: 'invalid',
          warnings: [
            'Comparing vote shares from different area levels (e.g. a kunta vs. a vaalipiiri) is not valid.',
            'A party\'s vote share in a kunta and in the containing vaalipiiri are different measures — the vaalipiiri share averages over all included kunnat.',
            'Similarly, äänestysalue shares and kunta shares cannot be directly compared.',
          ],
          recommendations: [
            'Always compare areas at the same level.',
            'Use compare_areas which requires areas of the same level.',
            'Use get_area_profile to understand a single area at all levels.',
          ],
        },
      };

      const result = validations[comparison_type];
      return mcpText({
        comparison_type,
        details: details ?? {},
        ...result,
        note: 'validity: "valid" = no known issues. "valid_with_caveats" = usable but read warnings. "invalid" = do not present this comparison without major qualification.',
      });
    }
  );

  // ── get_data_caveats ──────────────────────────────────────────────────────
  server.tool(
    'get_data_caveats',
    'Returns known limitations and data quality issues for a specific dataset, tool, or topic. Always call this before presenting sensitive analytical results to a user. Returns severity levels: critical (affects validity), moderate (affects interpretation), minor (informational).',
    {
      topic: z.string().optional().describe('Specific topic, tool name, or table ID to get caveats for (e.g. "candidate", "vote_transfer", "13sw", "compare_elections"). Omit to get all caveats.'),
    },
    async ({ topic }) => {
      if (!topic) {
        return mcpText({
          all_caveats: Object.values(CAVEATS),
          summary: {
            critical: Object.values(CAVEATS).filter(c => c.severity === 'critical').map(c => c.id),
            moderate: Object.values(CAVEATS).filter(c => c.severity === 'moderate').map(c => c.id),
            minor: Object.values(CAVEATS).filter(c => c.severity === 'minor').map(c => c.id),
          },
        });
      }

      const q = topic.toLowerCase();
      const matches = Object.values(CAVEATS).filter(c =>
        c.id.includes(q) ||
        c.description.toLowerCase().includes(q) ||
        c.affects.some(a => a.toLowerCase().includes(q))
      );

      if (matches.length === 0) {
        return mcpText({
          message: `No specific caveats found for topic "${topic}".`,
          hint: 'Available caveat IDs: ' + Object.keys(CAVEATS).join(', '),
        });
      }

      return mcpText({
        topic,
        matching_caveats: matches,
      });
    }
  );

}
