import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { loadPartyResults, loadCandidateResults } from '../../data/loaders.js';
import { getElectionTables, ALL_ELECTION_TABLES } from '../../data/election-tables.js';
import type { ElectionRecord, ElectionType } from '../../data/types.js';
import { ELECTION_TYPE_PARAM, subnatLevel, matchesParty, pct, round2, mcpText, errResult } from '../shared.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Normalize a candidate name for cross-election comparison.
 * Candidate IDs are re-issued each election, so inactive detection must match by name.
 */
function normalizeCandidateName(name: string | undefined): string {
  if (!name) return '';
  return name.toLowerCase().replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/å/g, 'a').replace(/\s+/g, ' ').trim();
}

/** Minimum absolute vote change on the losing side required to classify co-movement as
 *  'consistent_with_transfer'. Filters out noise cases where 1–2 vote fluctuations
 *  would otherwise be counted as transfer evidence.
 */
const MIN_TRANSFER_VOTES = 50;

/** Returns the election year immediately before `year` that has candidate data, or undefined. */
function prevCandidateYear(electionType: ElectionType, year: number): number | undefined {
  const years = ALL_ELECTION_TABLES
    .filter((t) => t.election_type === electionType && (t.candidate_by_aanestysalue || t.candidate_national))
    .map((t) => t.year)
    .sort((a, b) => a - b);
  const idx = years.indexOf(year);
  return idx > 0 ? years[idx - 1] : undefined;
}

// ─── Tool registration ────────────────────────────────────────────────────────

export function registerStrategicTools(server: McpServer): void {

  // ── detect_inactive_high_vote_candidates ─────────────────────────────────
  server.tool(
    'detect_inactive_high_vote_candidates',
    'Identifies candidates who ran in a past election but did not run in the target election (inactive candidates). ' +
    'Returns their votes, strongest areas, and party — useful for identifying "orphaned" vote pools available for other candidates. ' +
    '\n\nPass year = the election you are targeting (e.g. 2023). ' +
    'from_year defaults to the immediately preceding election with candidate data — omit it unless you want a specific comparison year.',
    {
      year: z.coerce.number().describe('The election you are targeting (e.g. 2023 for parliamentary, 2025 for municipal). Candidates absent in this year are flagged as inactive.'),
      election_type: ELECTION_TYPE_PARAM,
      unit_key: z.string().optional().describe('Geographic unit key (vaalipiiri for parliamentary/municipal, hyvinvointialue for regional). Omit for EU/presidential.'),
      from_year: z.coerce.number().optional().describe('The past election year to look for inactive candidates. Defaults to the immediately preceding election year with candidate data. Override if you want a specific comparison.'),
      party_id: z.string().optional().describe('Filter to candidates from a specific party (abbreviation or code). Omit for all parties.'),
      min_votes: z.coerce.number().optional().describe('Minimum votes in from_year to include in results. Defaults to 100.'),
      limit: z.coerce.number().optional().describe('Maximum number of candidates to return, sorted by votes descending. Defaults to 20.'),
    },
    async ({ year, from_year, election_type, unit_key, party_id, min_votes = 100, limit = 20 }) => {
      const electionType: ElectionType = election_type ?? 'parliamentary';
      const to_year = year;
      if (!from_year) {
        const prev = prevCandidateYear(electionType, to_year);
        if (!prev) {
          return errResult(`No preceding election with candidate data found for ${electionType} before ${to_year}. Available candidate years: ${
            ALL_ELECTION_TABLES
              .filter((t) => t.election_type === electionType && (t.candidate_by_aanestysalue || t.candidate_national))
              .map((t) => t.year).sort().join(', ')
          }.`);
        }
        from_year = prev;
      }
      // Validate that candidate tables exist for both years
      const fromTables = getElectionTables(electionType, from_year);
      const toTables = getElectionTables(electionType, to_year);

      const unitLabel = unit_key ?? 'national';
      if (!fromTables?.candidate_by_aanestysalue && !fromTables?.candidate_national) {
        return errResult(`No candidate data for ${electionType} ${from_year}.`);
      }
      if (!toTables?.candidate_by_aanestysalue && !toTables?.candidate_national) {
        return errResult(`No candidate data for ${electionType} ${to_year}.`);
      }
      if (unit_key && fromTables?.candidate_by_aanestysalue && !fromTables.candidate_by_aanestysalue[unit_key]) {
        return errResult(`Unknown unit "${unit_key}" for ${electionType} ${from_year}. Valid: ${Object.keys(fromTables.candidate_by_aanestysalue).join(', ')}.`);
      }

      let fromRows: ElectionRecord[];
      let toRows: ElectionRecord[];
      let fromTableId: string;

      try {
        const fromResult = await loadCandidateResults(from_year, unit_key, undefined, electionType);
        fromRows = fromResult.rows;
        fromTableId = fromResult.tableId;
      } catch (err) {
        return errResult(`Failed to load ${from_year} candidate data: ${String(err)}`);
      }

      try {
        const toResult = await loadCandidateResults(to_year, unit_key, undefined, electionType);
        toRows = toResult.rows;
      } catch (err) {
        return errResult(`Failed to load ${to_year} candidate data: ${String(err)}`);
      }

      // Match candidates by normalized name — candidate IDs are re-issued each election
      const toNormalizedNames = toRows.map((r) => normalizeCandidateName(r.candidate_name)).filter(Boolean);
      const toCandidateNames = new Set(toNormalizedNames);

      // Detect normalization collisions (e.g. "Mäki" and "Maki" both → "maki")
      const nameSeen = new Set<string>();
      const collisionNames = new Set<string>();
      for (const n of toNormalizedNames) {
        if (nameSeen.has(n)) collisionNames.add(n);
        nameSeen.add(n);
      }

      // Get unit-level totals from from_year for each candidate
      const unitAreaLevel = electionType === 'regional' ? 'hyvinvointialue' as const
        : (electionType === 'eu_parliament' || electionType === 'presidential') ? 'koko_suomi' as const
        : 'vaalipiiri' as const;
      const fromVpRows = fromRows.filter((r) => r.area_level === unitAreaLevel && r.candidate_id);

      // Filter: absent in to_year (by name), optionally by party, and min_votes
      const inactive = fromVpRows
        .filter((r) => !toCandidateNames.has(normalizeCandidateName(r.candidate_name)))
        .filter((r) => !party_id || matchesParty(r, party_id))
        .filter((r) => r.votes >= min_votes)
        .sort((a, b) => b.votes - a.votes)
        .slice(0, limit);

      if (inactive.length === 0) {
        return mcpText({
          from_year, to_year, election_type: electionType, unit_key: unitLabel, party_id: party_id ?? 'all',
          inactive_candidates: [],
          message: 'No inactive candidates found matching the criteria.',
          method: { source_table: fromTableId },
        });
      }

      // For each inactive candidate, find their strongest areas
      const result = inactive.map((vpRow) => {
        const aalueRows = fromRows
          .filter((r) => r.candidate_id === vpRow.candidate_id && r.area_level === 'aanestysalue')
          .sort((a, b) => b.votes - a.votes)
          .slice(0, 5);

        return {
          candidate_id: vpRow.candidate_id,
          candidate_name: vpRow.candidate_name,
          party: vpRow.party_id,
          votes_in_from_year: vpRow.votes,
          vote_share_pct: vpRow.vote_share ? pct(vpRow.vote_share) : null,
          strongest_areas: aalueRows.map((r) => ({
            area_id: r.area_id,
            area_name: r.area_name,
            votes: r.votes,
          })),
        };
      });

      const totalOrphanedVotes = inactive.reduce((s, r) => s + r.votes, 0);

      return mcpText({
        from_year,
        to_year,
        election_type: electionType,
        unit_key: unitLabel,
        party_id: party_id ?? 'all',
        n_inactive_candidates: result.length,
        total_votes_from_inactive_candidates: totalOrphanedVotes,
        inactive_candidates: result,
        ...(collisionNames.size > 0 ? {
          name_normalization_warning: `${collisionNames.size} normalized name collision(s) detected — distinct candidates share the same normalized form (e.g. "Mäki" and "Maki" both normalize to "maki"). Active/inactive status for these candidates may be incorrect.`,
        } : {}),
        strategic_note: `These candidates had ${totalOrphanedVotes.toLocaleString()} combined votes in ${from_year} and did not run in ${to_year}. Research on Finnish open-list PR elections suggests personal votes are partially but not fully transferable when a candidate does not run again. Treat these figures as an upper bound on transferable support rather than a guaranteed vote pool. Cross-reference with find_area_overperformance to identify areas where a new candidate might absorb these votes.`,
        method: {
          description: 'Inactive = candidate name present in from_year but absent in to_year (normalized name match — candidate IDs differ between elections). Votes from unit-level aggregate row.',
          source_table: fromTableId,
        },
      });
    }
  );

  // ── find_vote_decline_areas ───────────────────────────────────────────────
  server.tool(
    'find_vote_decline_areas',
    'Identifies areas where a party lost significant vote share between two elections — voters who may be looking for alternatives. Supports all election types.',
    {
      party_id: z.string().describe('The party whose lost votes represent an opportunity.'),
      election_type: ELECTION_TYPE_PARAM,
      year1: z.coerce.number().describe('The earlier election year (baseline).'),
      year2: z.coerce.number().describe('The later election year (comparison).'),
      min_vote_loss_pp: z.coerce.number().optional().describe('Minimum vote share loss in pp to flag an area. Defaults to 3.'),
      min_votes_year1: z.coerce.number().optional().describe('Minimum votes in year1 to include an area. Defaults to 50.'),
      limit: z.coerce.number().optional().describe('Maximum areas to return. Defaults to 30.'),
    },
    async ({ party_id, election_type, year1, year2, min_vote_loss_pp = 3, min_votes_year1 = 50, limit = 30 }) => {
      const electionType: ElectionType = election_type ?? 'parliamentary';
      const areaLvl = subnatLevel(electionType);
      let rows1: ElectionRecord[];
      let rows2: ElectionRecord[];
      let tableId: string;

      try {
        const r1 = await loadPartyResults(year1, undefined, electionType);
        rows1 = r1.rows;
        tableId = r1.tableId;
      } catch (err) {
        return errResult(`Failed to load ${year1} data: ${String(err)}`);
      }
      try {
        const r2 = await loadPartyResults(year2, undefined, electionType);
        rows2 = r2.rows;
      } catch (err) {
        return errResult(`Failed to load ${year2} data: ${String(err)}`);
      }

      const kunta1 = rows1.filter((r) => matchesParty(r, party_id) && r.area_level === areaLvl && r.votes >= min_votes_year1);
      if (kunta1.length === 0) return errResult(`Party "${party_id}" not found in ${electionType} ${year1}.`);

      const kunta2Map = new Map<string, ElectionRecord>();
      rows2.filter((r) => matchesParty(r, party_id) && r.area_level === areaLvl)
        .forEach((r) => kunta2Map.set(r.area_id, r));

      const exposed = kunta1
        .map((r1) => {
          const r2 = kunta2Map.get(r1.area_id);
          const share1 = r1.vote_share;
          const share2 = r2?.vote_share;
          const loss_pp = (share1 !== undefined && share2 !== undefined)
            ? round2(share1 - share2)
            : null;
          return {
            area_id: r1.area_id,
            area_name: r1.area_name,
            votes_year1: r1.votes,
            votes_year2: r2?.votes ?? null,
            vote_share_year1_pct: share1 ? pct(share1) : null,
            vote_share_year2_pct: share2 ? pct(share2) : null,
            vote_share_loss_pp: loss_pp,
          };
        })
        .filter((a) => a.vote_share_loss_pp !== null && a.vote_share_loss_pp >= min_vote_loss_pp)
        .sort((a, b) => (b.vote_share_loss_pp ?? 0) - (a.vote_share_loss_pp ?? 0))
        .slice(0, limit);

      const netVoteCountChange = exposed.reduce(
        (s, a) => s + ((a.votes_year2 ?? 0) - (a.votes_year1 ?? 0)),
        0
      );
      const totalSharePointsLost = exposed.reduce(
        (s, a) => s + (a.vote_share_loss_pp ?? 0),
        0
      );

      return mcpText({
        party_id,
        year1,
        year2,
        min_vote_loss_pp,
        n_exposed_areas: exposed.length,
        net_vote_count_change_in_exposed_areas: netVoteCountChange,
        net_vote_count_change_note: 'Positive = raw votes gained; negative = raw votes lost. Can be positive even when share fell (e.g. higher turnout). Not equivalent to "lost votes".',
        total_share_points_lost_in_exposed_areas: round2(totalSharePointsLost),
        exposed_areas: exposed,
        strategic_note: `These ${exposed.length} areas saw ${party_id} lose ≥${min_vote_loss_pp}pp of vote share between ${year1} and ${year2}, representing structural weakening. The cause may be demobilisation (own voters abstaining) or persuasion loss (voters switching to another party) — cross-reference with estimate_vote_transfer_proxy and get_turnout to distinguish these scenarios before targeting campaign resources.`,
        method: {
          description: `Exposed = ${areaLvl} where party vote share fell by ≥ min_vote_loss_pp between year1 and year2.`,
          source_table: tableId,
          confidence: 'structural indicator',
        },
      });
    }
  );

  // ── estimate_vote_transfer_proxy ─────────────────────────────────────────
  server.tool(
    'estimate_vote_transfer_proxy',
    'Estimates where votes moved between two elections using area-level vote changes as a structural proxy. Compares how much one party gained vs. how much another lost in the same areas. This is NOT a causal measurement — it is an inference from aggregate election results.',
    {
      losing_party_id: z.string().describe('Party that lost votes between year1 and year2 (the "source" of transferring votes).'),
      gaining_party_id: z.string().describe('Party that gained votes (the potential "destination").'),
      election_type: ELECTION_TYPE_PARAM,
      year1: z.coerce.number().describe('Earlier election year.'),
      year2: z.coerce.number().describe('Later election year.'),
      area_id: z.string().optional().describe('Restrict to a specific area. Omit to analyse at sub-national level.'),
      min_votes: z.coerce.number().optional().describe('Minimum votes in year1 to include an area. Defaults to 50.'),
    },
    async ({ losing_party_id, gaining_party_id, election_type, year1, year2, area_id, min_votes = 50 }) => {
      const electionType: ElectionType = election_type ?? 'parliamentary';
      const areaLvl = subnatLevel(electionType);
      let rows1: ElectionRecord[];
      let rows2: ElectionRecord[];
      let tableId: string;

      try {
        const r1 = await loadPartyResults(year1, area_id, electionType);
        rows1 = r1.rows;
        tableId = r1.tableId;
      } catch (err) {
        return errResult(`Failed to load ${year1} data: ${String(err)}`);
      }
      try {
        const r2 = await loadPartyResults(year2, area_id, electionType);
        rows2 = r2.rows;
      } catch (err) {
        return errResult(`Failed to load ${year2} data: ${String(err)}`);
      }

      const level = area_id ? undefined : areaLvl;

      const loser1 = rows1.filter((r) => matchesParty(r, losing_party_id) && (!level || r.area_level === level) && r.votes >= min_votes);
      const gainer1 = rows1.filter((r) => matchesParty(r, gaining_party_id) && (!level || r.area_level === level));
      if (loser1.length === 0) return errResult(`Party "${losing_party_id}" not found in ${year1}.`);
      if (gainer1.length === 0) return errResult(`Party "${gaining_party_id}" not found in ${year1}.`);

      const loser2Map = new Map<string, ElectionRecord>();
      const gainer2Map = new Map<string, ElectionRecord>();
      rows2.filter((r) => matchesParty(r, losing_party_id)).forEach((r) => loser2Map.set(r.area_id, r));
      rows2.filter((r) => matchesParty(r, gaining_party_id)).forEach((r) => gainer2Map.set(r.area_id, r));

      // Correlation analysis: in areas where loser lost votes, did gainer gain votes?
      const areaAnalysis = loser1
        .map((l1) => {
          const l2 = loser2Map.get(l1.area_id);
          const g1 = gainer1.find((r) => r.area_id === l1.area_id);
          const g2 = gainer2Map.get(l1.area_id);
          const loser_change = l2 ? l2.votes - l1.votes : null;
          const gainer_change = (g1 && g2) ? g2.votes - g1.votes : null;
          return {
            area_id: l1.area_id,
            area_name: l1.area_name,
            loser_votes_year1: l1.votes,
            loser_votes_year2: l2?.votes ?? null,
            loser_change,
            gainer_votes_year1: g1?.votes ?? null,
            gainer_votes_year2: g2?.votes ?? null,
            gainer_change,
            co_movement: (loser_change !== null && gainer_change !== null)
              ? (
                  loser_change < 0 &&
                  gainer_change > 0 &&
                  Math.abs(loser_change) >= MIN_TRANSFER_VOTES &&
                  gainer_change >= 0.1 * Math.abs(loser_change)
                    ? 'consistent_with_transfer'
                    : 'inconsistent'
                )
              : 'insufficient_data',
          };
        })
        .filter((a) => a.loser_change !== null);

      const consistent = areaAnalysis.filter((a) => a.co_movement === 'consistent_with_transfer');
      const inconsistent = areaAnalysis.filter((a) => a.co_movement === 'inconsistent');

      // Pearson r between loser_change and gainer_change across all areas with both values
      const paired = areaAnalysis.filter((a) => a.loser_change !== null && a.gainer_change !== null) as
        Array<{ loser_change: number; gainer_change: number; [key: string]: unknown }>;
      let areaCorrR: number | null = null;
      if (paired.length >= 3) {
        const xs = paired.map(a => a.loser_change);
        const ys = paired.map(a => a.gainer_change);
        const n = xs.length;
        const xMean = xs.reduce((s, v) => s + v, 0) / n;
        const yMean = ys.reduce((s, v) => s + v, 0) / n;
        const num = xs.reduce((s, v, i) => s + (v - xMean) * (ys[i]! - yMean), 0);
        const den = Math.sqrt(xs.reduce((s, v) => s + (v - xMean) ** 2, 0) * ys.reduce((s, v) => s + (v - yMean) ** 2, 0));
        areaCorrR = den > 0 ? Math.round((num / den) * 1000) / 1000 : null;
      }

      // National-level totals
      const nationalLoser1 = rows1.find((r) => matchesParty(r, losing_party_id) && r.area_level === 'koko_suomi');
      const nationalLoser2 = rows2.find((r) => matchesParty(r, losing_party_id) && r.area_level === 'koko_suomi');
      const nationalGainer1 = rows1.find((r) => matchesParty(r, gaining_party_id) && r.area_level === 'koko_suomi');
      const nationalGainer2 = rows2.find((r) => matchesParty(r, gaining_party_id) && r.area_level === 'koko_suomi');

      const loserNationalChange = (nationalLoser1 && nationalLoser2)
        ? nationalLoser2.votes - nationalLoser1.votes : null;
      const gainerNationalChange = (nationalGainer1 && nationalGainer2)
        ? nationalGainer2.votes - nationalGainer1.votes : null;

      return mcpText({
        proxy_method: 'election result inference',
        confidence: 'structural indicator',
        losing_party: losing_party_id,
        gaining_party: gaining_party_id,
        year1,
        year2,
        national_summary: {
          loser_vote_change: loserNationalChange,
          gainer_vote_change: gainerNationalChange,
          loser_share_change_pp: (nationalLoser1?.vote_share && nationalLoser2?.vote_share)
            ? round2(nationalLoser2.vote_share - nationalLoser1.vote_share) : null,
          gainer_share_change_pp: (nationalGainer1?.vote_share && nationalGainer2?.vote_share)
            ? round2(nationalGainer2.vote_share - nationalGainer1.vote_share) : null,
        },
        area_co_movement: {
          n_areas_analysed: areaAnalysis.length,
          n_consistent_with_transfer: consistent.length,
          n_inconsistent: inconsistent.length,
          pct_consistent: areaAnalysis.length > 0
            ? pct(consistent.length / areaAnalysis.length * 100) : null,
          pct_consistent_caution: 'This percentage counts areas where both conditions are directionally met (loser lost ≥50 votes AND gainer gained ≥10% of loser loss). It is NOT a probability of voter transfer. Even unrelated parties show co-movement when both track a national swing.',
          area_correlation_r: areaCorrR,
          area_correlation_note: areaCorrR !== null
            ? `Pearson r=${areaCorrR} between loser_change and gainer_change across ${paired.length} areas. Positive r = areas where loser lost more also tended to be areas where gainer gained more, consistent with a transfer pattern. r>0.5 is moderate evidence; r>0.7 is strong. Note: r measures co-movement, not causation.`
            : `Pearson r not computed (fewer than 3 areas with complete data).`,
        },
        top_transfer_areas: consistent
          .sort((a, b) => Math.abs(b.loser_change ?? 0) - Math.abs(a.loser_change ?? 0))
          .slice(0, 10),
        interpretation: [
          `In ${consistent.length} of ${areaAnalysis.length} municipalities, ${losing_party_id} lost ≥50 votes while ${gaining_party_id} gained ≥10% of that loss — consistent with a transfer pattern.`,
          'This is a structural proxy, not a measured transfer. Voters are anonymous; this inference is based on aggregate area-level changes only.',
          'Alternative explanations include differential turnout, new voters entering, or three-way vote movements.',
          'Note: even a high co-movement rate does not prove voter transfer — it shows aggregate co-movement consistent with transfer. Compare these results to survey-based voter transition studies before drawing conclusions.',
        ],
        method: {
          description: `Area co-movement analysis: for each ${areaLvl}, check if losing_party votes fell AND gaining_party votes rose between year1 and year2.`,
          source_table: tableId,
          proxy_method: 'election result inference',
          confidence: 'structural indicator',
        },
      });
    }
  );

  // ── rank_areas_for_party ─────────────────────────────────────────
  server.tool(
    'rank_areas_for_party',
    'Ranks municipalities by historical party presence — where the party already has strong support, growing trends, and large vote pools. Useful for GOTV mobilisation and consolidation targeting. NOTE: scores are derived solely from historical vote share data. This tool does not identify persuadable non-supporters, model demographic opportunity, or predict voter transferability. All score components are returned individually for sensitivity checking.',
    {
      party_id: z.string().describe('The party running the campaign (abbreviation or code).'),
      election_type: ELECTION_TYPE_PARAM,
      reference_year: z.coerce.number().describe('The most recent election year to use as baseline (e.g. 2023).'),
      trend_year: z.coerce.number().optional().describe('Earlier election year for computing trend. If omitted, only static scores are used.'),
      min_votes: z.coerce.number().optional().describe('Minimum party votes in reference_year to include an area. Defaults to 20.'),
      limit: z.coerce.number().optional().describe('Number of top areas to return. Defaults to 25.'),
    },
    async ({ party_id, election_type, reference_year, trend_year, min_votes = 20, limit = 25 }) => {
      const electionType: ElectionType = election_type ?? 'parliamentary';
      const areaLvl = subnatLevel(electionType);
      let refRows: ElectionRecord[];
      let trendRows: ElectionRecord[] | null = null;
      let tableId: string;

      try {
        const r = await loadPartyResults(reference_year, undefined, electionType);
        refRows = r.rows;
        tableId = r.tableId;
      } catch (err) {
        return errResult(`Failed to load ${reference_year} data: ${String(err)}`);
      }

      if (trend_year) {
        try {
          const r = await loadPartyResults(trend_year, undefined, electionType);
          trendRows = r.rows;
        } catch (err) {
          console.error(`[rank_areas_for_party] failed to load trend year ${trend_year}:`, err);
          trendRows = null;
        }
      }

      const nationalRow = refRows.find((r) => matchesParty(r, party_id) && r.area_level === 'koko_suomi');
      const nationalShare = nationalRow?.vote_share;
      if (!nationalShare) return errResult(`Party "${party_id}" not found in ${electionType} ${reference_year}.`);

      const allSubnatRows = refRows.filter((r) => r.area_level === areaLvl);
      const allVotesByArea = new Map<string, number>();
      for (const r of allSubnatRows) {
        allVotesByArea.set(r.area_id, (allVotesByArea.get(r.area_id) ?? 0) + r.votes);
      }

      const partyKunta = refRows.filter(
        (r) => matchesParty(r, party_id) && r.area_level === areaLvl && r.votes >= min_votes
      );
      if (partyKunta.length === 0) return errResult(`No ${areaLvl} data found for "${party_id}" in ${electionType} ${reference_year}.`);

      const trendMap = new Map<string, number>();
      if (trendRows) {
        trendRows
          .filter((r) => matchesParty(r, party_id) && r.area_level === areaLvl)
          .forEach((r) => { if (r.vote_share !== undefined) trendMap.set(r.area_id, r.vote_share); });
      }

      const maxVotes = Math.max(...partyKunta.map((r) => r.votes));

      // Pre-pass: collect all trend changes to build the percentile distribution for c2.
      // Using the observed distribution rather than a fixed ±10pp scale ensures that
      // Finnish area-level swings (typically ±1–3pp) are spread across the full 0–1 range.
      const allTrendChanges: number[] = [];
      for (const r of partyKunta) {
        const prevShare = trendMap.get(r.area_id);
        if (prevShare !== undefined) {
          allTrendChanges.push((r.vote_share ?? 0) - prevShare);
        }
      }
      const sortedTrendChanges = [...allTrendChanges].sort((a, b) => a - b);

      const scored = partyKunta.map((r) => {
        const share = r.vote_share ?? 0;
        const totalVotes = allVotesByArea.get(r.area_id) ?? 0;

        // Component 1: current vote share relative to national (0–1)
        // Ratio to national average, capped at 3× to allow differentiation at the top end.
        // score = min(share/national, 3) / 3 → national average = 0.333, 3× national = 1.0
        const c1_current_support = Math.min(share / nationalShare, 3) / 3;

        // Component 2: growth trend (0–1; 0.5 if no trend data)
        // Uses percentile rank within the actual distribution of trend changes for this
        // party/election pair. Avoids the ±10pp fixed scale that compressed all Finnish
        // area-level swings (typically ±1–3pp) into a near-constant range.
        let c2_trend = 0.5;
        const prevShare = trendMap.get(r.area_id);
        if (prevShare !== undefined) {
          const change = share - prevShare;
          const rank = sortedTrendChanges.filter((t) => t <= change).length;
          c2_trend = sortedTrendChanges.length > 1
            ? (rank - 1) / (sortedTrendChanges.length - 1)
            : 0.5;
        }

        // Component 3: electorate size (total votes cast in area / largest area total) (0–1)
        const maxTotalVotes = Math.max(...Array.from(allVotesByArea.values()), 1);
        const c3_size = (allVotesByArea.get(r.area_id) ?? 0) / maxTotalVotes;

        // Composite score: weighted average of 3 independent components (c4 removed — was mathematically identical to 1 − c1)
        const weights = { c1: 0.40, c2: 0.35, c3: 0.25 };
        const composite = round2(
          c1_current_support * weights.c1 +
          c2_trend * weights.c2 +
          c3_size * weights.c3
        );

        return {
          area_id: r.area_id,
          area_name: r.area_name,
          composite_score: composite,
          components: {
            c1_current_support: round2(c1_current_support),
            c2_trend: trendMap.has(r.area_id) ? round2(c2_trend) : null,
            c3_size: round2(c3_size),
          },
          data: {
            party_votes: r.votes,
            party_share_pct: pct(share),
            national_share_pct: pct(nationalShare),
            trend_share_pct: prevShare !== undefined ? pct(prevShare) : null,
            trend_change_pp: prevShare !== undefined ? round2(share - prevShare) : null,
          },
        };
      });

      scored.sort((a, b) => b.composite_score - a.composite_score);
      const ranked = scored.slice(0, limit).map((a, i) => ({ rank: i + 1, ...a }));

      return mcpText({
        party_id,
        election_type: electionType,
        reference_year,
        trend_year: trend_year ?? null,
        national_share_pct: pct(nationalShare),
        [`n_${areaLvl}s_scored`]: scored.length,
        top_target_areas: ranked,
        scoring_methodology: {
          description: 'Composite score = weighted average of 3 independent components (all 0–1).',
          weights: { c1_current_support: 0.40, c2_trend: 0.35, c3_size: 0.25 },
          components: {
            c1_current_support: 'Current party vote share relative to national average. Formula: min(share/national, 3)/3 — national average scores 0.33, 3× national scores 1.0. Areas up to 3× above national are differentiated.',
            c2_trend: 'Percentile rank of vote share change (trend_year → reference_year) within the actual distribution of changes across all scored areas. An area with the largest gain scores 1.0; the largest loss scores 0.0. 0.5 if no trend year provided. Percentile rank avoids the fixed ±10pp scale which would compress typical Finnish area-level swings (±1–3pp) into a near-constant range.',
            c3_size: `Total votes cast in area relative to the largest area. Measures electorate size, not party vote volume.`,
          },
          note: 'Scores are relative to this party\'s own distribution. Use compare_parties and find_area_overperformance for cross-party context.',
          methodology_warning: 'This tool ranks areas by where the party already has support — it is a consolidation and GOTV tool, not a persuasion-opportunity tool. The weights (0.40/0.35/0.25) are heuristic and not empirically calibrated; rankings may change materially with different weight choices. For persuasion targeting, cross-reference with estimate_vote_transfer_proxy and get_turnout.',
        },
        method: {
          source_table: tableId,
          proxy_method: 'composite indicator',
          confidence: 'structural indicator',
        },
      });
    }
  );

}
