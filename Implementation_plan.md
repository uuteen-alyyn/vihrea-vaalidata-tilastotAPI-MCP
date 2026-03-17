# Implementation Plan — FI Election Data MCP

## API Architecture Notes (from research 2026-03-16)

Key findings that affect implementation — see `docs/api-notes.md` for full details.

**Candidate data is split per vaalipiiri.** For parliamentary elections, there is no single national table with äänestysalue-level candidate breakdown. It is 13 separate tables (one per vaalipiiri). A national candidate query requires fetching all 13 and merging. This costs 13 API requests.

**Rate limit is 10 req / 10-second window.** The `PxWebClient` throttles requests automatically. National candidate queries will take ~13+ seconds. This must be communicated to callers.

**No "list elections" API endpoint exists.** `list_elections` must be backed by the static table registry in `src/data/election-tables.ts`. This file must be maintained manually when new elections are published.

**Older elections may be in `StatFin_Passiivi`** (archive database). Whether candidate-level tables exist for pre-2023 parliamentary elections needs verification.

**`statfin_evaa_pxt_13sw`** (party by kunta, 1983–2023) is the most powerful single table — covers all parliamentary elections in one query.

**`statfin_evaa_pxt_13t3`** has no area variable — it is a national/candidate-level summary only, with no geographic breakdown. Per-vaalipiiri tables (13t6–13ti) are needed for äänestysalue-level data.

**Table IDs require `.px` extension** in both GET (metadata) and POST (data) requests. The discovery API returns IDs without `.px`; the client appends it automatically.

**Area codes in 13sw**: 6-digit format `{vp:02}{kunta:03}` — e.g. `010091` = Helsinki (VP01 + KU091), `010000` = VP01 vaalipiiri total, `SSS` = national total.

**Area codes in candidate tables (13t6–13ti)**: `VP##` = vaalipiiri, `KU###` = kunta, alphanumeric = äänestysalue.

---

## Phase 1: Project Setup ✅ COMPLETE

**Goal:** Establish a working TypeScript/Node.js project with MCP SDK scaffolding.

### Tasks
- [x] Initialize npm project (`package.json`)
- [x] Configure TypeScript (`tsconfig.json`)
- [x] Install MCP SDK (`@modelcontextprotocol/sdk`) — sdk v1.27.1, 99 packages, 0 vulnerabilities
- [x] Create entry point (`src/index.ts`) that starts the MCP server
- [x] Create `src/server.ts` with tool registration scaffold
- [x] Add build and dev scripts
- [x] Add `.gitignore`
- [x] Create stub `index.ts` files for all 7 tool categories

### Tests
- [x] `npm run build` succeeds with no errors
- [ ] MCP server starts and connects without crashing (not yet tested end-to-end with a client)

---

## Phase 2: Tilastokeskus API Client ✅ COMPLETE

**Goal:** Implement a reliable client for the Statistics Finland PxWeb API that fetches and normalizes raw election data.

### Tasks
- [x] Research and document the PxWeb API (`docs/api-notes.md`)
- [x] Implement `PxWebClient` (`src/api/pxweb-client.ts`) with rate-limit throttling and auto `.px` extension
- [x] Define raw API types (`src/api/types.ts`)
- [x] Define canonical schema types (`src/data/types.ts`)
- [x] Implement normalizers (`src/data/normalizer.ts`):
  - [x] `normalizePartyByKunta()` for table 13sw
  - [x] `normalizeCandidateByAanestysalue()` for tables 13t6–13ti
- [x] Add in-memory TTL cache (`src/cache/cache.ts`)
- [x] Create election table registry (`src/data/election-tables.ts`) with 2023 parliamentary tables
- [x] GET metadata for key tables and confirm variable codes:
  - [x] `statfin_evaa_pxt_13sw` — variables: Vuosi, Sukupuoli, Puolue, Vaalipiiri ja kunta vaalivuonna, Tiedot
  - [x] `statfin_evaa_pxt_13t3` — no area variable; national candidate summary only
  - [x] `statfin_evaa_pxt_13t6` — variables: Vuosi, Alue/Äänestysalue, Ehdokas, Valintatieto, Tiedot
  - [x] `statfin_evaa_pxt_13sx` — variables: Vuosi, Sukupuoli, Alue, Tiedot
- [x] End-to-end test: fetch + normalize real datasets (verified with live API)
- [ ] Investigate `StatFin_Passiivi` for 2019 and older parliamentary candidate tables
- [ ] Extend table registry with 2019 and older elections

### Tests
- [x] Client successfully fetches metadata for `statfin_evaa_pxt_13sw`
- [x] POST query returns correct vote count — KOK Helsinki 2023: 102,592 votes (26.4%), matches official results
- [x] Normalized rows match canonical schema (all required fields present)
- [x] Rate throttle: 15 sequential requests complete without HTTP 429 (10.6s, no errors)
- [x] Caching works: second identical request returns in 0ms (cache_hit=true)

---

## Phase 3: Discovery Layer Tools ✅ COMPLETE

**Goal:** LLMs can discover what elections and geographic areas are available.

**Note:** `list_elections` reads from the static table registry — it does NOT call the API.

### Tools
- [x] `list_elections` — derives list from `election-tables.ts` registry
- [x] `describe_election` — metadata with caveats for the split-table candidate architecture
- [x] `list_area_levels` — returns the four supported geographic levels
- [x] `get_area_hierarchy` — parent-child relationships between area levels

### Tests
- [x] `list_elections` returns parliamentary 2023 and municipal 2025
- [x] `describe_election` 2023: candidate_data=true, 13 vaalipiirit listed
- [x] `get_area_hierarchy` correctly chains äänestysalue→kunta→vaalipiiri→koko_suomi

---

## Phase 4: Entity Resolution Tools ✅ COMPLETE

**Goal:** LLMs can resolve fuzzy candidate, party, and area names to canonical identifiers.

**Implementation notes:**
- Fuzzy matching: bigram similarity (Dice coefficient) on normalized strings + substring scoring + reversed-name scoring for candidates
- Party resolution: static alias map covering Finnish/Swedish/English names → abbreviation; metadata fallback for unknown parties
- Area resolution: 13sw metadata cached; strips "KU###"/"VP##" prefix from area names before scoring; Swedish→Finnish name map for common municipalities (e.g. Helsingfors→Helsinki, Esbo→Espoo)
- Candidate resolution: fetches `Ehdokas` variable from per-vaalipiiri table metadata; accepts name in any word order; vaalipiiri param required for fast single-table lookup or omit for all-13 scan

### Tools
- [x] `resolve_candidate` — returns `candidate_id`, `canonical_name`, `match_confidence`, `possible_alternatives`
- [x] `resolve_party` — resolves party names and abbreviations (e.g. "kokoomus", "KOK", "National Coalition Party")
- [x] `resolve_area` — handles municipality names, spelling variations, Finnish/Swedish forms
- [x] `resolve_entities` — batch resolver for mixed inputs

### Tests
- [x] `resolve_candidate` "Heinäluoma" → Heinäluoma Eveliina (SDP), id 01010176 ✓
- [x] `resolve_candidate` "Eveliina Heinäluoma" (reversed order) → same result ✓
- [x] `resolve_area` "Helsingfors" (Swedish) → area_id 010091 KU091 Helsinki ✓
- [x] `resolve_area` "Espoo" and "Esbo" → same area_id 020049 ✓
- [x] `resolve_party` "kokoomus", "KOK", "National Coalition Party" → party_id KOK ✓
- [x] `resolve_party` "True Finns", "Perussuomalaiset" → party_id PS ✓
- [x] `resolve_entities` batch: SDP, Green League, Espoo, Esbo, Valtonen Elina — all resolved correctly ✓

---

## Phase 5: Canonical Retrieval Tools ✅ COMPLETE

**Goal:** LLMs can retrieve structured, normalized election data for candidates, parties, and areas.

### Tools
- [x] `get_candidate_results` — queries per-vaalipiiri candidate tables with äänestysalue breakdown
- [x] `get_party_results` — queries 13sw for all parliamentary elections 1983–2023
- [x] `get_turnout` — queries 13sx turnout table
- [x] `get_area_results` — all parties in a geographic area; optional candidate data
- [x] `get_election_results` — full party dataset for an election, filterable by area_level
- [x] `get_rankings` — ranked parties or candidates within a scope
- [x] `get_top_n` — top-N convenience wrapper over get_rankings

### Tests
- [x] `get_party_results` KOK Helsinki 2023: 102,592 votes (26.4%) ✓
- [x] `get_candidate_results` Heinäluoma Eveliina Helsinki kunta: 15,837 votes ✓
- [x] `get_area_results` Helsinki kunta: 22 parties ✓
- [x] `get_election_results` KOK national 2023: 644,555 votes (20.8%) ✓
- [x] `get_rankings` top 5 parties: KOK, PS, SDP, KESK, VAS ✓
- [x] `get_top_n` top 3 Helsinki candidates: Valtonen Elina (32,562), Halla-aho Jussi (22,081), Heinäluoma Eveliina (15,837) ✓

---

## Phase 6: Deterministic Analytical Tools ✅ COMPLETE

**Goal:** MCP computes reusable political science metrics so LLMs don't have to reconstruct them.

**Implementation notes:**
- Created `src/data/loaders.ts` as a shared data-access layer used by both analytics and retrieval tools
- `loadPartyResults` falls back to any entry with `party_by_kunta` when querying older years — the 13sw table covers 1983–2023 in one table, so older year queries use the 2023 registry entry
- Party rows in normalized data use PxWeb numeric codes as `party_id` (not "KOK"); `matchesParty()` helper handles both code and name/abbreviation matching
- Concentration metric: top-N share method (fraction of votes held by top 1/3/5/10 areas) — simpler and more interpretable than HHI for election analytics
- Overperformance baseline: party = national vote share; candidate = vaalipiiri-level vote share
- All geographic analysis uses äänestysalue rows only (not vaalipiiri/kunta aggregates) to avoid double-counting

### Tools
- [x] `analyze_candidate_profile` — total votes, vote share, overall rank, rank within party, share of party vote, strongest/weakest areas, geographic concentration
- [x] `analyze_party_profile` — vote totals, vote share, strongest areas, geographic spread
- [x] `compare_candidates` — side-by-side vote results and area comparisons
- [x] `compare_parties` — side-by-side party comparison
- [x] `compare_elections` — party across elections: vote change, share change, rank change
- [x] `find_area_overperformance` — areas where candidate/party performs above baseline
- [x] `find_area_underperformance` — inverse of overperformance
- [x] `analyze_geographic_concentration` — top-N share concentration index
- [x] `analyze_within_party_position` — rank within party, share of party vote, distance to adjacent candidates
- [x] `analyze_vote_distribution` — distribution stats (mean, median, std dev, min, max, histogram)

### Tests
- [x] `analyze_candidate_profile` Heinäluoma: 15,837 votes, rank 3 overall, rank 1 in SDP, share_of_party_vote=0.19 ✓
- [x] `compare_elections` KOK 2015→2019→2023: −16,255 / +120,598 votes, rank improved +2 in 2023 ✓
- [x] `find_area_overperformance` Heinäluoma: baseline 4.1%, top area +7.9pp (Mellunmäki A) ✓
- [x] `find_area_underperformance` KOK: baseline 20.8%, underperforming areas documented ✓
- [x] `analyze_geographic_concentration` KOK: top10_share=0.518 (10 municipalities hold 52% of votes) ✓
- [x] `compare_candidates` Valtonen (32,562) > Halla-aho (22,081) > Heinäluoma (15,837) — consistent with get_top_n ✓

---

## Phase 7: Strategic Opportunity Tools ✅ COMPLETE

**Goal:** Enable targeted campaign analytics — identifying exposed vote pools and high-opportunity areas.

**Implementation notes:**
- `detect_inactive_high_vote_candidates`: Requires both from_year and to_year in registry. Currently fails for 2019 (gracefully) since only 2023 candidate tables are registered. Will work once 2019 tables are added in Phase 2.
- `find_exposed_vote_pools`: Uses 13sw party data (1983–2023). `n_exposed_areas` in output reflects the sliced count (up to `limit`), not total count — documented limitation.
- `estimate_vote_transfer_proxy`: Works well with 13sw party data. 87% co-movement rate for KESK→PS 2019→2023 is a structurally plausible result (both parties shifted ~2.5pp nationally).
- `rank_target_areas`: 4-component scoring (current support, trend, size, upside). Full methodology exported in output for auditability.

### Tools
- [x] `detect_inactive_high_vote_candidates` — candidates not running in the next election with their prior votes and strongest areas
- [x] `find_exposed_vote_pools` — areas where party vote share fell significantly between elections
- [x] `estimate_vote_transfer_proxy` — proxy estimates from area co-movement; output includes `proxy_method` and `confidence` metadata
- [x] `rank_target_areas` — composite score with 4 transparent components; full methodology in output

### Tests
- [x] `detect_inactive_high_vote_candidates` 2019→2023 helsinki: fails gracefully with clear message (2019 not in registry) ✓
- [x] `find_exposed_vote_pools` KESK 2019→2023: 181 municipalities with ≥2pp loss identified ✓
- [x] `estimate_vote_transfer_proxy` output includes `proxy_method: "election result inference"` and `confidence: "structural indicator"` ✓
- [x] `estimate_vote_transfer_proxy` KESK→PS 2019→2023: national −74,280 / +82,176, 87% area co-movement ✓
- [x] `rank_target_areas` SDP 2023 (trend 2019): all 4 components present for each area, methodology fully documented ✓

---

## Phase 8: Area-Centric Tools ✅ COMPLETE

**Goal:** LLMs can analyze individual areas and compare them.

**Implementation notes:**
- 13sw party rows include a `party_id: "SSS"` total row ("Puolueiden äänet yhteensä", 100% share) — all area tools filter this out explicitly
- Volatility uses the Pedersen index (sum of |share_t - share_{t-1}| / 2) — standard political science measure. Helsinki avg = 12.12pp (2011–2023), indicating high urban volatility
- `find_strongholds`/`find_weak_zones` rank by vote_share, not raw votes — intentional (a stronghold is where share is highest, not where the candidate has most supporters in absolute terms)

### Tools
- [x] `get_area_profile` — top parties, historical trend, Pedersen volatility
- [x] `compare_areas` — side-by-side comparison with leading party per area
- [x] `analyze_area_volatility` — Pedersen index per election period with biggest gainer/loser
- [x] `find_strongholds` — strongest areas by vote share for party or candidate
- [x] `find_weak_zones` — weakest areas by vote share

### Tests
- [x] `get_area_profile` Helsinki 2015–2023: KOK 26.4%, SDP 20.9%, VIHR 15.3%; avg Pedersen 14.83 ✓
- [x] `compare_areas` Helsinki/Espoo/Tampere: KOK leads Helsinki/Espoo, SDP leads Tampere ✓
- [x] `analyze_area_volatility` Helsinki 2011–2023: avg Pedersen 12.12 (consistent with get_area_profile calculation) ✓
- [x] `find_strongholds` Heinäluoma: Mellunmäki A #1 — consistent with find_area_overperformance ✓
- [x] `find_weak_zones` KOK: Swedish coastal municipalities (Närpiö 0.7%, Uusikaarlepyy 0.9%) — geographically plausible ✓

---

## Phase 9: Audit and Transparency Tools ✅ COMPLETE

**Goal:** All analytical outputs are auditable — LLMs and users can verify methodology, data sources, and limitations.

**Implementation notes:**
- All tools are purely static (no API calls). Knowledge is encoded directly in the module.
- Metric registry covers all 9 metrics used in Phase 6–8 tools.
- Lineage registry covers the most commonly used tools. For tools not listed, every tool response already includes `method.source_table` in its output.
- Caveat registry: 2 critical (candidate data 2023-only, vote transfer proxy-only), 1 moderate (municipality boundary changes), 4 minor.

### Tools
- [x] `explain_metric` — definition, formula, unit, methodology notes for all MCP metrics
- [x] `trace_result_lineage` — source tables, query filters, normalization, transformations, caveats per tool
- [x] `validate_comparison` — 6 comparison types checked; returns validity + warnings + recommendations
- [x] `get_data_caveats` — 7 known caveats with severity levels; filterable by topic

### Tests
- [x] `explain_metric` pedersen_index, composite_score, vote_transfer_proxy — all return meaningful definitions ✓
- [x] `explain_metric` partial name "transfer" → vote_transfer_proxy ✓
- [x] `trace_result_lineage` estimate_vote_transfer_proxy includes originating table (statfin_evaa_pxt_13sw) ✓
- [x] `trace_result_lineage` compare_elections: source_tables includes 13sw ✓
- [x] `validate_comparison` candidate_across_vaalipiirit → validity: "invalid", 3 warnings ✓
- [x] `get_data_caveats` candidate: returns candidate_data_2023_only (critical) + national_candidate_query_slow (minor) ✓
- [x] `get_data_caveats` all: 2 critical, 1 moderate, 4 minor ✓

---

## Phase 10: Integration, Polish, and System Prompt ✅ COMPLETE

**Goal:** The MCP is production-ready and can be connected to an LLM client.

**Implementation notes:**
- 38 tools registered across 7 categories (PRD said "40+" but 38 is the actual count per the phase plan).
- System prompt registered as a named MCP prompt ("system") via `server.prompt()`.
- All tools have error handling via try/catch returning `{ error: "..." }` JSON payloads.
- In-memory TTL cache in `src/cache/cache.ts` already covers the most expensive repeated API calls (metadata fetches, party-by-kunta table).
- TypeScript strict mode, clean build throughout.

### Tasks
- [x] Register all tools with the MCP server (all 7 category registrars wired in `src/server.ts`)
- [x] Implement the MCP system prompt (as specified in PRD section 9)
- [x] Error handling: all tools return structured `{ error: "..." }` on failure
- [x] End-to-end integration test: resolve candidate → get profile → compare elections → rank target areas
- [x] Performance review: TTL cache covers metadata and 13sw fetches; candidate fetches are cached per vaalipiiri

### Tests
- [x] 38 tools registered and enumerated by `server._registeredTools` ✓
- [x] System prompt accessible via `server._registeredPrompts['system']`, returns correct text ✓
- [x] Integration workflow: Heinäluoma resolve (exact confidence) → profile (15,837 votes, rank 3, rank-in-party 1) → SDP compare 2019→2023 (+2.20pp) → rank target areas (Helsinki #1, Tampere #2, Vantaa #3) ✓
- [x] `npm run build` clean throughout all phases ✓

---

## Phase 11: Election-Agnostic Architecture + All Missing Elections ✅ COMPLETE

**Goal:** The MCP covers all major Finnish elections from 2019 onwards (municipal, regional, EU, presidential) in addition to parliamentary. The architecture is refactored so adding a new election requires only a registry entry — no code changes.

**Scope:** Elections targeted: 2019 EU, 2021 Municipal, 2022 Regional, 2023 Parliament (done), 2024 Presidential, 2024 EU, 2025 Municipal, 2025 Regional. Elections before 2019 are out of scope for candidate data; party data for parliamentary already covers 1983–2023 via 13sw.

---

### Phase 11A: Architectural Refactor (prerequisite for all subsequent phases)

**Problem:** Table structure is currently hardcoded in 3+ places (normalizer, loaders, retrieval tool). Each new election type required touching all of them. This must be fixed before adding more election types.

**Key finding from API research (2026-03-16):** Variable names and area code formats differ significantly across election types:
- Parliamentary 2023 candidate: `Alue/Äänestysalue`, `evaa_aanet`, area codes `VP01`/`KU091`
- Parliamentary 2019 candidate: `Äänestysalue`, `Sar1` as dimension key, area codes `VP01`/`091`
- Municipal 2025 candidate: `Äänestysalue`, text-detect votes, area codes `091 Helsinki`/`01 091 Kruununhaka A`
- Regional 2025 candidate: `Äänestysalue`, text-detect votes, area codes `HVA01 ...`/`018 Askola`
- EU 2024 candidate: no area variable (national single list)
- Presidential 2024: `Alue` (2079 values), `Kierros` (round), no party dimension

#### Tasks

**1. Extend `src/data/types.ts`**
- Add `hyvinvointialue` to `AreaLevel` union
- Add optional `round?: number` to `ElectionRecord` (presidential)

**2. Extend `src/data/election-tables.ts`**
Add `CandidateTableSchema` and `PartyTableSchema` interfaces to `ElectionTableSet`:
```typescript
interface CandidateTableSchema {
  area_var: string;
  area_code_format:
    | 'parliamentary_active'    // VP##, KU###, else=aanestysalue
    | 'parliamentary_archive'   // VP##, 3-digit=kunta, else=aanestysalue
    | 'text_prefix_space'       // "091 X"=kunta, "01 091 X"=aanestysalue, "01 X vaalipiiri"=vaalipiiri
    | 'hyvinvointialue_prefix'  // HVA##=hyvinvointialue, 3-digit=kunta, else=aanestysalue
    | 'national';               // no area — single national row
  geographic_unit_type: 'vaalipiiri' | 'hyvinvointialue' | 'national';
  measures_are_dimension_keys: boolean;  // true for 2019 archive (Sar1/Sar2 in key[])
  has_vuosi_var: boolean;
  has_valintatieto_var: boolean;
  has_round_var?: boolean;        // presidential
  has_party_dimension: boolean;   // false for presidential
}

interface PartyTableSchema {
  area_var: string;
  party_var: string;
  area_code_format: 'six_digit' | 'text_prefix_space';
  gender_var?: string;            // regional 14y4 requires Ehdokkaan sukupuoli=Yhteensä
  national_total_code: string;    // e.g. 'SSS', 'Manner-Suomi', 'Koko maa'
}
```
Add `candidate_table_schema?: CandidateTableSchema` and `party_table_schema?: PartyTableSchema` to `ElectionTableSet`.
Populate schemas for the existing 2023 and 2019 parliamentary entries.

**3. Refactor `src/data/normalizer.ts`**
- Replace `inferAreaLevelFromCandidateCode()` with `inferAreaLevel(code, format: CandidateTableSchema['area_code_format'])`
- Update `normalizeCandidateByAanestysalue()` to accept `CandidateTableSchema` and use it instead of runtime detection
- Update `normalizePartyByKunta()` → rename `normalizePartyTable()`, accept `PartyTableSchema`, handle both area code formats
- Remove all `metadata.variables.some(...)` runtime detection — that logic moves to the registry

**4. Refactor `src/data/loaders.ts`**
- `loadPartyResults(electionType, year, areaId?)`: reads `party_table_schema` from registry, works for any election type
- `loadCandidateResults(electionType, year, geographicUnitKey, candidateId?)`: reads `candidate_table_schema` from registry; `geographicUnitKey` maps to the right table (vaalipiiri, hyvinvointialue, or 'national')

**5. Update `src/tools/retrieval/index.ts`**
- `get_candidate_results`: replace inline variable-detection block with schema lookup from registry
- `get_party_results`, `get_turnout`: add `election_type` parameter routing

**6. Verify existing tests still pass**
- 2023 parliamentary: all existing tests ✓
- 2019 parliamentary: all tests added in this session ✓

---

### Phase 11B: Municipal Elections (2021, 2025)

**Structure:** Nearly identical to parliamentary — 13 vaalipiiri candidate tables, same vaalipiiri keys, same geographic hierarchy (vaalipiiri → kunta → äänestysalue).

**Key differences from parliamentary:**
- Party table variable: `Alue` (not `Vaalipiiri ja kunta vaalivuonna`), area codes use `text_prefix_space` format
- Candidate area codes: `text_prefix_space` format (e.g. `091 Helsinki`, `01 091 Kruununhaka A (001A)`)
- Candidate valueText format: `"Sazonov Daniel / KOK / Helsinki"` (kunta not vaalipiiri in third field)
- 2021 archive: per-äänestysalue candidate tables may not exist — verify; kunta-level only confirmed

**Tables to register:**

2025 Municipal (StatFin):
- party_by_kunta: `statfin_kvaa_pxt_14z7` (1976–2025 multi-year)
- candidate_by_aanestysalue: `14v9` (helsinki) through `14vk` (lappi) — verify all 13 keys
- turnout: `statfin_kvaa_pxt_14vl`

2021 Municipal (StatFin_Passiivi):
- party_by_kunta: `statfinpas_kvaa_pxt_12g3_2021` (1976–2021)
- candidate: investigate whether per-äänestysalue tables exist; if only kunta-level, note as caveat

#### Tasks
- [x] Verify 2025 municipal candidate table variable names match schema (fetch metadata for `14v9`)
- [x] Verify 2021 archive candidate table structure
- [x] Register 2025 municipal with full schemas
- [x] Register 2021 municipal with available schemas
- [x] Test `get_party_results` municipal 2025 Helsinki
- [x] Test `get_candidate_results` municipal 2025 Helsinki candidate
- [x] Test `analyze_candidate_profile` municipal 2025
- [x] Test `compare_elections` KOK municipal 2021→2025

---

### Phase 11C: Regional Elections (2022, 2025)

**Structure:** Similar to parliamentary but with `hyvinvointialue` as the top geographic level instead of vaalipiiri. 21 hyvinvointialue instead of 13 vaalipiiri.

**Key differences:**
- New `AreaLevel`: `hyvinvointialue` (must add to types.ts in Phase 11A)
- Area codes: `HVA##` prefix for hyvinvointialue, 3-digit for kunta
- Party table has gender filter variable (`Ehdokkaan sukupuoli`) — must filter to `Yhteensä`
- `geographic_unit_type: 'hyvinvointialue'` — tools accepting `vaalipiiri` must also accept `hyvinvointialue`

**Tables to register:**

2025 Regional (StatFin):
- party_by_kunta: `statfin_alvaa_pxt_14y4` (2022–2025)
- candidate_by_aanestysalue: `14zu` (Itä-Uusimaa) through `151p` (Lappi) — 21 tables
- Map hyvinvointialue keys (e.g. `ita-uusimaa`, `keski-uusimaa`, ...)

2022 Regional (StatFin_Passiivi):
- party: `statfinpas_alvaa_pxt_13by_2022`
- candidate: investigate whether per-äänestysalue tables exist in archive

#### Tasks
- [x] Define 21 hyvinvointialue key names (lowercase, hyphenated)
- [x] Fetch metadata for one 2025 regional candidate table to verify variable names
- [x] Register 2025 regional with full schemas
- [x] Register 2022 regional
- [x] Update tools to accept `hyvinvointialue` geographic unit parameter
- [x] Test `get_party_results` regional 2025
- [x] Test `get_candidate_results` regional 2025
- [x] Test `compare_elections` across 2022→2025 regional

---

### Phase 11D: EU Parliament Elections (2019, 2024)

**Structure:** Finland is a single national constituency for EU elections (since 1999). No vaalipiiri split. Candidate table is one national table with all candidates ranked.

**Key differences:**
- `geographic_unit_type: 'national'` — no per-area candidate breakdown
- Party table area variable: `Vaalipiiri ja kuntamuoto` (urban/rural classification, not full kunta) — limited geographic depth
- Multi-year party table `14gv` covers 1996–2024
- No `Valintatieto` filter variable
- Candidate valueText format: `"Aaltola Mika / KOK"` (no vaalipiiri field)

**Tables to register:**

2024 EU (StatFin):
- party multi-year: `statfin_euvaa_pxt_14gv` (1996–2024)
- candidate national: `statfin_euvaa_pxt_14gy`

2019 EU (StatFin_Passiivi):
- party: `020_euvaa_2019_tau_102`
- candidate: `430_euvaa_2019_tau_105`

#### Tasks
- [x] Fetch metadata for `14gy` and `14gv` to confirm variable names
- [x] Register 2024 EU with schemas
- [x] Register 2019 EU with schemas
- [x] Test `get_party_results` EU national 2024
- [x] Test `get_candidate_results` EU 2024 (no area breakdown)
- [x] Test `compare_elections` EU 2019→2024

---

### Phase 11E: Presidential Elections (2024)

**Structure:** Uniquely different — no party dimension, two rounds, all areas in a single table.

**Key differences:**
- `has_party_dimension: false` — `party_id`/`party_name` fields absent; candidates listed by name only
- `has_round_var: true` — `Kierros` variable with `Ensimmäinen vaali` / `Toinen vaali`
- All geography in one table: 2079 area values (koko_suomi + vaalipiiri + kunta)
- `geographic_unit_type: 'national'` — no split tables
- Candidate valueText: `"Alexander Stubb"` (just name, no party/vaalipiiri)
- Analytics tools relying on party dimension (`rank_within_party`, `analyze_within_party_position`, party tools) must gracefully return N/A

**Tables to register:**

2024 Presidential (StatFin):
- candidate (all areas): `statfin_pvaa_pxt_14d5`
- turnout: `statfin_pvaa_pxt_14d6`
- multi-election candidate summary: `statfin_pvaa_pxt_14db` (1994–2024 by vaalipiiri)

#### Tasks
- [x] Add `round?: number` to `ElectionRecord` in types.ts (if not already done in 11A)
- [x] Register 2024 presidential with schema
- [x] Add `round` parameter to `get_candidate_results` and `analyze_candidate_profile`
- [x] Test round 1 vs round 2 results for Stubb
- [x] Verify party-dependent tools return graceful N/A for presidential

---

### Phase 11F: Integration + Documentation

#### Tasks
- [x] Update `list_elections` to show all registered elections
- [x] Update system prompt data coverage section
- [x] Update `get_data_caveats` with new caveats:
  - EU: no kunta-level candidate geography (national only)
  - Presidential: no party dimension, two rounds
  - Municipal 2021: candidate data may be kunta-level only (no äänestysalue)
  - Regional 2022: verify candidate data depth
- [x] Update `trace_result_lineage` for new election types
- [x] Update CLAUDE.md data coverage section
- [x] Full cross-election integration test (one query per new election type)
- [x] Mark Phase 11 complete in logbook

---

## Phase 12: Historical Parliamentary Candidate Data (2007–2015)

**Goal:** Extend candidate data coverage to 2007, 2011, and 2015 parliamentary elections using StatFin_Passiivi archive tables.

**Known unknowns:** Archive variable formats may differ across years (2019 already uses a different format than 2023). Each year may require its own normalization path or format detection.

### Tasks
- [ ] Research StatFin_Passiivi for 2015, 2011, 2007 parliamentary candidate table IDs
- [ ] Fetch metadata for one table per year and compare variable structures to 2019 archive format
- [ ] Determine if existing normalizer handles them or if new format variants are needed
- [ ] Register 2015 candidate tables (13 vaalipiiri)
- [ ] Register 2011 candidate tables (13 vaalipiiri)
- [ ] Register 2007 candidate tables (13 vaalipiiri)
- [ ] Live API smoke test for each year (one vaalipiiri per year)
- [ ] Update `list_elections` data coverage output
- [ ] Logbook entry

---

## Phase 13: Municipal 2021 Candidate Data Gap

**Goal:** Determine whether per-äänestysalue candidate tables exist for municipal 2021 in StatFin_Passiivi, and register them if they do.

**Context:** Municipal 2021 currently has party data only (via multi-year 14z7 table). Candidate-level queries for 2021 are unsupported. The 2025 tables (14v9–14vk) are registered and working.

### Tasks
- [ ] Search StatFin_Passiivi (`/fi/StatFin_Passiivi/kvaa/`) for 2021 candidate tables
- [ ] If found: fetch metadata, verify variable format, register tables
- [ ] If not found: add explicit caveat to `get_data_caveats` and `describe_election` for municipal 2021
- [ ] Logbook entry with finding

---

## Phase 14: Cross-Election-Type Analytics Tool

**Goal:** Add a tool that compares a party or candidate across different election types within a single response (e.g. SDP performance municipal 2021 → parliamentary 2023 → regional 2025).

**Context:** Current `compare_elections` works within one election type only. Cross-type comparison requires normalizing vote share across fundamentally different electorate sizes, which must be handled carefully (caveats about incomparable denominators).

### Tasks
- [ ] Design tool schema: inputs (party or candidate name, list of election_type+year pairs), outputs (table + methodology note)
- [ ] Implement `compare_across_elections` tool in analytics
- [ ] Handle caveat: EU/presidential vote share not directly comparable to municipal/parliamentary
- [ ] Test: SDP across municipal 2021, parliamentary 2023, regional 2025
- [ ] Logbook entry

---

## Phase 15: System Prompt

**Goal:** Write the system prompt that a consuming LLM (Claude in Claude Desktop) uses to understand which tools exist and how to orchestrate them for analyst queries.

### Tasks
- [ ] Draft system prompt covering all tool categories and election types
- [ ] Add data coverage and known caveats section
- [ ] Add worked examples (one per election type)
- [ ] Test system prompt with real queries in Claude Desktop
- [ ] Logbook entry
