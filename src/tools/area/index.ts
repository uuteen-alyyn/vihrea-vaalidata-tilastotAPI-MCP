import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { loadPartyResults, loadCandidateResults } from '../../data/loaders.js';
import { PARLIAMENTARY_TABLES } from '../../data/election-tables.js';
import { queryElectionData } from '../../data/query-engine.js';
import type { ElectionRecord, ElectionType } from '../../data/types.js';
import { ELECTION_TYPE_PARAM, subnatLevel, matchesParty, pct, round2, mcpText, errResult } from '../shared.js';

/** All parliamentary years available in 13sw (1983–2023) */
const ALL_PARL_YEARS = [1983, 1987, 1991, 1995, 1999, 2003, 2007, 2011, 2015, 2019, 2023];

/**
 * Default election years per type — used when the caller does not specify years.
 * A5: prevents tools from silently querying parliamentary years for non-parliamentary
 * election types (which returns empty results with no error).
 */
const DEFAULT_YEARS_BY_TYPE: Record<ElectionType, number[]> = {
  parliamentary: [2011, 2015, 2019, 2023],
  municipal:     [2012, 2017, 2021, 2025],
  eu_parliament: [2009, 2014, 2019, 2024],
  regional:      [2022, 2025],
  presidential:  [2018, 2024],
};

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
    async ({ area_id, election_type, reference_year, history_years, top_n = 5 }) => {
      const electionType: ElectionType = election_type ?? 'parliamentary';
      const typeYears = DEFAULT_YEARS_BY_TYPE[electionType];
      const defaultRefYear = typeYears[typeYears.length - 1]!;
      const resolvedRefYear = reference_year ?? defaultRefYear;
      const years = history_years ?? typeYears.slice(-3);
      if (!years.includes(resolvedRefYear)) years.push(resolvedRefYear);
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
      const refYear = yearData.find(d => d.year === resolvedRefYear) ?? yearData[yearData.length - 1]!;
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
      const volatility: Array<{
        from_year: number; to_year: number; years_between: number;
        pedersen_index: number; pedersen_per_4yr_cycle: number;
      }> = [];
      for (let i = 1; i < yearData.length; i++) {
        const prev = yearData[i - 1]!;
        const curr = yearData[i]!;
        const prevMap = partyShareMap(prev.rows.filter(r => r.area_id === area_id));
        const currMap = partyShareMap(curr.rows.filter(r => r.area_id === area_id));
        if (prevMap.size > 0 && currMap.size > 0) {
          const pedersen = pedersenIndex(prevMap, currMap);
          const yearsBetween = curr.year - prev.year;
          volatility.push({
            from_year: prev.year,
            to_year: curr.year,
            years_between: yearsBetween,
            pedersen_index: pedersen,
            // POL-8: normalize by period length so different-gap elections are comparable
            pedersen_per_4yr_cycle: round2(pedersen / (yearsBetween / 4)),
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
        // POL-5: survivorship bias warning — trend tracks current top parties only
        historical_trend_caveat: `historical_trend tracks the top ${top_n} parties from the reference year (${resolvedRefYear}) only. Parties that were strong in earlier years but declined or exited are not shown — the trend therefore skews toward parties with sustained recent success. For full historical party landscape use compare_elections or analyze_area_volatility.`,
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
          // POL-16: named specific Finnish party discontinuity events
          pedersen_method_note: 'The Pedersen index is keyed on party_id. Known Finnish party discontinuities that inflate the index: SMP→PS (1995 election); SKL→KD (2001 rename); Sini/Sininen tulevaisuus split from PS (2017, appears in 2019 results). Elections spanning these years should be interpreted with extra caution.',
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
      year: z.number().optional().describe('Election year. Defaults to the most recent year for the given election_type.'),
      top_n: z.number().optional().describe('Number of top parties to show per area. Defaults to 5.'),
    },
    async ({ area_ids, election_type, year, top_n = 5 }) => {
      const electionType: ElectionType = election_type ?? 'parliamentary';
      const typeYears = DEFAULT_YEARS_BY_TYPE[electionType];
      const resolvedYear = year ?? typeYears[typeYears.length - 1]!;
      let allRows: ElectionRecord[];
      let tableId: string;

      try {
        const result = await loadPartyResults(resolvedYear, undefined, electionType);
        allRows = result.rows;
        tableId = result.tableId;
      } catch (err) {
        return errResult(`Failed to load party data: ${String(err)}`);
      }

      const areas = area_ids.map(area_id => {
        const areaRows = allRows.filter(r => r.area_id === area_id && r.party_id);
        if (areaRows.length === 0) return { area_id, error: `Area ${area_id} not found in ${resolvedYear} data.` };

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

      // Warn if area_ids span different area levels — vote shares are not comparable across levels
      const distinctLevels = [...new Set(areas.flatMap(a => 'area_level' in a ? [a.area_level] : []))];
      const crossLevelWarning = distinctLevels.length > 1
        ? `WARNING: area_ids span different area levels (${distinctLevels.join(', ')}). Vote shares are not comparable across levels — a kunta share reflects that municipality only, a vaalipiiri share reflects the whole district.`
        : null;

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
        year: resolvedYear,
        election_type: electionType,
        ...(crossLevelWarning ? { cross_level_warning: crossLevelWarning } : {}),
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
      years: z.array(z.number()).optional().describe('Election years to include. Defaults to the most recent 4 years for the given election_type.'),
    },
    async ({ area_id, election_type, years }) => {
      const electionType: ElectionType = election_type ?? 'parliamentary';
      const resolvedYears = years ?? DEFAULT_YEARS_BY_TYPE[electionType];
      const sortedYears = [...resolvedYears].sort((a, b) => a - b);
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

      // POL-11: minimum vote share threshold to exclude micro-parties from biggest_gainer/loser.
      // A party with <1% share in both periods is noise, not a meaningful gainer/loser.
      const MIN_SHARE_FOR_GAINER = 1.0;

      const volatility: Array<{
        from_year: number; to_year: number; years_between: number;
        pedersen_index: number; pedersen_per_4yr_cycle: number;
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
        const yearsBetween = curr.year - prev.year;

        // Filter micro-parties before picking biggest gainer/loser (POL-11)
        const substantiveChanges = changes.filter(c => {
          const s1 = prevMap.get(c.party_id)?.share ?? 0;
          const s2 = currMap.get(c.party_id)?.share ?? 0;
          return Math.max(s1, s2) >= MIN_SHARE_FOR_GAINER;
        });
        const sorted = [...substantiveChanges].sort((a, b) => b.change_pp - a.change_pp);

        volatility.push({
          from_year: prev.year,
          to_year: curr.year,
          years_between: yearsBetween,
          pedersen_index: pedersen,
          // POL-8: normalize for inter-election period length (Finnish cycle ≈ 4 years)
          pedersen_per_4yr_cycle: round2(pedersen / (yearsBetween / 4)),
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
          description: 'Pedersen volatility index = sum(|share_t - share_{t-1}|) / 2. Computed from 13sw party vote shares at the specified area level. pedersen_per_4yr_cycle normalizes for inter-election gap (÷ years_between/4) to make different-gap elections comparable.',
          source_table: tableId,
          // POL-16: specific Finnish party discontinuity events named
          pedersen_method_note: 'The Pedersen index is keyed on party_id. Known Finnish party discontinuities that inflate the index: SMP→PS (1995 election — SMP dissolves, PS inherits some support); SKL→KD (2001 rename); Sini/Sininen tulevaisuus split from PS (2017, appears in 2019 results). Elections spanning these years should be interpreted with extra caution.',
          biggest_gainer_note: `Biggest gainer/loser excludes parties with <${MIN_SHARE_FOR_GAINER}% share in both periods to suppress micro-party noise.`,
        },
      });
    }
  );

  // ── find_strongholds ──────────────────────────────────────────────────────
  server.tool(
    'find_strongholds',
    'Finds the strongest or weakest geographic areas for a party or candidate by vote share. direction=\'strongholds\' (default) returns highest-share areas; direction=\'weak_zones\' returns lowest-share areas. Replaces the removed find_weak_zones tool.',
    {
      year: z.number().describe('Election year.'),
      election_type: ELECTION_TYPE_PARAM,
      subject_type: z.enum(['party', 'candidate']).describe('Whether to find areas for a party or a candidate.'),
      subject_id: z.string().describe('Party abbreviation (e.g. "KOK") or candidate_id.'),
      unit_key: z.string().optional().describe('Required when subject_type=candidate (vaalipiiri/hyvinvointialue key). Omit for EU/presidential.'),
      min_votes: z.number().optional().describe('Minimum votes to include an area. Defaults to 10.'),
      limit: z.number().optional().describe('Number of areas to return. Defaults to 15.'),
      direction: z.enum(['strongholds', 'weak_zones']).optional().describe("'strongholds' (default) = highest vote share areas; 'weak_zones' = lowest vote share areas."),
    },
    async ({ year, election_type, subject_type, subject_id, unit_key, min_votes = 10, limit = 15, direction = 'strongholds' }) => {
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

        const sortedAreas = [...areaRows]
          .sort((a, b) => direction === 'weak_zones'
            ? (a.vote_share ?? 0) - (b.vote_share ?? 0)
            : (b.vote_share ?? 0) - (a.vote_share ?? 0))
          .slice(0, limit)
          .map((r, i) => ({
            rank: i + 1,
            area_id: r.area_id,
            area_name: r.area_name,
            votes: r.votes,
            vote_share_pct: pct(r.vote_share!),
          }));

        const nationalRow = rows.find(r => matchesParty(r, subject_id) && r.area_level === 'koko_suomi');
        const areasKey = direction === 'weak_zones' ? 'weak_zones' : 'strongholds';

        return mcpText({
          subject_type: 'party',
          subject_id,
          year,
          election_type: electionType,
          area_level: areaLvl,
          national_share_pct: nationalRow?.vote_share ? pct(nationalRow.vote_share) : null,
          [areasKey]: sortedAreas,
          method: { description: `Ranked by vote share ${direction === 'weak_zones' ? 'ascending' : 'descending'}. Min votes filter applied to exclude tiny areas.`, source_table: tableId },
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

        const sortedCandAreas = [...candidateRows]
          .sort((a, b) => direction === 'weak_zones'
            ? (a.vote_share ?? 0) - (b.vote_share ?? 0)
            : (b.vote_share ?? 0) - (a.vote_share ?? 0))
          .slice(0, limit)
          .map((r, i) => ({
            rank: i + 1,
            area_id: r.area_id,
            area_name: r.area_name,
            votes: r.votes,
            vote_share_pct: pct(r.vote_share!),
          }));

        const candAreasKey = direction === 'weak_zones' ? 'weak_zones' : 'strongholds';
        return mcpText({
          subject_type: 'candidate',
          subject_id,
          candidate_name: vpRow?.candidate_name,
          party: vpRow?.party_id,
          year,
          election_type: electionType,
          unit_key: unit_key ?? 'national',
          unit_share_pct: vpRow?.vote_share ? pct(vpRow.vote_share) : null,
          [candAreasKey]: sortedCandAreas,
          method: { description: `Ranked by vote share ${direction === 'weak_zones' ? 'ascending' : 'descending'} at äänestysalue level. Min votes filter applied.`, source_table: tableId },
        });
      }
    }
  );

  // find_weak_zones REMOVED (T1): use find_strongholds with direction='weak_zones'.
  // DEAD CODE START
  /*
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
  // DEAD CODE END
  */

  // ── find_comparable_areas ─────────────────────────────────────────────────
  server.tool(
    'find_comparable_areas',
    'Find municipalities with vote-share patterns most similar to a reference municipality. Fetches party data at kunta level for each requested election, builds a vote-share vector per kunta (one dimension per subject × election pair), normalizes each dimension to [0,1] across all kunnat, then ranks by Euclidean distance from the reference area. Smaller distance = more similar electoral behaviour.',
    {
      reference_area_id: z.string().describe('area_id of the reference municipality in the format returned by query_election_data at kunta level (e.g. "KU837" for Tampere from 13t2/14vm tables, or the 6-digit code from multi-year tables).'),
      subjects: z.array(z.string()).min(1).max(10).describe('Party IDs to include in the similarity vector (e.g. ["VIHR", "SDP"]). Each subject × election pair becomes one dimension.'),
      elections: z.array(z.object({
        election_type: ELECTION_TYPE_PARAM,
        year: z.number().describe('Election year.'),
      })).min(1).max(6).describe('List of elections to use. Each election × subject pair is one dimension of the similarity vector.'),
      n_results: z.number().int().min(1).max(50).default(10).describe('Number of most-similar municipalities to return (default: 10).'),
    },
    async ({ reference_area_id, subjects, elections, n_results }) => {
      // Fan-out: fetch kunta-level party data for all requested elections simultaneously.
      // query_election_data takes flat election_types × years; we post-filter to exact pairs.
      const electionTypes = [...new Set(elections.map((e) => e.election_type))] as ElectionType[];
      const years = [...new Set(elections.map((e) => e.year))];
      const requestedPairs = new Set(elections.map((e) => `${e.election_type}:${e.year}`));

      let rows: ElectionRecord[];
      let tableIds: string[];
      try {
        const result = await queryElectionData({
          subject_type: 'party',
          subject_ids: subjects,
          election_types: electionTypes,
          years,
          area_level: 'kunta',
        });
        rows = result.rows;
        tableIds = result.table_ids;
      } catch (err) {
        return errResult(`Failed to fetch data: ${String(err)}`);
      }

      // Keep only rows from the exact requested (election_type × year) pairs.
      rows = rows.filter((r) => requestedPairs.has(`${r.election_type}:${r.year}`));

      // Build dimension keys: one per (subject × election_type × year) combination.
      const dimensions: { subject: string; election_type: ElectionType; year: number; key: string }[] = [];
      for (const e of elections) {
        const et = e.election_type as ElectionType;
        for (const s of subjects) {
          dimensions.push({ subject: s, election_type: et, year: e.year, key: `${s}::${et}::${e.year}` });
        }
      }

      // Group rows by area_id, then by dimension key → raw vote_share.
      const areaMap = new Map<string, Map<string, number>>();
      for (const r of rows) {
        if (!r.party_id || r.vote_share === undefined) continue;
        const dimKey = `${r.party_id}::${r.election_type}::${r.year}`;
        let areaEntry = areaMap.get(r.area_id);
        if (!areaEntry) { areaEntry = new Map(); areaMap.set(r.area_id, areaEntry); }
        areaEntry.set(dimKey, r.vote_share);
      }

      if (areaMap.size === 0) {
        return errResult('No kunta-level data found for the given elections and subjects. Check that the election years and subjects are correct.');
      }

      if (!areaMap.has(reference_area_id)) {
        const sample = [...areaMap.keys()].slice(0, 5).join(', ');
        return errResult(`reference_area_id "${reference_area_id}" not found in results. Sample area_ids: ${sample}. Make sure to use the exact format returned by query_election_data at kunta level.`);
      }

      // Collect area_names from the rows for output.
      const areaNames = new Map<string, string>();
      for (const r of rows) { if (r.area_name) areaNames.set(r.area_id, r.area_name); }

      // Normalize each dimension to [0, 1] across all kunnat.
      const allAreaIds = [...areaMap.keys()];
      const dimMins = new Map<string, number>();
      const dimMaxs = new Map<string, number>();
      for (const d of dimensions) {
        const vals = allAreaIds.map((id) => areaMap.get(id)?.get(d.key) ?? 0);
        dimMins.set(d.key, Math.min(...vals));
        dimMaxs.set(d.key, Math.max(...vals));
      }

      function normalizedVec(areaId: string): number[] {
        const entry = areaMap.get(areaId);
        return dimensions.map((d) => {
          const raw = entry?.get(d.key) ?? 0;
          const mn = dimMins.get(d.key)!;
          const mx = dimMaxs.get(d.key)!;
          return mx === mn ? 0.5 : (raw - mn) / (mx - mn);
        });
      }

      const refVec = normalizedVec(reference_area_id);

      // Compute Euclidean distance from reference for every other kunta.
      const scored = allAreaIds
        .filter((id) => id !== reference_area_id)
        .map((id) => {
          const vec = normalizedVec(id);
          const dist = Math.sqrt(vec.reduce((sum, v, i) => sum + (v - refVec[i]!) ** 2, 0));
          return { area_id: id, area_name: areaNames.get(id) ?? id, distance: round2(dist) };
        })
        .sort((a, b) => a.distance - b.distance)
        .slice(0, n_results);

      // Build reference summary for context.
      const refEntry = areaMap.get(reference_area_id)!;
      const refSummary: Record<string, number> = {};
      for (const d of dimensions) {
        refSummary[d.key.replace(/::/g, ' / ')] = round2(refEntry.get(d.key) ?? 0);
      }

      return mcpText({
        reference: { area_id: reference_area_id, area_name: areaNames.get(reference_area_id) ?? reference_area_id, vote_shares: refSummary },
        comparable_areas: scored,
        dimensions: dimensions.map((d) => `${d.subject} / ${d.election_type} ${d.year}`),
        method: {
          description: 'Euclidean distance on normalized vote-share vectors. Each dimension (subject × election) normalized to [0,1] across all kunnat so different base vote shares contribute equally.',
          n_kunnat_compared: allAreaIds.length - 1,
          source_tables: tableIds,
        },
      });
    }
  );

}
