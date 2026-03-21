import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { loadPartyResults, loadCandidateResults } from '../../data/loaders.js';
import { computeEnp } from '../../data/normalizer.js';
import type { ElectionRecord, ElectionType, AreaLevel } from '../../data/types.js';
import { ELECTION_TYPE_PARAM, subnatLevel, matchesParty, pct, round2, mcpText, errResult } from '../shared.js';
import { parseKuntaCode } from '../../data/area-hierarchy.js';

// ─── Shared caveats ───────────────────────────────────────────────────────────

/**
 * POL-12: rank_within_party is intra-party only and does not indicate seat outcome.
 * Added to every output that exposes rank_within_party.
 */
const RANK_WITHIN_PARTY_CAVEAT =
  "Intra-party ranking only. Does not indicate election outcome or seat allocation — " +
  "seat distribution depends on party total votes and d'Hondt divisor calculation, " +
  "which this service does not model.";

// ─── Analytics helpers ────────────────────────────────────────────────────────

/**
 * Geographic concentration index.
 * Uses top-N share method: fraction of total votes held by top N areas.
 * More interpretable than HHI for election analysis.
 */
function concentrationMetrics(areaVotes: number[]): {
  top1_share_pct: number;
  top3_share_pct: number;
  top5_share_pct: number;
  top10_share_pct: number;
  n_areas: number;
} {
  const sorted = [...areaVotes].sort((a, b) => b - a);
  const total = sorted.reduce((s, v) => s + v, 0);
  if (total === 0) return { top1_share_pct: 0, top3_share_pct: 0, top5_share_pct: 0, top10_share_pct: 0, n_areas: 0 };
  const topShare = (n: number) =>
    pct((sorted.slice(0, n).reduce((s, v) => s + v, 0) / total) * 100);
  return {
    top1_share_pct: topShare(1),
    top3_share_pct: topShare(3),
    top5_share_pct: topShare(5),
    top10_share_pct: topShare(10),
    n_areas: sorted.length,
  };
}

function topN<T extends { votes: number }>(rows: T[], n: number): T[] {
  return [...rows].sort((a, b) => b.votes - a.votes).slice(0, n);
}

function bottomN<T extends { votes: number }>(rows: T[], n: number): T[] {
  return [...rows].sort((a, b) => a.votes - b.votes).slice(0, n);
}

// ─── Tool registration ────────────────────────────────────────────────────────

export function registerAnalyticsTools(server: McpServer): void {

  // ── analyze_candidate_profile ────────────────────────────────────────────
  server.tool(
    'analyze_candidate_profile',
    'Computes a comprehensive performance profile for a single candidate: total votes, vote share, overall rank in unit, rank within party, share of party vote, strongest and weakest areas, and geographic concentration index.',
    {
      year: z.coerce.number().describe('Election year (e.g. 2023).'),
      election_type: ELECTION_TYPE_PARAM,
      candidate_id: z.string().describe('Candidate code (e.g. "01010176"). Use resolve_candidate if you only have a name.'),
      unit_key: z.string().optional().describe('Geographic unit key. Parliamentary/municipal: vaalipiiri (e.g. "helsinki"). Regional: hyvinvointialue (e.g. "pirkanmaa"). EU/presidential: omit.'),
    },
    async ({ year, election_type, candidate_id, unit_key }) => {
      const electionType: ElectionType = election_type ?? 'parliamentary';
      let allRows: ElectionRecord[];
      let tableId: string;
      try {
        const result = await loadCandidateResults(year, unit_key, undefined, electionType);
        allRows = result.rows;
        tableId = result.tableId;
      } catch (err) {
        return errResult(`Failed to load candidate data: ${String(err)}`);
      }
      const unitLabel = unit_key ?? 'national';

      // The candidate's own rows across all area levels
      const candidateRows = allRows.filter((r) => r.candidate_id === candidate_id);
      if (candidateRows.length === 0) {
        return errResult(`Candidate ${candidate_id} not found in ${unitLabel} ${year}.`);
      }

      // Unit-level total for this candidate (VP## row for parliamentary, HV## for regional, SSS for EU/presidential)
      const unitAreaLevel: AreaLevel = electionType === 'regional' ? 'hyvinvointialue'
        : (electionType === 'eu_parliament' || electionType === 'presidential') ? 'koko_suomi'
        : 'vaalipiiri';
      const vpRow = candidateRows.find((r) => r.area_level === unitAreaLevel)
        ?? candidateRows.find((r) => r.area_level === 'vaalipiiri');
      const usingFallbackSum = !vpRow;
      const totalVotes = vpRow?.votes ?? candidateRows.filter((r) => r.area_level === 'aanestysalue').reduce((s, r) => s + r.votes, 0);
      const candidateName = candidateRows[0]!.candidate_name ?? candidate_id;
      const partyId = candidateRows[0]!.party_id ?? '';

      // All candidates at unit level → overall rank
      const allVpRows = allRows.filter((r) => r.area_level === unitAreaLevel && r.candidate_id);
      const overallRank = allVpRows
        .sort((a, b) => b.votes - a.votes)
        .findIndex((r) => r.candidate_id === candidate_id) + 1;

      // Same-party candidates at vaalipiiri level → rank within party
      const partyVpRows = allVpRows.filter((r) => r.party_id === partyId).sort((a, b) => b.votes - a.votes);
      const rankWithinParty = partyVpRows.findIndex((r) => r.candidate_id === candidate_id) + 1;
      const partyTotalVotes = partyVpRows.reduce((s, r) => s + r.votes, 0);
      const shareOfPartyVotePct = partyTotalVotes > 0 ? pct(totalVotes / partyTotalVotes * 100) : null;

      // Within-party position detail (absorbed from analyze_within_party_position)
      const partyRanked = partyVpRows.map((r, i) => ({
        candidate_id: r.candidate_id,
        candidate_name: r.candidate_name,
        votes: r.votes,
        rank_within_party: i + 1,
      }));
      const rankIdx = rankWithinParty - 1;
      const candidateAbove = partyRanked[rankIdx - 1] ?? null;
      const candidateBelow = partyRanked[rankIdx + 1] ?? null;

      // äänestysalue rows for geographic analysis
      const aalueRows = candidateRows.filter((r) => r.area_level === 'aanestysalue');
      const strongest = topN(aalueRows, 5).map((r) => ({
        area_id: r.area_id,
        area_name: r.area_name,
        votes: r.votes,
        vote_share: r.vote_share ? pct(r.vote_share) : null,
      }));
      const weakest = bottomN(aalueRows.filter((r) => r.votes > 0), 5).map((r) => ({
        area_id: r.area_id,
        area_name: r.area_name,
        votes: r.votes,
        vote_share: r.vote_share ? pct(r.vote_share) : null,
      }));

      const concentration = concentrationMetrics(aalueRows.map((r) => r.votes));

      // Election outcome from Valintatieto (parliamentary, municipal, regional)
      const rawOutcome = vpRow?.election_outcome ?? candidateRows[0]?.election_outcome;
      const OUTCOME_MAP: Record<string, string> = { '1': 'elected', '2': 'varalla', '3': 'not_elected' };
      const election_outcome = rawOutcome ? (OUTCOME_MAP[rawOutcome] ?? 'unknown') : null;

      return mcpText({
        candidate_id,
        candidate_name: candidateName,
        party: partyId,
        year,
        election_type: electionType,
        unit_key: unitLabel,
        election_outcome,
        total_votes: totalVotes,
        vote_share_pct: vpRow?.vote_share ? pct(vpRow.vote_share) : null,
        rank_overall_in_unit: overallRank || null,
        rank_within_party: rankWithinParty || null,
        rank_within_party_caveat: RANK_WITHIN_PARTY_CAVEAT,
        total_party_candidates: partyVpRows.length,
        share_of_party_vote_pct: shareOfPartyVotePct,
        candidate_above_in_party: candidateAbove,
        candidate_below_in_party: candidateBelow,
        votes_behind_rank_above: candidateAbove ? candidateAbove.votes - totalVotes : null,
        votes_ahead_of_rank_below: candidateBelow ? totalVotes - candidateBelow.votes : null,
        all_party_candidates: partyRanked,
        ...(usingFallbackSum ? { data_warning: 'total_votes reconstructed by summing äänestysalue rows — unit-level aggregate row not found. May be incomplete if not all rows were loaded.' } : {}),
        strongest_areas: strongest,
        weakest_areas: weakest,
        geographic_concentration: concentration,
        method: {
          description: 'Ranks computed at vaalipiiri level using the VP## aggregate row. Geographic analysis uses äänestysalue-level rows only to avoid double-counting.',
          source_table: tableId,
        },
      });
    }
  );

  // ── analyze_party_profile ────────────────────────────────────────────────
  server.tool(
    'analyze_party_profile',
    'Computes a performance profile for a party in an election: national totals, vote share, strongest and weakest areas, and geographic spread. Supports all election types.',
    {
      year: z.coerce.number().describe('Election year.'),
      election_type: ELECTION_TYPE_PARAM,
      party_id: z.string().describe('Party abbreviation or code (e.g. "KOK", "SDP"). Use resolve_party if needed.'),
    },
    async ({ year, election_type, party_id }) => {
      const electionType: ElectionType = election_type ?? 'parliamentary';
      const areaLvl = subnatLevel(electionType);
      let rows: ElectionRecord[];
      let tableId: string;
      try {
        const result = await loadPartyResults(year, undefined, electionType);
        rows = result.rows;
        tableId = result.tableId;
      } catch (err) {
        return errResult(`Failed to load party data: ${String(err)}`);
      }

      const partyRows = rows.filter((r) => matchesParty(r, party_id));
      if (partyRows.length === 0) {
        return errResult(`Party "${party_id}" not found in ${electionType} ${year}. Use resolve_party to find the correct party_id.`);
      }

      const partyName = partyRows[0]!.party_name ?? party_id;
      const nationalRow = partyRows.find((r) => r.area_level === 'koko_suomi');
      const subnatRows = partyRows.filter((r) => r.area_level === areaLvl);

      const nationalVotes = nationalRow?.votes ?? subnatRows.reduce((s, r) => s + r.votes, 0);
      const nationalShare = nationalRow?.vote_share;

      const allNationalRows = rows.filter((r) => r.area_level === 'koko_suomi');
      const totalNationalVotes = allNationalRows.reduce((s, r) => s + r.votes, 0);

      const strongest = topN(subnatRows, 10).map((r) => ({
        area_id: r.area_id,
        area_name: r.area_name,
        votes: r.votes,
        vote_share_pct: r.vote_share ? pct(r.vote_share) : null,
      }));

      const weakest = bottomN(subnatRows.filter((r) => r.votes > 0), 5).map((r) => ({
        area_id: r.area_id,
        area_name: r.area_name,
        votes: r.votes,
        vote_share_pct: r.vote_share ? pct(r.vote_share) : null,
      }));

      const concentration = concentrationMetrics(subnatRows.map((r) => r.votes));
      const election_enp = computeEnp(allNationalRows);

      return mcpText({
        party_id,
        party_name: partyName,
        year,
        election_type: electionType,
        national_votes: nationalVotes,
        national_vote_share_pct: nationalShare ? pct(nationalShare) : null,
        total_national_votes_cast: totalNationalVotes,
        election_enp,
        [`n_${areaLvl}s`]: subnatRows.length,
        [`n_${areaLvl}s_with_votes`]: subnatRows.filter((r) => r.votes > 0).length,
        [`strongest_${areaLvl}s`]: strongest,
        [`weakest_${areaLvl}s`]: weakest,
        geographic_concentration: concentration,
        method: {
          description: `National total from koko_suomi row. Strongest/weakest based on ${areaLvl}-level rows. election_enp = Laakso-Taagepera ENP from all koko_suomi party rows.`,
          source_table: tableId,
        },
      });
    }
  );

  // ── compare_candidates ───────────────────────────────────────────────────
  server.tool(
    'compare_candidates',
    'Side-by-side vote comparison for two or more candidates in the same election unit. Returns votes, overall rank, party, and strongest areas for each.',
    {
      year: z.coerce.number().describe('Election year.'),
      election_type: ELECTION_TYPE_PARAM,
      candidate_ids: z.array(z.string()).min(2).max(10).describe('List of candidate_id values to compare (2–10). Use resolve_candidate to find IDs.'),
      unit_key: z.string().optional().describe('Vaalipiiri (parliamentary/municipal), hyvinvointialue (regional), or omit for EU/presidential.'),
    },
    async ({ year, election_type, candidate_ids, unit_key }) => {
      const electionType: ElectionType = election_type ?? 'parliamentary';
      let allRows: ElectionRecord[];
      let tableId: string;
      try {
        const result = await loadCandidateResults(year, unit_key, undefined, electionType);
        allRows = result.rows;
        tableId = result.tableId;
      } catch (err) {
        return errResult(`Failed to load candidate data: ${String(err)}`);
      }

      const unitAreaLevel: AreaLevel = electionType === 'regional' ? 'hyvinvointialue'
        : (electionType === 'eu_parliament' || electionType === 'presidential') ? 'koko_suomi'
        : 'vaalipiiri';
      const allVpRows = allRows.filter((r) => r.area_level === unitAreaLevel && r.candidate_id)
        .sort((a, b) => b.votes - a.votes);
      const rankMap = new Map(allVpRows.map((r, i) => [r.candidate_id, i + 1]));

      const comparison = candidate_ids.map((cid) => {
        const vpRow = allVpRows.find((r) => r.candidate_id === cid);
        if (!vpRow) return { candidate_id: cid, error: 'Not found in this vaalipiiri' };

        const rank = rankMap.get(cid) ?? 0;
        const aalueRows = allRows.filter((r) => r.candidate_id === cid && r.area_level === 'aanestysalue');
        const top3 = topN(aalueRows, 3).map((r) => ({ area_name: r.area_name, votes: r.votes }));

        return {
          candidate_id: cid,
          candidate_name: vpRow.candidate_name,
          party: vpRow.party_id,
          votes: vpRow.votes,
          vote_share_pct: vpRow.vote_share ? pct(vpRow.vote_share) : null,
          rank_in_unit: rank,
          top_3_areas: top3,
        };
      });

      return mcpText({
        year,
        election_type: electionType,
        unit_key: unit_key ?? 'national',
        comparison,
        method: {
          description: `Votes and ranks from ${unitAreaLevel}-level aggregate rows. Top areas from äänestysalue rows.`,
          source_table: tableId,
        },
      });
    }
  );

  // ── compare_parties ──────────────────────────────────────────────────────
  server.tool(
    'compare_parties',
    'Side-by-side vote comparison for two or more parties in an election. Returns national votes, vote share, and rank for each. Supports all election types.',
    {
      year: z.coerce.number().describe('Election year.'),
      election_type: ELECTION_TYPE_PARAM,
      party_ids: z.array(z.string()).min(2).max(15).describe('List of party_id values to compare (2–15). Use resolve_party to find IDs.'),
      area_id: z.string().optional().describe('Restrict comparison to a specific area. Defaults to national.'),
    },
    async ({ year, election_type, party_ids, area_id }) => {
      const electionType: ElectionType = election_type ?? 'parliamentary';
      let rows: ElectionRecord[];
      let tableId: string;
      try {
        const result = await loadPartyResults(year, area_id ?? 'SSS', electionType);
        rows = result.rows;
        tableId = result.tableId;
      } catch (err) {
        return errResult(`Failed to load party data: ${String(err)}`);
      }

      // The loaded rows are for the specific area; sort all parties by votes for ranking
      const allSorted = [...rows].sort((a, b) => b.votes - a.votes);

      const comparison = party_ids.map((pid) => {
        const row = rows.find((r) => matchesParty(r, pid));
        if (!row) return { party_id: pid, error: 'Not found' };
        const rank = allSorted.findIndex((r) => r.party_id === row.party_id) + 1;
        return {
          party_id: pid,
          party_name: row.party_name,
          votes: row.votes,
          vote_share_pct: row.vote_share ? pct(row.vote_share) : null,
          rank: rank || null,
        };
      });

      return mcpText({
        year,
        election_type: electionType,
        area_id: area_id ?? 'SSS',
        comparison,
        method: {
          description: 'Party votes from party table. Rank is relative to all parties in the same area.',
          source_table: tableId,
        },
      });
    }
  );

  // compare_elections REMOVED (T1): subsumed by compare_across_dimensions.
  // Migration: compare_across_dimensions(subject_type='party', subject_ids=[party_id],
  //   elections=[{election_type, year}, ...], vary='election', area_level='koko_suomi')

  // ── find_area_overperformance ────────────────────────────────────────────
  server.tool(
    'find_area_overperformance',
    'Finds areas where a party or candidate performs above their baseline. Baseline for parties = national vote share. Baseline for candidates = unit-level vote share. Returns areas ranked by overperformance magnitude.',
    {
      year: z.coerce.number().describe('Election year.'),
      election_type: ELECTION_TYPE_PARAM,
      subject_type: z.enum(['party', 'candidate']).describe('Whether to analyse a party or a candidate.'),
      subject_id: z.string().describe('Party abbreviation (e.g. "KOK") or candidate_id (e.g. "01010176").'),
      unit_key: z.string().optional().describe('Required when subject_type=candidate (vaalipiiri/hyvinvointialue key). Omit for EU/presidential.'),
      area_level: z.enum(['aanestysalue', 'kunta', 'vaalipiiri', 'hyvinvointialue']).optional().describe(
        'Geographic level for the overperformance analysis. ' +
        'For parties: filters rows at the requested level (default = kunta for parl/municipal, vaalipiiri for EU/presidential, hyvinvointialue for regional). ' +
        'For candidates: aanestysalue = raw per-district (default); kunta = aggregate äänestysalue → kunta using parseKuntaCode. ' +
        'Kunta aggregation requires parliamentary, municipal, or presidential election type.'
      ),
      min_votes: z.coerce.number().optional().describe('Minimum votes in an area to include in results. Defaults to 50 (filters noise from tiny polling districts).'),
      direction: z.enum(['over', 'under']).optional().describe("'over' (default) = areas above baseline; 'under' = areas below baseline."),
    },
    async ({ year, election_type, subject_type, subject_id, unit_key, area_level, min_votes = 50, direction = 'over' }) => {
      const electionType: ElectionType = election_type ?? 'parliamentary';
      if (subject_type === 'party') {
        const areaLvl: AreaLevel = (area_level as AreaLevel | undefined) ?? subnatLevel(electionType);
        let rows: ElectionRecord[];
        let tableId: string;
        try {
          const result = await loadPartyResults(year, undefined, electionType);
          rows = result.rows;
          tableId = result.tableId;
        } catch (err) {
          return errResult(String(err));
        }

        const nationalRow = rows.find((r) => matchesParty(r, subject_id) && r.area_level === 'koko_suomi');
        const baseline = nationalRow?.vote_share;
        if (!baseline) return errResult(`No national vote share found for party "${subject_id}" in ${year}.`);

        // POL-10: build area total-votes map so consumers can contextualise magnitude
        const areaTotals = new Map<string, number>();
        for (const r of rows.filter((r) => r.area_level === areaLvl && r.party_id !== 'SSS')) {
          areaTotals.set(r.area_id, (areaTotals.get(r.area_id) ?? 0) + r.votes);
        }

        const subnatRows = rows.filter((r) => matchesParty(r, subject_id) && r.area_level === areaLvl && r.votes >= min_votes);
        const overperf = subnatRows
          .filter((r) => r.vote_share !== undefined)
          .map((r) => ({
            area_id: r.area_id,
            area_name: r.area_name,
            votes: r.votes,
            area_total_votes: areaTotals.get(r.area_id) ?? null,
            area_vote_share_pct: pct(r.vote_share!),
            baseline_pct: pct(baseline),
            overperformance_pp: round2(r.vote_share! - baseline),
          }))
          .sort((a, b) => b.overperformance_pp - a.overperformance_pp);

        const partyAreas = direction === 'under'
          ? overperf.filter(a => a.overperformance_pp < 0)
              .map(a => ({ ...a, underperformance_pp: round2(-a.overperformance_pp) }))
              .sort((a, b) => b.underperformance_pp - a.underperformance_pp)
          : overperf.filter(a => a.overperformance_pp > 0);
        return mcpText({
          subject_type: 'party',
          subject_id,
          year,
          election_type: electionType,
          area_level: areaLvl,
          baseline_pct: pct(baseline),
          baseline_description: 'National vote share',
          ...(direction === 'under' ? { underperforming_areas: partyAreas } : { overperforming_areas: partyAreas }),
          method: {
            description: `Baseline = party national vote share. ${direction === 'under' ? 'Underperformance = baseline - area_vote_share' : 'Overperformance = area_vote_share - baseline'}. ${areaLvl} level only.`,
            source_table: tableId,
          },
        });

      } else {
        let allRows: ElectionRecord[];
        let tableId: string;
        try {
          const result = await loadCandidateResults(year, unit_key, undefined, electionType);
          allRows = result.rows;
          tableId = result.tableId;
        } catch (err) {
          return errResult(String(err));
        }

        const unitAreaLevel: AreaLevel = electionType === 'regional' ? 'hyvinvointialue'
          : (electionType === 'eu_parliament' || electionType === 'presidential') ? 'koko_suomi'
          : 'vaalipiiri';
        const vpRow = allRows.find((r) => r.candidate_id === subject_id && r.area_level === unitAreaLevel)
          ?? allRows.find((r) => r.candidate_id === subject_id && r.area_level === 'vaalipiiri');
        if (!vpRow) return errResult(`Candidate ${subject_id} not found${unit_key ? ` in ${unit_key}` : ''}.`);
        const baseline = vpRow.vote_share;
        if (!baseline) return errResult(`No unit-level vote share for candidate ${subject_id}.`);

        const requestedLevel = area_level ?? 'aanestysalue';

        if (requestedLevel === 'kunta') {
          // Aggregate äänestysalue → kunta using parseKuntaCode (D2)
          if (!['parliamentary', 'municipal', 'presidential'].includes(electionType)) {
            return errResult('Kunta-level aggregation is only available for parliamentary, municipal, and presidential elections.');
          }
          // Sum total votes per kunta (all candidates)
          const kuntaTotals = new Map<string, number>();
          const kuntaNames = new Map<string, string>();
          for (const r of allRows.filter((r) => r.area_level === 'aanestysalue')) {
            const kCode = parseKuntaCode(r.area_id, electionType);
            if (!kCode) continue;
            kuntaTotals.set(kCode, (kuntaTotals.get(kCode) ?? 0) + r.votes);
            if (!kuntaNames.has(kCode)) {
              // Derive kunta name: strip trailing district number from äänestysalue name
              kuntaNames.set(kCode, r.area_name.replace(/\s+\d+\w*$/, '').trim() || kCode);
            }
          }
          // Sum candidate votes per kunta
          const candKuntaVotes = new Map<string, number>();
          for (const r of allRows.filter((r) => r.candidate_id === subject_id && r.area_level === 'aanestysalue')) {
            const kCode = parseKuntaCode(r.area_id, electionType);
            if (!kCode) continue;
            candKuntaVotes.set(kCode, (candKuntaVotes.get(kCode) ?? 0) + r.votes);
          }

          const overperf = [...candKuntaVotes.entries()]
            .filter(([, votes]) => votes >= min_votes)
            .map(([kCode, votes]) => {
              const total = kuntaTotals.get(kCode) ?? 1;
              const share = votes / total;
              return {
                area_id: kCode,
                area_name: kuntaNames.get(kCode) ?? kCode,
                votes,
                area_total_votes: total,
                area_vote_share_pct: pct(share),
                baseline_pct: pct(baseline),
                overperformance_pp: round2(share - baseline),
              };
            })
            .sort((a, b) => b.overperformance_pp - a.overperformance_pp);

          const kuntaAreas = direction === 'under'
            ? overperf.filter(a => a.overperformance_pp < 0)
                .map(a => ({ ...a, underperformance_pp: round2(-a.overperformance_pp) }))
                .sort((a, b) => b.underperformance_pp - a.underperformance_pp)
            : overperf.filter(a => a.overperformance_pp > 0);
          return mcpText({
            subject_type: 'candidate',
            subject_id,
            candidate_name: vpRow.candidate_name,
            year,
            election_type: electionType,
            unit_key: unit_key ?? 'national',
            area_level: 'kunta',
            baseline_pct: pct(baseline),
            baseline_description: 'Candidate vote share at unit (vaalipiiri/hyvinvointialue) level',
            ...(direction === 'under' ? { underperforming_areas: kuntaAreas } : { overperforming_areas: kuntaAreas }),
            method: {
              description: 'Baseline = candidate unit-level share. Kunta votes aggregated from äänestysalue via parseKuntaCode. ' +
                           'area_id = 3-digit kunta code. area_name derived from äänestysalue names (best-effort).',
              source_table: tableId,
            },
          });

        } else {
          // Default: äänestysalue level (original behavior)
          // POL-10: total votes per äänestysalue for area-size context
          const areaTotals = new Map<string, number>();
          for (const r of allRows.filter((r) => r.area_level === 'aanestysalue')) {
            areaTotals.set(r.area_id, (areaTotals.get(r.area_id) ?? 0) + r.votes);
          }

          const aalueRows = allRows.filter((r) => r.candidate_id === subject_id && r.area_level === 'aanestysalue' && r.votes >= min_votes);
          const overperf = aalueRows
            .filter((r) => r.vote_share !== undefined)
            .map((r) => ({
              area_id: r.area_id,
              area_name: r.area_name,
              votes: r.votes,
              area_total_votes: areaTotals.get(r.area_id) ?? null,
              area_vote_share_pct: pct(r.vote_share!),
              baseline_pct: pct(baseline),
              overperformance_pp: round2(r.vote_share! - baseline),
            }))
            .sort((a, b) => b.overperformance_pp - a.overperformance_pp);

          const aalueAreas = direction === 'under'
            ? overperf.filter(a => a.overperformance_pp < 0)
                .map(a => ({ ...a, underperformance_pp: round2(-a.overperformance_pp) }))
                .sort((a, b) => b.underperformance_pp - a.underperformance_pp)
            : overperf.filter(a => a.overperformance_pp > 0);
          return mcpText({
            subject_type: 'candidate',
            subject_id,
            candidate_name: vpRow.candidate_name,
            year,
            election_type: electionType,
            unit_key: unit_key ?? 'national',
            area_level: 'aanestysalue',
            baseline_pct: pct(baseline),
            baseline_description: 'Candidate vote share at unit level',
            ...(direction === 'under' ? { underperforming_areas: aalueAreas } : { overperforming_areas: aalueAreas }),
            method: {
              description: `Baseline = candidate vote share in unit aggregate row. ${direction === 'under' ? 'Underperformance = baseline - äänestysalue_share' : 'Overperformance = äänestysalue_share - baseline'}.`,
              source_table: tableId,
            },
          });
        }
      }
    }
  );

  // find_area_underperformance REMOVED (T1): use find_area_overperformance with direction='under'.

  /* DEAD CODE — find_area_underperformance removed (T1)
    use find_area_overperformance with direction='under' instead.
    Original tool description:
    {
      year: z.coerce.number().describe('Election year.'),
      election_type: ELECTION_TYPE_PARAM,
      subject_type: z.enum(['party', 'candidate']).describe('Whether to analyse a party or a candidate.'),
      subject_id: z.string().describe('Party abbreviation (e.g. "KOK") or candidate_id (e.g. "01010176").'),
      unit_key: z.string().optional().describe('Required when subject_type=candidate (vaalipiiri/hyvinvointialue key). Omit for EU/presidential.'),
      area_level: z.enum(['aanestysalue', 'kunta', 'vaalipiiri', 'hyvinvointialue']).optional().describe(
        'Geographic level. For parties: filters rows at this level (default = kunta/vaalipiiri/hyvinvointialue by type). ' +
        'For candidates: aanestysalue = raw (default); kunta = aggregate äänestysalue → kunta (parliamentary/municipal/presidential only).'
      ),
      min_votes: z.coerce.number().optional().describe('Minimum votes in area to include. Defaults to 10.'),
    },
    async ({ year, election_type, subject_type, subject_id, unit_key, area_level, min_votes = 10 }) => {
      const electionType: ElectionType = election_type ?? 'parliamentary';
      if (subject_type === 'party') {
        const areaLvl: AreaLevel = (area_level as AreaLevel | undefined) ?? subnatLevel(electionType);
        let rows: ElectionRecord[];
        let tableId: string;
        try {
          const result = await loadPartyResults(year, undefined, electionType);
          rows = result.rows;
          tableId = result.tableId;
        } catch (err) {
          return errResult(String(err));
        }

        const nationalRow = rows.find((r) => matchesParty(r, subject_id) && r.area_level === 'koko_suomi');
        const baseline = nationalRow?.vote_share;
        if (!baseline) return errResult(`No national vote share found for party "${subject_id}" in ${year}.`);

        // POL-10: area total votes for size context (consistent with find_area_overperformance)
        const areaTotalsP = new Map<string, number>();
        for (const r of rows.filter((r) => r.area_level === areaLvl && r.party_id !== 'SSS')) {
          areaTotalsP.set(r.area_id, (areaTotalsP.get(r.area_id) ?? 0) + r.votes);
        }

        const subnatRows = rows.filter((r) => matchesParty(r, subject_id) && r.area_level === areaLvl && r.votes >= min_votes);
        const underperf = subnatRows
          .filter((r) => r.vote_share !== undefined && r.vote_share < baseline)
          .map((r) => ({
            area_id: r.area_id,
            area_name: r.area_name,
            votes: r.votes,
            area_total_votes: areaTotalsP.get(r.area_id) ?? null,
            area_vote_share_pct: pct(r.vote_share!),
            baseline_pct: pct(baseline),
            underperformance_pp: round2(baseline - r.vote_share!),
          }))
          .sort((a, b) => b.underperformance_pp - a.underperformance_pp);

        return mcpText({
          subject_type: 'party',
          subject_id,
          year,
          election_type: electionType,
          area_level: areaLvl,
          baseline_pct: pct(baseline),
          baseline_description: 'National vote share',
          underperforming_areas: underperf,
          method: {
            description: `Baseline = party national vote share. Underperformance = baseline - area_vote_share. ${areaLvl} level.`,
            source_table: tableId,
          },
        });

      } else {
        let allRows: ElectionRecord[];
        let tableId: string;
        try {
          const result = await loadCandidateResults(year, unit_key, undefined, electionType);
          allRows = result.rows;
          tableId = result.tableId;
        } catch (err) {
          return errResult(String(err));
        }

        const unitAreaLevel: AreaLevel = electionType === 'regional' ? 'hyvinvointialue'
          : (electionType === 'eu_parliament' || electionType === 'presidential') ? 'koko_suomi'
          : 'vaalipiiri';
        const vpRow = allRows.find((r) => r.candidate_id === subject_id && r.area_level === unitAreaLevel)
          ?? allRows.find((r) => r.candidate_id === subject_id && r.area_level === 'vaalipiiri');
        if (!vpRow) return errResult(`Candidate ${subject_id} not found${unit_key ? ` in ${unit_key}` : ''}.`);
        const baseline = vpRow.vote_share;
        if (!baseline) return errResult(`No unit-level vote share for candidate ${subject_id}.`);

        const requestedLevel = area_level ?? 'aanestysalue';

        if (requestedLevel === 'kunta') {
          if (!['parliamentary', 'municipal', 'presidential'].includes(electionType)) {
            return errResult('Kunta-level aggregation is only available for parliamentary, municipal, and presidential elections.');
          }
          const kuntaTotals = new Map<string, number>();
          const kuntaNames = new Map<string, string>();
          for (const r of allRows.filter((r) => r.area_level === 'aanestysalue')) {
            const kCode = parseKuntaCode(r.area_id, electionType);
            if (!kCode) continue;
            kuntaTotals.set(kCode, (kuntaTotals.get(kCode) ?? 0) + r.votes);
            if (!kuntaNames.has(kCode)) {
              kuntaNames.set(kCode, r.area_name.replace(/\s+\d+\w*$/, '').trim() || kCode);
            }
          }
          const candKuntaVotes = new Map<string, number>();
          for (const r of allRows.filter((r) => r.candidate_id === subject_id && r.area_level === 'aanestysalue')) {
            const kCode = parseKuntaCode(r.area_id, electionType);
            if (!kCode) continue;
            candKuntaVotes.set(kCode, (candKuntaVotes.get(kCode) ?? 0) + r.votes);
          }

          const underperf = [...candKuntaVotes.entries()]
            .filter(([, votes]) => votes >= min_votes)
            .map(([kCode, votes]) => {
              const total = kuntaTotals.get(kCode) ?? 1;
              const share = votes / total;
              return {
                area_id: kCode,
                area_name: kuntaNames.get(kCode) ?? kCode,
                votes,
                area_total_votes: total,
                area_vote_share_pct: pct(share),
                baseline_pct: pct(baseline),
                underperformance_pp: round2(baseline - share),
              };
            })
            .filter((r) => r.underperformance_pp > 0)
            .sort((a, b) => b.underperformance_pp - a.underperformance_pp);

          return mcpText({
            subject_type: 'candidate',
            subject_id,
            candidate_name: vpRow.candidate_name,
            year,
            election_type: electionType,
            unit_key: unit_key ?? 'national',
            area_level: 'kunta',
            baseline_pct: pct(baseline),
            baseline_description: 'Candidate vote share at unit (vaalipiiri/hyvinvointialue) level',
            underperforming_areas: underperf,
            method: {
              description: 'Baseline = candidate unit-level share. Kunta votes aggregated from äänestysalue via parseKuntaCode. ' +
                           'area_id = 3-digit kunta code. area_name derived from äänestysalue names (best-effort).',
              source_table: tableId,
            },
          });

        } else {
          // Default: äänestysalue level
          const areaTotalsC = new Map<string, number>();
          for (const r of allRows.filter((r) => r.area_level === 'aanestysalue')) {
            areaTotalsC.set(r.area_id, (areaTotalsC.get(r.area_id) ?? 0) + r.votes);
          }

          const aalueRows = allRows.filter((r) => r.candidate_id === subject_id && r.area_level === 'aanestysalue' && r.votes >= min_votes);
          const underperf = aalueRows
            .filter((r) => r.vote_share !== undefined && r.vote_share < baseline)
            .map((r) => ({
              area_id: r.area_id,
              area_name: r.area_name,
              votes: r.votes,
              area_total_votes: areaTotalsC.get(r.area_id) ?? null,
              area_vote_share_pct: pct(r.vote_share!),
              baseline_pct: pct(baseline),
              underperformance_pp: round2(baseline - r.vote_share!),
            }))
            .sort((a, b) => b.underperformance_pp - a.underperformance_pp);

  */

  // ── analyze_geographic_concentration ────────────────────────────────────
  server.tool(
    'analyze_geographic_concentration',
    'Measures how geographically concentrated a candidate\'s or party\'s vote is. Returns top-N area dependence metrics. A score close to 1 means nearly all votes come from few areas.',
    {
      year: z.coerce.number().describe('Election year.'),
      election_type: ELECTION_TYPE_PARAM,
      subject_type: z.enum(['party', 'candidate']).describe('Whether to analyse a party or a candidate.'),
      subject_id: z.string().describe('Party abbreviation (e.g. "KOK") or candidate_id.'),
      unit_key: z.string().optional().describe('Required when subject_type=candidate (vaalipiiri/hyvinvointialue key). Omit for EU/presidential.'),
    },
    async ({ year, election_type, subject_type, subject_id, unit_key }) => {
      const electionType: ElectionType = election_type ?? 'parliamentary';
      const areaLvl = subnatLevel(electionType);
      if (subject_type === 'party') {
        let rows: ElectionRecord[];
        let tableId: string;
        try {
          const result = await loadPartyResults(year, undefined, electionType);
          rows = result.rows;
          tableId = result.tableId;
        } catch (err) {
          return errResult(String(err));
        }
        const subnatRows = rows.filter((r) => matchesParty(r, subject_id) && r.area_level === areaLvl);
        if (subnatRows.length === 0) return errResult(`Party "${subject_id}" not found in ${electionType} ${year}.`);
        const conc = concentrationMetrics(subnatRows.map((r) => r.votes));
        const top10 = topN(subnatRows, 10).map((r) => ({ area_name: r.area_name, votes: r.votes }));
        const totalVotesP = subnatRows.reduce((s, r) => s + r.votes, 0);
        const hhi = totalVotesP > 0 ? Math.round(subnatRows.reduce((s, r) => s + (r.votes / totalVotesP) ** 2, 0) * 10000) / 10000 : null;

        return mcpText({
          subject_type: 'party', subject_id, year, election_type: electionType,
          concentration: conc,
          hhi,
          [`top_10_${areaLvl}s`]: top10,
          interpretation: {
            top1_share: `${conc.top1_share_pct}% of votes come from the single strongest ${areaLvl}`,
            top3_share: `${conc.top3_share_pct}% of votes come from the top 3 ${areaLvl}s`,
            top10_share: `${conc.top10_share_pct}% of votes come from the top 10 ${areaLvl}s`,
            hhi: hhi !== null ? `HHI=${hhi} (0=perfectly dispersed, 1=all votes in one area)` : 'n/a',
          },
          method: { description: `Top-N share concentration and HHI (Herfindahl) using ${areaLvl}-level rows.`, source_table: tableId },
        });

      } else {
        let allRows: ElectionRecord[];
        let tableId: string;
        try {
          const result = await loadCandidateResults(year, unit_key, undefined, electionType);
          allRows = result.rows;
          tableId = result.tableId;
        } catch (err) {
          return errResult(String(err));
        }
        const aalueRows = allRows.filter((r) => r.candidate_id === subject_id && r.area_level === 'aanestysalue');
        if (aalueRows.length === 0) return errResult(`Candidate ${subject_id} not found${unit_key ? ` in ${unit_key}` : ''}.`);
        const vpRow = allRows.find((r) => r.candidate_id === subject_id && (r.area_level === 'vaalipiiri' || r.area_level === 'hyvinvointialue' || r.area_level === 'koko_suomi'));
        const conc = concentrationMetrics(aalueRows.map((r) => r.votes));
        const top10 = topN(aalueRows, 10).map((r) => ({ area_name: r.area_name, votes: r.votes }));
        const totalVotesC = aalueRows.reduce((s, r) => s + r.votes, 0);
        const hhiC = totalVotesC > 0 ? Math.round(aalueRows.reduce((s, r) => s + (r.votes / totalVotesC) ** 2, 0) * 10000) / 10000 : null;

        return mcpText({
          subject_type: 'candidate', subject_id,
          candidate_name: vpRow?.candidate_name,
          year, election_type: electionType, unit_key: unit_key ?? 'national',
          concentration: conc,
          hhi: hhiC,
          top_10_aanestysalueet: top10,
          interpretation: {
            top1_share: `${conc.top1_share_pct}% of votes come from the single strongest äänestysalue`,
            top3_share: `${conc.top3_share_pct}% of votes come from the top 3 äänestysalueet`,
            top10_share: `${conc.top10_share_pct}% of votes come from the top 10 äänestysalueet`,
            hhi: hhiC !== null ? `HHI=${hhiC} (0=perfectly dispersed, 1=all votes in one äänestysalue)` : 'n/a',
          },
          method: { description: 'Top-N share concentration and HHI (Herfindahl) using äänestysalue-level rows to avoid double-counting.', source_table: tableId },
        });
      }
    }
  );

}
