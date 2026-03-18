# Implementation Plan: Dynamic Query Engine & Comparable Workflows

**Created:** 2026-03-18
**Motivation:** Real LLM test sessions revealed that the MCP has the right architecture but wrong data coverage. The Tilastokeskus API has äänestysalue-level data for all election types and years — but the current tool layer only surfaces a fraction of it. This plan redesigns around a generic query engine that supports any combination of candidate × year × election type × geographic level.

---

## Core design principle (shift)

**Current model:** Tools know which table to call. Input is validated against a pre-enumerated set of options.

**New model:** The table registry becomes a routing engine. A query is expressed as dimensions (`subject`, `election_type`, `year`, `area_level`, `filters`) and the engine finds the right table, builds the query, fetches data, and normalizes it — regardless of election type.

The LLM should be able to ask: *"Compare VIHR support in Tampere across all elections 2019–2025"* and the engine resolves which tables to combine, what area codes mean in each, and how to join the results.

---

## Phase 0: HTTP Body Bug Fix (CRITICAL — do first)

**Goal:** Fix broken production HTTP before any other work.

The HTTP transport in `server-http.ts` does not buffer the request body before passing it to the MCP handler. This means POST requests with a body (all tool calls in HTTP mode) silently fail or produce empty input. The MCP works over stdio but is broken over HTTP.

**Fix:** Buffer the full request body before parsing it as JSON. This is a one-liner change to the body-reading section of `server-http.ts`.

**Test:** Send a `tools/call` POST request with a non-trivial body (e.g. `get_party_results`) via HTTP and confirm it returns a valid result rather than an error or empty response.

**This must be done before any Phase A work.** Nothing else matters if the HTTP transport is broken in production.

---

## Phase A: Table Registry Expansion

**Goal:** Add all confirmed-working tables from `scan_tables.mjs` to `election-tables.ts`. No new tools — just correct data routing.

### A1: Year-specific party tables (fixes 403)

Replace multi-year table queries at area level with year-specific tables that stay under PxWeb's cell-count limit.

| Add to registry | Election | Years | Area coverage | Replaces |
|---|---|---|---|---|
| `statfin_evaa_pxt_13t2` | parliamentary | 2023 | koko_suomi → vaalipiiri → kunta → äänestysalue | `13sw` for area queries |
| `statfin_kvaa_pxt_14vm` | municipal | 2025 | koko_suomi → vaalipiiri → kunta → äänestysalue | `14z7` for area queries |
| `statfin_euvaa_pxt_14h2` | eu_parliament | 2024 | koko_suomi → vaalipiiri → äänestysalue | `14gv` for area queries |

**Schema for `13t2`:** `Alue/Äänestysalue` (2131 values: SSS, VP##, KU###, ##NNN###) × `Puolue` × `Ehdokkaan sukupuoli` × `Tiedot`

**Schema for `14vm`:** `Äänestysalue` (1963 values) × `Puolue` × `Ehdokkaan sukupuoli` × `Tiedot` — note: `KU###` prefix for kunta, `01091001A` format for äänestysalue

**Schema for `14h2`:** `Äänestysalue` (2079 values) × `Puolue` × `Sukupuoli` × `Tiedot`

**Routing rule — the 403 is triggered by cell count, not area level:**
The problem is not which area level is requested but whether `areaId` is omitted (fetching all areas at once). `13sw` filtered to a single area returns ~20 parties × 2 measures = ~40 cells: no 403. But fetching all areas from `13sw` for one year gives ~305 areas × 20 parties × 2 measures ≈ 12,000+ cells, which exceeds the PxWeb limit.

Routing logic in `loadPartyResults`:
1. `areaId` is specified (filtering to one area) → multi-year table is fine, small response
2. `areaId` is undefined (fetching all areas) → use year-specific table for that year; `13t2`/`14vm`/`14h2` contain all area levels in one query within cell limits

### A2: EU candidate tables by area

| Add to registry | Content | Area levels |
|---|---|---|
| `statfin_euvaa_pxt_14gx` | Candidate votes by vaalipiiri (2024) | koko_suomi + 13 vaalipiirit |
| `statfin_euvaa_pxt_14gw` | Candidate votes by äänestysalue (2024) | koko_suomi + vaalipiiri + äänestysalue |

`14gx` variables: `Vuosi`, `Puolue ja ehdokas` (247 values: parties + individual candidates), `Vaalipiiri` (14 values)

**ElectionTableSet schema additions required:**
Neither table fits existing `ElectionTableSet` fields. Add two new optional fields to the interface in `election-tables.ts`:

```typescript
/** EU-specific: candidate votes by vaalipiiri (14gx). All candidates, 14 areas, no filter needed. */
candidate_by_vaalipiiri?: string;
/** EU-specific: candidate votes by äänestysalue (14gw). Requires candidate_id filter — see routing rule below. */
candidate_by_aanestysalue_eu?: string;
```

Register on the EU 2024 entry:
```typescript
candidate_by_vaalipiiri:          'statfin_euvaa_pxt_14gx',
candidate_by_aanestysalue_eu:     'statfin_euvaa_pxt_14gw',
```

**Routing rule for `14gw`:** EU candidate queries at äänestysalue level require a `candidate_id` filter. Without one, 247 candidates × 2079 areas exceeds the cell limit. No special chunking logic is needed — any real query (e.g. "how did Harjanne do in Helsinki äänestysalueet?") is naturally anchored to one candidate. If `candidate_id` is missing and `area_level` is `äänestysalue`, return an error requiring it.

- `area_level = vaalipiiri` → use `14gx` (all candidates, 14 areas, ~3500 cells — no filter needed)
- `area_level = äänestysalue`, `candidate_id` provided → use `14gw` filtered to that candidate (~2079 cells)
- `area_level = äänestysalue`, no `candidate_id` → error: "candidate_id required for äänestysalue-level EU candidate queries"

This enables EU candidate results by vaalipiiri — the data the test session failed to return.

### A3: Presidential multi-year vaalipiiri

| Add to registry | Content | Area levels |
|---|---|---|
| `statfin_pvaa_pxt_14db` | Candidate results by vaalipiiri, 1994–2024 | koko_suomi + 13 vaalipiirit |

Enables cross-year presidential candidate comparison at vaalipiiri level without needing äänestysalue tables.

**ElectionTableSet schema addition required:**
`14db` covers multiple years and multiple area levels (koko_suomi + vaalipiiri) — it is not a per-äänestysalue table and doesn't fit `candidate_national` (which implies national totals only). Add one new optional field:

```typescript
/** Presidential/multi-year: candidate votes by vaalipiiri across years (14db). */
candidate_multiyr_vaalipiiri?: string;
```

Register on the presidential 2024 entry:
```typescript
candidate_multiyr_vaalipiiri: 'statfin_pvaa_pxt_14db',
```

### A4: Regional elections (alvaa) — remaining gaps

**Already implemented in `election-tables.ts`:**
- `14y4` — party multi-year 2022+2025, `REGIONAL_PARTY_SCHEMA`, registered on 2025 entry
- `14zu`–`151p` — all 21 per-äänestysalue candidate tables for 2025, registered in `candidate_by_aanestysalue`
- 2022 entry registered (party-only via fallback, no candidate tables — correct)

**Remaining gaps (not yet in registry):**

| Table | Content | Priority |
|---|---|---|
| `14z8`–`14zt` | Candidate summary per hyvinvointialue (21 tables, aggregate level only) | LOW — useful for faster B1 lookup but `14zu`–`151p` already work |
| `14y2` | Party support äänestysalueittain 2025 (year-specific, like `13t2` for regional) | MEDIUM — needed for A1-style routing if regional äänestysalue party queries 403 |
| `14y3` | Turnout multi-year | LOW |
| `157b`–`157f` | Turnout by demographics (5 tables: age/education/language/income/activity) | LOW — add to `voter_turnout_by_demographics` on 2025 entry, analogous to parliamentary |

**Before implementing any of these:** run `scan_tables.mjs` against `StatFin/alvaa/` to confirm the table IDs and schemas are as listed. The `14z8`–`14zt` range in particular needs verification — the B1 resolver can use the already-registered `14zu`–`151p` tables for name lookup instead, making `14z8`–`14zt` optional.

**Regional 2022 candidate data does not exist.** The 2022 entry correctly has no `candidate_by_aanestysalue`. Tools requiring candidate data (`detect_inactive_high_vote_candidates`, `analyze_candidate_profile`) must return a clear error for `regional:2022` — not a silent empty result. Document in `get_data_caveats`.

### A5: Fix election-type-aware year defaults in area tools

Three tools hardcode default year lists that only make sense for parliamentary elections:

- `analyze_area_volatility` defaults to `years: [2011, 2015, 2019, 2023]`
- `get_area_profile` defaults to `history_years: [2015, 2019, 2023]`
- `compare_areas` defaults to `year: 2023`

When called with `election_type: 'municipal'` or `election_type: 'eu_parliament'` etc. without explicit years, these tools silently query years that don't exist for that election type and return empty or partial results with no error.

Fix: add a `DEFAULT_YEARS_BY_TYPE` map and apply it when the caller omits years:

```typescript
const DEFAULT_YEARS_BY_TYPE: Record<ElectionType, number[]> = {
  parliamentary: [2011, 2015, 2019, 2023],
  municipal:     [2012, 2017, 2021, 2025],
  eu_parliament: [2009, 2014, 2019, 2024],
  regional:      [2022, 2025],
  presidential:  [2018, 2024],
};
```

For `compare_areas`, use `DEFAULT_YEARS_BY_TYPE[electionType][last]` as the default single year.

This is a correctness fix, not a feature — these tools currently produce silent wrong output for non-parliamentary election types.

### A6: StatFin_Passiivi scan for historical party tables

**Goal:** Determine whether year-specific party tables equivalent to `13t2` (parl:2023) exist for earlier parliamentary years (2019, 2015, 2011) in the `StatFin_Passiivi` archive.

The multi-year table `13sw` covers 1983–2023 nationally but hits the 403 cell limit when queried at vaalipiiri or kunta level. `13t2` was confirmed for 2023 — earlier equivalents may exist in Passiivi.

**Action:** Run `scan_tables.mjs` against `StatFin_Passiivi/evaa/` and look for tables with `Äänestysalue` or `Vaalipiiri` area dimensions and a year suffix (e.g. `*_2019_*`). For any confirmed table, verify it matches the `13t2` schema (area × party × gender × Tiedot) before adding it to the registry.

**Test:** If a 2019 table is found and registered, `get_party_results(election_type: 'parliamentary', year: 2019, area_level: 'vaalipiiri')` → returns 13 vaalipiiri rows without 403.

**Note:** Until this scan is done, parl:2019 area queries fall back to national totals only. Cross-election comparisons at vaalipiiri level must exclude parl:2019 unless A6 confirms a valid table.

**Tests for A:** Existing `get_party_results` for VIHR, parliamentary 2023, vaalipiiri → should return 13 vaalipiiri rows without 403. EU candidate results for Niinistö by vaalipiiri → should return 13 rows. `analyze_area_volatility(election_type: 'municipal', area_id: 'KU837')` without specifying years → queries 2012, 2017, 2021, 2025 (not parliamentary years).

---

## Phase B: Dynamic Candidate Resolver

**Goal:** `resolve_candidate` should work for any election type, not just parliamentary.

### B1: Routing table for candidate lookup tables

Each election type has a different set of candidate tables. The resolver needs to know which table to search per type:

| Election type | Lookup table | Area dimension | Already registered? |
|---|---|---|---|
| parliamentary | `13t6`–`13ti` per vaalipiiri (13 tables) | per vaalipiiri | ✅ yes (`candidate_by_aanestysalue` on 2023 entry) |
| municipal 2025 | `14v9`–`14vk` per vaalipiiri (12 tables) | per vaalipiiri | ✅ yes (`candidate_by_aanestysalue` on 2025 entry) |
| municipal 2021 | `12vs_2021`–`12wu_2021` per vaalipiiri (12 tables) | per vaalipiiri | ✅ yes (`candidate_by_aanestysalue` on 2021 entry) |
| eu_parliament | `14gx` (vaalipiiri) or `14gy` (national) | vaalipiiri or national | `14gy` ✅ yes; `14gx` ❌ added in A2 |
| presidential | `14d5` | national (all candidates in one table) | ✅ yes (`candidate_national` on 2024 entry) |
| regional 2025 | `14zu`–`151p` per hyvinvointialue (21 tables) | per hyvinvointialue | ✅ yes (`candidate_by_aanestysalue` on 2025 entry) |

Note: the earlier plan mentioned `14uk`–`14v8` for municipal — those IDs are incorrect. The actual registered tables are `14v9`–`14vk` (2025) and `12vs_2021`–`12wu_2021` (2021). The B1 resolver does not need to register any new tables for parliamentary, municipal, or regional; it only needs to dispatch to the tables already there.

### B2: Candidate index pattern

For election types where candidates span multiple tables (parliamentary, municipal, regional), the resolver should:
1. If `unit_hint` is provided (vaalipiiri key or hyvinvointialue key): search that table only
2. If no hint: fan out to all unit tables in parallel (accept latency, ~13 API calls)

Do not attempt a "national summary table first" optimization. `13t3` (parliamentary national summary) has not been verified to contain searchable candidate names — it may only contain vote counts, not the name-formatted rows the fuzzy matcher needs. Verify `13t3` content before relying on it; if confirmed usable as a name lookup, it can be added as step 1 in a later iteration.

The current parliamentary resolver already does step 2 correctly. The fix is extending it to dispatch by `election_type`.

```
resolveCandidateForType(query, election_type, year, unit_hint?) → CandidateMatch[]
```

### B3: Extend `resolve_area` for hyvinvointialue

`resolve_area` currently fetches its area list from parliamentary 2023's party table, giving it access to kunta, vaalipiiri, and koko_suomi codes only. After A4, an LLM querying regional election data has no way to resolve "Pirkanmaan hyvinvointialue" → `HV07`.

Fix: when `area_level: 'hyvinvointialue'` is requested (or inferred from a regional election context), fetch the area list from a regional party table (`14y4` or `14y2`) and fuzzy-match against those values.

```
resolve_area({ query: 'Pirkanmaa', area_level: 'hyvinvointialue' }) → { area_id: 'HV07', area_name: 'Pirkanmaan hyvinvointialue', area_level: 'hyvinvointialue' }
```

This is a small targeted addition to the existing resolver — the fuzzy matching logic is unchanged, only the source table for the area list changes.

**Tests for B:** `resolve_candidate("Atte Harjanne", eu_parliament, 2024)` → finds ID `050196`, party VIHR. `resolve_candidate("Santeri Leinonen", municipal, 2025)` → finds or not found cleanly. `resolve_area("Pirkanmaa", area_level: "hyvinvointialue")` → returns `HV07`.

---

## Phase C: Generic Comparable Workflow Engine

**Goal:** One engine that can answer any of: "Compare X across areas", "Compare X across years", "Compare X vs Y in area Z". All producing normalized, joinable output.

### C1: Dimension model

Every query result is tagged with four dimensions:

```
{
  subject_type: 'candidate' | 'party',
  subject_id: string,           // candidate_id or party_id
  subject_name: string,
  election_type: ElectionType,
  year: number,
  area_level: AreaLevel,        // koko_suomi | vaalipiiri | kunta | äänestysalue | hyvinvointialue | maakunta
  area_id: string,
  area_name: string,
  votes: number,
  vote_share_pct: number,
  rank_in_area?: number,        // rank among all candidates/parties in this area
  rank_in_unit?: number,        // rank within their vaalipiiri/unit
}
```

This schema is already close to the existing canonical schema. The key additions are `election_type` and `year` being part of every row, enabling joins across elections.

### C2: `query_election_data` — the core flexible tool

A new low-level tool that subsumes `get_party_results` and `get_candidate_results`. **Migration path:** once C2 is implemented, the existing tools are refactored to delegate to `query_election_data` internally rather than being removed. Their external interface is unchanged; they become thin wrappers. This avoids breaking any existing LLM tool calls while eliminating duplicated routing logic.

```
query_election_data({
  subject_type: 'candidate' | 'party',
  subject_ids?: string[],          // filter to specific candidates/parties; null = all
  election_type: ElectionType | ElectionType[],
  years: number | number[],
  area_level: AreaLevel,
  area_ids?: string[],             // filter to specific areas; null = all
  include_demographics?: false,    // if true, join demographic turnout data
  output_mode: 'rows' | 'analysis'
})
```

The engine:
1. Resolves which table(s) to use via the expanded registry
2. Builds minimal PxWeb queries (respecting cell-count limits: chunk if needed)
3. Normalizes all results to canonical schema
4. Optionally joins across multiple election_types/years into one result set

### C3: `compare_across_dimensions` — the LLM-facing comparison tool

A higher-level tool for the most common comparison patterns. The LLM specifies what to hold constant and what to vary:

```
compare_across_dimensions({
  subject: { type: 'party', id: 'VIHR' },
  vary: 'election',                     // what changes between rows
  elections: [
    { election_type: 'parliamentary', year: 2019 },
    { election_type: 'parliamentary', year: 2023 },
    { election_type: 'municipal',     year: 2021 },
    { election_type: 'municipal',     year: 2025 },
    { election_type: 'eu_parliament', year: 2024 },
  ],
  area_level: 'vaalipiiri',
  area_ids: ['VP01', 'VP02', 'VP07'],   // Helsinki, Uusimaa, Pirkanmaa
  output_mode: 'analysis'
})
```

Output: a table with elections as rows, areas as columns.

**pp-change computation rules:**
- Computed only between elections of the same type, sorted by year (e.g. parliamentary:2019→2023, municipal:2021→2025)
- When election types are mixed in one call, pp-changes are computed per-type independently; rows with no prior same-type election in the list show `pp_change: null`
- Never compute pp-change across different election types (parliamentary→municipal is not meaningful)

**Vary modes:**

| `vary` | Rows represent | Columns represent |
|---|---|---|
| `'election'` | different elections/years | areas or subjects |
| `'area'` | different geographic areas | elections or subjects |
| `'subject'` | different candidates or parties | elections or areas |

### C4: `find_comparable_areas` — geographic comparison with context

Given a reference area and subject, find areas with similar vote share patterns. Useful for: "Find municipalities that behave like Tampere for VIHR across elections."

```
find_comparable_areas({
  reference_area_id: 'KU837',     // Tampere
  subjects: ['VIHR', 'SDP'],
  elections: [parliamentary:2023, municipal:2025],
  n_results: 10
})
```

**Similarity metric (fixed, not a parameter):** Euclidean distance on the normalized vote-share vector. For each kunta, build a vector of `vote_share_pct` values — one dimension per (subject × election) combination. Normalize each dimension to [0,1] across all kunnat before computing distance, so subjects with different base vote shares (VIHR ~15% vs SDP ~20%) contribute equally. Return the `n_results` kunnat with smallest distance to the reference area.

Removing `similarity_metric` as a user-facing parameter: the formula must be fixed and documented so `explain_metric` can describe it precisely. Multiple selectable metrics without defined formulas are not auditable.

### C5: `scrape_candidate_trajectory` — cross-election candidate tracking

Given a candidate (by name or ID), find all elections they have appeared in and return their results:

```
scrape_candidate_trajectory({
  query: 'Atte Harjanne',
  election_types: ['parliamentary', 'eu_parliament', 'municipal'],  // required, no default
  years?: number[],              // optional filter; default = all registered years per type
  area_level: 'vaalipiiri',
  include_party_context: true    // also return how party did in same area/election
})
```

Returns timeline of: election → votes → vote_share → rank_in_vaalipiiri → rank_in_party → party_total_votes.

**Rate limit constraint:** `election_types` is required with no `search_all_elections: true` shortcut. Searching all types × all years without a filter can trigger 100+ API calls (parliamentary alone: 5 years × 13 vaalipiiri fan-out = 65 calls), taking 2–3 minutes and starving other users of the upstream rate limit budget. The LLM must specify which election types to search based on context. This is not a technical limitation to engineer around — it is the correct interface design.

**Cross-election identity:** Candidate IDs are reissued each election. Resolution uses fuzzy name matching per election, not ID lookup. Confirmed matches (score ≥ 0.95) are included automatically; medium-confidence matches (0.55–0.95) are returned with a flag for LLM review.

This answers "where has X been a candidate and how did they do?" efficiently when the LLM already has context about which elections are relevant.

---

## Phase D: Area Reconstruction Engine

**Goal:** Since all elections have äänestysalue data, any coarser area result can be computed by aggregation. This eliminates the dependency on pre-aggregated tables and enables geographic cross-election comparisons at any level.

### D1: `aggregateCandidatesToKunta` — äänestysalue → kunta roll-up

```typescript
aggregateCandidatesToKunta(rows: ElectionRecord[], electionType: ElectionType) → ElectionRecord[]
```

Takes raw äänestysalue-level candidate rows (as returned by `loadCandidateResults`), extracts the kunta code from each row's `area_id` using `parseKuntaCode` (see D2), groups by candidate + kunta, sums votes, and recomputes `vote_share` from the kunta total. Returns one row per candidate per kunta.

**For party data this function is not needed.** The year-specific party tables (`13t2`, `14vm`, `14h2`) already contain pre-aggregated rows at every level (SSS, VP##, KU###, äänestysalue) in the same table. To get kunta-level party results, simply filter the returned rows for `area_level === 'kunta'`. Tilastokeskus does the aggregation.

### D2: `parseKuntaCode` + `KUNTA_TO_VAALIPIIRI` map

> **Phase C gate.** C2, C3, C4, D3, and E4 all depend on D2. Phase C cannot start until D2 is complete and validated.

**Why the original "static lookup table" design is wrong:**
A file mapping 2000 äänestysalue IDs to kunta IDs would need a separate version per election year, because municipalities can independently reorganize their voting districts. It would be both large and stale by the next election. The correct approach is that the kunta code is already **embedded in the äänestysalue identifier by Tilastokeskus's own naming convention** — it is extractable by parsing, not by lookup.

---

**Component 1: `parseKuntaCode(code, electionType)` function**

| Election type | Area code format | Kunta extraction |
|---|---|---|
| parliamentary | `01091001A` | slice positions 2–4 → `091` |
| municipal | `01091001A` | same |
| presidential | `01091011D` | same |
| eu_parliament | **verify `14gw` format before implementing** | TBD |

```typescript
// Lives in src/data/normalizer.ts alongside inferAreaLevelFromCandidateCode
function parseKuntaCode(code: string, electionType: ElectionType): string | null {
  if (electionType === 'parliamentary' || electionType === 'municipal' || electionType === 'presidential') {
    if (/^\d{2}\d{3}\d{3}[A-Z]$/.test(code)) return code.slice(2, 5);
  }
  // EU: implement after verifying 14gw area code format
  return null;
}
```

This does not go stale when a municipality reorganizes voting districts. The kunta code at positions 2–4 is the municipality that owns the district — it only changes if the municipality itself merges with another (a national administrative event, not a local change).

**Before implementing the EU branch:** fetch `14gw` metadata and inspect the actual area code values. The table may already contain `KU###`-format kunta rows (like `14h2` does), in which case no parsing is needed for EU kunta aggregation — just filter for `KU###` rows.

---

**Component 2: `KUNTA_TO_VAALIPIIRI` static map**

The vaalipiiri a kunta belongs to is NOT embedded in any area code. It is needed for cross-election joins at vaalipiiri level and for making `resolve_area` work without a live API call.

```typescript
// Lives in src/data/election-tables.ts or a new src/data/area-hierarchy.ts
export const KUNTA_TO_VAALIPIIRI: Record<string, string> = {
  '091': 'helsinki',
  '049': 'uusimaa',    // Espoo
  '092': 'uusimaa',    // Vantaa
  '837': 'pirkanmaa',  // Tampere
  // ... ~310 entries total
};
```

**How to build the map (one-time derivation from `13sw` metadata):**

The 6-digit area codes in `13sw`'s `Vaalipiiri ja kunta vaalivuonna` variable encode both the kunta and its vaalipiiri. The format is: `VP_PREFIX` (2 digits) + `KUNTA` (3 digits, zero-padded) + `0`. The aggregate (vaalipiiri) rows end in `0000` and the kunta rows don't.

1. Fetch `13sw` metadata and read all values from `Vaalipiiri ja kunta vaalivuonna`
2. For each 6-digit code ending in `0000` (vaalipiiri aggregate): `vp_prefix = code.slice(0, 2)`, note the vaalipiiri key from its value text (e.g. "Helsingin vaalipiiri" → `'helsinki'`). This gives a 13-entry prefix→key map:

| 6-digit prefix | Vaalipiiri key |
|---|---|
| `01` | `helsinki` |
| `02` | `uusimaa` |
| `03` | `lounais-suomi` |
| `04` | `satakunta` |
| `05` | `hame` |
| `06` | `pirkanmaa` |
| `07` | `kaakkois-suomi` |
| `08` | `savo-karjala` |
| `09` | `vaasa` |
| `10` | `keski-suomi` |
| `11` | `oulu` |
| `12` | `lappi` |
| `13` | `ahvenanmaa` |

3. For each kunta code (6-digit, not ending in `0000`): `kunta_3digit = code.slice(2, 5)`, `vaalipiiri_key = prefixMap[code.slice(0, 2)]`
4. Write all ~310 pairs as the static `KUNTA_TO_VAALIPIIRI` object

This map is stable — last changed in the 2012 vaalipiiri boundary reform. Boundary changes require national legislation and happen very rarely. If a reform occurs, updating the map is an intentional code change, not a data maintenance problem.

**Scope limitation — regional elections are excluded from D2.** Hyvinvointialue (HV01–HV21) boundaries do not map unambiguously onto vaalipiiri boundaries. Cross-election joins that include `regional` alongside `parliamentary`/`municipal`/`eu_parliament` at vaalipiiri level are not supported. Attempting to join regional and non-regional data on `area_id` must return an explicit error, not a silent mismatch.

---

**Tests for D2:** `parseKuntaCode('01091001A', 'parliamentary')` → `'091'`. `parseKuntaCode('01837001A', 'parliamentary')` → `'837'` (Tampere). `KUNTA_TO_VAALIPIIRI['091']` → `'helsinki'`. `KUNTA_TO_VAALIPIIRI['837']` → `'pirkanmaa'`.

---

**Existing code impact — what to update when D2 is implemented:**

| Location | Current state | Change |
|---|---|---|
| `src/data/normalizer.ts:inferAreaLevelFromCandidateCode` (line 65) | Classifies code → area level by prefix pattern | Add `parseKuntaCode` as a sibling function in the same file. No changes to `inferAreaLevelFromCandidateCode` itself — the two functions have different jobs |
| `src/data/election-tables.ts:PartyTableSchema.area_code_format` | Encodes `'six_digit' \| 'vp_prefix' \| 'five_digit'` format per schema | `parseKuntaCode` uses `ElectionType` as its dispatch parameter (simpler for callers than requiring the schema object). No change to `PartyTableSchema` needed |
| `src/tools/entity-resolution/index.ts:getAreaList()` (line 227) | Fetches kunta + vaalipiiri names from parliamentary `13sw` metadata; hardcoded to `getElectionTables('parliamentary', year)` | After D2, supplement with `KUNTA_TO_VAALIPIIRI` so area resolution works without a live API call. Keep metadata fetch for names (the static map has codes only, not names). Concretely: build the AreaEntry list from `KUNTA_TO_VAALIPIIRI` keys + look up names lazily from the 13sw metadata as now |
| `src/tools/entity-resolution/index.ts:resolve_area` (line 412) | `area_level` param accepts `kunta \| vaalipiiri \| koko_suomi` only; no `aanestysalue` | No change needed — resolve_area is for looking up areas by name, not by area code. LLMs don't need to resolve äänestysalue codes by name |
| `src/data/normalizer.ts:normalizeCandidateByAanestysalue` (line 257) | Returns raw rows with `area_level: 'aanestysalue'` and no parent info | After D2, optionally tag each row with `kunta_id: parseKuntaCode(area_id, electionType)`. This makes downstream aggregation a simple `groupBy(kunta_id)` without re-parsing |

### D3: EU candidate results kunnittain (via `14gw` aggregation)

Once `14gw` is mapped, we can:
1. Fetch Niinistö's results at äänestysalue level from `14gw`
2. Aggregate äänestysalue → kunta using D2
3. Return kunta-level results

This answers the "How did Niinistö/Harjanne do in Uusimaa by municipality?" question that was impossible in the test session.

**Tests for D:** `query_election_data({ subject_type: 'candidate', subject_ids: ['050208'], election_type: 'eu_parliament', year: 2024, area_level: 'kunta' })` → should return ~310 kunta rows via `14gw` aggregation.

---

## Phase E: LLM Tool Surface Cleanup

**Goal:** The LLM should not need to know table IDs, area code formats, or query chunking strategies. Simplify the interface without reducing capability.

### ~~E1: Unified subject parameter~~ — DROPPED

Renaming `candidate_id`/`party_id` to `subject: { type, id }` across all tools is a breaking change to all existing LLM tool calls with no functional gain. The current parameter names work correctly. Dropped.

### E2: Require explicit `area_level`

`area_level` is a required parameter in `query_election_data` and `compare_across_dimensions`. If omitted, return an error asking the caller to specify it. Do not infer it from query shape or response size.

Rationale: inferring area_level based on internal heuristics produces inconsistent behavior — the same tool call with the same parameters could return vaalipiiri rows one time and kunta rows another if the heuristic changes. This makes the tool non-auditable and harder for the LLM to reason about. The LLM has the context to choose the right granularity; the MCP should not second-guess it.

### E3: `describe_available_data` tool

Replaces manual `describe_election` calls. Given any set of parameters, returns exactly what data can be fetched and at what granularity:

```
describe_available_data({
  election_type: 'eu_parliament',
  year: 2024,
  subject_type: 'candidate'
})
→ {
    area_levels: ['koko_suomi', 'vaalipiiri', 'kunta', 'äänestysalue'],
    note: 'kunta and äänestysalue derived via 14gw aggregation',
    candidate_search: 'available via 14gx (vaalipiiri) or 14gw (äänestysalue)',
    ...
  }
```

### E4: Fix `find_area_overperformance` area_level routing

The tool currently returns äänestysalue rows regardless of requested `area_level`. Fix:
- `area_level: 'vaalipiiri'` → aggregate äänestysalue results to vaalipiiri before returning
- `area_level: 'kunta'` → aggregate to kunta
- `area_level: 'äänestysalue'` → return raw (current behavior)

---

## Data flow diagrams

### Flow 1: "How did party X do in area Y over time?"

```
LLM calls compare_across_dimensions(party=VIHR, area=VP07, elections=[parl:2023, kvaa:2025])
  ↓
Table router:
  parl:2023 + vaalipiiri → 13t2 (year-specific, confirmed working)
  kvaa:2025 + vaalipiiri → 14vm (year-specific, confirmed working)
  ↓
PxWeb queries (2 calls, each ~100 cells, no 403)
  ↓
Normalize all to { election_type, year, area_id, party_id, votes, vote_share_pct }
  ↓
Join on area_id, sort by year
  ↓
Analysis mode: markdown table + pp-changes (null for first election of each type, no prior to compare)
```

**Note:** parl:2019 + vaalipiiri is excluded from this example because no year-specific party table for parliamentary 2019 has been confirmed in the API. See A6 — until that scan is done and a table confirmed, parl:2019 area queries fall back to national totals only.

### Flow 2: "How did candidate X perform across all elections?"

```
LLM calls scrape_candidate_trajectory(query="Atte Harjanne", election_types=["eu_parliament","parliamentary"], years=[2023,2024])
  ↓
Candidate resolver, dispatched by type:
  eu_parliament:2024 → search 14gx (national, 247 candidates) → found (ID 050196, score 1.0)
  parliamentary:2023 → fan out to 13 vaalipiiri tables → not found
  ↓
For each election where found: query_election_data at vaalipiiri level
  ↓
Join results: timeline of votes + share + rank per election
  ↓
Analysis: trajectory narrative
```

LLM specifies `election_types` and `years` based on known context (Harjanne ran for EU in 2024) rather than triggering a full all-types scan.

### Flow 3: "Find areas similar to reference area for party support"

```
LLM calls find_comparable_areas(reference=KU837/Tampere, party=VIHR, elections=[parl:2023, kvaa:2025])
  ↓
For each election: query_election_data at kunta level (all kunnat)
  ↓
For each kunta: compute similarity score to Tampere's (vote_share, change_pp) vector
  ↓
Return top N similar kunnat with similarity scores
```

### Flow 4: "EU candidate kunta-level results via aggregation"

```
LLM calls query_election_data(candidate=Niinistö, eu_parliament:2024, area_level=kunta)
  ↓
Table router: EU candidate + kunta → route to 14gw (äänestysalue table)
  ↓
Fetch 14gw: ~2079 areas × 1 candidate = ~2079 cells (within limit)
  ↓
Area aggregator: parseKuntaCode(area_id, 'eu_parliament') extracts kunta per row
  (Note: verify 14gw area code format first — if table already contains KU### rows,
   filter directly instead of aggregating)
  ↓
Sum votes per kunta, recompute vote_share from kunta_total_votes
  ↓
Return 310 kunta rows
```

---

## Implementation phases & sequence

| Phase | Prerequisite | Effort | Impact |
|---|---|---|---|
| **Phase 0: HTTP body bug fix** (`server-http.ts`) | None | Small — buffer body before transport | **CRITICAL — production HTTP is broken** |
| A1: Year-specific party tables | None | Small — add 3 table entries + routing condition | HIGH — fixes 403 immediately |
| A2: EU candidate tables + routing rules | None | Small — add 2 table entries + error for missing candidate_id | HIGH — enables EU area queries |
| A5: Election-type-aware year defaults | None | Small — DEFAULT_YEARS_BY_TYPE map in 3 tools | HIGH — fixes silent wrong output for non-parliamentary |
| A3: Presidential multi-year vaalipiiri | None | Small — add 1 table entry | MEDIUM |
| A4: Regional elections remaining gaps | None | Small — core already implemented; add `14y2`, `157b`–`157f`, verify `14z8`–`14zt` | LOW–MEDIUM |
| A6: StatFin_Passiivi scan for historical party tables | None | Small — run scan_tables.mjs against Passiivi | Unblocks parl:2019 vaalipiiri comparisons |
| B1/B2: Candidate resolver routing | A2 | Medium — refactor resolver to dispatch by type | HIGH — fixes resolve_candidate for all types |
| B3: resolve_area for hyvinvointialue | A4 | Small — add area list source for regional election context | MEDIUM — required for regional usability |
| **D2: `parseKuntaCode` + `KUNTA_TO_VAALIPIIRI`** | None | **Small-Medium** — `parseKuntaCode` is ~10 lines; `KUNTA_TO_VAALIPIIRI` is a one-time ~310-entry derivation from `13sw` metadata (see build instructions in D2 section) | **GATE for Phase C** — C2/C3/C4/D3/E4 all block on this |
| C2: query_election_data | A1, A2, D2 | Large — new unified tool; existing tools delegate to it | HIGH — foundation for Phase C |
| C3: compare_across_dimensions | C2 | Medium — composition over C2 | HIGH — key LLM-facing tool |
| C5: scrape_candidate_trajectory | B1, C2 | Medium — orchestration with required election_types param | HIGH — answers career-tracking questions |
| D3: EU kunta via aggregation | A2, D2 | Small — aggregation pass in C2 | MEDIUM |
| E4: fix find_area_overperformance | D2 | Small | MEDIUM |
| C4: find_comparable_areas | C2 | Medium — normalize-then-euclidean must be a named tested function | MEDIUM |
| E3: describe_available_data | A1–A5, A4 | Small | LOW |

---

## What does NOT need to change

- The canonical data schema — it already supports multi-election joins
- The caching layer (`withCache`) — it works well
- The analysis mode pattern — `output_mode: 'analysis'` is the right design
- The fuzzy matching in `resolve_candidate` — `scoreMatch()` is solid
- The demographics tools — they work correctly and have good coverage

---

## Tests for the full plan

After implementing all phases, these queries should succeed end-to-end:

1. `compare_across_dimensions(VIHR, [parl:2019, parl:2023, eu:2024, kvaa:2025], area_level=vaalipiiri)` → 5-row × 13-column table, no 403
2. `query_election_data(Niinistö, eu:2024, area_level=kunta)` → ~310 kunta rows via 14gw aggregation
3. `scrape_candidate_trajectory("Ville Niinistö", election_types=["eu_parliament", "parliamentary"])` → eu:2024 results found; parliamentary returns not-found cleanly
4. `compare_across_dimensions(VIHR vs SDP, parl:2023, area_level=kunta)` → party comparison at kunta level
5. `find_comparable_areas(KU837, VIHR, [parl:2023, kvaa:2025])` → top 10 "Tampere-like" municipalities
6. `resolve_candidate("Jutta Urpilainen", eu_parliament, 2024)` → finds correctly via 14gx
7. `query_election_data(party=VIHR, alvaa:2025, area_level=äänestysalue)` → regional election results
8. `scrape_candidate_trajectory("Santeri Leinonen", election_types=["parliamentary", "municipal"])` → finds parliamentary 2023; municipal returns not-found cleanly
