import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { loadPartyResults, loadCandidateResults } from '../../data/loaders.js';
import type { ElectionRecord } from '../../data/types.js';

// ─── Analytics helpers ────────────────────────────────────────────────────────

/**
 * Geographic concentration index.
 * Uses top-N share method: fraction of total votes held by top N areas.
 * More interpretable than HHI for election analysis.
 */
function concentrationMetrics(areaVotes: number[]): {
  top1_share: number;
  top3_share: number;
  top5_share: number;
  top10_share: number;
  n_areas: number;
} {
  const sorted = [...areaVotes].sort((a, b) => b - a);
  const total = sorted.reduce((s, v) => s + v, 0);
  if (total === 0) return { top1_share: 0, top3_share: 0, top5_share: 0, top10_share: 0, n_areas: 0 };
  const topShare = (n: number) =>
    Math.round((sorted.slice(0, n).reduce((s, v) => s + v, 0) / total) * 1000) / 1000;
  return {
    top1_share: topShare(1),
    top3_share: topShare(3),
    top5_share: topShare(5),
    top10_share: topShare(10),
    n_areas: sorted.length,
  };
}

function pct(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function topN<T extends { votes: number }>(rows: T[], n: number): T[] {
  return [...rows].sort((a, b) => b.votes - a.votes).slice(0, n);
}

function bottomN<T extends { votes: number }>(rows: T[], n: number): T[] {
  return [...rows].sort((a, b) => a.votes - b.votes).slice(0, n);
}

/**
 * Match a party row by either its numeric code (party_id) or text label (party_name).
 * party_name in 13sw rows is the full text like "Kansallinen Kokoomus" or abbreviated like "KOK".
 */
function matchesParty(row: ElectionRecord, query: string): boolean {
  const q = query.toLowerCase().trim();
  return row.party_id === query || row.party_name?.toLowerCase() === q;
}

function mcpText(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }] };
}

function errResult(msg: string) {
  return mcpText({ error: msg });
}

// ─── Tool registration ────────────────────────────────────────────────────────

export function registerAnalyticsTools(server: McpServer): void {

  // ── analyze_candidate_profile ────────────────────────────────────────────
  server.tool(
    'analyze_candidate_profile',
    'Computes a comprehensive performance profile for a single candidate: total votes, vote share, overall rank in vaalipiiri, rank within party, share of party vote, strongest and weakest äänestysalueet, and geographic concentration index.',
    {
      year: z.number().describe('Election year (e.g. 2023).'),
      candidate_id: z.string().describe('Candidate code (e.g. "01010176"). Use resolve_candidate if you only have a name.'),
      vaalipiiri: z.string().describe('Vaalipiiri key (e.g. "helsinki"). Required — candidate data is stored per vaalipiiri.'),
    },
    async ({ year, candidate_id, vaalipiiri }) => {
      let allRows: ElectionRecord[];
      let tableId: string;
      let vpCode: string;
      let cache_hit: boolean;
      try {
        const result = await loadCandidateResults(year, vaalipiiri);
        allRows = result.rows;
        tableId = result.tableId;
        vpCode = result.vaalipiiri_code;
        cache_hit = result.cache_hit;
      } catch (err) {
        return errResult(`Failed to load candidate data: ${String(err)}`);
      }

      // The candidate's own rows across all area levels
      const candidateRows = allRows.filter((r) => r.candidate_id === candidate_id);
      if (candidateRows.length === 0) {
        return errResult(`Candidate ${candidate_id} not found in vaalipiiri ${vaalipiiri} ${year}.`);
      }

      // Vaalipiiri-level total for this candidate
      const vpRow = candidateRows.find((r) => r.area_level === 'vaalipiiri');
      const totalVotes = vpRow?.votes ?? candidateRows.filter((r) => r.area_level === 'aanestysalue').reduce((s, r) => s + r.votes, 0);
      const candidateName = candidateRows[0]!.candidate_name ?? candidate_id;
      const partyId = candidateRows[0]!.party_id ?? '';

      // All candidates at vaalipiiri level → overall rank
      const allVpRows = allRows.filter((r) => r.area_level === 'vaalipiiri' && r.candidate_id);
      const overallRank = allVpRows
        .sort((a, b) => b.votes - a.votes)
        .findIndex((r) => r.candidate_id === candidate_id) + 1;

      // Same-party candidates at vaalipiiri level → rank within party
      const partyVpRows = allVpRows.filter((r) => r.party_id === partyId).sort((a, b) => b.votes - a.votes);
      const rankWithinParty = partyVpRows.findIndex((r) => r.candidate_id === candidate_id) + 1;
      const partyTotalVotes = partyVpRows.reduce((s, r) => s + r.votes, 0);
      const shareOfPartyVote = partyTotalVotes > 0 ? round2(totalVotes / partyTotalVotes) : null;

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
        vaalipiiri,
        total_votes: totalVotes,
        vote_share_pct: vpRow?.vote_share ? pct(vpRow.vote_share) : null,
        rank_overall_in_vaalipiiri: overallRank || null,
        rank_within_party: rankWithinParty || null,
        total_party_candidates: partyVpRows.length,
        share_of_party_vote: shareOfPartyVote,
        strongest_areas: strongest,
        weakest_areas: weakest,
        geographic_concentration: concentration,
        method: {
          description: 'Ranks computed at vaalipiiri level using the VP## aggregate row. Geographic analysis uses äänestysalue-level rows only to avoid double-counting.',
          source_table: tableId,
          cache_hit,
        },
      });
    }
  );

  // ── analyze_party_profile ────────────────────────────────────────────────
  server.tool(
    'analyze_party_profile',
    'Computes a performance profile for a party in an election: national totals, vote share, strongest and weakest municipalities, and geographic spread.',
    {
      year: z.number().describe('Election year (1983–2023 for parliamentary).'),
      party_id: z.string().describe('Party abbreviation or code (e.g. "KOK", "SDP"). Use resolve_party if needed.'),
    },
    async ({ year, party_id }) => {
      let rows: ElectionRecord[];
      let tableId: string;
      let cache_hit: boolean;
      try {
        const result = await loadPartyResults(year);
        rows = result.rows;
        tableId = result.tableId;
        cache_hit = result.cache_hit;
      } catch (err) {
        return errResult(`Failed to load party data: ${String(err)}`);
      }

      // Resolve party_id to the code used in the data (try both direct and by text match)
      const partyRows = rows.filter((r) => matchesParty(r, party_id));
      if (partyRows.length === 0) {
        return errResult(`Party "${party_id}" not found in parliamentary ${year}. Use resolve_party to find the correct party_id.`);
      }

      const partyName = partyRows[0]!.party_name ?? party_id;
      const nationalRow = partyRows.find((r) => r.area_level === 'koko_suomi');
      const kuntaRows = partyRows.filter((r) => r.area_level === 'kunta');

      const nationalVotes = nationalRow?.votes ?? kuntaRows.reduce((s, r) => s + r.votes, 0);
      const nationalShare = nationalRow?.vote_share;

      // National total votes for context
      const allNationalRows = rows.filter((r) => r.area_level === 'koko_suomi');
      const totalNationalVotes = allNationalRows.reduce((s, r) => s + r.votes, 0);

      const strongest = topN(kuntaRows, 10).map((r) => ({
        area_id: r.area_id,
        area_name: r.area_name,
        votes: r.votes,
        vote_share_pct: r.vote_share ? pct(r.vote_share) : null,
      }));

      const weakest = bottomN(kuntaRows.filter((r) => r.votes > 0), 5).map((r) => ({
        area_id: r.area_id,
        area_name: r.area_name,
        votes: r.votes,
        vote_share_pct: r.vote_share ? pct(r.vote_share) : null,
      }));

      const concentration = concentrationMetrics(kuntaRows.map((r) => r.votes));

      return mcpText({
        party_id,
        party_name: partyName,
        year,
        national_votes: nationalVotes,
        national_vote_share_pct: nationalShare ? pct(nationalShare) : null,
        total_national_votes_cast: totalNationalVotes,
        n_municipalities: kuntaRows.length,
        n_municipalities_with_votes: kuntaRows.filter((r) => r.votes > 0).length,
        strongest_municipalities: strongest,
        weakest_municipalities: weakest,
        geographic_concentration: concentration,
        method: {
          description: 'National total from koko_suomi row in 13sw. Strongest/weakest based on kunta-level rows.',
          source_table: tableId,
          cache_hit,
        },
      });
    }
  );

  // ── compare_candidates ───────────────────────────────────────────────────
  server.tool(
    'compare_candidates',
    'Side-by-side vote comparison for two or more candidates in the same vaalipiiri and election. Returns votes, overall rank, party, and strongest areas for each.',
    {
      year: z.number().describe('Election year.'),
      candidate_ids: z.array(z.string()).min(2).max(10).describe('List of candidate_id values to compare (2–10). Use resolve_candidate to find IDs.'),
      vaalipiiri: z.string().describe('Vaalipiiri key (e.g. "helsinki"). All candidates must be in the same vaalipiiri.'),
    },
    async ({ year, candidate_ids, vaalipiiri }) => {
      let allRows: ElectionRecord[];
      let tableId: string;
      let cache_hit: boolean;
      try {
        const result = await loadCandidateResults(year, vaalipiiri);
        allRows = result.rows;
        tableId = result.tableId;
        cache_hit = result.cache_hit;
      } catch (err) {
        return errResult(`Failed to load candidate data: ${String(err)}`);
      }

      const allVpRows = allRows.filter((r) => r.area_level === 'vaalipiiri' && r.candidate_id)
        .sort((a, b) => b.votes - a.votes);

      const comparison = candidate_ids.map((cid) => {
        const vpRow = allVpRows.find((r) => r.candidate_id === cid);
        if (!vpRow) return { candidate_id: cid, error: 'Not found in this vaalipiiri' };

        const rank = allVpRows.findIndex((r) => r.candidate_id === cid) + 1;
        const aalueRows = allRows.filter((r) => r.candidate_id === cid && r.area_level === 'aanestysalue');
        const top3 = topN(aalueRows, 3).map((r) => ({ area_name: r.area_name, votes: r.votes }));

        return {
          candidate_id: cid,
          candidate_name: vpRow.candidate_name,
          party: vpRow.party_id,
          votes: vpRow.votes,
          vote_share_pct: vpRow.vote_share ? pct(vpRow.vote_share) : null,
          rank_in_vaalipiiri: rank,
          top_3_areas: top3,
        };
      });

      return mcpText({
        year,
        vaalipiiri,
        comparison,
        method: {
          description: 'Votes and ranks from vaalipiiri-level aggregate rows. Top areas from äänestysalue rows.',
          source_table: tableId,
          cache_hit,
        },
      });
    }
  );

  // ── compare_parties ──────────────────────────────────────────────────────
  server.tool(
    'compare_parties',
    'Side-by-side vote comparison for two or more parties in an election. Returns national votes, vote share, and rank for each. Optionally filter to a specific area.',
    {
      year: z.number().describe('Election year.'),
      party_ids: z.array(z.string()).min(2).max(15).describe('List of party_id values to compare (2–15). Use resolve_party to find IDs.'),
      area_id: z.string().optional().describe('Restrict comparison to a specific area (e.g. "010091" for Helsinki kunta, "SSS" for national). Defaults to national.'),
    },
    async ({ year, party_ids, area_id }) => {
      let rows: ElectionRecord[];
      let tableId: string;
      let cache_hit: boolean;
      try {
        const result = await loadPartyResults(year, area_id ?? 'SSS');
        rows = result.rows;
        tableId = result.tableId;
        cache_hit = result.cache_hit;
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
        area_id: area_id ?? 'SSS',
        comparison,
        method: {
          description: 'Party votes from 13sw. Rank is relative to all parties in the same area.',
          source_table: tableId,
          cache_hit,
        },
      });
    }
  );

  // ── compare_elections ────────────────────────────────────────────────────
  server.tool(
    'compare_elections',
    'Tracks a party across two or more parliamentary elections: vote total, vote share, and rank at each election, plus change metrics between consecutive elections.',
    {
      party_id: z.string().describe('Party abbreviation or code (e.g. "KOK", "SDP").'),
      years: z.array(z.number()).min(2).max(10).describe('Election years to compare (e.g. [2015, 2019, 2023]). Parliamentary years available: 1983, 1987, 1991, 1995, 1999, 2003, 2007, 2011, 2015, 2019, 2023.'),
      area_id: z.string().optional().describe('Area code to compare within. Defaults to national (SSS).'),
    },
    async ({ party_id, years, area_id }) => {
      const effectiveArea = area_id ?? 'SSS';
      const yearResults: Array<{
        year: number;
        votes: number | null;
        vote_share_pct: number | null;
        rank: number | null;
        error?: string;
      }> = [];
      const tableIds: string[] = [];

      for (const year of years.sort((a, b) => a - b)) {
        try {
          const { rows, tableId } = await loadPartyResults(year, effectiveArea);
          if (!tableIds.includes(tableId)) tableIds.push(tableId);
          const row = rows.find((r) => matchesParty(r, party_id));
          const rank = [...rows].sort((a, b) => b.votes - a.votes).findIndex((r) => r.party_id === row?.party_id) + 1;
          yearResults.push({
            year,
            votes: row?.votes ?? null,
            vote_share_pct: row?.vote_share ? pct(row.vote_share) : null,
            rank: row ? (rank || null) : null,
          });
        } catch (_) {
          yearResults.push({ year, votes: null, vote_share_pct: null, rank: null, error: `No data for ${year}` });
        }
      }

      // Compute changes between consecutive years
      const changes = yearResults.slice(1).map((curr, i) => {
        const prev = yearResults[i]!;
        return {
          from_year: prev.year,
          to_year: curr.year,
          vote_change: (curr.votes !== null && prev.votes !== null) ? curr.votes - prev.votes : null,
          vote_share_change_pp: (curr.vote_share_pct !== null && prev.vote_share_pct !== null)
            ? round2(curr.vote_share_pct - prev.vote_share_pct)
            : null,
          rank_change: (curr.rank !== null && prev.rank !== null) ? prev.rank - curr.rank : null, // positive = improved
        };
      });

      return mcpText({
        party_id,
        area_id: effectiveArea,
        by_year: yearResults,
        changes,
        method: {
          description: 'Votes and shares from 13sw party-by-kunta table. Rank is relative to all parties in the same area per year. vote_share_change_pp = percentage point change. rank_change: positive = moved up (better).',
          source_tables: tableIds,
        },
      });
    }
  );

  // ── find_area_overperformance ────────────────────────────────────────────
  server.tool(
    'find_area_overperformance',
    'Finds areas where a party or candidate performs above their baseline. Baseline for parties = national vote share in that election. Baseline for candidates = party\'s vaalipiiri-level vote share. Returns areas ranked by overperformance magnitude.',
    {
      year: z.number().describe('Election year.'),
      subject_type: z.enum(['party', 'candidate']).describe('Whether to analyse a party or a candidate.'),
      subject_id: z.string().describe('Party abbreviation (e.g. "KOK") or candidate_id (e.g. "01010176").'),
      vaalipiiri: z.string().optional().describe('Required when subject_type=candidate. Also used to limit party analysis to one vaalipiiri if provided.'),
      min_votes: z.number().optional().describe('Minimum votes in an area to include in results (filters out tiny areas). Defaults to 10.'),
    },
    async ({ year, subject_type, subject_id, vaalipiiri, min_votes = 10 }) => {
      if (subject_type === 'party') {
        let rows: ElectionRecord[];
        let tableId: string;
        try {
          const result = await loadPartyResults(year);
          rows = result.rows;
          tableId = result.tableId;
        } catch (err) {
          return errResult(String(err));
        }

        const nationalRow = rows.find((r) => matchesParty(r, subject_id) && r.area_level === 'koko_suomi');
        const baseline = nationalRow?.vote_share;
        if (!baseline) return errResult(`No national vote share found for party "${subject_id}" in ${year}.`);

        const kuntaRows = rows.filter((r) => matchesParty(r, subject_id) && r.area_level === 'kunta' && r.votes >= min_votes);
        const overperf = kuntaRows
          .filter((r) => r.vote_share !== undefined)
          .map((r) => ({
            area_id: r.area_id,
            area_name: r.area_name,
            votes: r.votes,
            area_vote_share_pct: pct(r.vote_share!),
            baseline_pct: pct(baseline),
            overperformance_pp: round2(r.vote_share! - baseline),
          }))
          .sort((a, b) => b.overperformance_pp - a.overperformance_pp);

        return mcpText({
          subject_type: 'party',
          subject_id,
          year,
          baseline_pct: pct(baseline),
          baseline_description: 'National vote share',
          overperforming_areas: overperf.filter((a) => a.overperformance_pp > 0),
          method: {
            description: 'Baseline = party national vote share (koko_suomi row in 13sw). Overperformance = area_vote_share - baseline. Kunta level only.',
            source_table: tableId,
          },
        });

      } else {
        if (!vaalipiiri) return errResult('vaalipiiri is required for candidate analysis.');
        let allRows: ElectionRecord[];
        let tableId: string;
        try {
          const result = await loadCandidateResults(year, vaalipiiri);
          allRows = result.rows;
          tableId = result.tableId;
        } catch (err) {
          return errResult(String(err));
        }

        const vpRow = allRows.find((r) => r.candidate_id === subject_id && r.area_level === 'vaalipiiri');
        if (!vpRow) return errResult(`Candidate ${subject_id} not found in vaalipiiri ${vaalipiiri}.`);
        const baseline = vpRow.vote_share;
        if (!baseline) return errResult(`No vaalipiiri-level vote share for candidate ${subject_id}.`);

        const aalueRows = allRows.filter((r) => r.candidate_id === subject_id && r.area_level === 'aanestysalue' && r.votes >= min_votes);
        const overperf = aalueRows
          .filter((r) => r.vote_share !== undefined)
          .map((r) => ({
            area_id: r.area_id,
            area_name: r.area_name,
            votes: r.votes,
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
          vaalipiiri,
          baseline_pct: pct(baseline),
          baseline_description: 'Candidate vote share at vaalipiiri level',
          overperforming_areas: overperf.filter((a) => a.overperformance_pp > 0),
          method: {
            description: 'Baseline = candidate vote share in vaalipiiri (VP## row). Overperformance = äänestysalue_share - baseline.',
            source_table: tableId,
          },
        });
      }
    }
  );

  // ── find_area_underperformance ───────────────────────────────────────────
  server.tool(
    'find_area_underperformance',
    'Finds areas where a party or candidate performs below their baseline. Inverse of find_area_overperformance. See that tool for baseline methodology.',
    {
      year: z.number().describe('Election year.'),
      subject_type: z.enum(['party', 'candidate']).describe('Whether to analyse a party or a candidate.'),
      subject_id: z.string().describe('Party abbreviation (e.g. "KOK") or candidate_id (e.g. "01010176").'),
      vaalipiiri: z.string().optional().describe('Required when subject_type=candidate.'),
      min_votes: z.number().optional().describe('Minimum votes in area to include. Defaults to 10.'),
    },
    async ({ year, subject_type, subject_id, vaalipiiri, min_votes = 10 }) => {
      if (subject_type === 'party') {
        let rows: ElectionRecord[];
        let tableId: string;
        try {
          const result = await loadPartyResults(year);
          rows = result.rows;
          tableId = result.tableId;
        } catch (err) {
          return errResult(String(err));
        }

        const nationalRow = rows.find((r) => matchesParty(r, subject_id) && r.area_level === 'koko_suomi');
        const baseline = nationalRow?.vote_share;
        if (!baseline) return errResult(`No national vote share found for party "${subject_id}" in ${year}.`);

        const kuntaRows = rows.filter((r) => matchesParty(r, subject_id) && r.area_level === 'kunta' && r.votes >= min_votes);
        const underperf = kuntaRows
          .filter((r) => r.vote_share !== undefined && r.vote_share < baseline)
          .map((r) => ({
            area_id: r.area_id,
            area_name: r.area_name,
            votes: r.votes,
            area_vote_share_pct: pct(r.vote_share!),
            baseline_pct: pct(baseline),
            underperformance_pp: round2(baseline - r.vote_share!),
          }))
          .sort((a, b) => b.underperformance_pp - a.underperformance_pp);

        return mcpText({
          subject_type: 'party',
          subject_id,
          year,
          baseline_pct: pct(baseline),
          baseline_description: 'National vote share',
          underperforming_areas: underperf,
          method: {
            description: 'Baseline = party national vote share. Underperformance = baseline - area_vote_share.',
            source_table: tableId,
          },
        });

      } else {
        if (!vaalipiiri) return errResult('vaalipiiri is required for candidate analysis.');
        let allRows: ElectionRecord[];
        let tableId: string;
        try {
          const result = await loadCandidateResults(year, vaalipiiri);
          allRows = result.rows;
          tableId = result.tableId;
        } catch (err) {
          return errResult(String(err));
        }

        const vpRow = allRows.find((r) => r.candidate_id === subject_id && r.area_level === 'vaalipiiri');
        if (!vpRow) return errResult(`Candidate ${subject_id} not found in vaalipiiri ${vaalipiiri}.`);
        const baseline = vpRow.vote_share;
        if (!baseline) return errResult(`No vaalipiiri-level vote share for candidate ${subject_id}.`);

        const aalueRows = allRows.filter((r) => r.candidate_id === subject_id && r.area_level === 'aanestysalue' && r.votes >= min_votes);
        const underperf = aalueRows
          .filter((r) => r.vote_share !== undefined && r.vote_share < baseline)
          .map((r) => ({
            area_id: r.area_id,
            area_name: r.area_name,
            votes: r.votes,
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
          vaalipiiri,
          baseline_pct: pct(baseline),
          baseline_description: 'Candidate vote share at vaalipiiri level',
          underperforming_areas: underperf,
          method: {
            description: 'Baseline = candidate vote share in vaalipiiri. Underperformance = baseline - äänestysalue_share.',
            source_table: tableId,
          },
        });
      }
    }
  );

  // ── analyze_geographic_concentration ────────────────────────────────────
  server.tool(
    'analyze_geographic_concentration',
    'Measures how geographically concentrated a candidate\'s or party\'s vote is. Returns top-N area dependence metrics (fraction of total votes held by top 1/3/5/10 areas). A score close to 1 means nearly all votes come from few areas.',
    {
      year: z.number().describe('Election year.'),
      subject_type: z.enum(['party', 'candidate']).describe('Whether to analyse a party or a candidate.'),
      subject_id: z.string().describe('Party abbreviation (e.g. "KOK") or candidate_id.'),
      vaalipiiri: z.string().optional().describe('Required when subject_type=candidate. Optional for party (limits to one vaalipiiri if provided).'),
    },
    async ({ year, subject_type, subject_id, vaalipiiri }) => {
      if (subject_type === 'party') {
        let rows: ElectionRecord[];
        let tableId: string;
        try {
          const result = await loadPartyResults(year);
          rows = result.rows;
          tableId = result.tableId;
        } catch (err) {
          return errResult(String(err));
        }
        const kuntaRows = rows.filter((r) => matchesParty(r, subject_id) && r.area_level === 'kunta');
        if (kuntaRows.length === 0) return errResult(`Party "${subject_id}" not found in ${year}.`);
        const conc = concentrationMetrics(kuntaRows.map((r) => r.votes));
        const top10 = topN(kuntaRows, 10).map((r) => ({ area_name: r.area_name, votes: r.votes }));

        return mcpText({
          subject_type: 'party', subject_id, year,
          concentration: conc,
          top_10_municipalities: top10,
          interpretation: {
            top1_share: `${pct(conc.top1_share * 100)}% of votes come from the single strongest municipality`,
            top3_share: `${pct(conc.top3_share * 100)}% of votes come from the top 3 municipalities`,
            top10_share: `${pct(conc.top10_share * 100)}% of votes come from the top 10 municipalities`,
          },
          method: { description: 'Top-N share concentration using kunta-level rows from 13sw.', source_table: tableId },
        });

      } else {
        if (!vaalipiiri) return errResult('vaalipiiri is required for candidate concentration analysis.');
        let allRows: ElectionRecord[];
        let tableId: string;
        try {
          const result = await loadCandidateResults(year, vaalipiiri);
          allRows = result.rows;
          tableId = result.tableId;
        } catch (err) {
          return errResult(String(err));
        }
        const aalueRows = allRows.filter((r) => r.candidate_id === subject_id && r.area_level === 'aanestysalue');
        if (aalueRows.length === 0) return errResult(`Candidate ${subject_id} not found in vaalipiiri ${vaalipiiri}.`);
        const vpRow = allRows.find((r) => r.candidate_id === subject_id && r.area_level === 'vaalipiiri');
        const conc = concentrationMetrics(aalueRows.map((r) => r.votes));
        const top10 = topN(aalueRows, 10).map((r) => ({ area_name: r.area_name, votes: r.votes }));

        return mcpText({
          subject_type: 'candidate', subject_id,
          candidate_name: vpRow?.candidate_name,
          year, vaalipiiri,
          concentration: conc,
          top_10_aanestysalueet: top10,
          interpretation: {
            top1_share: `${pct(conc.top1_share * 100)}% of votes come from the single strongest äänestysalue`,
            top3_share: `${pct(conc.top3_share * 100)}% of votes come from the top 3 äänestysalueet`,
            top10_share: `${pct(conc.top10_share * 100)}% of votes come from the top 10 äänestysalueet`,
          },
          method: { description: 'Top-N share concentration using äänestysalue-level rows to avoid double-counting.', source_table: tableId },
        });
      }
    }
  );

  // ── analyze_within_party_position ────────────────────────────────────────
  server.tool(
    'analyze_within_party_position',
    'Analyses a candidate\'s position within their party: rank among party candidates, share of party vote, votes above/below adjacent candidates, and distance to the last elected vs. first unelected seat.',
    {
      year: z.number().describe('Election year.'),
      candidate_id: z.string().describe('Candidate code. Use resolve_candidate if you only have a name.'),
      vaalipiiri: z.string().describe('Vaalipiiri key (e.g. "helsinki").'),
    },
    async ({ year, candidate_id, vaalipiiri }) => {
      let allRows: ElectionRecord[];
      let tableId: string;
      let cache_hit: boolean;
      try {
        const result = await loadCandidateResults(year, vaalipiiri);
        allRows = result.rows;
        tableId = result.tableId;
        cache_hit = result.cache_hit;
      } catch (err) {
        return errResult(String(err));
      }

      const vpRows = allRows.filter((r) => r.area_level === 'vaalipiiri' && r.candidate_id)
        .sort((a, b) => b.votes - a.votes);

      const targetRow = vpRows.find((r) => r.candidate_id === candidate_id);
      if (!targetRow) return errResult(`Candidate ${candidate_id} not found in vaalipiiri ${vaalipiiri}.`);

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
        vaalipiiri,
        votes: targetRow.votes,
        rank_within_party: rankWithinParty,
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
          cache_hit,
        },
      });
    }
  );

  // ── analyze_vote_distribution ────────────────────────────────────────────
  server.tool(
    'analyze_vote_distribution',
    'Analyses how a party\'s or candidate\'s votes are distributed across geographic areas: mean, median, standard deviation, min, max, and a histogram. Useful for understanding whether support is evenly spread or clustered.',
    {
      year: z.number().describe('Election year.'),
      subject_type: z.enum(['party', 'candidate']).describe('Whether to analyse a party or a candidate.'),
      subject_id: z.string().describe('Party abbreviation or candidate_id.'),
      vaalipiiri: z.string().optional().describe('Required when subject_type=candidate.'),
    },
    async ({ year, subject_type, subject_id, vaalipiiri }) => {
      let voteCounts: number[];
      let areaLevel: string;
      let tableId: string;

      if (subject_type === 'party') {
        let rows: ElectionRecord[];
        try {
          const result = await loadPartyResults(year);
          rows = result.rows;
          tableId = result.tableId;
        } catch (err) {
          return errResult(String(err));
        }
        const kuntaRows = rows.filter((r) => matchesParty(r, subject_id) && r.area_level === 'kunta');
        if (kuntaRows.length === 0) return errResult(`Party "${subject_id}" not found in ${year}.`);
        voteCounts = kuntaRows.map((r) => r.votes);
        areaLevel = 'kunta';
      } else {
        if (!vaalipiiri) return errResult('vaalipiiri is required for candidate analysis.');
        let allRows: ElectionRecord[];
        try {
          const result = await loadCandidateResults(year, vaalipiiri);
          allRows = result.rows;
          tableId = result.tableId;
        } catch (err) {
          return errResult(String(err));
        }
        const aalueRows = allRows.filter((r) => r.candidate_id === subject_id && r.area_level === 'aanestysalue');
        if (aalueRows.length === 0) return errResult(`Candidate ${subject_id} not found.`);
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

      // Simple histogram: 10 buckets
      const bucketSize = Math.ceil((max - min + 1) / 10) || 1;
      const buckets: Array<{ from: number; to: number; count: number }> = [];
      for (let i = 0; i < 10; i++) {
        const from = min + i * bucketSize;
        const to = from + bucketSize - 1;
        const count = sorted.filter((v) => v >= from && v <= to).length;
        buckets.push({ from, to, count });
        if (to >= max) break;
      }

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

}
