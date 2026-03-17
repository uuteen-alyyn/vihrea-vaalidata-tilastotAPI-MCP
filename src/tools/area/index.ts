import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { loadPartyResults, loadCandidateResults } from '../../data/loaders.js';
import { PARLIAMENTARY_TABLES } from '../../data/election-tables.js';
import type { ElectionRecord, ElectionType } from '../../data/types.js';
import { ELECTION_TYPE_PARAM, subnatLevel, matchesParty, pct, round2, mcpText, errResult } from '../shared.js';

/** All parliamentary years available in 13sw (1983–2023) */
const ALL_PARL_YEARS = [1983, 1987, 1991, 1995, 1999, 2003, 2007, 2011, 2015, 2019, 2023];

/**
 * Pedersen volatility index: sum of |share_t - share_{t-1}| / 2
 * Measures total electoral change between two elections.
 * Range: 0 (identical) to 100 (complete replacement of parties).
 */
function pedersenIndex(
  parties1: Map<string, number>,  // partyId → vote share (as %)
  parties2: Map<string, number>
): number {
  const allParties = new Set([...parties1.keys(), ...parties2.keys()]);
  let totalChange = 0;
  for (const p of allParties) {
    const s1 = parties1.get(p) ?? 0;
    const s2 = parties2.get(p) ?? 0;
    totalChange += Math.abs(s2 - s1);
  }
  return round2(totalChange / 2);
}

/** Build partyId→share map from rows (excludes SSS total row) */
function partyShareMap(rows: ElectionRecord[], areaId?: string): Map<string, number> {
  const map = new Map<string, number>();
  const filtered = areaId ? rows.filter(r => r.area_id === areaId) : rows;
  for (const r of filtered) {
    if (r.party_id && r.party_id !== 'SSS' && r.vote_share !== undefined) {
      map.set(r.party_id, r.vote_share);
    }
  }
  return map;
}

// ─── Tool registration ────────────────────────────────────────────────────────

export function registerAreaTools(server: McpServer): void {

  // ── get_area_profile ──────────────────────────────────────────────────────
  server.tool(
    'get_area_profile',
    'Returns a comprehensive profile of a geographic area: top parties in the most recent election, historical party trend across elections, and volatility.',
    {
      area_id: z.string().describe('Area code. Parliamentary: 6-digit (e.g. "010091" for Helsinki, "SSS" for national). Use resolve_area to find codes.'),
      election_type: ELECTION_TYPE_PARAM,
      reference_year: z.number().optional().describe('Most recent election year to use. Defaults to 2023 for parliamentary.'),
      history_years: z.array(z.number()).optional().describe('Additional election years to include in the historical trend.'),
      top_n: z.number().optional().describe('Number of top parties to show. Defaults to 5.'),
    },
    async ({ area_id, election_type, reference_year = 2023, history_years, top_n = 5 }) => {
      const electionType: ElectionType = election_type ?? 'parliamentary';
      const years = history_years ?? [2015, 2019, 2023];
      if (!years.includes(reference_year)) years.push(reference_year);
      years.sort((a, b) => a - b);

      // Fetch data for all requested years
      const yearData: Array<{ year: number; rows: ElectionRecord[] }> = [];
      let primaryTableId = '';

      for (const year of years) {
        try {
          const { rows, tableId } = await loadPartyResults(year, area_id, electionType);
          if (!primaryTableId) primaryTableId = tableId;
          yearData.push({ year, rows });
        } catch (err) {
          console.error(`[get_area_profile] failed to load year ${year}:`, err);
        }
      }

      if (yearData.length === 0) return errResult(`No party data found for area ${area_id}.`);

      // Reference year parties (top N)
      const refYear = yearData.find(d => d.year === reference_year) ?? yearData[yearData.length - 1]!;
      const refRows = refYear.rows.filter(r => r.area_id === area_id);

      if (refRows.length === 0) {
        return errResult(`Area ${area_id} not found in ${refYear.year} data. Use resolve_area to verify the area code.`);
      }

      const areaName = refRows[0]!.area_name;
      const areaLevel = refRows[0]!.area_level;

      const topParties = [...refRows]
        .filter(r => r.party_id && r.party_id !== 'SSS')
        .sort((a, b) => b.votes - a.votes)
        .slice(0, top_n)
        .map((r, i) => ({
          rank: i + 1,
          party_id: r.party_id,
          party_name: r.party_name,
          votes: r.votes,
          vote_share_pct: r.vote_share ? pct(r.vote_share) : null,
        }));

      // Historical trend for top parties
      const trackPartyIds = topParties.map(p => p.party_id!);
      const trend = yearData.map(({ year, rows }) => {
        const aRows = rows.filter(r => r.area_id === area_id);
        const partyEntry: Record<string, number | null> = {};
        for (const pid of trackPartyIds) {
          const pr = aRows.find(r => r.party_id === pid);
          partyEntry[pid] = pr?.vote_share ? pct(pr.vote_share) : null;
        }
        const totalVotes = aRows.filter(r => r.party_id && r.party_id !== 'SSS').reduce((s, r) => s + r.votes, 0);
        return { year, total_votes: totalVotes, party_shares_pct: partyEntry };
      });

      // Volatility between consecutive available years
      const volatility: Array<{ from_year: number; to_year: number; pedersen_index: number }> = [];
      for (let i = 1; i < yearData.length; i++) {
        const prev = yearData[i - 1]!;
        const curr = yearData[i]!;
        const prevMap = partyShareMap(prev.rows.filter(r => r.area_id === area_id));
        const currMap = partyShareMap(curr.rows.filter(r => r.area_id === area_id));
        if (prevMap.size > 0 && currMap.size > 0) {
          volatility.push({
            from_year: prev.year,
            to_year: curr.year,
            pedersen_index: pedersenIndex(prevMap, currMap),
          });
        }
      }

      const avgVolatility = volatility.length > 0
        ? round2(volatility.reduce((s, v) => s + v.pedersen_index, 0) / volatility.length)
        : null;

      return mcpText({
        area_id,
        area_name: areaName,
        area_level: areaLevel,
        reference_year: refYear.year,
        top_parties: topParties,
        historical_trend: trend,
        volatility: {
          by_election: volatility,
          average_pedersen_index: avgVolatility,
          interpretation: avgVolatility !== null
            ? `Average ${avgVolatility} pp total vote share moved between elections (Pedersen index). Values above ~10 indicate high volatility.`
            : null,
        },
        method: {
          description: 'Party data from 13sw. Historical trend tracks top parties from the reference year. Pedersen volatility = sum(|share_t - share_{t-1}|) / 2.',
          source_table: primaryTableId,
        },
      });
    }
  );

  // ── compare_areas ─────────────────────────────────────────────────────────
  server.tool(
    'compare_areas',
    'Side-by-side comparison of two or more geographic areas: top party rankings, vote shares, total votes. All areas must be comparable — e.g. all kunta, or all vaalipiiri.',
    {
      area_ids: z.array(z.string()).min(2).max(8).describe('List of area codes (2–8). Use resolve_area to find codes.'),
      election_type: ELECTION_TYPE_PARAM,
      year: z.number().optional().describe('Election year. Defaults to 2023.'),
      top_n: z.number().optional().describe('Number of top parties to show per area. Defaults to 5.'),
    },
    async ({ area_ids, election_type, year = 2023, top_n = 5 }) => {
      const electionType: ElectionType = election_type ?? 'parliamentary';
      let allRows: ElectionRecord[];
      let tableId: string;

      try {
        const result = await loadPartyResults(year, undefined, electionType);
        allRows = result.rows;
        tableId = result.tableId;
      } catch (err) {
        return errResult(`Failed to load party data: ${String(err)}`);
      }

      const areas = area_ids.map(area_id => {
        const areaRows = allRows.filter(r => r.area_id === area_id && r.party_id);
        if (areaRows.length === 0) return { area_id, error: `Area ${area_id} not found in ${year} data.` };

        const areaName = areaRows[0]!.area_name;
        const areaLevel = areaRows[0]!.area_level;
        const totalVotes = areaRows.filter(r => r.party_id !== 'SSS').reduce((s, r) => s + r.votes, 0);
        const topParties = [...areaRows]
          .filter(r => r.party_id !== 'SSS')
          .sort((a, b) => b.votes - a.votes)
          .slice(0, top_n)
          .map((r, i) => ({
            rank: i + 1,
            party_id: r.party_id,
            party_name: r.party_name,
            votes: r.votes,
            vote_share_pct: r.vote_share ? pct(r.vote_share) : null,
          }));

        return { area_id, area_name: areaName, area_level: areaLevel, total_votes: totalVotes, top_parties: topParties };
      });

      // Cross-area party comparison: which party ranks #1 in each area?
      const leading_parties = areas
        .filter(a => !('error' in a) && 'top_parties' in a)
        .map(a => ({
          area_id: a.area_id,
          area_name: (a as { area_name: string }).area_name,
          leading_party: (a as { top_parties: Array<{ party_name: string; vote_share_pct: number | null }> }).top_parties[0]?.party_name,
          leading_party_share_pct: (a as { top_parties: Array<{ vote_share_pct: number | null }> }).top_parties[0]?.vote_share_pct,
        }));

      return mcpText({
        year,
        election_type: electionType,
        areas,
        leading_parties_summary: leading_parties,
        method: { description: 'Party votes from party table. All areas compared at their native level.', source_table: tableId },
      });
    }
  );

  // ── analyze_area_volatility ───────────────────────────────────────────────
  server.tool(
    'analyze_area_volatility',
    'Measures electoral volatility for a geographic area across multiple elections using the Pedersen index. Higher values indicate more voter movement between parties.',
    {
      area_id: z.string().describe('Area code (e.g. "010091" for Helsinki kunta).'),
      election_type: ELECTION_TYPE_PARAM,
      years: z.array(z.number()).optional().describe('Election years to include. Defaults to [2011, 2015, 2019, 2023] for parliamentary.'),
    },
    async ({ area_id, election_type, years = [2011, 2015, 2019, 2023] }) => {
      const electionType: ElectionType = election_type ?? 'parliamentary';
      const sortedYears = [...years].sort((a, b) => a - b);
      const yearData: Array<{ year: number; rows: ElectionRecord[] }> = [];
      let tableId = '';

      for (const year of sortedYears) {
        try {
          const { rows, tableId: tid } = await loadPartyResults(year, area_id, electionType);
          if (!tableId) tableId = tid;
          yearData.push({ year, rows: rows.filter(r => r.area_id === area_id) });
        } catch (err) {
          console.error(`[analyze_area_volatility] failed to load year ${year}:`, err);
        }
      }

      if (yearData.length < 2) return errResult(`Need at least 2 years of data to compute volatility. Found: ${yearData.map(d => d.year).join(', ')}`);

      // Check area exists
      const testRows = yearData[0]!.rows;
      if (testRows.length === 0) return errResult(`Area ${area_id} not found in data. Use resolve_area to verify.`);
      const areaName = testRows[0]!.area_name;

      const volatility: Array<{
        from_year: number;
        to_year: number;
        pedersen_index: number;
        biggest_gainer: { party_name: string | undefined; change_pp: number } | null;
        biggest_loser: { party_name: string | undefined; change_pp: number } | null;
      }> = [];

      for (let i = 1; i < yearData.length; i++) {
        const prev = yearData[i - 1]!;
        const curr = yearData[i]!;

        const prevMap = new Map(prev.rows.filter(r => r.party_id && r.party_id !== 'SSS' && r.vote_share !== undefined)
          .map(r => [r.party_id!, { share: r.vote_share!, name: r.party_name }]));
        const currMap = new Map(curr.rows.filter(r => r.party_id && r.party_id !== 'SSS' && r.vote_share !== undefined)
          .map(r => [r.party_id!, { share: r.vote_share!, name: r.party_name }]));

        const allParties = new Set([...prevMap.keys(), ...currMap.keys()]);
        const changes: Array<{ party_id: string; party_name: string | undefined; change_pp: number }> = [];
        for (const pid of allParties) {
          const s1 = prevMap.get(pid)?.share ?? 0;
          const s2 = currMap.get(pid)?.share ?? 0;
          const name = currMap.get(pid)?.name ?? prevMap.get(pid)?.name;
          changes.push({ party_id: pid, party_name: name, change_pp: round2(s2 - s1) });
        }

        const pedersen = round2(changes.reduce((s, c) => s + Math.abs(c.change_pp), 0) / 2);
        const sorted = [...changes].sort((a, b) => b.change_pp - a.change_pp);

        volatility.push({
          from_year: prev.year,
          to_year: curr.year,
          pedersen_index: pedersen,
          biggest_gainer: sorted[0] ? { party_name: sorted[0].party_name, change_pp: sorted[0].change_pp } : null,
          biggest_loser: sorted[sorted.length - 1] ? { party_name: sorted[sorted.length - 1]!.party_name, change_pp: sorted[sorted.length - 1]!.change_pp } : null,
        });
      }

      const avgVolatility = round2(volatility.reduce((s, v) => s + v.pedersen_index, 0) / volatility.length);
      const maxVolatility = Math.max(...volatility.map(v => v.pedersen_index));
      const minVolatility = Math.min(...volatility.map(v => v.pedersen_index));

      return mcpText({
        area_id,
        area_name: areaName,
        years_analysed: yearData.map(d => d.year),
        volatility_by_period: volatility,
        summary: {
          average_pedersen_index: avgVolatility,
          max_pedersen_index: maxVolatility,
          min_pedersen_index: minVolatility,
          interpretation: `Average Pedersen index of ${avgVolatility} means ~${avgVolatility}pp of votes shifted between parties per election on average. Values above 10 indicate high volatility; Finnish average is typically 8–12pp.`,
        },
        method: {
          description: 'Pedersen volatility index = sum(|share_t - share_{t-1}|) / 2. Computed from 13sw party vote shares at the specified area level.',
          source_table: tableId,
        },
      });
    }
  );

  // ── find_strongholds ──────────────────────────────────────────────────────
  server.tool(
    'find_strongholds',
    'Finds the strongest geographic areas for a party or candidate — areas where they achieve the highest vote share. Returns areas ranked by vote share descending.',
    {
      year: z.number().describe('Election year.'),
      election_type: ELECTION_TYPE_PARAM,
      subject_type: z.enum(['party', 'candidate']).describe('Whether to find strongholds for a party or a candidate.'),
      subject_id: z.string().describe('Party abbreviation (e.g. "KOK") or candidate_id.'),
      unit_key: z.string().optional().describe('Required when subject_type=candidate (vaalipiiri/hyvinvointialue key). Omit for EU/presidential.'),
      min_votes: z.number().optional().describe('Minimum votes to include an area. Defaults to 10.'),
      limit: z.number().optional().describe('Number of top areas to return. Defaults to 15.'),
    },
    async ({ year, election_type, subject_type, subject_id, unit_key, min_votes = 10, limit = 15 }) => {
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

        const areaRows = rows.filter(r =>
          matchesParty(r, subject_id) &&
          r.area_level === areaLvl &&
          r.votes >= min_votes &&
          r.vote_share !== undefined
        );
        if (areaRows.length === 0) return errResult(`Party "${subject_id}" not found in ${electionType} ${year} at ${areaLvl} level.`);

        const strongholds = [...areaRows]
          .sort((a, b) => (b.vote_share ?? 0) - (a.vote_share ?? 0))
          .slice(0, limit)
          .map((r, i) => ({
            rank: i + 1,
            area_id: r.area_id,
            area_name: r.area_name,
            votes: r.votes,
            vote_share_pct: pct(r.vote_share!),
          }));

        const nationalRow = rows.find(r => matchesParty(r, subject_id) && r.area_level === 'koko_suomi');

        return mcpText({
          subject_type: 'party',
          subject_id,
          year,
          election_type: electionType,
          area_level: areaLvl,
          national_share_pct: nationalRow?.vote_share ? pct(nationalRow.vote_share) : null,
          strongholds,
          method: { description: 'Ranked by vote share descending. Min votes filter applied to exclude tiny areas.', source_table: tableId },
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

        const candidateRows = allRows.filter(r =>
          r.candidate_id === subject_id &&
          r.area_level === 'aanestysalue' &&
          r.votes >= min_votes &&
          r.vote_share !== undefined
        );
        if (candidateRows.length === 0) return errResult(`Candidate ${subject_id} not found${unit_key ? ` in ${unit_key}` : ''}.`);

        const vpRow = allRows.find(r => r.candidate_id === subject_id && (r.area_level === 'vaalipiiri' || r.area_level === 'hyvinvointialue' || r.area_level === 'koko_suomi'));

        const strongholds = [...candidateRows]
          .sort((a, b) => (b.vote_share ?? 0) - (a.vote_share ?? 0))
          .slice(0, limit)
          .map((r, i) => ({
            rank: i + 1,
            area_id: r.area_id,
            area_name: r.area_name,
            votes: r.votes,
            vote_share_pct: pct(r.vote_share!),
          }));

        return mcpText({
          subject_type: 'candidate',
          subject_id,
          candidate_name: vpRow?.candidate_name,
          party: vpRow?.party_id,
          year,
          election_type: electionType,
          unit_key: unit_key ?? 'national',
          unit_share_pct: vpRow?.vote_share ? pct(vpRow.vote_share) : null,
          strongholds,
          method: { description: 'Ranked by vote share descending at äänestysalue level. Min votes filter applied.', source_table: tableId },
        });
      }
    }
  );

  // ── find_weak_zones ───────────────────────────────────────────────────────
  server.tool(
    'find_weak_zones',
    'Finds the weakest geographic areas for a party or candidate — areas where they achieve the lowest vote share. Inverse of find_strongholds.',
    {
      year: z.number().describe('Election year.'),
      election_type: ELECTION_TYPE_PARAM,
      subject_type: z.enum(['party', 'candidate']).describe('Whether to find weak zones for a party or a candidate.'),
      subject_id: z.string().describe('Party abbreviation (e.g. "KOK") or candidate_id.'),
      unit_key: z.string().optional().describe('Required when subject_type=candidate (vaalipiiri/hyvinvointialue key). Omit for EU/presidential.'),
      min_votes: z.number().optional().describe('Minimum votes to include an area. Defaults to 10.'),
      limit: z.number().optional().describe('Number of worst areas to return. Defaults to 15.'),
    },
    async ({ year, election_type, subject_type, subject_id, unit_key, min_votes = 10, limit = 15 }) => {
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

        const areaRows = rows.filter(r =>
          matchesParty(r, subject_id) &&
          r.area_level === areaLvl &&
          r.votes >= min_votes &&
          r.vote_share !== undefined
        );
        if (areaRows.length === 0) return errResult(`Party "${subject_id}" not found in ${electionType} ${year} at ${areaLvl} level.`);

        const weakZones = [...areaRows]
          .sort((a, b) => (a.vote_share ?? 0) - (b.vote_share ?? 0))
          .slice(0, limit)
          .map((r, i) => ({
            rank: i + 1,
            area_id: r.area_id,
            area_name: r.area_name,
            votes: r.votes,
            vote_share_pct: pct(r.vote_share!),
          }));

        const nationalRow = rows.find(r => matchesParty(r, subject_id) && r.area_level === 'koko_suomi');

        return mcpText({
          subject_type: 'party',
          subject_id,
          year,
          election_type: electionType,
          area_level: areaLvl,
          national_share_pct: nationalRow?.vote_share ? pct(nationalRow.vote_share) : null,
          weak_zones: weakZones,
          method: { description: 'Ranked by vote share ascending. Min votes filter applied to exclude tiny areas.', source_table: tableId },
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

        const candidateRows = allRows.filter(r =>
          r.candidate_id === subject_id &&
          r.area_level === 'aanestysalue' &&
          r.votes >= min_votes &&
          r.vote_share !== undefined
        );
        if (candidateRows.length === 0) return errResult(`Candidate ${subject_id} not found${unit_key ? ` in ${unit_key}` : ''}.`);

        const vpRow = allRows.find(r => r.candidate_id === subject_id && (r.area_level === 'vaalipiiri' || r.area_level === 'hyvinvointialue' || r.area_level === 'koko_suomi'));

        const weakZones = [...candidateRows]
          .sort((a, b) => (a.vote_share ?? 0) - (b.vote_share ?? 0))
          .slice(0, limit)
          .map((r, i) => ({
            rank: i + 1,
            area_id: r.area_id,
            area_name: r.area_name,
            votes: r.votes,
            vote_share_pct: pct(r.vote_share!),
          }));

        return mcpText({
          subject_type: 'candidate',
          subject_id,
          candidate_name: vpRow?.candidate_name,
          party: vpRow?.party_id,
          year,
          election_type: electionType,
          unit_key: unit_key ?? 'national',
          unit_share_pct: vpRow?.vote_share ? pct(vpRow.vote_share) : null,
          weak_zones: weakZones,
          method: { description: 'Ranked by vote share ascending at äänestysalue level. Min votes filter applied.', source_table: tableId },
        });
      }
    }
  );

}
