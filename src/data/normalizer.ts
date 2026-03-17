import type { PxWebResponse, PxWebColumn, PxWebTableMetadata } from '../api/types.js';
import type { ElectionRecord, ElectionType, AreaLevel } from './types.js';
import type { PartyTableSchema } from './election-tables.js';

/**
 * Builds a lookup from variable code → index in data row `key` array.
 * Only 'd' (dimension) and 't' (time) columns appear in key[].
 */
export function buildKeyIndex(columns: PxWebColumn[]): Record<string, number> {
  return Object.fromEntries(
    columns
      .filter((c) => c.type === 'd' || c.type === 't')
      .map((c, i) => [c.code, i])
  );
}

/**
 * Builds a lookup from variable code → index in data row `values` array.
 * Only 'c' (measure) columns appear in values[].
 */
export function buildValueIndex(columns: PxWebColumn[]): Record<string, number> {
  return Object.fromEntries(
    columns
      .filter((c) => c.type === 'c')
      .map((c, i) => [c.code, i])
  );
}

/**
 * Builds a code→text lookup map from table metadata for a given variable.
 */
export function buildValueTextMap(
  metadata: PxWebTableMetadata,
  variableCode: string
): Map<string, string> {
  const v = metadata.variables.find((v) => v.code === variableCode);
  if (!v) return new Map();
  const map = new Map<string, string>();
  v.values.forEach((code, i) => map.set(code, v.valueTexts[i] ?? code));
  return map;
}

/**
 * Infer area level from the code format used in candidate tables.
 *
 * Handles codes from parliamentary, municipal, regional, presidential tables:
 *   SSS         → koko_suomi  (presidential national total)
 *   VP##        → vaalipiiri  (parliamentary 2023/2019, EU archive, presidential)
 *   KU###       → kunta       (parliamentary 2023 active)
 *   HV##        → hyvinvointialue (regional 2025)
 *   ###         → kunta       (3-digit: parliamentary 2019 archive, regional, presidential)
 *   else        → aanestysalue
 */
export function inferAreaLevelFromCandidateCode(code: string): AreaLevel {
  if (code === 'SSS') return 'koko_suomi';
  if (code.startsWith('VP')) return 'vaalipiiri';
  if (code.startsWith('KU')) return 'kunta';
  if (code.startsWith('HV')) return 'hyvinvointialue';
  if (/^\d{3}$/.test(code)) return 'kunta';
  return 'aanestysalue';
}

/**
 * Infer area level from codes in a party-by-area table, using the table schema.
 */
export function inferPartyAreaLevel(code: string, schema: PartyTableSchema): AreaLevel {
  if (code === schema.national_code) return 'koko_suomi';
  switch (schema.area_code_format) {
    case 'six_digit':
      if (/^\d{6}$/.test(code) && code.endsWith('0000')) return schema.aggregate_area_level;
      return 'kunta';
    case 'vp_prefix':
      if (code.startsWith('VP')) return schema.aggregate_area_level;
      if (/^\d{3}$/.test(code)) return 'kunta';
      return 'kunta';
    case 'five_digit':
      if (code === '00000') return 'koko_suomi';
      if (/^\d{5}$/.test(code) && code.endsWith('000')) return schema.aggregate_area_level;
      return 'kunta';
  }
}

/**
 * Parse a candidate name string from valueText.
 * Parliamentary:  "Harakka Timo / SDP / Helsingin vaalipiiri"
 * Municipal:      "Sazonov Daniel / KOK / Helsinki"
 * Regional:       "Aho-Mantila Ella / KOK / Itä-Uudenmaan hyvinvointialue"
 * EU:             "Aaltola Mika / KOK"
 * Presidential:   "Alexander Stubb"
 */
export function parseCandidateValueText(valueText: string): {
  name: string;
  party: string;
  unit: string;
} {
  const parts = valueText.split(' / ');
  return {
    name:  parts[0]?.trim() ?? valueText,
    party: parts[1]?.trim() ?? '',
    unit:  parts[2]?.trim() ?? '',
  };
}

// ─── Party table normalizer ────────────────────────────────────────────────────

/**
 * Normalizes a PxWeb response from any party-votes-by-area table.
 * Uses the PartyTableSchema to handle variable name and code differences
 * across parliamentary, municipal, regional, EU tables.
 *
 * Handles two internal measure formats:
 *   - Content columns ('c' type): evaa_aanet / aanet_yht / euvaa_aanet appear directly in values[]
 *   - Dimension keys ('d' type): Sar1/Sar2 appear in key[]; values[] has exactly 1 element
 *     (used in EU 2019 archive table with 'Puolueiden kannatus' variable)
 */
export function normalizePartyTable(
  response: PxWebResponse,
  metadata: PxWebTableMetadata,
  year: number,
  electionType: ElectionType,
  schema: PartyTableSchema
): ElectionRecord[] {
  const keyIdx = buildKeyIndex(response.columns);
  const valIdx = buildValueIndex(response.columns);

  const areaTexts  = buildValueTextMap(metadata, schema.area_var);
  const partyTexts = buildValueTextMap(metadata, schema.party_var);

  // Detect whether the measure variable is a dimension key (Sar-type archive tables)
  // vs content columns (modern tables where votes_code is a content column code).
  const measureIsKey =
    Object.prototype.hasOwnProperty.call(keyIdx, schema.votes_code) ||
    (metadata.variables.some((v) => v.code === schema.measure_var) &&
     !Object.prototype.hasOwnProperty.call(valIdx, schema.votes_code));

  const records: ElectionRecord[] = [];

  if (measureIsKey) {
    // ── Sar-dimension format (EU 2019 archive) ──────────────────────────────
    const measureVarIdx = keyIdx[schema.measure_var];
    const votesByKey  = new Map<string, number>();
    const sharesByKey = new Map<string, number>();

    for (const row of response.data) {
      const areaCode   = row.key[keyIdx[schema.area_var]];
      const partyCode  = row.key[keyIdx[schema.party_var]];
      const measureCode = measureVarIdx !== undefined ? row.key[measureVarIdx] : undefined;
      if (areaCode === undefined || partyCode === undefined) continue;
      if (partyCode === schema.party_total_code) continue;
      const val = parseFloat(row.values[0] ?? '0');
      if (isNaN(val)) continue;
      const mapKey = `${partyCode}::${areaCode}`;
      if (measureCode === schema.votes_code) votesByKey.set(mapKey, val);
      else if (measureCode === schema.share_code) sharesByKey.set(mapKey, val);
    }

    for (const [mapKey, votes] of votesByKey) {
      const sep       = mapKey.indexOf('::');
      const partyCode = mapKey.slice(0, sep);
      const areaCode  = mapKey.slice(sep + 2);
      records.push({
        election_type: electionType,
        year,
        area_level: inferPartyAreaLevel(areaCode, schema),
        area_id:    areaCode,
        area_name:  areaTexts.get(areaCode) ?? areaCode,
        party_id:   partyCode,
        party_name: partyTexts.get(partyCode) ?? partyCode,
        votes,
        vote_share: sharesByKey.get(mapKey),
      });
    }
  } else {
    // ── Content-column format (all modern tables) ───────────────────────────
    for (const row of response.data) {
      const areaCode  = row.key[keyIdx[schema.area_var]];
      const partyCode = row.key[keyIdx[schema.party_var]];
      if (areaCode === undefined || partyCode === undefined) continue;
      if (partyCode === schema.party_total_code) continue;

      const rawVotes = row.values[valIdx[schema.votes_code]];
      const rawShare = row.values[valIdx[schema.share_code]];
      const votes    = parseFloat(rawVotes ?? '0');
      if (isNaN(votes)) continue;

      const vote_share = rawShare !== undefined ? parseFloat(rawShare) : undefined;
      records.push({
        election_type: electionType,
        year,
        area_level: inferPartyAreaLevel(areaCode, schema),
        area_id:    areaCode,
        area_name:  areaTexts.get(areaCode) ?? areaCode,
        party_id:   partyCode,
        party_name: partyTexts.get(partyCode) ?? partyCode,
        votes,
        vote_share: vote_share !== undefined && !isNaN(vote_share) ? vote_share : undefined,
      });
    }
  }

  return records;
}

/**
 * Backward-compatible alias for parliamentary party data.
 * @deprecated Use normalizePartyTable() with a PartyTableSchema instead.
 */
export function normalizePartyByKunta(
  response: PxWebResponse,
  metadata: PxWebTableMetadata,
  year: number
): ElectionRecord[] {
  const SCHEMA = {
    area_var:             'Vaalipiiri ja kunta vaalivuonna',
    party_var:            'Puolue',
    measure_var:          'Tiedot',
    votes_code:           'evaa_aanet',
    share_code:           'evaa_osuus_aanista',
    party_total_code:     'SSS',
    gender_var:           'Sukupuoli',
    gender_total_code:    'SSS',
    area_code_format:     'six_digit' as const,
    national_code:        'SSS',
    aggregate_area_level: 'vaalipiiri' as const,
  };
  return normalizePartyTable(response, metadata, year, 'parliamentary', SCHEMA);
}

// ─── Candidate table normalizer ───────────────────────────────────────────────

/**
 * Normalizes a PxWeb response from any candidate-votes-by-area table.
 *
 * Handles multiple table formats:
 *   Parliamentary 2023 active:  Alue/Äänestysalue + Tiedot (content columns)
 *   Parliamentary 2019 archive: Äänestysalue + Äänestystiedot (Sar1/Sar2 as dimension keys)
 *   Municipal 2025:             Äänestysalue + Tiedot (content columns, KU### area codes)
 *   Regional 2025:              Äänestysalue + Tiedot (content columns, HV## area codes)
 *   EU 2024:                    no area variable (national only)
 *   EU 2019 archive:            no area variable, Äänestystiedot as dimension
 *   Presidential 2024:          Alue (all areas in one table) + Kierros (round)
 *
 * @param electionType  Used to set election_type on each record.
 * @param roundFilter   If provided, only emit rows for this round (presidential).
 */
export function normalizeCandidateByAanestysalue(
  response: PxWebResponse,
  metadata: PxWebTableMetadata,
  year: number,
  electionType: ElectionType = 'parliamentary',
  roundFilter?: number
): ElectionRecord[] {
  const keyIdx = buildKeyIndex(response.columns);
  const valIdx = buildValueIndex(response.columns);

  // Detect area variable — try each known name; null means national-only (no area var)
  const AREA_VAR_CANDIDATES = ['Alue/Äänestysalue', 'Äänestysalue', 'Alue'];
  const AREA_KEY = metadata.variables.find(
    (v) => AREA_VAR_CANDIDATES.includes(v.code)
  )?.code ?? null;

  const areaTexts      = AREA_KEY ? buildValueTextMap(metadata, AREA_KEY) : new Map<string, string>();
  const candidateTexts = buildValueTextMap(metadata, 'Ehdokas');

  // Detect measure variable (Tiedot or Äänestystiedot / Puolueiden kannatus)
  const tiedotVar = metadata.variables.find(
    (v) => v.code === 'Tiedot' || v.code === 'Äänestystiedot' || v.code === 'Puolueiden kannatus'
  );
  const VOTES_KEY = tiedotVar?.values.find(
    (_, i) => (tiedotVar.valueTexts[i] ?? '').toLowerCase().includes('äänimäärä') ||
              (tiedotVar.valueTexts[i] ?? '').toLowerCase().includes('äänet')
  ) ?? 'evaa_aanet';
  const SHARE_KEY = tiedotVar?.values.find(
    (_, i) => (tiedotVar.valueTexts[i] ?? '').toLowerCase().includes('osuus')
  ) ?? 'evaa_osuus_aanista';

  // Detect round variable (presidential)
  const roundVar  = metadata.variables.find((v) => v.code === 'Kierros');
  const ROUND_KEY = roundVar?.code ?? null;
  // Build round code → round number map: first value = 1, second = 2
  const roundCodeToNumber = new Map<string, number>();
  roundVar?.values.forEach((code, i) => roundCodeToNumber.set(code, i + 1));

  // Detect whether measure is a dimension key (archive Sar-format) or content column
  const tiedotIsKey =
    Object.prototype.hasOwnProperty.call(keyIdx, VOTES_KEY) ||
    (tiedotVar !== undefined && !Object.prototype.hasOwnProperty.call(valIdx, VOTES_KEY));

  const CANDIDATE_KEY = 'Ehdokas';

  // Presidential candidate codes to skip (non-candidates)
  const SKIP_CANDIDATE_CODES = new Set(['00', '11']);

  const records: ElectionRecord[] = [];

  if (tiedotIsKey) {
    // ── Archive Sar-dimension format (2019 parliamentary, 2019 EU archive) ──
    const TIEDOT_KEY = tiedotVar?.code ?? 'Äänestystiedot';
    const tiedotIdx  = keyIdx[TIEDOT_KEY];
    const votesByKey  = new Map<string, { votes: number; areaCode: string; candidateCode: string; roundNum?: number }>();
    const sharesByKey = new Map<string, number>();

    for (const row of response.data) {
      const areaCode      = AREA_KEY ? row.key[keyIdx[AREA_KEY]] : 'SSS';
      const candidateCode = row.key[keyIdx[CANDIDATE_KEY]];
      const tiedotCode    = tiedotIdx !== undefined ? row.key[tiedotIdx] : undefined;
      const roundCode     = ROUND_KEY ? row.key[keyIdx[ROUND_KEY]] : undefined;
      if (candidateCode === undefined) continue;
      if (SKIP_CANDIDATE_CODES.has(candidateCode)) continue;
      const roundNum = roundCode ? roundCodeToNumber.get(roundCode) : undefined;
      if (roundFilter !== undefined && roundNum !== undefined && roundNum !== roundFilter) continue;
      const val = parseFloat(row.values[0] ?? '0');
      if (isNaN(val)) continue;
      const mapKey = `${candidateCode}::${areaCode ?? 'SSS'}::${roundNum ?? 0}`;
      if (tiedotCode === VOTES_KEY) votesByKey.set(mapKey, { votes: val, areaCode: areaCode ?? 'SSS', candidateCode, roundNum });
      else if (tiedotCode === SHARE_KEY) sharesByKey.set(mapKey, val);
    }

    for (const [mapKey, { votes, areaCode, candidateCode, roundNum }] of votesByKey) {
      const candidateText = candidateTexts.get(candidateCode) ?? candidateCode;
      const parsed = parseCandidateValueText(candidateText);
      const record: ElectionRecord = {
        election_type: electionType,
        year,
        area_level: AREA_KEY ? inferAreaLevelFromCandidateCode(areaCode) : 'koko_suomi',
        area_id:    areaCode,
        area_name:  areaTexts.get(areaCode) ?? areaCode,
        candidate_id:   candidateCode,
        candidate_name: parsed.name,
        party_id:   parsed.party || undefined,
        party_name: parsed.party || undefined,
        votes,
        vote_share: sharesByKey.get(mapKey),
      };
      if (roundNum !== undefined) record.round = roundNum;
      records.push(record);
    }
  } else {
    // ── Content-column format (2023 parliamentary, 2025 municipal/regional, EU 2024, presidential) ──
    for (const row of response.data) {
      const areaCode      = AREA_KEY ? row.key[keyIdx[AREA_KEY]] : 'SSS';
      const candidateCode = row.key[keyIdx[CANDIDATE_KEY]];
      const roundCode     = ROUND_KEY ? row.key[keyIdx[ROUND_KEY]] : undefined;
      if (candidateCode === undefined) continue;
      if (SKIP_CANDIDATE_CODES.has(candidateCode)) continue;
      const roundNum = roundCode ? roundCodeToNumber.get(roundCode) : undefined;
      if (roundFilter !== undefined && roundNum !== undefined && roundNum !== roundFilter) continue;

      const rawVotes = row.values[valIdx[VOTES_KEY]];
      const rawShare = row.values[valIdx[SHARE_KEY]];
      const votes    = parseFloat(rawVotes ?? '0');
      if (isNaN(votes)) continue;

      const vote_share     = rawShare !== undefined ? parseFloat(rawShare) : undefined;
      const candidateText  = candidateTexts.get(candidateCode) ?? candidateCode;
      const parsed         = parseCandidateValueText(candidateText);

      const record: ElectionRecord = {
        election_type: electionType,
        year,
        area_level: AREA_KEY ? inferAreaLevelFromCandidateCode(areaCode ?? 'SSS') : 'koko_suomi',
        area_id:    areaCode ?? 'SSS',
        area_name:  areaTexts.get(areaCode ?? 'SSS') ?? (areaCode ?? 'Koko maa'),
        candidate_id:   candidateCode,
        candidate_name: parsed.name,
        party_id:   parsed.party || undefined,
        party_name: parsed.party || undefined,
        votes,
        vote_share: vote_share !== undefined && !isNaN(vote_share) ? vote_share : undefined,
      };
      if (roundNum !== undefined) record.round = roundNum;
      records.push(record);
    }
  }

  return records;
}
