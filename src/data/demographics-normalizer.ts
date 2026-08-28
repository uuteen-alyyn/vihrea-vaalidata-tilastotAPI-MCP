/**
 * Normalizers for voter background and voter turnout by demographics tables.
 *
 * Background tables (13su parliamentary, 14w4 municipal):
 *   All background dimensions live in a single Taustamuuttujat variable.
 *   Year filtering is done server-side in the loader; the normalizer receives
 *   already-filtered rows.
 *
 * Turnout tables (13ys/13yt/13yu/13yv/13yw etc.):
 *   Single-year tables with a geographic Alue dimension. The loader filters
 *   to Alue=SSS (national) before calling the normalizer.
 *   Presidential tables also have a Kierros (round) dimension.
 *   Age tables (13ys, 152q, 14ha, 14nk) use near-individual age bins that
 *   must be aggregated to 7 standard groups.
 */

import type { PxWebResponse, PxWebTableMetadata } from '../api/types.js';
import type { VoterBackgroundRow, VoterTurnoutDemographicRow, ElectionType } from './types.js';
import { buildKeyIndex, buildValueIndex, buildValueTextMap } from './normalizer.js';
import {
  findVariable,
  requireVariable,
  findYearVariable,
  findMeasureVariable,
  requireContentCode,
  AREA_HINTS,
  GENDER_HINTS,
  ROUND_HINTS,
  BACKGROUND_DIMENSION_HINTS,
} from '../api/variable-resolver.js';

// ── Shared ────────────────────────────────────────────────────────────────────

const GENDER_CODE_MAP: Record<string, 'total' | 'male' | 'female'> = {
  SSS: 'total',
  '1': 'male',
  '2': 'female',
};

// ── Background table constants ────────────────────────────────────────────────

/**
 * Taustamuuttujat codes to request for each background dimension.
 * Includes the dimension-level total code so it can be stripped in the normalizer.
 */
export const BACKGROUND_DIMENSION_CODES: Record<string, string[]> = {
  employment:      ['ptoSSS', 'pto11', 'pto12', 'pto22', 'pto24', 'pto99'],
  education:       ['kouSSS', 'kou1_9', 'kou3_4', 'kou5', 'kou6', 'kou7_8'],
  employer_sector: ['sekSSS', 'sek1', 'sek2', 'sek3', 'sek8'],
  income_decile:   ['des1', 'des10'],       // only bottom and top decile available
  language:        ['kifise', 'kisv', 'ki02', 'kiX'],
  origin:          ['sy2'],                 // only foreign-background available
};

/** Aggregate/total codes — stripped from voter background output */
const BACKGROUND_TOTAL_CODES = new Set(['SSS', 'ptoSSS', 'kouSSS', 'sekSSS']);

/**
 * Map canonical group name to the PxWeb value code in the group variable.
 * The eligible voter code differs between parliamentary and municipal tables.
 */
export function groupPxWebCode(
  electionType: ElectionType,
  group: 'eligible_voters' | 'candidates' | 'elected'
): string {
  if (group === 'eligible_voters') return electionType === 'municipal' ? '0001' : '00S1';
  if (group === 'candidates') return '1002';
  return '2002'; // elected
}

/**
 * Gender variable name differs between parliamentary (Sukupuoli) and
 * municipal (Ehdokkaan sukupuoli) background tables.
 */
export function genderVarName(electionType: ElectionType): string {
  return electionType === 'municipal' ? 'Ehdokkaan sukupuoli' : 'Sukupuoli';
}

/**
 * Normalize a voter background API response into VoterBackgroundRow[].
 * Returns rows for all three genders; caller may filter by gender if needed.
 */
export function normalizeVoterBackground(
  response: PxWebResponse,
  metadata: PxWebTableMetadata,
  electionType: ElectionType,
  year: number,
  group: 'eligible_voters' | 'candidates' | 'elected',
  dimension: string,
): VoterBackgroundRow[] {
  const keyIdx = buildKeyIndex(response.columns);
  const valIdx = buildValueIndex(response.columns);

  // Gender variable label differs by election type; the resolver falls back
  // through the other known labels before giving up.
  const genderVarCode = requireVariable(
    metadata, [genderVarName(electionType), ...GENDER_HINTS], 'gender', metadata.title
  ).code;
  const taustaVarCode = requireVariable(
    metadata, BACKGROUND_DIMENSION_HINTS, 'background_dimension', metadata.title
  ).code;

  const genderKeyIdx = keyIdx[genderVarCode];
  const taustaKeyIdx = keyIdx[taustaVarCode];

  if (genderKeyIdx === undefined || taustaKeyIdx === undefined) {
    throw new Error(
      `normalizeVoterBackground: expected key columns not found ` +
      `(gender=${genderVarCode}, dimension=${taustaVarCode}, ` +
      `found keys=${Object.keys(keyIdx).join(',')})`
    );
  }

  // Content codes gained a subject prefix in July 2026: lkm1 → evaa-lkm1.
  const measureVar = findMeasureVariable(metadata);
  const lkm1Idx = valIdx[requireContentCode(measureVar, 'lkm1', metadata.title)];
  const prosIdx = valIdx[requireContentCode(measureVar, 'pros', metadata.title)];
  if (lkm1Idx === undefined || prosIdx === undefined) {
    throw new Error(
      `normalizeVoterBackground: count/share measure columns not found in response ` +
      `(found values=${Object.keys(valIdx).join(',')})`
    );
  }

  const taustaTextMap = buildValueTextMap(metadata, taustaVarCode);
  const rows: VoterBackgroundRow[] = [];

  for (const row of response.data) {
    const taustaCode = row.key[taustaKeyIdx] ?? '';
    const genderCode = row.key[genderKeyIdx] ?? '';

    if (BACKGROUND_TOTAL_CODES.has(taustaCode)) continue;

    const gender = GENDER_CODE_MAP[genderCode];
    if (!gender) continue;

    rows.push({
      election_type: electionType,
      year,
      group,
      dimension,
      category_code: taustaCode,
      category_name: taustaTextMap.get(taustaCode) ?? taustaCode,
      gender,
      count:     parseFloat(row.values[lkm1Idx] ?? '0') || 0,
      share_pct: parseFloat(row.values[prosIdx]  ?? '0') || 0,
    });
  }

  return rows;
}

// ── Turnout table constants ────────────────────────────────────────────────────

/** Election-type → Tiedot column suffix used in turnout tables */
const TIEDOT_SUFFIX: Record<string, string> = {
  parliamentary: 'evaa',
  municipal:     'kvaa',
  eu_parliament: 'euvaa',
  presidential:  'pvaa',
};

/**
 * Near-individual age bins from 13ys/152q/14ha/14nk grouped into standard labels.
 * 18 and 19 are separate codes; all others are 5-year bins.
 */
const AGE_GROUP_MAPPING: Array<[string, string[]]> = [
  ['18-24', ['018', '019', '20-24']],
  ['25-34', ['25-29', '30-34']],
  ['35-44', ['35-39', '40-44']],
  ['45-54', ['45-49', '50-54']],
  ['55-64', ['55-59', '60-64']],
  ['65-74', ['65-69', '70-74']],
  ['75+',   ['75-79', '80-']],
];

/** Maps each raw age bin code to its standard group label */
const AGE_CODE_TO_GROUP = new Map<string, string>(
  AGE_GROUP_MAPPING.flatMap(([label, codes]) => codes.map((c) => [c, label] as [string, string]))
);

/** Codes that represent totals or unknowns — stripped from turnout output */
const TURNOUT_STRIP_CODES = new Set(['SSS', '09', '9', 'X']);

/**
 * Normalize a voter turnout by demographics API response.
 * Returns rows for all three genders; caller may filter by gender if needed.
 *
 * @param round  Presidential round filter (1 or 2, default 1). Ignored for
 *               other election types that have no Kierros variable.
 */
export function normalizeVoterTurnoutByDemographics(
  response: PxWebResponse,
  metadata: PxWebTableMetadata,
  electionType: ElectionType,
  year: number,
  dimension: 'age_group' | 'education' | 'income_quintile' | 'origin_language' | 'activity',
  round = 1,
): VoterTurnoutDemographicRow[] {
  const keyIdx = buildKeyIndex(response.columns);
  const valIdx = buildValueIndex(response.columns);

  const suffix = TIEDOT_SUFFIX[electionType];
  if (!suffix) throw new Error(`normalizeVoterTurnoutByDemographics: unknown electionType ${electionType}`);

  const measureVar  = findMeasureVariable(metadata);
  const eligibleIdx = valIdx[requireContentCode(measureVar, `aoiky_al_${suffix}`, metadata.title)];
  const votesIdx    = valIdx[requireContentCode(measureVar, `a_al_${suffix}`, metadata.title)];
  if (eligibleIdx === undefined || votesIdx === undefined) {
    throw new Error(
      `normalizeVoterTurnoutByDemographics: measure columns aoiky_al_${suffix}/a_al_${suffix} not found ` +
      `(found values=${Object.keys(valIdx).join(',')})`
    );
  }

  const genderVar = requireVariable(metadata, GENDER_HINTS, 'gender', metadata.title);
  const areaVar   = findVariable(metadata, AREA_HINTS);
  const roundVar  = findVariable(metadata, ROUND_HINTS);
  const yearVar   = findYearVariable(metadata);

  // The dimension variable is whatever remains once the known roles are named.
  // It differs per table (Koulutusaste, Tulokvintiili, Ikäluokka, …) and is the
  // thing the caller actually asked for, so it cannot be listed in advance.
  const knownCodes = new Set(
    [genderVar.code, areaVar?.code, roundVar?.code, yearVar?.code, measureVar?.code]
      .filter((c): c is string => c !== undefined)
  );
  const dimVarCode = response.columns
    .filter((c) => (c.type === 'd' || c.type === 't') && !knownCodes.has(c.code))
    .map((c) => c.code)[0];
  if (!dimVarCode) {
    throw new Error(`normalizeVoterTurnoutByDemographics: dimension variable not found in response columns`);
  }

  const dimKeyIdx     = keyIdx[dimVarCode];
  const genderKeyIdx  = keyIdx[genderVar.code];
  const kierrosKeyIdx = roundVar ? keyIdx[roundVar.code] : undefined;

  if (dimKeyIdx === undefined || genderKeyIdx === undefined) {
    throw new Error(`normalizeVoterTurnoutByDemographics: expected key columns missing`);
  }

  const dimTextMap = buildValueTextMap(metadata, dimVarCode);

  if (dimension === 'age_group') {
    // Aggregate near-individual age bins → 7 standard groups, per gender
    const grouped = new Map<string, { eligible: number; votes: number }>();

    for (const row of response.data) {
      const ageCode    = row.key[dimKeyIdx] ?? '';
      const genderCode = row.key[genderKeyIdx] ?? '';

      if (ageCode === 'SSS') continue;
      if (kierrosKeyIdx !== undefined && row.key[kierrosKeyIdx] !== String(round)) continue;

      const standardLabel = AGE_CODE_TO_GROUP.get(ageCode);
      if (!standardLabel) continue;

      const mapKey  = `${standardLabel}:${genderCode}`;
      const current = grouped.get(mapKey) ?? { eligible: 0, votes: 0 };
      current.eligible += parseFloat(row.values[eligibleIdx] ?? '0') || 0;
      current.votes    += parseFloat(row.values[votesIdx]    ?? '0') || 0;
      grouped.set(mapKey, current);
    }

    const rows: VoterTurnoutDemographicRow[] = [];
    for (const [label] of AGE_GROUP_MAPPING) {
      for (const genderCode of ['SSS', '1', '2']) {
        const agg = grouped.get(`${label}:${genderCode}`);
        if (!agg || agg.eligible === 0) continue;
        const gender = GENDER_CODE_MAP[genderCode];
        if (!gender) continue;
        rows.push({
          election_type:   electionType,
          year,
          dimension,
          category_code:   label,
          category_name:   label,
          gender,
          eligible_voters: Math.round(agg.eligible),
          votes_cast:      Math.round(agg.votes),
          turnout_pct:     Math.round((agg.votes / agg.eligible) * 1000) / 10,
        });
      }
    }
    return rows;
  }

  // Non-age dimensions: direct row mapping
  const rows: VoterTurnoutDemographicRow[] = [];

  for (const row of response.data) {
    const dimCode    = row.key[dimKeyIdx] ?? '';
    const genderCode = row.key[genderKeyIdx] ?? '';

    if (TURNOUT_STRIP_CODES.has(dimCode)) continue;
    if (kierrosKeyIdx !== undefined && row.key[kierrosKeyIdx] !== String(round)) continue;

    const gender = GENDER_CODE_MAP[genderCode];
    if (!gender) continue;

    const eligible = parseFloat(row.values[eligibleIdx] ?? '0') || 0;
    const votes    = parseFloat(row.values[votesIdx]    ?? '0') || 0;

    rows.push({
      election_type:   electionType,
      year,
      dimension,
      category_code:   dimCode,
      category_name:   dimTextMap.get(dimCode) ?? dimCode,
      gender,
      eligible_voters: Math.round(eligible),
      votes_cast:      Math.round(votes),
      turnout_pct:     eligible > 0 ? Math.round((votes / eligible) * 1000) / 10 : 0,
    });
  }

  return rows;
}
