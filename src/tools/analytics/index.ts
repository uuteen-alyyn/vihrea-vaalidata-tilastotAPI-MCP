import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { loadPartyResults, loadCandidateResults } from '../../data/loaders.js';
import type { ElectionRecord, ElectionType, AreaLevel } from '../../data/types.js';
import { ELECTION_TYPE_PARAM, subnatLevel, matchesParty, pct, round2, mcpText, errResult } from '../shared.js';

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
      year: z.number().describe('Election year (e.g. 2023).'),
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

      return mcpText({
        candidate_id,
        candidate_name: candidateName,
        party: partyId,
        year,
        election_type: electionType,
        unit_key: unitLabel,
        total_votes: totalVotes,
        vote_share_pct: vpRow?.vote_share ? pct(vpRow.vote_share) : null,
        rank_overall_in_unit: overallRank || null,
        rank_within_party: rankWithinParty || null,
        rank_within_party_caveat: RANK_WITHIN_PARTY_CAVEAT,
        total_party_candidates: partyVpRows.length,
        share_of_party_vote_pct: shareOfPartyVotePct,
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
      year: z.number().describe('Election year.'),
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

      return mcpText({
        party_id,
        party_name: partyName,
        year,
        election_type: electionType,
        national_votes: nationalVotes,
        national_vote_share_pct: nationalShare ? pct(nationalShare) : null,
        total_national_votes_cast: totalNationalVotes,
        [`n_${areaLvl}s`]: subnatRows.length,
        [`n_${areaLvl}s_with_votes`]: subnatRows.filter((r) => r.votes > 0).length,
        [`strongest_${areaLvl}s`]: strongest,
        [`weakest_${areaLvl}s`]: weakest,
        geographic_concentration: concentration,
        method: {
          description: `National total from koko_suomi row. Strongest/weakest based on ${areaLvl}-level rows.`,
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
      year: z.number().describe('Election year.'),
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
      year: z.number().describe('Election year.'),
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

  // ── compare_elections ────────────────────────────────────────────────────
  server.tool(
    'compare_elections',
    'Tracks a party across multiple elections of the same type: vote total, vote share, and rank at each election, plus change metrics between consecutive elections.',
    {
      party_id: z.string().describe('Party abbreviation or code (e.g. "KOK", "SDP").'),
      election_type: ELECTION_TYPE_PARAM,
      years: z.array(z.number()).min(2).max(10).describe('Election years to compare (e.g. [2015, 2019, 2023]).'),
      area_id: z.string().optional().describe('Area code to compare within. Defaults to national (SSS).'),
    },
    async ({ party_id, election_type, years, area_id }) => {
      const electionType: ElectionType = election_type ?? 'parliamentary';
      const effectiveArea = area_id ?? 'SSS';
      const yearResults: Array<{
        year: number;
        votes: number | null;
        vote_share_pct: number | null;
        _raw_vote_share: number | null;
        rank: number | null;
        error?: string;
      }> = [];
      const tableIds: string[] = [];

      // _raw_vote_share is kept unrounded for accurate change computation (POL-9/STAT-4)
      const yearResultsUnsorted = await Promise.all(years.map(async (year) => {
        try {
          const { rows, tableId } = await loadPartyResults(year, effectiveArea, electionType);
          if (!tableIds.includes(tableId)) tableIds.push(tableId);
          const row = rows.find((r) => matchesParty(r, party_id));
          const rank = [...rows].sort((a, b) => b.votes - a.votes).findIndex((r) => r.party_id === row?.party_id) + 1;
          return {
            year,
            votes: row?.votes ?? null,
            vote_share_pct: row?.vote_share ? pct(row.vote_share) : null,
            _raw_vote_share: row?.vote_share ?? null,
            rank: row ? (rank || null) : null,
          };
        } catch (err) {
          console.error(`[compare_elections] failed to load year ${year}:`, err);
          return { year, votes: null, vote_share_pct: null, _raw_vote_share: null, rank: null, error: `No data for ${year}` };
        }
      }));
      yearResults.push(...yearResultsUnsorted.sort((a, b) => a.year - b.year));

      // Compute changes between consecutive years.
      // POL-9/STAT-4: derive vote_share_change_pp from raw (unrounded) values before rounding
      // to avoid compounding rounding errors from pct()-rounded inputs.
      const changes = yearResults.slice(1).map((curr, i) => {
        const prev = yearResults[i]!;
        return {
          from_year: prev.year,
          to_year: curr.year,
          vote_change: (curr.votes !== null && prev.votes !== null) ? curr.votes - prev.votes : null,
          vote_share_change_pp: (curr._raw_vote_share !== null && prev._raw_vote_share !== null)
            ? round2(curr._raw_vote_share - prev._raw_vote_share)
            : null,
          rank_change: (curr.rank !== null && prev.rank !== null) ? prev.rank - curr.rank : null, // positive = improved
        };
      });

      return mcpText({
        party_id,
        election_type: electionType,
        area_id: effectiveArea,
        // Strip internal _raw_vote_share from output
        by_year: yearResults.map(({ _raw_vote_share: _r, ...rest }) => rest),
        changes,
        method: {
          description: 'Votes and shares from party table. Rank is relative to all parties in the same area per year. vote_share_change_pp = percentage point change. rank_change: positive = moved up (better).',
          source_tables: tableIds,
        },
      });
    }
  );

  // ── find_area_overperformance ────────────────────────────────────────────
  server.tool(
    'find_area_overperformance',
    'Finds areas where a party or candidate performs above their baseline. Baseline for parties = national vote share. Baseline for candidates = unit-level vote share. Returns areas ranked by overperformance magnitude.',
    {
      year: z.number().describe('Election year.'),
      election_type: ELECTION_TYPE_PARAM,
      subject_type: z.enum(['party', 'candidate']).describe('Whether to analyse a party or a candidate.'),
      subject_id: z.string().describe('Party abbreviation (e.g. "KOK") or candidate_id (e.g. "01010176").'),
      unit_key: z.string().optional().describe('Required when subject_type=candidate (vaalipiiri/hyvinvointialue key). Omit for EU/presidential.'),
      min_votes: z.number().optional().describe('Minimum votes in an area to include in results. Defaults to 10.'),
    },
    async ({ year, election_type, subject_type, subject_id, unit_key, min_votes = 10 }) => {
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

        return mcpText({
          subject_type: 'party',
          subject_id,
          year,
          election_type: electionType,
          baseline_pct: pct(baseline),
          baseline_description: 'National vote share',
          overperforming_areas: overperf.filter((a) => a.overperformance_pp > 0),
          method: {
            description: `Baseline = party national vote share. Overperformance = area_vote_share - baseline. ${areaLvl} level only.`,
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

        return mcpText({
          subject_type: 'candidate',
          subject_id,
          candidate_name: vpRow.candidate_name,
          year,
          election_type: electionType,
          unit_key: unit_key ?? 'national',
          baseline_pct: pct(baseline),
          baseline_description: 'Candidate vote share at unit level',
          overperforming_areas: overperf.filter((a) => a.overperformance_pp > 0),
          method: {
            description: 'Baseline = candidate vote share in unit aggregate row. Overperformance = äänestysalue_share - baseline.',
            source_table: tableId,
          },
        });
      }
    }
  );

  // ── find_area_underperformance ───────────────────────────────────────────
  server.tool(
    'find_area_underperformance',
    'Finds areas where a party or candidate performs below their baseline. Inverse of find_area_overperformance.',
    {
      year: z.number().describe('Election year.'),
      election_type: ELECTION_TYPE_PARAM,
      subject_type: z.enum(['party', 'candidate']).describe('Whether to analyse a party or a candidate.'),
      subject_id: z.string().describe('Party abbreviation (e.g. "KOK") or candidate_id (e.g. "01010176").'),
      unit_key: z.string().optional().describe('Required when subject_type=candidate (vaalipiiri/hyvinvointialue key). Omit for EU/presidential.'),
      min_votes: z.number().optional().describe('Minimum votes in area to include. Defaults to 10.'),
    },
    async ({ year, election_type, subject_type, subject_id, unit_key, min_votes = 10 }) => {
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

        // POL-10: area total votes for size context (consistent with find_area_overperformance)
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

        return mcpText({
          subject_type: 'candidate',
          subject_id,
          candidate_name: vpRow.candidate_name,
          year,
          election_type: electionType,
          unit_key: unit_key ?? 'national',
          baseline_pct: pct(baseline),
          baseline_description: 'Candidate vote share at unit level',
          underperforming_areas: underperf,
          method: {
            description: 'Baseline = candidate vote share in unit aggregate row. Underperformance = baseline - äänestysalue_share.',
            source_table: tableId,
          },
        });
      }
    }
  );

  // ── analyze_geographic_concentration ────────────────────────────────────
  server.tool(
    'analyze_geographic_concentration',
    'Measures how geographically concentrated a candidate\'s or party\'s vote is. Returns top-N area dependence metrics. A score close to 1 means nearly all votes come from few areas.',
    {
      year: z.number().describe('Election year.'),
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

        return mcpText({
          subject_type: 'party', subject_id, year, election_type: electionType,
          concentration: conc,
          [`top_10_${areaLvl}s`]: top10,
          interpretation: {
            top1_share: `${conc.top1_share_pct}% of votes come from the single strongest ${areaLvl}`,
            top3_share: `${conc.top3_share_pct}% of votes come from the top 3 ${areaLvl}s`,
            top10_share: `${conc.top10_share_pct}% of votes come from the top 10 ${areaLvl}s`,
          },
          method: { description: `Top-N share concentration using ${areaLvl}-level rows.`, source_table: tableId },
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

        return mcpText({
          subject_type: 'candidate', subject_id,
          candidate_name: vpRow?.candidate_name,
          year, election_type: electionType, unit_key: unit_key ?? 'national',
          concentration: conc,
          top_10_aanestysalueet: top10,
          interpretation: {
            top1_share: `${conc.top1_share_pct}% of votes come from the single strongest äänestysalue`,
            top3_share: `${conc.top3_share_pct}% of votes come from the top 3 äänestysalueet`,
            top10_share: `${conc.top10_share_pct}% of votes come from the top 10 äänestysalueet`,
          },
          method: { description: 'Top-N share concentration using äänestysalue-level rows to avoid double-counting.', source_table: tableId },
        });
      }
    }
  );

  // ── analyze_within_party_position ────────────────────────────────────────
  server.tool(
    'analyze_within_party_position',
    'Analyses a candidate\'s position within their party: rank among party candidates, share of party vote, votes above/below adjacent candidates.',
    {
      year: z.number().describe('Election year.'),
      election_type: ELECTION_TYPE_PARAM,
      candidate_id: z.string().describe('Candidate code. Use resolve_candidate if you only have a name.'),
      unit_key: z.string().optional().describe('Vaalipiiri (parliamentary/municipal), hyvinvointialue (regional), or omit for EU/presidential.'),
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
        return errResult(String(err));
      }

      const unitAreaLevel: AreaLevel = electionType === 'regional' ? 'hyvinvointialue'
        : (electionType === 'eu_parliament' || electionType === 'presidential') ? 'koko_suomi'
        : 'vaalipiiri';
      const vpRows = allRows.filter((r) => r.area_level === unitAreaLevel && r.candidate_id)
        .sort((a, b) => b.votes - a.votes);

      const targetRow = vpRows.find((r) => r.candidate_id === candidate_id);
      if (!targetRow) return errResult(`Candidate ${candidate_id} not found${unit_key ? ` in ${unit_key}` : ''}.`);

      const partyId = targetRow.party_id;
      const partyRows = vpRows.filter((r) => r.party_id === partyId).sort((a, b) => b.votes - a.votes);
      const partyTotalVotes = partyRows.reduce((s, r) => s + r.votes, 0);
      const rankWithinParty = partyRows.findIndex((r) => r.candidate_id === candidate_id) + 1;

      const partyRowsWithRank = partyRows.map((r, i) => ({
        candidate_id: r.candidate_id,
        candidate_name: r.candidate_name,
        votes: r.votes,
        rank_within_party: i + 1,
      }));

      const candidatePartyRankIdx = rankWithinParty - 1;
      const above = partyRowsWithRank[candidatePartyRankIdx - 1];
      const below = partyRowsWithRank[candidatePartyRankIdx + 1];

      return mcpText({
        candidate_id,
        candidate_name: targetRow.candidate_name,
        party: partyId,
        year,
        election_type: electionType,
        unit_key: unit_key ?? 'national',
        votes: targetRow.votes,
        rank_within_party: rankWithinParty,
        rank_within_party_caveat: RANK_WITHIN_PARTY_CAVEAT,
        total_party_candidates: partyRows.length,
        share_of_party_vote_pct: partyTotalVotes > 0 ? pct(targetRow.votes / partyTotalVotes * 100) : null,
        party_total_votes: partyTotalVotes,
        candidate_above_in_party: above ?? null,
        candidate_below_in_party: below ?? null,
        votes_behind_rank_above: above ? above.votes - targetRow.votes : null,
        votes_ahead_of_rank_below: below ? targetRow.votes - below.votes : null,
        all_party_candidates: partyRowsWithRank,
        method: {
          description: 'Ranks computed at vaalipiiri-level aggregate rows. Party total = sum of all party candidate votes at VP level.',
          source_table: tableId,
        },
      });
    }
  );

  // ── analyze_vote_distribution ────────────────────────────────────────────
  server.tool(
    'analyze_vote_distribution',
    'Analyses how a party\'s or candidate\'s votes are distributed across geographic areas: mean, median, standard deviation, min, max, and a histogram.',
    {
      year: z.number().describe('Election year.'),
      election_type: ELECTION_TYPE_PARAM,
      subject_type: z.enum(['party', 'candidate']).describe('Whether to analyse a party or a candidate.'),
      subject_id: z.string().describe('Party abbreviation or candidate_id.'),
      unit_key: z.string().optional().describe('Required when subject_type=candidate (vaalipiiri/hyvinvointialue key). Omit for EU/presidential.'),
    },
    async ({ year, election_type, subject_type, subject_id, unit_key }) => {
      const electionType: ElectionType = election_type ?? 'parliamentary';
      const areaLvl = subnatLevel(electionType);
      let voteCounts: number[];
      let areaLevel: string;
      let tableId: string;

      if (subject_type === 'party') {
        let rows: ElectionRecord[];
        try {
          const result = await loadPartyResults(year, undefined, electionType);
          rows = result.rows;
          tableId = result.tableId;
        } catch (err) {
          return errResult(String(err));
        }
        const subnatRows = rows.filter((r) => matchesParty(r, subject_id) && r.area_level === areaLvl);
        if (subnatRows.length === 0) return errResult(`Party "${subject_id}" not found in ${electionType} ${year}.`);
        voteCounts = subnatRows.map((r) => r.votes);
        areaLevel = areaLvl;
      } else {
        let allRows: ElectionRecord[];
        try {
          const result = await loadCandidateResults(year, unit_key, undefined, electionType);
          allRows = result.rows;
          tableId = result.tableId;
        } catch (err) {
          return errResult(String(err));
        }
        const aalueRows = allRows.filter((r) => r.candidate_id === subject_id && r.area_level === 'aanestysalue');
        if (aalueRows.length === 0) return errResult(`Candidate ${subject_id} not found${unit_key ? ` in ${unit_key}` : ''}.`);
        voteCounts = aalueRows.map((r) => r.votes);
        areaLevel = 'aanestysalue';
      }

      const sorted = [...voteCounts].sort((a, b) => a - b);
      const n = sorted.length;
      const total = sorted.reduce((s, v) => s + v, 0);
      const mean = total / n;
      const median = n % 2 === 0
        ? (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2
        : sorted[Math.floor(n / 2)]!;
      const variance = sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
      const stdDev = Math.sqrt(variance);
      const min = sorted[0]!;
      const max = sorted[n - 1]!;

      // Simple histogram: 10 equal-width buckets, O(n) single pass
      const bucketSize = Math.ceil((max - min + 1) / 10) || 1;
      const counts = new Array(10).fill(0) as number[];
      for (const v of sorted) {
        const idx = Math.min(9, Math.floor((v - min) / bucketSize));
        counts[idx]++;
      }
      const rawBuckets = counts
        .map((count, i) => ({
          from: min + i * bucketSize,
          to: min + (i + 1) * bucketSize - 1,
          count,
        }))
        .filter((b) => b.from <= max);
      // STAT-3: clamp last bucket's `to` to actual data max to avoid arithmetic overshoot
      const buckets = rawBuckets.map((b, i) =>
        i === rawBuckets.length - 1 ? { ...b, to: max } : b
      );

      return mcpText({
        subject_type,
        subject_id,
        year,
        area_level: areaLevel,
        n_areas: n,
        total_votes: total,
        mean_votes_per_area: round2(mean),
        median_votes_per_area: median,
        std_dev: round2(stdDev),
        min_votes: min,
        max_votes: max,
        histogram: buckets,
        method: {
          description: `Vote count distribution across ${areaLevel} areas. Histogram uses equal-width buckets.`,
          source_table: tableId,
        },
      });
    }
  );

  // ── compare_across_elections ─────────────────────────────────────────────
  server.tool(
    'compare_across_elections',
    'Compares a party\'s national vote share and total across multiple election types and years in a single response. Useful for tracking a party\'s trajectory across parliamentary, municipal, regional, and EU elections. Includes comparability caveats because electorates and election rules differ across types.',
    {
      party: z.string().max(200).describe(
        'Party abbreviation or name to look up (e.g. "SDP", "KOK", "Perussuomalaiset"). ' +
        'Matched against party_id and party_name in each election.'
      ),
      elections: z.array(
        z.object({
          election_type: z.enum(['parliamentary', 'municipal', 'eu_parliament', 'regional']),
          year: z.number().int().min(1983).max(2030),
        })
      ).min(2).max(10).describe(
        'List of election type + year pairs to compare. ' +
        'Example: [{"election_type":"parliamentary","year":2023},{"election_type":"municipal","year":2021}]. ' +
        'Presidential elections are excluded — no party dimension exists in presidential data.'
      ),
    },
    async ({ party, elections }) => {
      const tableIds: string[] = [];

      const results = await Promise.all(elections.map(async ({ election_type, year }) => {
        try {
          const { rows, tableId } = await loadPartyResults(year, 'SSS', election_type as ElectionType);
          if (!tableIds.includes(tableId)) tableIds.push(tableId);

          // Find national total row for this party
          const row = rows.find((r) => matchesParty(r, party));
          if (!row) {
            return {
              election_type,
              year,
              votes: null,
              vote_share_pct: null,
              party_id: null,
              party_name: null,
              error: `Party "${party}" not found in ${election_type} ${year}`,
            };
          }

          // Find total national votes (all parties combined — sum SSS row if present, else sum all party rows)
          const nationalTotal = rows.reduce((s, r) => s + r.votes, 0);

          return {
            election_type,
            year,
            votes: row.votes,
            vote_share_pct: row.vote_share ? pct(row.vote_share) : pct((row.votes / nationalTotal) * 100),
            party_id: row.party_id,
            party_name: row.party_name,
          };
        } catch (err) {
          console.error(`[compare_across_elections] failed for ${election_type} ${year}:`, err);
          return {
            election_type,
            year,
            votes: null,
            vote_share_pct: null,
            party_id: null,
            party_name: null,
            error: `Data unavailable for ${election_type} ${year}`,
          };
        }
      }));

      // Sort by year ascending, then by election_type for same-year entries
      results.sort((a, b) => a.year !== b.year ? a.year - b.year : a.election_type.localeCompare(b.election_type));

      // Comparability notes per election type
      const comparabilityNotes: Record<string, string> = {
        parliamentary: 'National electorate: all Finnish citizens aged 18+. Vote share = % of all valid votes cast nationally.',
        municipal:     'National electorate: all Finnish citizens + permanent residents aged 18+. Vote share = % of all valid municipal votes cast nationally (sum across all municipalities).',
        regional:      'National electorate: all Finnish citizens + permanent residents aged 18+ (same as municipal). Covers 21 hyvinvointialue.',
        eu_parliament: 'Electorate: Finnish citizens + EU citizens residing in Finland. Non-Finnish EU citizens may vote here instead of their home country. Slightly different denominator from other election types.',
      };

      const uniqueTypes = [...new Set(results.map((r) => r.election_type))];
      const caveats: string[] = [];
      if (uniqueTypes.length > 1) {
        caveats.push(
          'Cross-election-type vote shares are NOT directly comparable. ' +
          'Each election type has different eligibility rules, different total electorates, ' +
          'and different party dynamics. Treat this as indicative trend data, not a strict apples-to-apples comparison.'
        );
      }
      if (uniqueTypes.includes('eu_parliament')) {
        // POL-13: expanded EU caveat with turnout ratio and second-order election reference
        caveats.push(
          'EU Parliament elections are second-order elections (Reif & Schmitt 1980): Finnish EU turnout ' +
          'is typically ~40% vs ~70–75% in parliamentary elections. The EU electorate is self-selected ' +
          '— lower-salience voters disproportionately abstain. EU vote shares and trends are structurally ' +
          'incomparable to national elections. Additionally, non-Finnish EU citizens residing in Finland ' +
          'may vote here rather than in their home country, slightly changing the eligible electorate.'
        );
      }
      if (uniqueTypes.includes('municipal')) {
        // POL-14: quantified municipal electorate caveat
        caveats.push(
          'Municipal elections allow all permanent residents aged 18+ to vote — including non-citizens ' +
          '(unlike parliamentary elections which require Finnish citizenship). This expands the eligible ' +
          'electorate by roughly 2–3% of eligible voters nationally. Vote shares are not directly ' +
          'comparable between municipal and parliamentary elections for parties with different support ' +
          'profiles among non-citizen residents. Municipal vote share also sums across all municipalities; ' +
          'parties without candidates everywhere will have lower national shares.'
        );
      }
      if (uniqueTypes.includes('eu_parliament') && uniqueTypes.includes('municipal')) {
        caveats.push(
          'This comparison includes both EU and municipal elections alongside parliamentary elections. ' +
          'All three have different electorates and dynamics — treat trends as directional indicators only.'
        );
      }

      return mcpText({
        party_query: party,
        // POL-6: caveats appear before results so LLM consumers see warnings first
        caveats,
        comparability_notes: Object.fromEntries(
          uniqueTypes.map((t) => [t, comparabilityNotes[t] ?? ''])
        ),
        results,
        method: {
          description:
            'National vote totals and shares loaded from each election\'s party-by-kunta table ' +
            'at the national (SSS) level. vote_share_pct taken from the table\'s own share column when ' +
            'available, otherwise computed as votes / sum_of_all_party_votes × 100.',
          source_tables: tableIds,
        },
      });
    }
  );

}
