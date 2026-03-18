import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { pxwebClient } from '../../api/pxweb-client.js';
import { withCache } from '../../cache/cache.js';
import {
  getElectionTables,
  getDatabasePath,
} from '../../data/election-tables.js';
import type { ElectionType } from '../../data/types.js';
import {
  normalizeStr,
  buildBigrams,
  bigramSimilarity,
  scoreMatch,
  scoreMatchFast,
  confidenceLabel,
} from '../../utils/fuzzy-match.js';
import {
  type CandidateEntry,
  getCandidateListForUnit,
  getCandidatesFromNationalTable,
  getCandidatesAllUnits,
} from '../../data/candidate-index.js';

// ─── Party alias map ─────────────────────────────────────────────────────────
// Maps normalized query → canonical party abbreviation used as valueText in PxWeb.
// PxWeb valueTexts for parties are the Finnish abbreviations (KOK, SDP, etc.)
// The actual numeric value codes differ per metadata; tools accept the text label.

interface PartyAlias {
  abbreviation: string;
  canonical_name_fi: string;
}

const PARTY_ALIASES: Record<string, PartyAlias> = {
  // KOK
  'kok': { abbreviation: 'KOK', canonical_name_fi: 'Kansallinen Kokoomus' },
  'kokoomus': { abbreviation: 'KOK', canonical_name_fi: 'Kansallinen Kokoomus' },
  'kansallinen kokoomus': { abbreviation: 'KOK', canonical_name_fi: 'Kansallinen Kokoomus' },
  'national coalition party': { abbreviation: 'KOK', canonical_name_fi: 'Kansallinen Kokoomus' },
  'national coalition': { abbreviation: 'KOK', canonical_name_fi: 'Kansallinen Kokoomus' },
  'samlingspartiet': { abbreviation: 'KOK', canonical_name_fi: 'Kansallinen Kokoomus' },
  // SDP
  'sdp': { abbreviation: 'SDP', canonical_name_fi: 'Suomen Sosialidemokraattinen Puolue' },
  'sosialidemokraatit': { abbreviation: 'SDP', canonical_name_fi: 'Suomen Sosialidemokraattinen Puolue' },
  'sosiaalidemokraatit': { abbreviation: 'SDP', canonical_name_fi: 'Suomen Sosialidemokraattinen Puolue' },
  'suomen sosialidemokraattinen puolue': { abbreviation: 'SDP', canonical_name_fi: 'Suomen Sosialidemokraattinen Puolue' },
  'social democrats': { abbreviation: 'SDP', canonical_name_fi: 'Suomen Sosialidemokraattinen Puolue' },
  'social democratic party': { abbreviation: 'SDP', canonical_name_fi: 'Suomen Sosialidemokraattinen Puolue' },
  'socialdemokraterna': { abbreviation: 'SDP', canonical_name_fi: 'Suomen Sosialidemokraattinen Puolue' },
  // PS
  'ps': { abbreviation: 'PS', canonical_name_fi: 'Perussuomalaiset' },
  'perussuomalaiset': { abbreviation: 'PS', canonical_name_fi: 'Perussuomalaiset' },
  'finns party': { abbreviation: 'PS', canonical_name_fi: 'Perussuomalaiset' },
  'true finns': { abbreviation: 'PS', canonical_name_fi: 'Perussuomalaiset' },
  'sannfinlandarna': { abbreviation: 'PS', canonical_name_fi: 'Perussuomalaiset' },
  // KESK
  'kesk': { abbreviation: 'KESK', canonical_name_fi: 'Suomen Keskusta' },
  'keskusta': { abbreviation: 'KESK', canonical_name_fi: 'Suomen Keskusta' },
  'suomen keskusta': { abbreviation: 'KESK', canonical_name_fi: 'Suomen Keskusta' },
  'centre party': { abbreviation: 'KESK', canonical_name_fi: 'Suomen Keskusta' },
  'center party': { abbreviation: 'KESK', canonical_name_fi: 'Suomen Keskusta' },
  'centern': { abbreviation: 'KESK', canonical_name_fi: 'Suomen Keskusta' },
  // VIHR
  'vihr': { abbreviation: 'VIHR', canonical_name_fi: 'Vihreä liitto' },
  'vihrea': { abbreviation: 'VIHR', canonical_name_fi: 'Vihreä liitto' },
  'vihrea liitto': { abbreviation: 'VIHR', canonical_name_fi: 'Vihreä liitto' },
  'vihrea liitto - de grona': { abbreviation: 'VIHR', canonical_name_fi: 'Vihreä liitto' },
  'vihreät': { abbreviation: 'VIHR', canonical_name_fi: 'Vihreä liitto' },
  'vihreat': { abbreviation: 'VIHR', canonical_name_fi: 'Vihreä liitto' },
  'green league': { abbreviation: 'VIHR', canonical_name_fi: 'Vihreä liitto' },
  'greens': { abbreviation: 'VIHR', canonical_name_fi: 'Vihreä liitto' },
  'de grona': { abbreviation: 'VIHR', canonical_name_fi: 'Vihreä liitto' },
  // VAS
  'vas': { abbreviation: 'VAS', canonical_name_fi: 'Vasemmistoliitto' },
  'vasemmistoliitto': { abbreviation: 'VAS', canonical_name_fi: 'Vasemmistoliitto' },
  'left alliance': { abbreviation: 'VAS', canonical_name_fi: 'Vasemmistoliitto' },
  'left': { abbreviation: 'VAS', canonical_name_fi: 'Vasemmistoliitto' },
  'vansterförbundet': { abbreviation: 'VAS', canonical_name_fi: 'Vasemmistoliitto' },
  'vasternforbundet': { abbreviation: 'VAS', canonical_name_fi: 'Vasemmistoliitto' },
  // RKP / SFP
  'rkp': { abbreviation: 'RKP', canonical_name_fi: 'Suomen ruotsalainen kansanpuolue' },
  'sfp': { abbreviation: 'RKP', canonical_name_fi: 'Suomen ruotsalainen kansanpuolue' },
  'svenska folkpartiet': { abbreviation: 'RKP', canonical_name_fi: 'Suomen ruotsalainen kansanpuolue' },
  'suomen ruotsalainen kansanpuolue': { abbreviation: 'RKP', canonical_name_fi: 'Suomen ruotsalainen kansanpuolue' },
  'swedish peoples party': { abbreviation: 'RKP', canonical_name_fi: 'Suomen ruotsalainen kansanpuolue' },
  "swedish people's party": { abbreviation: 'RKP', canonical_name_fi: 'Suomen ruotsalainen kansanpuolue' },
  // KD
  'kd': { abbreviation: 'KD', canonical_name_fi: 'Kristillisdemokraatit' },
  'kristillisdemokraatit': { abbreviation: 'KD', canonical_name_fi: 'Kristillisdemokraatit' },
  'kristdemokraatit': { abbreviation: 'KD', canonical_name_fi: 'Kristillisdemokraatit' },
  'christian democrats': { abbreviation: 'KD', canonical_name_fi: 'Kristillisdemokraatit' },
  'kristdemokraterna': { abbreviation: 'KD', canonical_name_fi: 'Kristillisdemokraatit' },
  // LIIK
  'liik': { abbreviation: 'LIIK', canonical_name_fi: 'Liike Nyt' },
  'liike nyt': { abbreviation: 'LIIK', canonical_name_fi: 'Liike Nyt' },
  'movement now': { abbreviation: 'LIIK', canonical_name_fi: 'Liike Nyt' },
  // SKP
  'skp': { abbreviation: 'SKP', canonical_name_fi: 'Suomen Kommunistinen Puolue' },
  'suomen kommunistinen puolue': { abbreviation: 'SKP', canonical_name_fi: 'Suomen Kommunistinen Puolue' },
  'communist party': { abbreviation: 'SKP', canonical_name_fi: 'Suomen Kommunistinen Puolue' },
  // PS (old Suomen maaseudun puolue variant occasionally searched)
  'smp': { abbreviation: 'SMP', canonical_name_fi: 'Suomen maaseudun puolue' },
};

// ─── Shared metadata fetcher ─────────────────────────────────────────────────

async function fetchMetadataCached(database: string, tableId: string) {
  return withCache(`meta:${tableId}`, () =>
    pxwebClient.getTableMetadata(database, tableId)
  ).then((r) => r.value);
}

// ─── Swedish → Finnish municipality name map (most common) ───────────────────
// Area names in the 13sw metadata are "KU### <Finnish name>" — no Swedish form.
// This map allows resolving Swedish names to their Finnish equivalents.
const SWEDISH_TO_FINNISH_AREA: Record<string, string> = {
  'helsingfors': 'helsinki',
  'esbo': 'espoo',
  'vanda': 'vantaa',
  'abo': 'turku',
  'tammerfors': 'tampere',
  'uleaborg': 'oulu',
  'borgå': 'porvoo',
  'lovisa': 'loviisa',
  'ekenäs': 'tammisaari',
  'hangö': 'hanko',
  'raseborg': 'raasepori',
  'jakobstad': 'pietarsaari',
  'gamlakarleby': 'kokkola',
  'vasa': 'vaasa',
  'villmanstrand': 'lappeenranta',
  'imatra': 'imatra',
  'nyslott': 'savonlinna',
  'st. michel': 'mikkeli',
  'kuopio': 'kuopio',
  'joensuu': 'joensuu',
  'jyvaskyla': 'jyväskylä',
  'lahtis': 'lahti',
  'kouvola': 'kouvola',
  'kotka': 'kotka',
  'rovaniemi': 'rovaniemi',
  'uleåborg': 'oulu',
  'björneborg': 'pori',
  'tavastehus': 'hämeenlinna',
  'hameenlinna': 'hämeenlinna',
  'riihimäki': 'riihimäki',
  'lohja': 'lohja',
  'lojo': 'lohja',
  'hyvinge': 'hyvinkää',
  'kervo': 'kerava',
  'grankulla': 'kauniainen',
  'kyrkslätt': 'kirkkonummi',
  'sibbo': 'sipoo',
  'nurmijärvi': 'nurmijärvi',
  'tusby': 'tuusula',
  'mäntsälä': 'mäntsälä',
  'träskända': 'järvenpää',
};

// ─── Area list builder (from 13sw metadata) ──────────────────────────────────

interface AreaEntry {
  area_id: string;
  area_name: string;
  area_level: 'koko_suomi' | 'vaalipiiri' | 'kunta';
}

async function getAreaList(year = 2023): Promise<AreaEntry[]> {
  const tables = getElectionTables('parliamentary', year);
  if (!tables?.party_by_kunta) throw new Error(`No party table for parliamentary ${year}`);
  const dbPath = getDatabasePath(tables);
  const metadata = await fetchMetadataCached(dbPath, tables.party_by_kunta);
  const areaVar = metadata.variables.find((v) => v.code === 'Vaalipiiri ja kunta vaalivuonna');
  if (!areaVar) throw new Error('Area variable not found in 13sw metadata');

  return areaVar.values.map((code, i) => {
    let area_level: AreaEntry['area_level'];
    if (code === 'SSS') area_level = 'koko_suomi';
    else if (/^\d{6}$/.test(code) && code.endsWith('0000')) area_level = 'vaalipiiri';
    else area_level = 'kunta';
    return { area_id: code, area_name: areaVar.valueTexts[i] ?? code, area_level };
  });
}

// ─── Tool registration ────────────────────────────────────────────────────────
// Candidate list builders moved to src/data/candidate-index.ts (shared module)

export function registerEntityResolutionTools(server: McpServer): void {

  // ── resolve_party ─────────────────────────────────────────────────────────
  server.tool(
    'resolve_party',
    'Resolves a fuzzy party name or abbreviation to a canonical party_id usable in other tools. Handles Finnish names, Swedish names, abbreviations, and English equivalents. Falls back to live metadata search if no static match found.',
    {
      query: z.string().max(200).describe('Party name or abbreviation to resolve (e.g. "kokoomus", "KOK", "National Coalition Party", "SDP", "Perussuomalaiset", "True Finns").'),
      year: z.number().optional().describe('Election year for metadata fallback. Defaults to 2023.'),
    },
    async ({ query, year = 2023 }) => {
      const normalized = normalizeStr(query);

      // 1. Static alias map lookup (exact normalized match)
      const staticMatch = PARTY_ALIASES[normalized] ?? PARTY_ALIASES[query.toLowerCase().trim()];
      if (staticMatch) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              party_id: staticMatch.abbreviation,
              canonical_name: staticMatch.canonical_name_fi,
              abbreviation: staticMatch.abbreviation,
              match_confidence: 'exact' as const,
              possible_alternatives: [],
              source: 'static_alias_map',
            }),
          }],
        };
      }

      // 2. Fuzzy search against static alias keys
      const aliasKeys = Object.keys(PARTY_ALIASES);
      const fuzzyAliasMatches = aliasKeys
        .map((key) => ({ key, score: scoreMatch(normalized, normalizeStr(key)) }))
        .filter((m) => m.score >= 0.55)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);

      if (fuzzyAliasMatches.length > 0) {
        const best = fuzzyAliasMatches[0];
        const bestAlias = PARTY_ALIASES[best.key]!;
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              party_id: bestAlias.abbreviation,
              canonical_name: bestAlias.canonical_name_fi,
              abbreviation: bestAlias.abbreviation,
              match_confidence: confidenceLabel(best.score),
              possible_alternatives: fuzzyAliasMatches.slice(1).map((m) => ({
                party_id: PARTY_ALIASES[m.key]!.abbreviation,
                canonical_name: PARTY_ALIASES[m.key]!.canonical_name_fi,
                score: Math.round(m.score * 100) / 100,
              })),
              source: 'static_alias_map_fuzzy',
            }),
          }],
        };
      }

      // 3. Metadata fallback — fetch live party list from 13sw
      try {
        const tables = getElectionTables('parliamentary', year);
        if (tables?.party_by_kunta) {
          const dbPath = getDatabasePath(tables);
          const metadata = await fetchMetadataCached(dbPath, tables.party_by_kunta);
          const partyVar = metadata.variables.find((v) => v.code === 'Puolue');
          if (partyVar) {
            const metaMatches = partyVar.valueTexts
              .map((text, i) => ({
                party_id: partyVar.values[i]!,
                text,
                score: Math.max(
                  scoreMatch(normalized, normalizeStr(text)),
                  scoreMatch(query.toLowerCase(), text.toLowerCase())
                ),
              }))
              .filter((m) => m.score >= 0.45)
              .sort((a, b) => b.score - a.score)
              .slice(0, 5);

            if (metaMatches.length > 0) {
              const best = metaMatches[0]!;
              return {
                content: [{
                  type: 'text' as const,
                  text: JSON.stringify({
                    party_id: best.party_id,
                    canonical_name: best.text,
                    abbreviation: null,
                    match_confidence: confidenceLabel(best.score),
                    possible_alternatives: metaMatches.slice(1).map((m) => ({
                      party_id: m.party_id,
                      canonical_name: m.text,
                      score: Math.round(m.score * 100) / 100,
                    })),
                    source: 'metadata_fuzzy',
                    note: 'party_id here is the PxWeb numeric code, not abbreviation. Use canonical_name for display.',
                  }),
                }],
              };
            }
          }
        }
      } catch (err) {
        console.error('[resolve_candidate] metadata fetch failed:', err);
        // fall through to no-match response
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            error: `No party match found for query: "${query}"`,
            suggestion: 'Try a common Finnish party abbreviation: KOK, SDP, PS, KESK, VIHR, VAS, RKP, KD, LIIK.',
          }),
        }],
      };
    }
  );

  // ── resolve_area ──────────────────────────────────────────────────────────
  server.tool(
    'resolve_area',
    'Resolves a fuzzy municipality, vaalipiiri, or area name to a canonical area_id usable in other tools. Handles Finnish and Swedish name forms, spelling variations, and partial names. Returns the area_id in the format used by get_party_results, get_area_results, and related tools.',
    {
      query: z.string().max(200).describe('Area name to resolve (e.g. "Helsinki", "Helsingfors", "Hki", "Pirkanmaa vaalipiiri", "Tampere", "Uusimaa").'),
      area_level: z.enum(['kunta', 'vaalipiiri', 'koko_suomi']).optional().describe('Restrict results to a specific area level. Omit to search all levels.'),
      year: z.number().optional().describe('Election year for area metadata. Defaults to 2023.'),
    },
    async ({ query, area_level, year = 2023 }) => {
      let areas: AreaEntry[];
      try {
        areas = await getAreaList(year);
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: `Failed to load area list: ${String(err)}` }),
          }],
        };
      }

      // Resolve Swedish names to Finnish equivalents
      const queryLow = query.toLowerCase().trim();
      const queryFi = SWEDISH_TO_FINNISH_AREA[queryLow] ?? queryLow;

      // Filter by level if specified
      const candidates = area_level ? areas.filter((a) => a.area_level === area_level) : areas;

      // Area names in metadata are "KU### Helsinki" or "VP## Pirkanmaan vaalipiiri" —
      // strip the code prefix for more accurate matching.
      const scored = candidates
        .map((area) => {
          // Strip "KU###" or "VP##" code prefix from name
          const namePlain = area.area_name.replace(/^(KU\d+|VP\d+)\s+/i, '').trim();
          return {
            ...area,
            score: Math.max(
              scoreMatch(queryFi, normalizeStr(namePlain)),
              scoreMatch(queryLow, normalizeStr(namePlain)),
              scoreMatch(queryFi, normalizeStr(area.area_name)),
            ),
          };
        })
        .filter((a) => a.score >= 0.45)
        .sort((a, b) => b.score - a.score)
        .slice(0, 8);

      if (scored.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: `No area match found for query: "${query}"`,
              suggestion: 'Try the official Finnish or Swedish municipality name, or a vaalipiiri name (e.g. "Helsingin vaalipiiri").',
            }),
          }],
        };
      }

      const best = scored[0]!;
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            area_id: best.area_id,
            area_name: best.area_name,
            area_level: best.area_level,
            match_confidence: confidenceLabel(best.score),
            possible_alternatives: scored.slice(1).map((a) => ({
              area_id: a.area_id,
              area_name: a.area_name,
              area_level: a.area_level,
              score: Math.round(a.score * 100) / 100,
            })),
            note: 'area_id is in the 6-digit format (e.g. 010091 for Helsinki kunta). For get_candidate_results, use the vaalipiiri key (e.g. "helsinki") instead.',
          }),
        }],
      };
    }
  );

  // ── resolve_candidate ─────────────────────────────────────────────────────
  server.tool(
    'resolve_candidate',
    'Resolves a fuzzy candidate name to a canonical candidate_id for any Finnish election type. For EU parliament and presidential, all candidates are in a single national table — no unit_key needed. For parliamentary, municipal, and regional elections, providing unit_key (vaalipiiri or hyvinvointialue) speeds up the search; omitting it fans out to all ~13–21 tables in parallel (~15s).',
    {
      query: z.string().max(200).describe('Candidate name to search for (full or partial, surname-first or firstname-first). Examples: "Heinäluoma", "Eveliina Heinäluoma", "Heinaluoma Eveliina", "Atte Harjanne".'),
      election_type: z.enum(['parliamentary', 'municipal', 'eu_parliament', 'presidential', 'regional']).describe('Election type. Determines which candidate tables to search.'),
      year: z.number().describe('Election year (e.g. 2023, 2024, 2025).'),
      unit_key: z.string().optional().describe('For parliamentary/municipal: vaalipiiri key (e.g. "helsinki", "pirkanmaa"). For regional: hyvinvointialue key (e.g. "pirkanmaa", "varsinais-suomi"). Ignored for EU parliament and presidential — those use a single national table.'),
      party: z.string().optional().describe('Party abbreviation to narrow results (e.g. "SDP", "KOK", "VIHR"). Case-insensitive, optional.'),
    },
    async ({ query, election_type, year, unit_key, party }) => {
      const electionType: ElectionType = election_type;
      let candidates: CandidateEntry[];
      try {
        const isNationalOnly = electionType === 'eu_parliament' || electionType === 'presidential';
        if (isNationalOnly) {
          candidates = await getCandidatesFromNationalTable(year, electionType);
        } else if (unit_key) {
          candidates = await getCandidateListForUnit(year, unit_key, electionType);
        } else {
          candidates = await getCandidatesAllUnits(year, electionType);
        }
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: `Failed to load candidate list: ${String(err)}` }),
          }],
        };
      }

      // Optionally filter by party
      const partyNorm = party ? party.toLowerCase().trim() : null;
      const filtered = partyNorm
        ? candidates.filter((c) => c.party.toLowerCase().includes(partyNorm))
        : candidates;

      // Score: try both "Lastname Firstname" and "Firstname Lastname" orderings
      const queryNorm = normalizeStr(query);
      const queryLow = query.toLowerCase().trim();
      const queryBigrams = buildBigrams(queryNorm);
      const queryParts = queryNorm.split(' ');
      const queryReversed = queryParts.length >= 2
        ? queryParts.slice(1).join(' ') + ' ' + queryParts[0]
        : queryNorm;
      const queryReversedLow = queryReversed.toLowerCase().trim();
      const queryReversedBigrams = buildBigrams(queryReversed);

      const scored = filtered
        .map((c) => {
          const nameNorm = normalizeStr(c.candidate_name);
          const nameLow = c.candidate_name.toLowerCase().trim();
          const s = Math.max(
            scoreMatchFast(queryLow, queryNorm, queryBigrams, nameLow, nameNorm),
            scoreMatchFast(queryReversedLow, queryReversed, queryReversedBigrams, nameLow, nameNorm),
            // Also score against just the last name (first token in "Lastname Firstname" format)
            scoreMatch(queryNorm, nameNorm.split(' ')[0] ?? ''),
          );
          return { ...c, score: s };
        })
        .filter((c) => c.score >= 0.45)
        .sort((a, b) => b.score - a.score)
        .slice(0, 8);

      if (scored.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: `No candidate match found for query: "${query}" in ${electionType} ${year}`,
              suggestion: `Try using the official name format (surname first). ${unit_key ? '' : 'Try specifying a unit_key to narrow the search.'}`,
            }),
          }],
        };
      }

      const best = scored[0]!;
      const isNational = best.vaalipiiri_key === 'national';
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            candidate_id: best.candidate_id,
            candidate_name: best.candidate_name,
            party: best.party,
            unit: isNational ? 'national' : best.vaalipiiri_name,
            unit_key: isNational ? undefined : best.vaalipiiri_key,
            election_type: electionType,
            year,
            match_confidence: confidenceLabel(best.score),
            possible_alternatives: scored.slice(1).map((c) => ({
              candidate_id: c.candidate_id,
              candidate_name: c.candidate_name,
              party: c.party,
              unit: c.vaalipiiri_key === 'national' ? undefined : c.vaalipiiri_name,
              score: Math.round(c.score * 100) / 100,
            })),
            usage_note: 'Use candidate_id in get_candidate_results. For parliamentary/municipal/regional, use unit_key as the vaalipiiri parameter.',
          }),
        }],
      };
    }
  );

  // ── resolve_entities ──────────────────────────────────────────────────────
  server.tool(
    'resolve_entities',
    'Batch resolver for a mixed list of candidates, parties, and areas. Each entity specifies its type and query. Resolves all in sequence and returns a combined result. Efficient when you need to resolve multiple entities from a single user query before fetching data.',
    {
      entities: z.array(z.object({
        entity_type: z.enum(['candidate', 'party', 'area']).describe('Type of entity to resolve.'),
        query: z.string().max(200).describe('Name or label to resolve.'),
        year: z.number().optional().describe('Election year context. Defaults to 2023.'),
        election_type: z.enum(['parliamentary', 'municipal', 'eu_parliament', 'presidential', 'regional']).optional().describe('For candidates: election type. Defaults to parliamentary.'),
        unit_key: z.string().optional().describe('For candidates: vaalipiiri or hyvinvointialue key to limit search scope.'),
        party: z.string().optional().describe('For candidates: party abbreviation to narrow results.'),
        area_level: z.enum(['kunta', 'vaalipiiri', 'koko_suomi']).optional().describe('For areas: restrict to area level.'),
      })).describe('List of entities to resolve. Maximum 20 per call.'),
    },
    async ({ entities }) => {
      if (entities.length > 20) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: 'Maximum 20 entities per call.' }),
          }],
        };
      }

      const results = await Promise.all(entities.map(async (entity) => {
        const year = entity.year ?? 2023;

        if (entity.entity_type === 'party') {
          const normalized = normalizeStr(entity.query);
          const staticMatch = PARTY_ALIASES[normalized] ?? PARTY_ALIASES[entity.query.toLowerCase().trim()];
          if (staticMatch) {
            return {
              input: entity.query,
              entity_type: 'party',
              party_id: staticMatch.abbreviation,
              canonical_name: staticMatch.canonical_name_fi,
              match_confidence: 'exact' as const,
              possible_alternatives: [],
            };
          }
          // Fuzzy against alias keys
          const best = Object.keys(PARTY_ALIASES)
            .map((k) => ({ k, score: scoreMatch(normalized, normalizeStr(k)) }))
            .filter((m) => m.score >= 0.55)
            .sort((a, b) => b.score - a.score)[0];
          if (best) {
            const alias = PARTY_ALIASES[best.k]!;
            return {
              input: entity.query,
              entity_type: 'party',
              party_id: alias.abbreviation,
              canonical_name: alias.canonical_name_fi,
              match_confidence: confidenceLabel(best.score),
              possible_alternatives: [],
            };
          }
          return { input: entity.query, entity_type: 'party', error: 'No match found' };

        } else if (entity.entity_type === 'area') {
          try {
            const areas = await getAreaList(year);
            const candidates = entity.area_level ? areas.filter((a) => a.area_level === entity.area_level) : areas;
            const eqLow = entity.query.toLowerCase().trim();
            const eqFi = SWEDISH_TO_FINNISH_AREA[eqLow] ?? eqLow;
            const best = candidates
              .map((a) => {
                const namePlain = a.area_name.replace(/^(KU\d+|VP\d+)\s+/i, '').trim();
                return {
                  ...a,
                  score: Math.max(
                    scoreMatch(eqFi, normalizeStr(namePlain)),
                    scoreMatch(eqLow, normalizeStr(namePlain)),
                    scoreMatch(eqFi, normalizeStr(a.area_name)),
                  ),
                };
              })
              .filter((a) => a.score >= 0.45)
              .sort((a, b) => b.score - a.score)[0];
            if (best) {
              return {
                input: entity.query,
                entity_type: 'area',
                area_id: best.area_id,
                area_name: best.area_name,
                area_level: best.area_level,
                match_confidence: confidenceLabel(best.score),
              };
            }
            return { input: entity.query, entity_type: 'area', error: 'No match found' };
          } catch (err) {
            return { input: entity.query, entity_type: 'area', error: String(err) };
          }

        } else if (entity.entity_type === 'candidate') {
          try {
            const eType: ElectionType = (entity.election_type as ElectionType | undefined) ?? 'parliamentary';
            const isNationalOnly = eType === 'eu_parliament' || eType === 'presidential';
            let cands: CandidateEntry[];
            if (isNationalOnly) {
              cands = await getCandidatesFromNationalTable(year, eType);
            } else if (entity.unit_key) {
              cands = await getCandidateListForUnit(year, entity.unit_key, eType);
            } else {
              cands = await getCandidatesAllUnits(year, eType);
            }
            const partyNorm = entity.party ? entity.party.toLowerCase().trim() : null;
            const filtered = partyNorm ? cands.filter((c) => c.party.toLowerCase().includes(partyNorm)) : cands;
            const qNorm = normalizeStr(entity.query);
            const qLow = entity.query.toLowerCase().trim();
            const qBigrams = buildBigrams(qNorm);
            const qParts = qNorm.split(' ');
            const qRev = qParts.length >= 2 ? qParts.slice(1).join(' ') + ' ' + qParts[0] : qNorm;
            const qRevLow = qRev.toLowerCase().trim();
            const qRevBigrams = buildBigrams(qRev);
            const best = filtered
              .map((c) => {
                const cNorm = normalizeStr(c.candidate_name);
                const cLow = c.candidate_name.toLowerCase().trim();
                return {
                  ...c,
                  score: Math.max(
                    scoreMatchFast(qLow, qNorm, qBigrams, cLow, cNorm),
                    scoreMatchFast(qRevLow, qRev, qRevBigrams, cLow, cNorm),
                    scoreMatch(qNorm, cNorm.split(' ')[0] ?? ''),
                  ),
                };
              })
              .filter((c) => c.score >= 0.45)
              .sort((a, b) => b.score - a.score)[0];
            if (best) {
              return {
                input: entity.query,
                entity_type: 'candidate',
                candidate_id: best.candidate_id,
                candidate_name: best.candidate_name,
                party: best.party,
                unit: best.vaalipiiri_key === 'national' ? undefined : best.vaalipiiri_name,
                unit_key: best.vaalipiiri_key === 'national' ? undefined : best.vaalipiiri_key,
                match_confidence: confidenceLabel(best.score),
              };
            }
            return { input: entity.query, entity_type: 'candidate', error: 'No match found' };
          } catch (err) {
            return { input: entity.query, entity_type: 'candidate', error: String(err) };
          }
        }
        return { input: entity.query, error: 'Unknown entity_type' };
      }));

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ resolved: results, count: results.length }),
        }],
      };
    }
  );
}
