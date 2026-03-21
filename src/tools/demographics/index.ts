import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { loadVoterBackground, loadVoterTurnoutByDemographics } from '../../data/loaders.js';
import type { VoterBackgroundRow, VoterTurnoutDemographicRow } from '../../data/types.js';
import { mcpText, errResult } from '../shared.js';

// ── Analysis builders ─────────────────────────────────────────────────────────

const GROUP_LABEL: Record<string, string> = {
  eligible_voters: 'Eligible voters (all residents eligible to vote)',
  candidates:      'Candidates (all parties combined)',
  elected:         'Elected officials',
};

const DIMENSION_LABEL: Record<string, string> = {
  employment:      'Employment status',
  education:       'Education level',
  employer_sector: 'Employer sector',
  income_decile:   'Income decile',
  language:        'Language',
  origin:          'Origin / background',
};

const DIMENSION_NOTE: Partial<Record<string, string>> = {
  income_decile:
    '⚠️ Only the lowest income decile (bottom 10%) and highest income decile (top 10%) are ' +
    'available in this table — intermediate deciles are not published in this format.',
  origin:
    'Only the "foreign-background" category is available in this table. ' +
    'Finnish-background is the implied complement but is not a separate published row.',
};

export function buildVoterBackgroundAnalysis(
  rows: VoterBackgroundRow[],
  electionType: string,
  year: number,
  group: string,
  dimension: string,
  gender: string,
  tableId: string,
): ReturnType<typeof mcpText> {
  const genderFilter = gender === 'total' ? 'SSS'
    : gender === 'male' ? '1' : '2';

  // The rows already contain all genders; filter to the requested one
  const filtered = gender === 'total'
    ? rows.filter(r => r.gender === 'total')
    : rows.filter(r => r.gender === (gender === 'male' ? 'male' : 'female'));

  const sorted = [...filtered].sort((a, b) => b.share_pct - a.share_pct);

  const dimNote = DIMENSION_NOTE[dimension];
  const groupNote =
    'Note: eligible_voters = everyone entitled to vote; ' +
    'candidates = who ran; elected = who won. These are three different populations ' +
    'and share_pct is calculated within each group separately.';

  const coverageNote =
    `Coverage — get_voter_background: parliamentary (2011, 2015, 2019, 2023), ` +
    `municipal (2012, 2017, 2021, 2025). Not available for EU parliament, presidential, or regional elections.`;

  const genderLabel = gender === 'total' ? 'Total (all)' : gender === 'male' ? 'Male' : 'Female';

  let md = `## Voter background: ${GROUP_LABEL[group] ?? group} — ${DIMENSION_LABEL[dimension] ?? dimension}\n\n`;
  md += `**Election:** ${electionType} ${year}  **Gender:** ${genderLabel}\n\n`;

  if (dimNote) md += `> ${dimNote}\n\n`;

  // Table
  md += `| Category | Count | Share (%) |\n`;
  md += `|---|---:|---:|\n`;
  for (const r of sorted) {
    md += `| ${r.category_name} | ${r.count.toLocaleString('fi-FI')} | ${r.share_pct.toFixed(1)} |\n`;
  }
  md += `\n_${groupNote}_\n\n`;
  md += `_${coverageNote}_\n\n`;
  md += `_Source: ${tableId}_`;

  void genderFilter; // used in filter above
  return mcpText({ mode: 'analysis', text: md });
}

export function buildTurnoutDemoAnalysis(
  rows: VoterTurnoutDemographicRow[],
  electionType: string,
  year: number,
  dimension: string,
  gender: string,
  round: number,
  tableId: string,
): ReturnType<typeof mcpText> {
  const genderKey = gender === 'total' ? 'total' : gender === 'male' ? 'male' : 'female';

  const filtered = rows.filter(r => r.gender === genderKey);
  const sorted = [...filtered].sort((a, b) => b.turnout_pct - a.turnout_pct);

  const coverageNote =
    `⚠️ Turnout-by-demographics is only available for: parliamentary (2023), ` +
    `municipal (2025), eu_parliament (2024), presidential (2024). ` +
    `Earlier years were not published in this format — this has been verified by full archive enumeration.`;

  const roundNote = electionType === 'presidential'
    ? `\n_Presidential election — round ${round}. Use round=2 for the runoff._\n`
    : '';

  let md = `## Voter turnout by ${dimension}: ${electionType} ${year}\n\n`;
  md += `**Gender:** ${gender === 'total' ? 'Total (all)' : gender === 'male' ? 'Male' : 'Female'}\n`;
  md += roundNote + '\n';

  // Table
  md += `| Category | Eligible voters | Votes cast | Turnout (%) |\n`;
  md += `|---|---:|---:|---:|\n`;
  for (const r of sorted) {
    md += `| ${r.category_name} | ${r.eligible_voters.toLocaleString('fi-FI')} | ${r.votes_cast.toLocaleString('fi-FI')} | **${r.turnout_pct.toFixed(1)}** |\n`;
  }

  if (sorted.length >= 2) {
    const highest = sorted[0]!;
    const lowest  = sorted[sorted.length - 1]!;
    md += `\n**Highest turnout:** ${highest.category_name} (${highest.turnout_pct.toFixed(1)}%)  `;
    md += `**Lowest:** ${lowest.category_name} (${lowest.turnout_pct.toFixed(1)}%)  `;
    md += `**Gap:** ${(highest.turnout_pct - lowest.turnout_pct).toFixed(1)} pp\n`;
  }

  // Gender gap note when showing total
  if (gender === 'total') {
    const maleRows   = rows.filter(r => r.gender === 'male');
    const femaleRows = rows.filter(r => r.gender === 'female');
    if (maleRows.length > 0 && femaleRows.length > 0) {
      let maxGap = 0;
      let maxGapCategory = '';
      for (const m of maleRows) {
        const f = femaleRows.find(r => r.category_code === m.category_code);
        if (f) {
          const gap = Math.abs(m.turnout_pct - f.turnout_pct);
          if (gap > maxGap) { maxGap = gap; maxGapCategory = m.category_name; }
        }
      }
      if (maxGapCategory) {
        const m = maleRows.find(r => r.category_name === maxGapCategory)!;
        const f = femaleRows.find(r => r.category_name === maxGapCategory)!;
        const higher = m.turnout_pct > f.turnout_pct ? 'men' : 'women';
        md += `\n**Largest gender gap:** ${maxGapCategory} — men ${m.turnout_pct.toFixed(1)}% vs women ${f.turnout_pct.toFixed(1)}% (${maxGap.toFixed(1)} pp; ${higher} vote at higher rate)\n`;
      }
    }
  }

  md += `\n_${coverageNote}_\n\n`;
  md += `_Source: ${tableId}_`;

  return mcpText({ mode: 'analysis', text: md });
}

// ── Tool registration ─────────────────────────────────────────────────────────

export function registerDemographicsTools(server: McpServer): void {

  // ── get_voter_background ───────────────────────────────────────────────────
  server.tool(
    'get_voter_background',
    'Socioeconomic composition (employment, education, employer sector, income decile, ' +
    'language, origin) of eligible voters, candidates, or elected officials. ' +
    'Parliamentary elections: 2011, 2015, 2019, 2023. ' +
    'Municipal elections: 2012, 2017, 2021, 2025. ' +
    'NOT available for EU parliament, presidential, or regional elections. ' +
    'Income decile only provides bottom (des1) and top (des10) decile — not all 10.',
    {
      election_type: z.enum(['parliamentary', 'municipal']).describe(
        'Election type. Supported: parliamentary (2011/2015/2019/2023), municipal (2012/2017/2021/2025).'
      ),
      year: z.coerce.number().describe(
        'Election year. Parliamentary: 2011, 2015, 2019, 2023. Municipal: 2012, 2017, 2021, 2025.'
      ),
      group: z.enum(['eligible_voters', 'candidates', 'elected']).describe(
        'Which population to describe. ' +
        'eligible_voters = all residents entitled to vote (the electorate). ' +
        'candidates = everyone who ran (all parties combined). ' +
        'elected = officials who won seats. ' +
        'These are three entirely different populations; shares are within-group.'
      ),
      dimension: z.enum(['employment', 'education', 'employer_sector', 'income_decile', 'language', 'origin']).describe(
        'Background characteristic to show. ' +
        'employment: employed/unemployed/student/retired/other. ' +
        'education: basic/secondary/lower-tertiary/bachelor/master+. ' +
        'employer_sector: private/state/municipality/entrepreneur. ' +
        'income_decile: ONLY bottom decile (lowest 10%) and top decile (highest 10%) available — not all 10. ' +
        'language: Finnish-or-Sami / Swedish / foreign / unknown. ' +
        'origin: only foreign-background category available (Finnish-background is the complement).'
      ),
      gender: z.enum(['total', 'male', 'female']).optional().describe(
        'Gender filter. Default: total (all genders combined). ' +
        'Use male/female to see gender-specific composition.'
      ),
      output_mode: z.enum(['data', 'analysis']).optional().describe(
        'data = normalized rows (JSON), analysis = markdown summary table.'
      ),
    },
    async ({ election_type, year, group, dimension, gender = 'total', output_mode }) => {
      try {
        const rows = await loadVoterBackground(election_type, year, group, dimension);
        const tableId = `statfin_${election_type === 'parliamentary' ? 'evaa' : 'kvaa'}_pxt_${election_type === 'parliamentary' ? '13su' : '14w4'}`;

        if ((output_mode ?? 'analysis') === 'data') {
          const genderKey = gender === 'total' ? 'total' : gender === 'male' ? 'male' : 'female';
          const filtered = rows.filter(r => r.gender === genderKey);
          return mcpText({ mode: 'data', rows: filtered });
        }

        return buildVoterBackgroundAnalysis(rows, election_type, year, group, dimension, gender, tableId);
      } catch (err: unknown) {
        return errResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ── get_voter_turnout_by_demographics ──────────────────────────────────────
  server.tool(
    'get_voter_turnout_by_demographics',
    'Actual voter participation rate broken down by a demographic dimension. ' +
    'parliamentary: 2023 ONLY. municipal: 2025 ONLY. eu_parliament: 2024 ONLY. presidential: 2024 ONLY. ' +
    'NOT available for regional elections. ' +
    'NOT available for any earlier years — verified by full archive enumeration.',
    {
      election_type: z.enum(['parliamentary', 'municipal', 'eu_parliament', 'presidential']).describe(
        'Election type. Valid years: parliamentary=2023, municipal=2025, eu_parliament=2024, presidential=2024.'
      ),
      year: z.coerce.number().describe(
        'Election year. Must match exactly: parliamentary→2023, municipal→2025, eu_parliament→2024, presidential→2024.'
      ),
      dimension: z.enum(['age_group', 'education', 'income_quintile', 'origin_language', 'activity']).describe(
        'Demographic dimension. ' +
        'age_group: standard 7 groups (18-24, 25-34, ..., 75+). ' +
        'education: basic/secondary/lower-tertiary/bachelor/master+. ' +
        'income_quintile: Q1 (bottom 20%) through Q5 (top 20%). ' +
        'origin_language: Finnish/Swedish/foreign-language speakers + origin (Finnish/foreign background). ' +
        'activity: employed/unemployed/outside-labor-force/students/retired.'
      ),
      gender: z.enum(['total', 'male', 'female']).optional().describe(
        'Gender filter. Default: total. When total, analysis mode also shows the largest gender gap.'
      ),
      round: z.coerce.number().optional().describe(
        'Presidential elections only: 1 = first round (default), 2 = second round (runoff).'
      ),
      output_mode: z.enum(['data', 'analysis']).optional().describe(
        'data = normalized rows (JSON), analysis = markdown summary table.'
      ),
    },
    async ({ election_type, year, dimension, gender = 'total', round = 1, output_mode }) => {
      try {
        const rows = await loadVoterTurnoutByDemographics(election_type, year, dimension, round);

        // Look up the table ID for source attribution
        const { getElectionTables } = await import('../../data/election-tables.js');
        const tableId = getElectionTables(election_type, year)?.voter_turnout_by_demographics?.[dimension] ?? '';

        if ((output_mode ?? 'analysis') === 'data') {
          const genderKey = gender === 'total' ? 'total' : gender === 'male' ? 'male' : 'female';
          const filtered = rows.filter(r => r.gender === genderKey);
          return mcpText({ mode: 'data', rows: filtered });
        }

        return buildTurnoutDemoAnalysis(rows, election_type, year, dimension, gender, round, tableId);
      } catch (err: unknown) {
        return errResult(err instanceof Error ? err.message : String(err));
      }
    }
  );
}
