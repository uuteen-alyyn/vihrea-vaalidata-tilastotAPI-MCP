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

## Phase 12: HTTP Deployment — Per-IP Rate Limiting ✅ COMPLETE

**Goal:** Protect the public HTTP endpoint from upstream API budget exhaustion by a single abusive client, while keeping the service completely open and frictionless for legitimate election candidate users.

**Design principle:** No passwords, no API keys, no accounts. Open access is intentional — the data is public. Rate limiting operates transparently at the infrastructure level. Users who hit limits get a clear, friendly message explaining what happened and how to get help.

### Context

- Upstream Tilastokeskus API: 10 requests / 10-second window (global limit shared by all clients)
- `resolve_candidate` without `vaalipiiri`: fires 13 API calls (~13–15s)
- A single client in a tight loop can fully saturate the upstream budget
- Target users (campaign teams) will make bursts of 10–20 calls per session, then pause

### Recommended limit

**30 requests / 60 seconds per IP** — generous enough for any realistic campaign session, restrictive enough to prevent runaway loops.

### Implementation (application-level, in `server-http.ts`)

- [x] Sliding-window rate limiter: `Map<ip, number[]>` of recent timestamps per IP
- [x] `checkRateLimit(ip)`: filters timestamps to last 60s, rejects if ≥ 30, else pushes new timestamp
- [x] `getClientIp(req)`: honours `X-Forwarded-For` for nginx/Cloudflare proxying
- [x] 429 JSON response body: `{ error, message, retry_after_seconds }` + `Retry-After` header
- [x] Stale-IP eviction via `setInterval` every 5 min (prevents unbounded Map growth)
- [x] Configurable via env vars: `RATE_LIMIT_REQUESTS` (default 30), `RATE_LIMIT_WINDOW_MS` (default 60000)
- [x] Startup log: `Rate limit: 30 req / 60s per IP`
- [x] Request log includes `ip=<addr>` field

### Tests (`src/rate-limiter.test.ts` — 8 tests)
- [x] Allows requests up to the limit
- [x] Rejects (limit+1)th request within window
- [x] Allows requests again after window elapses
- [x] Different IPs tracked independently
- [x] Sliding window: oldest timestamp expires correctly
- [x] `evict()` removes stale IPs / keeps active IPs

### Notes
- Infrastructure-level rate limiting (nginx/Cloudflare) can be added in front for additional protection without changing application code — the app-level limiter provides defense-in-depth.
- For nginx: `limit_req_zone $binary_remote_addr zone=mcp:10m rate=30r/m; limit_req zone=mcp burst=10 nodelay;`
- For Cloudflare: rate limit rule on the MCP endpoint URL with 30 req/min threshold.

---

## Phase 13: Historical Parliamentary Candidate Data (2007–2015) ✅ COMPLETE

**Goal:** Extend candidate data coverage to 2007, 2011, and 2015 parliamentary elections using StatFin_Passiivi archive tables.

### Findings
- All three years' tables exist in `StatFin_Passiivi/evaa/`.
- **2015**: 13 vaalipiiri (same boundaries as 2019/2023). `Äänestysalue` + `Äänestystiedot` (Sar1=votes, Sar2=share) — identical format to 2019.
- **2011**: 15 vaalipiiri (old boundaries). Same Sar-dimension format as 2015.
- **2007**: 15 vaalipiiri (old boundaries). Area variable is `Alue` (not `Äänestysalue`); Sar3=votes, Sar4=share. Normalizer auto-detects via text-search ('äänimäärä', 'osuus').
- **No normalizer changes needed** — existing `tiedotIsKey` branch + text detection handles all formats.

### Tasks
- [x] Research StatFin_Passiivi for 2015, 2011, 2007 parliamentary candidate table IDs
- [x] Fetch metadata for one table per year and compare variable structures to 2019 archive format
- [x] Confirmed: existing normalizer handles all three formats automatically
- [x] Register 2015 candidate tables (13 vaalipiiri) in `election-tables.ts`
- [x] Register 2011 candidate tables (15 vaalipiiri — old boundaries) with legacy keys
- [x] Register 2007 candidate tables (15 vaalipiiri — old boundaries) with legacy keys
- [x] `list_elections` auto-updated (driven by `ALL_ELECTION_TABLES`)
- [x] `describe_election` now shows caveat for 2007/2011 about boundary reform and correct keys
- [x] Build + tests: 99/99 passing

### 2011/2007 boundary note
Before 2012 vaalipiiri reform, Finland had 15 electoral districts. The 4 merged:
- `kymi` → `kaakkois-suomi` (2015+)
- `etela-savo` + `pohjois-savo` + `pohjois-karjala` → `savo-karjala` (2015+)

Callers must use old keys (e.g. `kymi`, `etela-savo`) when querying 2007/2011 elections.

---

## Phase 14: Municipal 2021 Candidate Data Gap ✅ COMPLETE

**Goal:** Determine whether per-äänestysalue candidate tables exist for municipal 2021 in StatFin_Passiivi, and register them if they do.

### Finding
Tables FOUND in StatFin_Passiivi. 12 per-vaalipiiri candidate tables exist (`statfinpas_kvaa_pxt_12vs_2021` through `statfinpas_kvaa_pxt_12wu_2021`). Format is content-column (`Tiedot` with `aanet_yht`=votes, `osuus_aanista`=share, `Äänestysalue` area variable) — same as 2025 municipal tables, no normalizer changes needed.

### Tasks
- [x] Search StatFin_Passiivi (`/fi/StatFin_Passiivi/kvaa/`) for 2021 candidate tables — found 12 vaalipiiri tables
- [x] Fetch metadata for Helsinki table, verify variable format matches 2025 format
- [x] Register 12 tables in `election-tables.ts` (MUNICIPAL_TABLES, database: archive)
- [x] Remove unused `AreaLevel` import from election-tables.ts
- [x] Build + tests: 99/99 passing
- [x] Logbook entry

---

## Phase 15: Cross-Election-Type Analytics Tool ✅ COMPLETE

**Goal:** Add a tool that compares a party across different election types within a single response (e.g. SDP performance municipal 2021 → parliamentary 2023 → regional 2025).

**Context:** Current `compare_elections` works within one election type only. Cross-type comparison requires normalizing vote share across fundamentally different electorate sizes, which must be handled carefully (caveats about incomparable denominators).

### Implementation

Tool: `compare_across_elections` — added to `src/tools/analytics/index.ts`

**Input schema:**
- `party` (string, max 200) — party abbreviation or name, matched against party_id and party_name
- `elections` (array of `{election_type, year}`, min 2, max 10) — which elections to compare
- Note: presidential excluded (no party dimension in presidential data)

**Output:**
- `results[]`: election_type, year, votes, vote_share_pct, party_id, party_name, error
- `caveats[]`: dynamic warnings based on which election types are included
- `comparability_notes{}`: per-type explanation of electorate definition
- `method{}`: description + source table IDs

**Comparability caveats handled:**
- Cross-type comparison: general "not directly comparable" caveat when multiple types present
- EU elections: different denominator (EU citizens in Finland can vote), low turnout
- Municipal: national share = sum across all municipalities (penalizes parties without candidates everywhere)
- Presidential: excluded from input enum (no party dimension)

**Implementation details:**
- Parallel `Promise.all` fetches national SSS-level data for each election
- vote_share_pct uses table's own `vote_share` column when available; falls back to votes/sum×100
- Results sorted by year ascending, then election_type for same-year entries

### Tasks
- [x] Design tool schema
- [x] Implement `compare_across_elections` in analytics
- [x] Handle EU/municipal comparability caveats
- [x] Build + tests: 99/99 passing
- [ ] Live test: SDP across municipal 2021, parliamentary 2023, regional 2025

---

## Phase 16: System Prompt ✅ COMPLETE

**Goal:** Write the system prompt that a consuming LLM (Claude in Claude Desktop) uses to understand which tools exist and how to orchestrate them for analyst queries.

**Implementation notes:**
- Registered via `server.registerPrompt()` (updated from deprecated `server.prompt()`)
- Seven sections: electoral context, standard workflow (numbered 1–7 with all tools listed), data coverage table, conventions, election-specific notes, worked examples
- Data coverage table updated to reflect all Phase 11 elections
- Added hyvinvointialue keys for regional elections
- Election-specific caveats: EU national-only, presidential no party + two rounds, 2021/2022 party-data-only
- One worked example per election type (parliamentary, municipal, regional, EU, presidential)

### Tasks
- [x] Draft system prompt covering all tool categories and election types
- [x] Add data coverage and known caveats section
- [x] Add worked examples (one per election type)
- [ ] Test system prompt with real queries in Claude Desktop
- [x] Logbook entry

---

## Phase 17: Math & Analytics Test Suite (QUAL-1) ✅ COMPLETE

**Goal:** Add automated test coverage for all deterministic analytics, math helpers, and normalizers. The 10 bugs in `MATH_AUDIT.md` were found by manual inspection — this phase makes regressions impossible to ship silently.

**Context:** The service is positioned as a "deterministic analytics" layer consumed by LLM systems. Without tests, any code change can silently corrupt vote share calculations, ranks, or geographic aggregations. See `audits/CODE_AUDIT.md` → QUAL-1.

### Test framework setup
- [x] Add Vitest to dev dependencies (`npm install -D vitest`) — lightweight, ESM-native, no config needed
- [x] Add `"test": "vitest run"` and `"test:watch": "vitest"` to `package.json` scripts
- [x] Add `vitest.config.ts` (environment: node, include: `src/**/*.test.ts`)

### Unit tests — pure math helpers (`src/tools/shared.test.ts`)
- [x] `pct()` — correct rounding, edge cases (0, negative, boundary), ratio→pct conversion
- [x] `round2()` — correct 2-decimal rounding, negative, BUG-1 ratio documentation
- [x] `mcpText()` — content structure, JSON serialization, arrays, nested objects
- [x] `errResult()` — error response structure
- [x] `subnatLevel()` — all 5 election types
- [x] `matchesParty()` — by id, by name, case-insensitive, partial non-match, falsy fields

### Unit tests — normalizer functions (`src/data/normalizer.test.ts`)
- [x] `buildKeyIndex()` — only d/t columns indexed, sequential indices
- [x] `buildValueIndex()` — only c columns indexed
- [x] `buildValueTextMap()` — correct map, unknown variable → empty map, fallback to code
- [x] `inferAreaLevelFromCandidateCode()` — SSS, VP##, KU###, HV##, 3-digit, other
- [x] `inferPartyAreaLevel()` — six_digit, vp_prefix, five_digit schema formats
- [x] `parseCandidateValueText()` — parliamentary, EU, presidential, municipal formats + whitespace
- [x] `normalizePartyTable()` — content-column format: SSS excluded, correct votes/share/area-level/names
- [x] `normalizeCandidateByAanestysalue()` — code "00" excluded, name/party parsed, area levels, types

### Regression tests — known bugs from MATH_AUDIT.md (`src/bugs.regression.test.ts`)
- [x] BUG-1: `round2(votes/total)` returns ratio, `pct(votes/total*100)` returns pct — documents fix
- [x] BUG-2: buggy approach sums kunta+vaalipiiri (double-counts); fix filters to kunta-only
- [x] BUG-3: `votes_year1 - votes_year2` can be negative when turnout rises; fix uses net change + share_points_lost
- [x] BUG-4: c1/c4 anti-correlation proven mathematically; composite = 0.20 + 0.15×c1
- [x] BUG-5: concentration fraction vs percentage — `×100` conversion required
- [x] BUG-8: 1-vote change classified as consistent_with_transfer; magnitude-threshold fix
- [x] BUG-9: `allVotesByArea` vs party-vote-volume c3 — different values, fix uses total votes
- [x] BUG-10: Mäki/Maki collision via normalization; fix detects same-normalized-name duplicates

### Test results
- **91 tests, 3 test files, 0 failures** (run: `npm test`)
- Integration smoke tests (live API) deferred — beyond scope of QUAL-1

---

## Phase 18: Code Quality & Security Fixes (CODE_AUDIT.md) ✅ COMPLETE

**Goal:** Address the remaining findings from `audits/CODE_AUDIT.md` that are not covered by earlier phases.

**Reference:** Full details and fix suggestions for each item are in `audits/CODE_AUDIT.md`.

**Implementation notes:**
- `src/tools/shared.ts` created with 7 shared helpers/constants; all 4 tool files updated to import from it
- Cache rewritten with LRU eviction (500 entries), disk persistence to `cache-store.json`, and coalesced async writes
- `resolve_entities` now uses `Promise.all`; `compare_elections` year queries parallelized
- Query bigrams pre-computed once before candidate inner loop via `buildBigrams` / `scoreMatchFast`
- `server.prompt()` → `server.registerPrompt()` (deprecation resolved in Phase 16)

### Immediate security fixes
- [x] **SEC-1** — Add `.claude/` to `.gitignore`; rotate GitHub PAT if any risk of prior commit
- [x] **SEC-3** — Add 30-second `AbortController` timeout to all `fetch()` calls in `pxweb-client.ts`
- [x] **SEC-5** — Replace recursive `throttle()` with a `while` loop
- [x] **SEC-6** — Add `.max(200)` to all `z.string()` parameters used in fuzzy matching
- [x] **SEC-7** — Validate parsed `PORT` is in range 1024–65535 in `server-http.ts`

### Correctness fixes
- [x] **QUAL-2** — Add entries to `get_data_caveats` for BUG-1 and BUG-2 (active math bugs); remove once fixed
- [x] **QUAL-3** — Replace all silent `catch (_) {}` with `console.error(...)` — tool name, year, error message
- [x] **QUAL-6** — Update system prompt data coverage (done in Phase 16)
- [x] **SEC-4** — Sanitize error messages to clients: log full details server-side, return generic upstream status to callers

### Efficiency fixes
- [x] **EFF-1** — Parallelize `resolve_entities`: replace serial `for` loop with `Promise.all`
- [x] **EFF-2** — Pre-build `Map<candidateId, rank>` in `compare_candidates` instead of repeated `findIndex()` in loops
- [x] **EFF-3** — Replace histogram O(10n) filter loop with single O(n) bucket-assignment pass in `analyze_vote_distribution`
- [x] **EFF-4** — Pre-compute query bigram Set once before candidate loop in `resolve_candidate` / `resolve_entities`
- [x] **EFF-5** — Use `Promise.all` for year queries in `compare_elections`

### Code quality
- [x] **QUAL-4** — Add basic request logging to HTTP server: timestamp, duration, status code
- [x] **QUAL-5** — Extract duplicated helpers to `src/tools/shared.ts`; all 4 tool files import from it
- [x] **QUAL-7** — Remove `@deprecated vaalipiiri_code` field from `CandidateLoadResult`
- [x] **QUAL-8** — Remove `cache_hit` from all tool response `method` blocks
- [x] **QUAL-9** — Remove `audits/` from `.gitignore` (replaced with `.claude/`)

### Cache / cost
- [x] **COST-1** — Persist cache to `cache-store.json`; loaded on startup, written async on `cacheSet`
- [x] **COST-4** — Add max entry count (500) with LRU eviction (oldest-first Map eviction)
- [x] Logbook entry

---

## Phase 19: MATH_AUDIT Bug Fixes ✅ COMPLETE

**Goal:** Fix all 10 bugs identified in `audits/MATH_AUDIT.md` and confirmed still-open in `audits/POLSCI_AUDIT_2026-03.md`. Bugs BUG-1 through BUG-10 were documented as regression tests in `src/bugs.regression.test.ts` (Phase 17) but the underlying code was never corrected.

**Reference files:**
- `audits/MATH_AUDIT.md` — original bug descriptions with exact fix suggestions
- `src/bugs.regression.test.ts` — regression tests that must be updated to assert fixed behavior after each fix
- `src/tools/audit/index.ts` — contains `get_data_caveats` entries for BUG-1 and BUG-2 that must be removed once those bugs are resolved

**Output schema changes (breaking — LLM consumers must be aware):**
- `analyze_candidate_profile`: `share_of_party_vote` (0–1 ratio) → `share_of_party_vote_pct` (percentage) — BUG-1
- `find_exposed_vote_pools`: `total_estimated_lost_votes` → `net_vote_count_change_in_exposed_areas` + new field `total_share_points_lost_in_exposed_areas` — BUG-3
- `analyze_candidate_profile` / `analyze_party_profile`: concentration fields `top1_share`, `top3_share`, etc. → `top1_share_pct`, `top3_share_pct`, etc. (×100 applied at source) — BUG-5
- `rank_target_areas`: c4 component removed; weights redistributed; scoring_methodology updated — BUG-4/BUG-9

**Dependency ordering:**
- BUG-9 must be fixed before BUG-4 (c3 fix is a prerequisite for the c4 redesign)
- All code fixes should be complete before updating `bugs.regression.test.ts`
- `audit/index.ts` caveats removed last (after BUG-1 and BUG-2 are confirmed fixed by tests)

---

### Step 1: BUG-2 — Fix `buildPartyAnalysis` double-counting (🔴 Critical)

**File:** `src/tools/retrieval/index.ts:353`

**Change:**
```typescript
// Before:
if (!row.party_id || row.area_level === 'koko_suomi') continue;

// After:
if (!row.party_id || row.area_level !== 'kunta') continue;
```

**Why `kunta` and not `aanestysalue`:** The comment in `Implementation_plan.md` Phase 6 confirms geographic analysis uses äänestysalue to avoid double-counting, but `buildPartyAnalysis` is used for party-level summaries where kunta is the right resolution (13sw has no äänestysalue breakdown). Filtering to `kunta` excludes vaalipiiri-level aggregates and koko_suomi correctly.

**Regression test update:** `BUG-2` describe block — change the `[CURRENTLY FAILING]` test to assert the fix path produces the correct value (`3000`, not `6000`).

- [ ] Fix `retrieval/index.ts:353`
- [ ] Update `bugs.regression.test.ts` BUG-2 block

---

### Step 2: BUG-1 — Fix `share_of_party_vote` ratio vs percentage (🔴 Critical)

**Files:** `src/tools/analytics/index.ts:96,127`

**Change:**
```typescript
// Before (line 96):
const shareOfPartyVote = partyTotalVotes > 0 ? round2(totalVotes / partyTotalVotes) : null;
// Before (line 127):
share_of_party_vote: shareOfPartyVote,

// After:
const shareOfPartyVotePct = partyTotalVotes > 0 ? pct(totalVotes / partyTotalVotes * 100) : null;
// After:
share_of_party_vote_pct: shareOfPartyVotePct,
```

**Cross-cutting changes required in `src/tools/audit/index.ts`:**
- Line 53: rename metric registry key from `share_of_party_vote` to `share_of_party_vote_pct`
- Line 57: update formula string to reflect pct output
- Line 250: update `explain_metric` parameter hint text
- Line 327: update `trace_result_lineage` transformations array
- Line 460: update recommendation text

**Regression test update:** `BUG-1` describe block — the `[CURRENTLY FAILING]` test (asserts `buggyResult === 0.23`) becomes the baseline to remove or replace; add assertion that the fixed formula returns `23`.

- [ ] Fix `analytics/index.ts:96,127`
- [ ] Update `audit/index.ts` metric references (lines 53, 57, 250, 327, 460)
- [ ] Update `bugs.regression.test.ts` BUG-1 block

---

### Step 3: BUG-5 — Fix concentration fractions missing unit context (🟠 High)

**File:** `src/tools/analytics/index.ts` — `concentrationMetrics()` function + all call sites

**Approach:** Multiply by 100 and rename fields **at the source** in `concentrationMetrics()` so all consumers receive percentages automatically.

```typescript
// Before in concentrationMetrics():
const topShare = (n: number) =>
  Math.round((sorted.slice(0, n).reduce((s, v) => s + v, 0) / total) * 1000) / 1000;
return { top1_share: topShare(1), top3_share: topShare(3), ... };

// After:
const topShare = (n: number) =>
  pct((sorted.slice(0, n).reduce((s, v) => s + v, 0) / total) * 100);
return { top1_share_pct: topShare(1), top3_share_pct: topShare(3), ... };
```

**Call sites to update:**
- `analyze_candidate_profile` (~line 167): field names change; remove any manual `× 100` if present
- `analyze_party_profile` (~line 244): same
- `analyze_geographic_concentration` (~lines 690–692): currently does `pct(conc.top1_share * 100)` — after fix, change to `conc.top1_share_pct` (no multiplication)

**Regression test update:** `BUG-5` describe block — update to assert new field names and that values are > 1 (clearly a percentage).

- [ ] Refactor `concentrationMetrics()` return values in `analytics/index.ts`
- [ ] Update all three call sites
- [ ] Update `bugs.regression.test.ts` BUG-5 block

---

### Step 4: BUG-3 — Fix `find_exposed_vote_pools` misleading "lost votes" (🔴 Critical)

**File:** `src/tools/strategic/index.ts:203–214`

**Change:**
```typescript
// Before:
const totalLostVotes = exposed.reduce(
  (s, a) => s + ((a.votes_year1 ?? 0) - (a.votes_year2 ?? 0)),
  0
);
// ...
total_estimated_lost_votes: totalLostVotes,

// After:
const netVoteCountChange = exposed.reduce(
  (s, a) => s + ((a.votes_year2 ?? 0) - (a.votes_year1 ?? 0)),
  0
);
const totalSharePointsLost = exposed.reduce(
  (s, a) => s + ((a.share_year1 ?? 0) - (a.share_year2 ?? 0)),
  0
);
// ...
net_vote_count_change_in_exposed_areas: netVoteCountChange,   // positive = gained raw votes; negative = lost
total_share_points_lost_in_exposed_areas: round2(totalSharePointsLost),
```

Note: `netVoteCountChange` uses year2 − year1 (positive = gained), which is less misleading than year1 − year2. Add a `note` field clarifying sign convention.

**Regression test update:** `BUG-3` describe block — assert new field names; verify `net_vote_count_change` is positive when turnout rose.

- [ ] Fix `strategic/index.ts:203–214`
- [ ] Update `bugs.regression.test.ts` BUG-3 block

---

### Step 5: BUG-9 — Fix `c3_size` to use actual electorate size (🔵 Low, prerequisite for BUG-4)

**File:** `src/tools/strategic/index.ts:457–458`

**Change:** `allVotesByArea` is already computed correctly at lines 420–424 but not used. Wire it in:

```typescript
// Before:
const c3_size = maxVotes > 0 ? r.votes / maxVotes : 0;

// After:
const maxTotalVotes = Math.max(...Array.from(allVotesByArea.values()), 1);
const c3_size = (allVotesByArea.get(r.area_id) ?? 0) / maxTotalVotes;
```

Update `scoring_methodology` description: `"c3_size: electorate size (total votes cast in area / largest area total)"`.

**Regression test update:** `BUG-9` describe block — update to assert c3 now uses total votes, not party votes.

- [ ] Fix `strategic/index.ts:457–458` and update `scoring_methodology` description
- [ ] Update `bugs.regression.test.ts` BUG-9 block

---

### Step 6: BUG-4 — Remove anti-correlated c4; redistribute weights (🟠 High)

**File:** `src/tools/strategic/index.ts:446–472`

**Decision:** Remove c4 entirely. c1 and c4 are mathematically identical (c4 = 1 − c1), so c4 adds zero independent information. A 3-component model is more honest.

**New weights (must sum to 1.0):**
- c1_current_support: `0.40` (up from 0.35)
- c2_trend: `0.35` (up from 0.25)
- c3_size: `0.25` (up from 0.20)

**Change:**
```typescript
// Remove c4 computation entirely.
// Update composite:
const score = round2(0.40 * c1 + 0.35 * c2 + 0.25 * c3_size);

// Update scoring_methodology output:
scoring_methodology: {
  components: 3,
  c1_current_support: { weight: 0.40, description: 'Party share relative to national (capped at 2×)' },
  c2_trend: { weight: 0.35, description: 'Vote share change trend (±10pp scale)' },
  c3_size: { weight: 0.25, description: 'Electorate size (total votes / largest area total)' },
  note: 'c4 (upside) removed in Phase 19: it was mathematically identical to 1 − c1 and added no independent information.',
}
```

**Regression test update:** `BUG-4` describe block — add assertion that the 3-component formula produces correct values; remove or comment out the c4 anti-correlation tests (they document a fixed bug).

- [ ] Remove c4 from `strategic/index.ts`; update score formula and `scoring_methodology`
- [ ] Update `bugs.regression.test.ts` BUG-4 block

---

### Step 7: BUG-8 — Add magnitude threshold to co-movement classification (🟡 Medium)

**File:** `src/tools/strategic/index.ts:319–322`

**Change:**
```typescript
// Before:
co_movement: (loser_change !== null && gainer_change !== null)
  ? (loser_change < 0 && gainer_change > 0 ? 'consistent_with_transfer' : 'inconsistent')
  : 'insufficient_data',

// After (min_votes threshold + proportionality check):
co_movement: (loser_change !== null && gainer_change !== null)
  ? (
      loser_change < 0 &&
      gainer_change > 0 &&
      Math.abs(loser_change) >= MIN_TRANSFER_VOTES &&
      gainer_change >= 0.1 * Math.abs(loser_change)
        ? 'consistent_with_transfer'
        : 'inconsistent'
    )
  : 'insufficient_data',
```

Add `const MIN_TRANSFER_VOTES = 50;` as a module-level constant (not a user parameter — keep the tool interface stable). This filters out noise cases where 1–2 vote changes are classified as transfer evidence.

**Regression test update:** `BUG-8` describe block — the `[CURRENTLY FAILING]` tests now become the passing behavior.

- [ ] Fix `strategic/index.ts:319–322`; add `MIN_TRANSFER_VOTES` constant
- [ ] Update `bugs.regression.test.ts` BUG-8 block

---

### Step 8: BUG-6 — Add warning when `analyze_candidate_profile` uses fallback vote sum (🟡 Medium)

**File:** `src/tools/analytics/index.ts:119,127`

**Change:** When the vaalipiiri-level aggregate row is missing and the code falls back to summing äänestysalue rows, add a `data_warning` field to the output:

```typescript
const vpRow = candidateRows.find((r) => r.area_level === 'vaalipiiri');
const usingFallback = !vpRow;
const totalVotes = vpRow?.votes ?? candidateRows
  .filter((r) => r.area_level === 'aanestysalue')
  .reduce((s, r) => s + r.votes, 0);

// In output:
...(usingFallback ? {
  data_warning: 'total_votes reconstructed by summing äänestysalue rows — vaalipiiri aggregate not found. May be incomplete if not all äänestysalue rows were loaded.'
} : {}),
```

No regression test needed (no existing test covers this path).

- [ ] Fix `analytics/index.ts:119,127`

---

### Step 9: BUG-7 — Document Pedersen inflation from party structural changes (🟡 Medium)

**File:** `src/tools/area/index.ts` — `analyze_area_volatility` and `get_area_profile` Pedersen output blocks

**Change:** Add a `method_note` field to both tool outputs:

```typescript
method_note: 'Pedersen index is computed from party_id keys. Party splits, mergers, or renames (e.g. SMP→PS 1995, Sini split 2017) create "ghost" volatility — the old party appears to go to 0 and the new one appears from 0. Elections spanning these structural changes will show inflated volatility that reflects label changes, not voter movement.',
```

No code logic changes — documentation only.

- [ ] Add `method_note` to `analyze_area_volatility` output in `area/index.ts`
- [ ] Add `method_note` to `get_area_profile` volatility section in `area/index.ts`

---

### Step 10: BUG-10 — Detect diacritic normalization collisions (🔵 Low)

**File:** `src/tools/strategic/index.ts` — `detect_inactive_high_vote_candidates`, `normalizeCandidateName`

**Change:** After building the `toYearMap` (normalized name → candidate), detect cases where two distinct raw names normalize to the same key:

```typescript
// After building toYearNames array:
const normalizedNames = toYearNames.map(normalizeCandidateName);
const seen = new Set<string>();
const collisions = new Set<string>();
for (const n of normalizedNames) {
  if (seen.has(n)) collisions.add(n);
  seen.add(n);
}
// In output:
...(collisions.size > 0 ? {
  name_normalization_warning: `${collisions.size} normalized name collision(s) detected — distinct candidates share the same normalized form (e.g. Mäki vs Maki). Inactive/active status for these candidates may be incorrect.`,
} : {}),
```

**Regression test update:** `BUG-10` describe block — add assertion that the collision detection fires on the Mäki/Maki case.

- [ ] Fix `strategic/index.ts` — add collision detection after `toYearMap` construction
- [ ] Update `bugs.regression.test.ts` BUG-10 block

---

### Step 11: Remove resolved bug caveats from `audit/index.ts`

Once BUG-1 and BUG-2 fixes are in place:
- Remove `bug_share_of_party_vote_ratio` entry (lines 225–231) from the caveat registry
- Remove `bug_party_analysis_double_counts` entry (lines 232–238) from the caveat registry
- Update `get_data_caveats` tool description string if it mentions these by name

- [ ] Remove BUG-1 and BUG-2 caveat entries from `audit/index.ts`

---

### Step 12: Update regression test suite

All `[CURRENTLY FAILING]` labels in `bugs.regression.test.ts` describe **buggy** behavior. After fixes, these tests will fail because the code no longer behaves that way. Update each:

- **BUG-1**: Replace "buggy formula returns ratio" test with assertion that `analytics/index.ts:96` now produces a percentage
- **BUG-2**: Replace "buggy approach sums vaalipiiri" test with assertion that kunta-only filter produces correct total
- **BUG-3**: Update field names (`net_vote_count_change_in_exposed_areas`, `total_share_points_lost_in_exposed_areas`)
- **BUG-4**: Remove c4 anti-correlation tests (c4 no longer exists); add 3-component weight verification
- **BUG-5**: Update field names to `_pct` variants; update `toBeLessThan(1)` to `toBeGreaterThan(1)`
- **BUG-8**: Verify noise cases are now classified `'inconsistent'`
- **BUG-9**: Verify c3 now uses `allVotesByArea` total
- **BUG-10**: Verify collision detection fires

- [ ] Update `bugs.regression.test.ts` to assert correct post-fix behavior throughout

---

### Step 13: Build + test

- [x] `npm run build` — no TypeScript errors
- [x] `npm test` — 96/96 tests pass (5 new regression tests added)
- [x] Logbook entry

---

## Phase 20: Critical Security Fixes ✅ COMPLETE

**Goal:** Close the critical and high-severity security vulnerabilities identified in `audits/SECURITY_AUDIT_2026-03.md`. All items are in `server-http.ts` or `normalizer.ts`. No tool interface changes.

**Reference:** `BACKLOG.md` — NEW-SEC-1/2/3/4/6/9/10

**Test plan:** `npm run build` + `npm test` after each fix; manual smoke test of rate limiter via curl.

---

### Step 1: NEW-SEC-2 — Fix X-Forwarded-For unconditional trust (🔴 Critical)

**File:** `src/server-http.ts` — `getClientIp()` function

**Issue:** Rate limiter accepts any `X-Forwarded-For` header value from any client, enabling trivial bypass by spoofing the header. A client can rotate IPs and never hit the 30 req/60s limit.

**Fix:** Only trust `X-Forwarded-For` when the actual socket IP is a known trusted proxy (loopback or RFC-1918 range). Otherwise fall back to `req.socket.remoteAddress`.

```typescript
const TRUSTED_PROXY_RANGES = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
const isTrustedProxy = (ip: string) =>
  TRUSTED_PROXY_RANGES.includes(ip) ||
  /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(ip);

function getClientIp(req: IncomingMessage): string {
  const socketIp = req.socket.remoteAddress ?? '0.0.0.0';
  if (isTrustedProxy(socketIp)) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string') return xff.split(',')[0].trim();
  }
  return socketIp;
}
```

- [ ] Fix `getClientIp()` in `server-http.ts`
- [ ] Add trusted proxy range check

---

### Step 2: NEW-SEC-1 / SEC-8 — Prototype pollution via `Object.fromEntries` (🔴 Critical)

**File:** `src/data/normalizer.ts`

**Issue:** If PxWeb API returns a response with a key like `__proto__` or `constructor`, `Object.fromEntries` writes to `Object.prototype`, corrupting the runtime for all subsequent operations.

**Fix:** Filter dangerous keys before passing to `Object.fromEntries`.

```typescript
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const safeFromEntries = <V>(entries: [string, V][]): Record<string, V> =>
  Object.fromEntries(entries.filter(([k]) => !FORBIDDEN_KEYS.has(k)));
```

Replace all `Object.fromEntries(...)` calls in `normalizer.ts` with `safeFromEntries(...)`.

- [ ] Add `safeFromEntries()` helper to `normalizer.ts`
- [ ] Replace all `Object.fromEntries` call sites

---

### Step 3: NEW-SEC-3 — Add request body size limit (🟠 High)

**File:** `src/server-http.ts` — request body accumulation

**Issue:** No maximum body size — a client can send an arbitrarily large POST body and exhaust memory.

**Fix:** Reject requests where accumulated body exceeds 1 MB (1,048,576 bytes).

```typescript
const MAX_BODY_BYTES = 1_048_576; // 1 MB
// In body accumulation loop:
if (body.length > MAX_BODY_BYTES) {
  res.writeHead(413, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Request body too large' }));
  return;
}
```

- [ ] Add body size guard to `server-http.ts`

---

### Step 4: NEW-SEC-4 — Add security response headers (🟠 High)

**File:** `src/server-http.ts`

**Issue:** No security headers — missing `X-Content-Type-Options`, `X-Frame-Options`, `Content-Security-Policy`.

**Fix:** Add headers to all responses via a helper called at the start of each request handler.

```typescript
function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'none'");
}
```

- [ ] Add `setSecurityHeaders()` and call it on every response

---

### Step 5: NEW-SEC-9 — Validate `CACHE_FILE` env var path (🟠 High)

**File:** Cache initialization code (wherever `CACHE_FILE` env var is read)

**Issue:** If `CACHE_FILE` is set to an absolute path outside the project directory (e.g. `/etc/passwd`), the service will write there without validation.

**Fix:** Resolve the path and assert it starts with the expected cache directory (or is a relative path).

```typescript
const rawCachePath = process.env.CACHE_FILE ?? 'cache-store.json';
const resolvedPath = path.resolve(rawCachePath);
const expectedDir = path.resolve('.');
if (!resolvedPath.startsWith(expectedDir + path.sep) && !resolvedPath.startsWith(expectedDir)) {
  throw new Error(`CACHE_FILE path escapes project directory: ${resolvedPath}`);
}
```

- [ ] Add path validation when `CACHE_FILE` env var is consumed

---

### Step 6: NEW-SEC-10 — Sanitize user query in error messages (🟠 High)

**File:** `src/server-http.ts`, tool files with `catch` blocks

**Issue:** Raw user input (tool arguments) echoed verbatim into error messages creates a prompt injection surface — a crafted query string can manipulate LLM context downstream.

**Fix:** Truncate and strip control characters from any user input that appears in error output. Max 200 chars.

```typescript
const sanitizeForLog = (s: unknown): string =>
  String(s).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200);
```

- [ ] Add `sanitizeForLog()` helper
- [ ] Replace raw input in error messages with `sanitizeForLog(input)`

---

### Step 7: NEW-SEC-6 — Cache integrity validation on load (🟠 High)

**File:** `src/cache/cache.ts` — disk cache load on startup

**Issue:** Cached JSON file is loaded and parsed without any integrity check. A corrupted or tampered `cache-store.json` silently produces wrong results.

**Fix:** Compute SHA-256 of the file on write; store hash alongside. On read, recompute hash and reject if mismatch (clear cache and start fresh).

- [ ] Add hash-on-write, hash-check-on-read to `cache.ts`

---

### Step 8: Build + test

- [ ] `npm run build` — no TypeScript errors
- [ ] `npm test` — all tests pass
- [ ] Commit: `Phase 20: critical security fixes (XFF, prototype pollution, body limit, headers, cache integrity)`
- [ ] Push to GitHub
- [ ] Logbook entry

---

## Phase 21: Critical Analytics Correctness ✅ COMPLETE

**Goal:** Fix correctness bugs that affect analysis outputs: case-sensitive party matching (affects all tools), the potentially incomplete BUG-5 fix, the broken c2 trend normalization in `rank_areas_by_party_presence`, and the missing seat-outcome caveat on `rank_within_party`.

**Reference:** `BACKLOG.md` — STAT-1, STAT-2, POL-7, POL-12, QUAL-2

---

### Step 1: STAT-1 — Fix `matchesParty` case-sensitivity (🟠 High)

**File:** `src/tools/shared.ts` — `matchesParty()` function (and any inline `row.party_id === query` call sites)

**Issue:** `matchesParty('kok', ...)` fails when stored `party_id = 'KOK'`. Affects all strategic and analytics tools when called from an LLM with lowercase input.

**Fix:**
```typescript
// In matchesParty():
const q = query.toLowerCase();
return row.party_id?.toLowerCase() === q || row.party_name?.toLowerCase().includes(q);
```

- [ ] Fix `matchesParty()` in `shared.ts`
- [ ] Search for inline `=== query` / `=== party` comparisons in tool files and lowercase them
- [ ] Add test case to `shared.test.ts` for lowercase input matching uppercase `party_id`

---

### Step 2: STAT-2 — Verify BUG-5 fix covers all `concentrationMetrics()` callers (🟠 High)

**File:** `src/tools/analytics/index.ts`

**Issue:** Phase 19 fixed `concentrationMetrics()` to return `_pct` fields, but `analyze_candidate_profile` and `analyze_party_profile` may still reference old field names (`top1_share`, `top3_share`, etc.) and receive percentages they treat as fractions or vice versa.

**Fix:**
1. Search all references to `conc.top1_share`, `conc.top3_share`, `conc.top5_share`, `conc.top10_share` in `analytics/index.ts`
2. Update each to `conc.top1_share_pct`, `conc.top3_share_pct`, etc.
3. Remove any manual `× 100` multiply that was compensating for the old fraction output

- [ ] Audit all callers of `concentrationMetrics()` in `analytics/index.ts`
- [ ] Update field references to `_pct` variants at all call sites
- [ ] Add assertions in test that `analyze_candidate_profile` concentration values are > 1 (percentages)

---

### Step 3: POL-7 — Fix c2 trend normalization scale (🔴 Critical)

**File:** `src/tools/strategic/index.ts` — `rank_areas_by_party_presence`, c2 computation

**Issue:** Current formula: `c2 = Math.min(1, Math.max(0, 0.5 + trendPp / 20))` uses ±10pp scale. Finnish area-level swings are typically ±1–3pp, so all real-world variation compresses into a 0.45–0.65 range — c2 effectively contributes only noise.

**Fix:** Replace fixed scale with percentile rank across the actual distribution of trend values for this party/election pair.

```typescript
// After computing trendPp for each area, collect all trend values:
const trendValues = results.map(r => r.trendPp).sort((a, b) => a - b);
// Then for each area:
const rank = trendValues.filter(t => t <= area.trendPp).length;
const c2 = trendValues.length > 1 ? (rank - 1) / (trendValues.length - 1) : 0.5;
```

Update `scoring_methodology.c2_trend.description` to reflect percentile-rank method.

- [ ] Replace fixed ±10pp c2 formula with percentile rank
- [ ] Update `scoring_methodology` description
- [ ] Update Phase 19 `BUG-4` regression tests if they assumed fixed-scale c2 behavior

---

### Step 4: POL-12 — Add seat-outcome caveat to `rank_within_party` outputs (🔴 Critical)

**Files:** All tools that output `rank_within_party`: `analytics/index.ts`, `retrieval/index.ts`

**Issue:** A candidate ranked #1 within their party may or may not have won a seat — depends on party list size, d'Hondt allocation, thresholds. No seat data exists in the MCP at all. Without an explicit caveat, consumers will interpret rank as outcome.

**Fix:** Add a `rank_caveat` field alongside every `rank_within_party` output:

```typescript
rank_within_party_caveat: 'Intra-party ranking only. Does not indicate election outcome or seat allocation — seat distribution depends on party total votes and d\'Hondt divisor calculation, which this service does not model.'
```

Alternatively, add it once to the `method` block of each affected tool.

- [ ] Add `rank_within_party_caveat` to `analyze_candidate_profile` output
- [ ] Add `rank_within_party_caveat` to `analyze_within_party_position` output
- [ ] Add `rank_within_party_caveat` to `get_rankings` / `get_top_n` output
- [ ] Add caveat to `get_data_caveats` registry in `audit/index.ts`

---

### Step 5: QUAL-2 — Register open POL-series issues in `get_data_caveats` (🟠 High)

**File:** `src/tools/audit/index.ts` — caveat registry

**Issue:** The most analytically dangerous open issues (POL-7, POL-12, unresolved framing issues) are not surfaced by `get_data_caveats`. LLM consumers have no way to know these limitations exist.

**Fix:** Add caveat entries for:
- `rank_within_party_no_seat_data` (🔴 Critical) — scope: `candidate`
- `c2_trend_percentile_scale` (🟠 High) — scope: `strategic`
- `pedersen_period_length` (🟠 High) — scope: `area`
- `compare_across_elections_eu_second_order` (🟡 Medium) — scope: `cross_election`

- [ ] Add 4 caveat entries to `audit/index.ts`

---

### Step 6: Build + test

- [ ] `npm run build` — no TypeScript errors
- [ ] `npm test` — all tests pass
- [ ] Commit: `Phase 21: analytics correctness — STAT-1, STAT-2, POL-7, POL-12, QUAL-2`
- [ ] Push to GitHub
- [ ] Logbook entry

---

## Phase 22: Robustness & Error Handling ✅ COMPLETE

**Goal:** Eliminate silent failure modes: silent catch blocks, missing API response validation, and broken entity matching for short strings.

**Reference:** `BACKLOG.md` — FUNC-5, FUNC-6, FUNC-7

---

### Step 1: FUNC-5 — Replace silent `catch (_)` blocks (🟠 High)

**File:** `src/tools/retrieval/index.ts` and other tool files

**Issue:** `catch (_) {}` swallows all errors silently. Callers receive empty/partial results with no indication that something went wrong.

**Fix:** Replace with `catch (err) { console.error('[tool-name]', err); }` and where possible include a `data_warning` or `error` field in the returned object.

- [ ] Find all `catch (_) {}` instances across `src/tools/`
- [ ] Replace with logged catch + surface error in output where feasible

---

### Step 2: FUNC-6 — Runtime validation of PxWeb API responses (🟠 High)

**File:** `src/api/pxweb-client.ts`, `src/data/normalizer.ts`

**Issue:** If PxWeb changes its schema or returns an error payload in JSON, the normalizer silently produces empty/wrong rows with no indication of the failure.

**Fix:** Add lightweight schema guards on raw API responses before passing to normalizer. Verify expected top-level fields (`columns`, `data`, etc.) are present and are the right types. Throw a descriptive error on mismatch.

- [ ] Add response shape guards in `pxweb-client.ts` after `response.json()`
- [ ] Add guard in `normalizer.ts` before processing `metadata.variables`

---

### Step 3: FUNC-7 — Fix `bigramSimilarity` for single-character inputs (🟡 Medium)

**File:** Entity resolution code (wherever `bigramSimilarity` / `buildBigrams` is defined)

**Issue:** A string of length 1 has 0 bigrams — score is 0/0 = 0. Single-character nicknames or initials never match anything.

**Fix:** For strings shorter than 2 characters, fall back to exact match (score 1.0) or prefix match.

```typescript
if (a.length < 2 || b.length < 2) {
  return a === b ? 1.0 : (b.startsWith(a) || a.startsWith(b) ? 0.5 : 0);
}
```

- [ ] Add short-string fallback to bigram similarity function
- [ ] Add test case: single-character input matching

---

### Step 4: Build + test

- [ ] `npm run build` — no TypeScript errors
- [ ] `npm test` — all tests pass
- [ ] Commit: `Phase 22: robustness — silent catch, API validation, bigram short-string fix`
- [ ] Push to GitHub
- [ ] Logbook entry

---

## Phase 23: Political Science Framing Improvements ✅ COMPLETE

**Goal:** Address the remaining POLSCI_AUDIT findings that affect analytical correctness without requiring breaking output changes. Mostly documentation, caveats, and minor output field additions.

**Reference:** `BACKLOG.md` — POL-5, POL-6, POL-8, POL-9, POL-10, POL-11, POL-13, POL-14, POL-15, POL-16, STAT-3

---

### POL-6: Move caveats before results in `compare_across_elections`

**File:** `src/tools/analytics/index.ts`

Reorder output object so `caveats` and `comparability_notes` appear before `results[]`. Affects JSON key ordering.

- [ ] Reorder output fields in `compare_across_elections`

---

### POL-8: Add `pedersen_per_cycle` to volatility outputs

**Files:** `src/tools/area/index.ts`, `src/tools/analytics/index.ts`

Add `years_between` (computed from election years) and `pedersen_per_cycle` (= `pedersen_index / (years_between / 4)`) so consumers can compare volatility across different-length inter-election periods.

- [ ] Add `years_between` and `pedersen_per_cycle` to `analyze_area_volatility` output
- [ ] Add to `get_area_profile` Pedersen section

---

### POL-9 / STAT-4: Fix `vote_share_change_pp` rounding artifact

**File:** relevant analytics tools

Compute change from raw vote counts (`(votes2 / total2 - votes1 / total1) * 100`) before rounding, not from already-rounded `pct()` values.

- [ ] Identify all `vote_share_change_pp` computation sites
- [ ] Fix to derive from raw values, round at output

---

### POL-10: Contextualise `find_area_overperformance` by area size

**File:** `src/tools/analytics/index.ts`

Add `area_electorate_votes` field to overperformance rows so consumers know whether a 5pp overperformance is in a 500-voter or a 50,000-voter area.

- [ ] Add `area_total_votes` to overperformance output rows

---

### POL-11: Filter micro-parties from `biggest_gainer`

**File:** `src/tools/area/index.ts`

Add a minimum absolute vote threshold (e.g. ≥ 1% national share, or ≥ 100 votes) before qualifying a party as `biggest_gainer` / `biggest_loser`.

- [ ] Add minimum threshold to `biggest_gainer` / `biggest_loser` computation

---

### POL-13: Expand EU caveat in `compare_across_elections`

**File:** `src/tools/analytics/index.ts`

Add turnout ratio quantification and note on second-order election dynamics (Reif & Schmitt 1980) to the EU caveat block.

- [ ] Expand EU caveat text

---

### POL-14: Quantify municipal expanded electorate caveat

**File:** `src/tools/analytics/index.ts`

When `election_type = 'municipal'` is compared with `'parliamentary'`, add a caveat noting that municipal elections include all residents 18+ (including non-citizens) while parliamentary is citizens-only.

- [ ] Add quantified caveat for municipal/parliamentary cross-comparison

---

### POL-15: Verify `subnatLevel` for EU elections

**File:** `src/tools/shared.ts` — `subnatLevel()` function

Verify that `subnatLevel('eu')` returns the correct level (currently returns `'vaalipiiri'` — may need to return `'national'` since Finland is a single EU constituency).

- [ ] Verify and correct `subnatLevel('eu')`
- [ ] Update test in `shared.test.ts`

---

### POL-16: Name specific Finnish party discontinuities in Pedersen note

**File:** `src/tools/area/index.ts`

The current `pedersen_method_note` mentions party splits/mergers generically. Name the specific events: SMP→PS (1995 election), Sini split (2017, appears in 2019 results), SKL→KD (2001).

- [ ] Update `pedersen_method_note` text with specific party/year events

---

### STAT-3: Clamp histogram last bucket to actual max

**File:** `src/tools/analytics/index.ts` — `analyze_vote_distribution`

The last histogram bucket's `to` field should equal `max` (the actual data maximum), not the arithmetically computed bucket boundary.

- [ ] Clamp last bucket `to` to actual data max

---

### POL-5: Add survivorship bias note to `get_area_profile`

**File:** `src/tools/area/index.ts`

Add a `trend_caveat` field noting that historical trend averages exclude candidates who left politics — the trend skews toward more successful candidates.

- [ ] Add `trend_caveat` to `get_area_profile` historical section

---

### Step final: Build + test

- [ ] `npm run build` — no TypeScript errors
- [ ] `npm test` — all tests pass
- [ ] Commit: `Phase 23: PolSci framing — POL-5/6/8/9/10/11/13/14/15/16, STAT-3`
- [ ] Push to GitHub
- [ ] Logbook entry

---

## Phase 24: Efficiency & Infrastructure ✅ COMPLETE

**Goal:** Address remaining efficiency, security-medium, and code quality items that don't fit earlier phases.

**Reference:** `BACKLOG.md` — NEW-SEC-7/8, COST-3, QUAL-6, EFF-2 (verify), TLS

---

### NEW-SEC-7: Add structured access logging

Log each tool call with: timestamp, tool name, sanitized query params, IP, response status, duration. Useful for debugging and future abuse detection.

- [x] Add access log to `server-http.ts` request handler — body chunks collected via EventEmitter broadcast alongside transport; log format: `ISO METHOD URL status Xms ip=Y tool=Z args=W`

---

### NEW-SEC-8: Document multi-instance rate limit limitation

The in-memory rate limiter is per-process. Document in `CLAUDE.md` and `server-http.ts` comments that horizontal scaling requires external state (Redis). No code change needed until deployment scales.

- [x] Add comment in `server-http.ts` near rate limiter
- [x] Add note to `CLAUDE.md` deployment section

---

### COST-3: Reduce cache key redundancy in `compare_elections`

Each year in `compare_elections` triggers a separate API call with a year-specific cache key. Investigate whether the 13sw table (all years in one table) can be fetched once and sliced for multiple years.

- [x] Investigated: each `loadPartyResults` call fetches one year via PxWeb `Vuosi` filter, cached as `data:13sw:parliamentary:YEAR:all`. Bulk-fetch optimization would require significant architectural change to `loaders.ts`. Deferred to BACKLOG — no code change.

---

### EFF-2: Verify `compare_candidates` fix from Phase 18

Phase 18 logged EFF-2 as fixed (pre-built `Map<candidateId, rank>`). Verify the fix is in place; remove from backlog if confirmed.

- [x] Confirmed: `compare_candidates` line 254 builds `rankMap = new Map(...)` and uses `rankMap.get(cid)` — O(1). No fix needed.

---

### QUAL-6: Audit system prompt against registered election tables

The system prompt's data coverage section may be stale. Compare it against `election-tables.ts` `ALL_ELECTION_TABLES` entries.

- [x] No system prompt file exists in-repo. The system prompt is registered as a MCP prompt at runtime via `server.registerPrompt()`. In-tree audit is not possible; cross-reference must be done via live server. Deferred to Phase 26 live tests.

---

### Step final: Build + test

- [x] `npm run build` — clean
- [x] `npm test` — 101/101 passed
- [x] Commit `d4c5e6a`: `Phase 24: efficiency and infrastructure cleanup`
- [x] Push to GitHub
- [x] Logbook entry

---

## Phase 25: Backlog Audit Closure ✅ COMPLETE

**Goal:** Close all open BACKLOG items that can be resolved without a live server. Add remaining items to the plan. Verify or fix each item.

**Reference:** `BACKLOG.md` — STAT-2, POL-10, NEW-SEC-5, COST-3, QUAL-6

---

### STAT-2: Verify `concentrationMetrics()` callers use correct `_pct` field names

Concern: Phase 19 fixed `concentrationMetrics()` to return `_pct` fields, but callers in `analyze_candidate_profile` and `analyze_party_profile` may still reference old names (`top1_share` etc.).

- [x] **Verdict: false alarm.** All callers (`analyze_candidate_profile` line 125, `analyze_party_profile` line 204, `analyze_geographic_concentration` lines 672/700) embed the whole `concentration` object directly into the response without destructuring. Since `concentrationMetrics()` returns `_pct` field names, the output is correct. No code change needed.

---

### POL-10: `find_area_underperformance` missing `area_total_votes` field

`find_area_overperformance` already added `area_total_votes` to each row (Phase 23). `find_area_underperformance` was missing it — inconsistent with its symmetric counterpart.

- [x] Added `area_total_votes` to both party and candidate branches of `find_area_underperformance` (`analytics/index.ts`). Area totals computed from same row set as overperformance to ensure consistency.

---

### NEW-SEC-5: No TLS

Service runs plain HTTP. TLS must be terminated at the infrastructure level (reverse proxy, Cloudflare, Azure App Service TLS offload).

- [x] Out of scope for this codebase. No application-layer change possible or appropriate. Documented in `CLAUDE.md` deployment section. Remains an infrastructure concern for deployment.

---

### COST-3 / QUAL-6: Already assessed

- [x] COST-3 — deferred architectural change. Documented in Phase 24.
- [x] QUAL-6 — no in-repo system prompt file. Deferred to Phase 26 live tests.

---

### Step final: Build + test

- [x] `npm run build` — clean
- [x] `npm test` — all tests pass
- [x] Commit: `Phase 25: backlog audit closure`
- [x] Push to GitHub
- [x] Logbook entry

---

## Phase 26: Integration Tests & Live Validation ⬜ PLANNED

**Goal:** Validate the full system end-to-end with a running MCP server against real election data. Also audit the registered MCP system prompt against `election-tables.ts` (QUAL-6 deferred from Phase 25).

**Reference:** `BACKLOG.md` — Phase 15 live test, Phase 16 system prompt test, QUAL-6

---

### Phase 15 live test: `compare_across_elections` SDP

Run against a live server:
```
compare_across_elections SDP [municipal 2021, parliamentary 2023, regional 2025]
```
Expected:
- Three result rows with plausible vote shares
- Cross-type caveat present
- Municipal national-share note present

- [ ] Start MCP server
- [ ] Run query via MCP client or Claude Desktop
- [ ] Verify output structure and values

---

### Phase 16: Claude Desktop system prompt test

Connect MCP server to Claude Desktop using the registered `system` prompt. Run a realistic analyst workflow:
1. Resolve a candidate
2. Get their profile
3. Compare their party across elections
4. Get strategic area ranking

- [ ] Connect Claude Desktop to local MCP server
- [ ] Run full analyst workflow
- [ ] Document any tool errors, missing data, or misleading outputs
- [ ] Create BACKLOG items for any issues found

---

### Step final

- [ ] Logbook entry with live test results
- [ ] Commit any fixes found during live testing
- [ ] Push to GitHub
