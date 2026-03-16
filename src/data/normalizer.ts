import type { PxWebResponse, PxWebColumn, PxWebTableMetadata } from '../api/types.js';
import type { ElectionRecord, ElectionType, AreaLevel } from './types.js';

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
 * Infer area level from the code format used in evaa candidate tables:
 *   VP##        → vaalipiiri   (both 2023 active and 2019 archive)
 *   KU###       → kunta        (2023 active tables)
 *   ###         → kunta        (2019 archive tables — 3-digit numeric, e.g. "091")
 *   ##{kunta}{area} → aanestysalue
 */
export function inferAreaLevelFromCandidateCode(code: string): AreaLevel {
  if (code.startsWith('VP')) return 'vaalipiiri';
  if (code.startsWith('KU')) return 'kunta';
  if (/^\d{3}$/.test(code)) return 'kunta';
  return 'aanestysalue';
}

/**
 * Infer area level from codes in the 13sw party-by-kunta table.
 * The area variable is 'Vaalipiiri ja kunta vaalivuonna'. Format:
 *   SSS         → koko_suomi (national total)
 *   ##0000      → vaalipiiri (e.g. 010000 = VP01 Helsinki)
 *   #####       → kunta (e.g. 010091 = KU091 Helsinki, format: vp(2) + kunta(3))
 */
export function inferAreaLevelFromPartyCode(code: string): AreaLevel {
  if (code === 'SSS') return 'koko_suomi';
  if (/^\d{6}$/.test(code) && code.endsWith('0000')) return 'vaalipiiri';
  if (/^\d{6}$/.test(code)) return 'kunta';
  return 'kunta';
}

/**
 * Parse a candidate name string from valueText:
 * Format: "Harakka Timo / SDP / Helsingin vaalipiiri"
 */
export function parseCandidateValueText(valueText: string): {
  name: string;
  party: string;
  vaalipiiri: string;
} {
  const parts = valueText.split(' / ');
  return {
    name: parts[0]?.trim() ?? valueText,
    party: parts[1]?.trim() ?? '',
    vaalipiiri: parts[2]?.trim() ?? '',
  };
}

// ─── Table: statfin_evaa_pxt_13sw (party votes by kunta, 1983–2023) ───────────
// Variable codes: Vuosi (t), Sukupuoli (d), Puolue (d), Vaalipiiri ja kunta vaalivuonna (d), Tiedot (d→measures)
// Tiedot values: evaa_aanet, evaa_osuus_aanista, evaa_aanet_medv_lkm, evaa_aanet_medv_pros, ...

export function normalizePartyByKunta(
  response: PxWebResponse,
  metadata: PxWebTableMetadata,
  year: number
): ElectionRecord[] {
  const keyIdx = buildKeyIndex(response.columns);
  const valIdx = buildValueIndex(response.columns);

  const areaTexts = buildValueTextMap(metadata, 'Vaalipiiri ja kunta vaalivuonna');
  const partyTexts = buildValueTextMap(metadata, 'Puolue');

  const AREA_KEY = 'Vaalipiiri ja kunta vaalivuonna';
  const PARTY_KEY = 'Puolue';
  const VOTES_KEY = 'evaa_aanet';
  const SHARE_KEY = 'evaa_osuus_aanista';

  const records: ElectionRecord[] = [];

  for (const row of response.data) {
    const areaCode = row.key[keyIdx[AREA_KEY]];
    const partyCode = row.key[keyIdx[PARTY_KEY]];
    const rawVotes = row.values[valIdx[VOTES_KEY]];
    const rawShare = row.values[valIdx[SHARE_KEY]];

    if (areaCode === undefined || partyCode === undefined) continue;

    const votes = parseFloat(rawVotes ?? '0');
    if (isNaN(votes)) continue;

    const vote_share = rawShare !== undefined ? parseFloat(rawShare) : undefined;

    records.push({
      election_type: 'parliamentary',
      year,
      area_level: inferAreaLevelFromPartyCode(areaCode),
      area_id: areaCode,
      area_name: areaTexts.get(areaCode) ?? areaCode,
      party_id: partyCode,
      party_name: partyTexts.get(partyCode) ?? partyCode,
      votes,
      vote_share: vote_share !== undefined && !isNaN(vote_share) ? vote_share : undefined,
    });
  }

  return records;
}

// ─── Table: statfin_evaa_pxt_13t6–13ti (2023) and archive equivalents (2019) ──
// 2023 variable codes: Vuosi (t), Alue/Äänestysalue (d), Ehdokas (d), Valintatieto (d), Tiedot (d→measures)
//   Tiedot values: evaa_aanet, evaa_osuus_aanista, evaa_enn_aanet, vluku
//   Area code format: VP## (vaalipiiri), KU### (kunta), ##kunta###letter (äänestysalue)
// 2019 archive variable codes: Äänestysalue (d), Ehdokas (d), Äänestystiedot (d→measures)
//   Äänestystiedot values: Sar1 (votes), Sar2 (share), Sar3 (advance votes), ...
//   Area code format: VP## (vaalipiiri), ### (kunta, 3-digit), ##kunta###letter (äänestysalue)

export function normalizeCandidateByAanestysalue(
  response: PxWebResponse,
  metadata: PxWebTableMetadata,
  year: number
): ElectionRecord[] {
  const keyIdx = buildKeyIndex(response.columns);
  const valIdx = buildValueIndex(response.columns);

  // Detect area variable — 2023 active uses 'Alue/Äänestysalue', 2019 archive uses 'Äänestysalue'
  const AREA_KEY = metadata.variables.some((v) => v.code === 'Alue/Äänestysalue')
    ? 'Alue/Äänestysalue'
    : 'Äänestysalue';

  // Detect measure codes — 2023: evaa_aanet / evaa_osuus_aanista; 2019: Sar1 / Sar2
  const tiedotVar = metadata.variables.find((v) => v.code === 'Tiedot' || v.code === 'Äänestystiedot');
  const VOTES_KEY = tiedotVar?.values.find(
    (_, i) => (tiedotVar.valueTexts[i] ?? '').includes('Äänimäärä')
  ) ?? 'evaa_aanet';
  const SHARE_KEY = tiedotVar?.values.find(
    (_, i) => (tiedotVar.valueTexts[i] ?? '').toLowerCase().includes('osuus')
  ) ?? 'evaa_osuus_aanista';

  const areaTexts = buildValueTextMap(metadata, AREA_KEY);
  const candidateTexts = buildValueTextMap(metadata, 'Ehdokas');

  const CANDIDATE_KEY = 'Ehdokas';

  const records: ElectionRecord[] = [];

  // Detect whether tiedot variable is a dimension key (2019 archive) or content column (2023 active).
  // In 2019 archive tables, Äänestystiedot is type 'd' and appears in key[]; values[] has exactly 1 element.
  // In 2023 active tables, Tiedot is a content variable and its values become separate values[] columns.
  const tiedotIsKey = Object.prototype.hasOwnProperty.call(keyIdx, VOTES_KEY)
    || (tiedotVar !== undefined && !Object.prototype.hasOwnProperty.call(valIdx, VOTES_KEY));

  if (tiedotIsKey) {
    // ── 2019 archive format ──
    // Äänestystiedot is a dimension: measure code (Sar1/Sar2) is in key[], values[] has 1 element.
    // Two rows per (candidate, area): one for votes (Sar1), one for share (Sar2).
    // We detect the tiedot key index by finding the column in keyIdx that matches our tiedot var code.
    const TIEDOT_KEY = tiedotVar?.code ?? 'Äänestystiedot';
    const tiedotIdx = keyIdx[TIEDOT_KEY];
    const votesByKey = new Map<string, number>();
    const sharesByKey = new Map<string, number>();

    for (const row of response.data) {
      const areaCode = row.key[keyIdx[AREA_KEY]];
      const candidateCode = row.key[keyIdx[CANDIDATE_KEY]];
      const tiedotCode = tiedotIdx !== undefined ? row.key[tiedotIdx] : undefined;
      if (areaCode === undefined || candidateCode === undefined) continue;
      const val = parseFloat(row.values[0] ?? '0');
      if (isNaN(val)) continue;
      const mapKey = `${candidateCode}::${areaCode}`;
      if (tiedotCode === VOTES_KEY) votesByKey.set(mapKey, val);
      else if (tiedotCode === SHARE_KEY) sharesByKey.set(mapKey, val);
    }

    for (const [mapKey, votes] of votesByKey) {
      const sepIdx = mapKey.indexOf('::');
      const candidateCode = mapKey.slice(0, sepIdx);
      const areaCode = mapKey.slice(sepIdx + 2);
      const candidateText = candidateTexts.get(candidateCode) ?? candidateCode;
      const parsed = parseCandidateValueText(candidateText);
      records.push({
        election_type: 'parliamentary',
        year,
        area_level: inferAreaLevelFromCandidateCode(areaCode),
        area_id: areaCode,
        area_name: areaTexts.get(areaCode) ?? areaCode,
        candidate_id: candidateCode,
        candidate_name: parsed.name,
        party_id: parsed.party,
        party_name: parsed.party,
        votes,
        vote_share: sharesByKey.get(mapKey),
      });
    }
  } else {
    // ── 2023 active format ──
    // Tiedot is a content variable: evaa_aanet and evaa_osuus_aanista appear as separate values[] columns.
    for (const row of response.data) {
      const areaCode = row.key[keyIdx[AREA_KEY]];
      const candidateCode = row.key[keyIdx[CANDIDATE_KEY]];
      const rawVotes = row.values[valIdx[VOTES_KEY]];
      const rawShare = row.values[valIdx[SHARE_KEY]];

      if (areaCode === undefined || candidateCode === undefined) continue;

      const votes = parseFloat(rawVotes ?? '0');
      if (isNaN(votes)) continue;

      const vote_share = rawShare !== undefined ? parseFloat(rawShare) : undefined;
      const candidateText = candidateTexts.get(candidateCode) ?? candidateCode;
      const parsed = parseCandidateValueText(candidateText);

      records.push({
        election_type: 'parliamentary',
        year,
        area_level: inferAreaLevelFromCandidateCode(areaCode),
        area_id: areaCode,
        area_name: areaTexts.get(areaCode) ?? areaCode,
        candidate_id: candidateCode,
        candidate_name: parsed.name,
        party_id: parsed.party,
        party_name: parsed.party,
        votes,
        vote_share: vote_share !== undefined && !isNaN(vote_share) ? vote_share : undefined,
      });
    }
  }

  return records;
}
