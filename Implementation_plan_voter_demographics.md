# Implementation Plan — Voter Demographics Layer

**Feature:** Äänestäjien taustatiedot — socio-demographic profiles of voters, candidates, and elected officials
**Data source:** Statistics Finland PxWeb API (StatFin/evaa/, kvaa/, euvaa/, pvaa/)
**Created:** 2026-03-18
**Revised:** 2026-03-18
**Follows:** Phase 25 (main `Implementation_plan.md`). These phases continue the numbering: **Phase 27–30**.

---

## Background & Motivation

The existing MCP covers *what* voters chose (party votes, candidate results, geographic variation). This layer adds *who voted* — the socio-demographic composition of the electorate, candidates, and elected officials.

Source publication: [Eduskuntavaalit 2023 – äänestäneiden taustatiedot](https://stat.fi/fi/julkaisu/cl8mvt1xt143o0cvzel1m7esx)

This enables a new class of analyst queries:
- "What income quintile has the lowest voter turnout?"
- "How has the education level of elected MPs changed since 2011?"
- "What is the gender gap in participation among 18–24-year-olds?"
- "How does voter turnout compare between Finnish-speakers and foreign-language speakers?"

---

## Two distinct data types

These two concepts come from different source tables and answer different questions:

| | `get_voter_background` | `get_voter_turnout_by_demographics` |
|---|---|---|
| **Question** | Who are these people? | Did they vote? |
| **Unit** | Eligible voters / candidates / elected MPs | All eligible voters in the electorate |
| **Output** | Socioeconomic composition (%) | Participation rate (%) |
| **Years** | Parliamentary 2011–2023, Municipal 2012–2025 | Most recent election per type only |
| **Source** | 13su (parliamentary), 14w4 (municipal) | 5 separate tables per election type |

---

## Available PxWeb Tables

### Parliamentary elections (StatFin/evaa/)

| Table ID | Description | Years |
|---|---|---|
| `statfin_evaa_pxt_13su` | Background of eligible voters, candidates & elected: employment, education, employer sector, income decile, language, origin | 2011, 2015, 2019, 2023 (multi-year table) |
| `statfin_evaa_pxt_13yt` | Turnout by education level & gender | 2023 only |
| `statfin_evaa_pxt_13yu` | Turnout by origin & language & gender | 2023 only |
| `statfin_evaa_pxt_13yv` | Turnout by income quintile & gender | 2023 only |
| `statfin_evaa_pxt_13yw` | Turnout by primary activity & gender | 2023 only |
| `statfin_evaa_pxt_13ys` | Turnout by near-individual age & gender (18, 19, then 5-year bins) | 2023 only — used internally to build age_group output |

> **Note on 13ys:** This table has ages 18 and 19 as individual codes, then 5-year bins (20–24, 25–29, …). The normalizer aggregates these into standard 7 groups (18–24, 25–34, 35–44, 45–54, 55–64, 65–74, 75+) so the tool output is consistent across election types. Aggregation uses raw counts (`aoiky_al_evaa` + `a_al_evaa`); percentages are recomputed, never averaged.

> **Note on 13su:** This is a multi-year table covering all four parliamentary elections. The loader uses it with a year filter, following the same fallback pattern as `statfin_evaa_pxt_13sw` for party data — registered once on the 2023 entry, found via `findVoterBackgroundTableForType()` for earlier years.

**Tables intentionally excluded from this feature:**
- `statfin_evaa_pxt_13ss` — median income / children by party. Interesting but a different analytical concept (party supporter profile rather than voter/candidate background). Deferred to future feature.
- `statfin_evaa_pxt_13ys` — exposed only internally for age_group aggregation, not as its own dimension.

### Municipal elections (StatFin/kvaa/)

| Table ID | Description | Years |
|---|---|---|
| `statfin_kvaa_pxt_14w4` | Background of eligible voters, candidates & elected: employment, education, employer sector, income decile, language, origin | 2012, 2017, 2021, 2025 (multi-year table) |
| `statfin_kvaa_pxt_152r` | Turnout by education level & gender | 2025 only |
| `statfin_kvaa_pxt_152s` | Turnout by origin & language & gender | 2025 only |
| `statfin_kvaa_pxt_152t` | Turnout by income quintile & gender | 2025 only |
| `statfin_kvaa_pxt_152u` | Turnout by primary activity & gender | 2025 only |
| `statfin_kvaa_pxt_152q` | Turnout by age group & gender | 2025 only |

**Tables intentionally excluded:**
- `statfin_kvaa_pxt_14wa` — cross-tabulation of eligible voters/candidates/elected by party × age × gender. Requires three-dimensional normalization; deferred to future feature.
- `statfin_kvaa_pxt_14wb` — median income by party. Same as 13ss — deferred.
- `statfin_kvaa_pxt_152p` — individual age turnout. Used internally only (like 13ys), but municipal elections already have the grouped table 152q so 152p is not needed at all.

### EU Parliament elections (StatFin/euvaa/)

| Table ID | Description | Years |
|---|---|---|
| `statfin_euvaa_pxt_14ha` | Turnout by age group & gender | 2024 only |
| `statfin_euvaa_pxt_14hb` | Turnout by education level & gender | 2024 only |
| `statfin_euvaa_pxt_14hc` | Turnout by origin & language & gender | 2024 only |
| `statfin_euvaa_pxt_14hd` | Turnout by income quintile & gender | 2024 only |
| `statfin_euvaa_pxt_14he` | Turnout by primary activity & gender | 2024 only |

### Presidential elections (StatFin/pvaa/)

| Table ID | Description | Years |
|---|---|---|
| `statfin_pvaa_pxt_14nk` | Turnout by age group & gender | 2024 only |
| `statfin_pvaa_pxt_14nl` | Turnout by education level & gender | 2024 only |
| `statfin_pvaa_pxt_14nm` | Turnout by origin & language & gender | 2024 only |
| `statfin_pvaa_pxt_14nn` | Turnout by income quintile & gender | 2024 only |
| `statfin_pvaa_pxt_14np` | Turnout by primary activity & gender | 2024 only |

> **Presidential round variable:** All five presidential tables contain a `Kierros` variable with values `1` (Ensimmäinen vaali) and `2` (Toinen vaali). The loader must filter to `Kierros=1` (first round) by default. Expose as an optional `round` parameter (1 or 2, default 1) in `loadVoterTurnoutByDemographics` and the tool schema. The tool description must note: "Presidential elections have two rounds; default is round 1. Use round=2 for the runoff."

**Coverage — turnout-by-demographics:**
Investigated 2026-03-18: `StatFin_Passiivi/evaa/` was fully enumerated (192 tables). No turnout-by-demographics tables exist for 2019 or 2015. The 5-dimension demographic series was introduced for the first time in 2023. **The years listed above are the only years that exist — this will not improve retroactively.**

**Coverage — voter background:**
No `get_voter_background` data found for EU parliament, presidential, or regional elections. Parliamentary and municipal only.

---

## Tool designs

### Tool 1: `get_voter_background`

**Question it answers:** "What is the socioeconomic composition of [group] in [election, year] by [dimension]?"

**Supported election types:** `parliamentary` | `municipal`

**Parameters:**

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `election_type` | `parliamentary` \| `municipal` | yes | |
| `year` | number | yes | Parliamentary: 2011, 2015, 2019, 2023. Municipal: 2012, 2017, 2021, 2025. Error if unsupported. |
| `group` | `eligible_voters` \| `candidates` \| `elected` | yes | No default — caller must be explicit. Three very different populations. |
| `dimension` | `employment` \| `education` \| `employer_sector` \| `income_decile` \| `language` \| `origin` | yes | No default. All dimensions are categories within a single `Taustamuuttujat` PxWeb variable — one API call per invocation, filtered by dimension. For `income_decile`: only lowest and highest decile are available, not all 10. |
| `gender` | `total` \| `male` \| `female` | no | Default: `total` |
| `output_mode` | `analysis` \| `data` | no | Default: `analysis` |

**Output (analysis mode):**
Markdown table of categories with count and share_pct, sorted by share_pct descending. Includes:
- Caveat: which groups (`eligible_voters` / `candidates` / `elected`) can be compared using this data
- Coverage note: available years for this election type

**Output (data mode):**
```
election_type, year, group, dimension, category_code, category_name, gender, count, share_pct
```

**Error behaviour:**
- Unsupported election type → `Error: get_voter_background is not available for [type]. Supported: parliamentary (2011/2015/2019/2023), municipal (2012/2017/2021/2025).`
- Unsupported year → `Error: No voter background data for parliamentary [year]. Available years: 2011, 2015, 2019, 2023.`

**Design note — no `party_filter`:** The underlying table (13su) does not cross-tabulate background dimensions by party for eligible voters. A future tool (`get_party_supporter_demographics`) could use 13ss/14wb for party-level income/family stats, but that is out of scope here.

---

### Tool 2: `get_voter_turnout_by_demographics`

**Question it answers:** "In [election, year], what fraction of [demographic group] actually voted?"

**Supported election types:** `parliamentary` | `municipal` | `eu_parliament` | `presidential`

**Parameters:**

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `election_type` | string | yes | All four types supported |
| `year` | number | yes | See valid years below. Error with clear message if wrong. |
| `dimension` | `age_group` \| `education` \| `income_quintile` \| `origin_language` \| `activity` | yes | No default — caller must choose. |
| `gender` | `total` \| `male` \| `female` | no | Default: `total`. Use `male`/`female` to see gender gap. |
| `output_mode` | `analysis` \| `data` | no | Default: `analysis` |

**Valid year per election type** (the only years that exist — documented in tool description and schema):

| Election type | Valid year | Reason |
|---|---|---|
| parliamentary | 2023 | First year this data was published |
| municipal | 2025 | Most recent municipal election |
| eu_parliament | 2024 | Most recent EU election |
| presidential | 2024 | Most recent presidential election |

**Output (analysis mode):**
Sorted table (highest → lowest turnout_pct) with eligible_voters, votes_cast, turnout_pct per category. Includes:
- Gender gap note if `gender=total` (highlight the dimension category with the largest male/female gap)
- **Mandatory coverage caveat** — always present: "Turnout-by-demographics is only available for [election_type] [year]. Earlier years were not published in this format."

**Output (data mode):**
```
election_type, year, dimension, category_code, category_name, gender, eligible_voters, votes_cast, turnout_pct
```

**Error behaviour:**
- Wrong year → `Error: Turnout-by-demographics for parliamentary elections is only available for 2023. No data exists for [requested year] — this has been verified by full archive enumeration.`
- Unsupported election type (e.g. regional) → `Error: get_voter_turnout_by_demographics is not available for regional elections. Supported: parliamentary (2023), municipal (2025), eu_parliament (2024), presidential (2024).`

---

## Data model changes

### `ElectionTableSet` (src/data/election-tables.ts)

Two new optional fields:

```typescript
/**
 * Background characteristics of eligible voters, candidates & elected.
 * Multi-year table — registered on the most recent entry only.
 * Loaded via findVoterBackgroundTableForType() fallback for older years,
 * mirroring the findPartyTableForType() pattern used for party_by_kunta.
 */
voter_background?: string;

/**
 * Turnout by demographic dimension — keyed by dimension name.
 * Only present on the single election entry where this data exists.
 * age_group uses grouped tables (152q, 14ha, 14nk).
 * For parliamentary, age_group is derived from 13ys by normalizer aggregation.
 */
voter_turnout_by_demographics?: Partial<Record<
  'age_group' | 'education' | 'income_quintile' | 'origin_language' | 'activity',
  string
>>;
```

New helper, parallel to `findPartyTableForType`:

```typescript
export function findVoterBackgroundTableForType(
  type: ElectionType
): ElectionTableSet | undefined {
  return ALL_ELECTION_TABLES.find(
    (t) => t.election_type === type && t.voter_background
  );
}
```

### New canonical types (src/data/types.ts)

```typescript
export interface VoterBackgroundRow {
  election_type: ElectionType;
  year: number;
  group: 'eligible_voters' | 'candidates' | 'elected';
  dimension: string;
  category_code: string;
  category_name: string;
  gender: 'total' | 'male' | 'female';
  count: number;
  share_pct: number;
}

export interface VoterTurnoutDemographicRow {
  election_type: ElectionType;
  year: number;
  dimension: string;
  category_code: string;
  category_name: string;
  gender: 'total' | 'male' | 'female';
  eligible_voters: number;
  votes_cast: number;
  turnout_pct: number;
}
```

### Error convention

Follow existing codebase pattern — plain `throw new Error(message)`. No new error types. Error messages must include the list of valid options so LLM consumers can self-correct.

---

## System prompt caveat text

The following text must be added verbatim to the MCP system prompt in Phase 30:

```
## Voter demographics tools — coverage

### get_voter_background
Socioeconomic profile (employment, education, employer sector, income decile,
language, origin) of eligible voters, candidates, and elected officials.
- Parliamentary: 2011, 2015, 2019, 2023
- Municipal: 2012, 2017, 2021, 2025
- NOT available for EU parliament, presidential, or regional elections.
- Use group=eligible_voters for the electorate, group=candidates for who ran,
  group=elected for who won. These are three different populations.

### get_voter_turnout_by_demographics
Actual participation rate broken down by a demographic dimension.
- Parliamentary: 2023 ONLY
- Municipal: 2025 ONLY
- EU parliament: 2024 ONLY
- Presidential: 2024 ONLY
- NOT available for regional elections.
- NOT available for any earlier years — this has been verified by full
  archive enumeration. Do not attempt to retrieve 2019 or 2015 data.
```

---

## Confirmed Variable Codes (pre-Phase 27 exploration, 2026-03-18)

The following metadata was fetched directly from the PxWeb API before Phase 27 coding began. Use this as the authoritative reference; Phase 27 tasks that duplicate these checks are marked accordingly.

### `statfin_evaa_pxt_13su` — Parliamentary voter background (multi-year)

| Variable | Code | Values |
|---|---|---|
| Year | `Vuosi` | 2011, 2015, 2019, 2023 |
| Gender | `Sukupuoli` | SSS (total), 1 (Miehet), 2 (Naiset) |
| Group | `Äänioikeutetut, ehdokkaat ja valitut` | 00S1 (eligible voters), 1002 (all candidates), 2002 (elected total) — plus per-party candidate codes |
| Background | `Taustamuuttujat` | All 6 dimensions in ONE variable — see below |
| Measures | `Tiedot` | lkm1 (count), pros (share %), pros_sp (share by gender %) |

**Taustamuuttujat codes by dimension:**

| Dimension | Codes |
|---|---|
| employment | ptoSSS (total), pto11 (employed), pto12 (unemployed), pto22 (students), pto24 (retired), pto99 (other) |
| education | kouSSS (total), kou1_9 (basic only), kou3_4 (secondary), kou5 (lower tertiary), kou6 (bachelor), kou7_8 (master/research) |
| employer_sector | sekSSS (total), sek1 (private), sek2 (state), sek3 (municipality), sek8 (entrepreneur) |
| income_decile | des1 (LOWEST decile only), des10 (HIGHEST decile only) — ⚠️ only two extremes available, NOT all 10 |
| language | kifise (Finnish/Sami), kisv (Swedish), ki02 (foreign language), kiX (unknown) |
| origin | sy2 (foreign-background) — ⚠️ single value; no "Finnish-background" counterpart code |

> **Key architectural note:** All background dimensions are categories within the SINGLE `Taustamuuttujat` variable, not separate API variables. The `dimension` parameter is implemented by filtering `Taustamuuttujat` to the relevant code subset. One API call can serve any dimension — separate API calls per dimension are NOT required.

> **Income decile limitation:** The table contains only the bottom decile (des1) and top decile (des10). If the analyst asks for a full decile breakdown it cannot be provided from this table. Document this prominently in the tool description and schema.

> **Origin dimension:** Only "foreign-background" (sy2) is present — there is no explicit "Finnish-background" code. The complement is implied. Document this in the output caveat.

### `statfin_kvaa_pxt_14w4` — Municipal voter background (multi-year)

Same `Taustamuuttujat` structure and codes as 13su with two differences:

| Difference | 13su (parliamentary) | 14w4 (municipal) |
|---|---|---|
| Gender variable name | `Sukupuoli` | `Ehdokkaan sukupuoli` |
| Eligible voter code | `00S1` | `0001` |

Years: 2012, 2017, 2021, 2025. Measures identical: lkm1, pros, pros_sp.

### `statfin_evaa_pxt_13ys` — Parliamentary turnout by age (2023)

| Variable | Code | Values |
|---|---|---|
| Year | `Vuosi` | 2023 only |
| Age | `Ikäluokka` | SSS (total), **018 (age 18), 019 (age 19)**, 20-24, 25-29, 30-34, 35-39, 40-44, 45-49, 50-54, 55-59, 60-64, 65-69, 70-74, 75-79, 80- |
| Gender | `Sukupuoli` | SSS, 1 (Miehet), 2 (Naiset) — **all three in same table** |
| Geography | `Alue` | SSS (Koko maa), vaalipiiri, kunta, äänestysalue — **must filter Alue=SSS for national results** |
| Measures | `Tiedot` | aoiky_evaa (national eligible voters, lkm), aoiky_al_evaa (area eligible voters, lkm), a_al_evaa (votes cast in area, lkm), pros_al_evaa (turnout in area, %), a_enn_evaa (early votes, lkm), pros_enn_evaa (early votes, %), osuus_evaa (coverage, %) |

> **Age grouping:** The table does NOT have purely individual ages. Ages 18 and 19 are separate codes; all other ages come in 5-year bins. To produce standard groups: 18–24 = {018 + 019 + 20-24}, 25–34 = {25-29 + 30-34}, 35–44 = {35-39 + 40-44}, 45–54 = {45-49 + 50-54}, 55–64 = {55-59 + 60-64}, 65–74 = {65-69 + 70-74}, 75+ = {75-79 + 80-}. Use `aoiky_al_evaa` + `a_al_evaa` (count measures) to aggregate, then recompute turnout_pct. Do NOT aggregate percentages directly.

> **Gender gap computation:** All three gender values (SSS, 1, 2) are present in the same table. Fetch all three in one API call. No separate requests needed for gender gap analysis.

### `statfin_evaa_pxt_13yv` — Parliamentary turnout by income quintile (2023)

| Variable | Code | Values |
|---|---|---|
| Year | `Vuosi` | 2023 only |
| Quintile | `Tulokvintiili` | SSS (total), 01 (I), 02 (II), 03 (III), 04 (IV), 05 (V), 09 (Tuntematon/Unknown) |
| Gender | `Sukupuoli` | SSS, 1, 2 — all in same table |
| Geography | `Alue` | SSS + full hierarchy — filter to SSS for national |
| Measures | `Tiedot` | Same structure as 13ys |

> **Unknown quintile (09):** Strip code 09 from output (no income classification). The output should show 5 rows (quintiles I–V).

---

## Phase 27: API Exploration & Table Registry ✅ COMPLETE

**Goal:** Verify exact variable codes for all new tables; register them in `election-tables.ts`.

### Tasks

- [x] ~~GET metadata for `statfin_evaa_pxt_13su`~~ — **confirmed** (see Confirmed Variable Codes section)
- [x] ~~GET metadata for `statfin_evaa_pxt_13ys`~~ — **confirmed** (age groups, Tiedot measures, Alue dimension)
- [x] ~~GET metadata for `statfin_evaa_pxt_13yv`~~ — **confirmed** (quintile codes 01–05, code 09=unknown to strip)
- [x] ~~GET metadata for `statfin_kvaa_pxt_14w4`~~ — **confirmed** (gender var and eligible voter code differ from 13su)
- [x] GET metadata for `statfin_evaa_pxt_13yt` — confirm education level value codes and Tiedot measures
- [x] GET metadata for `statfin_evaa_pxt_13yu` — confirm origin/language value codes
- [x] GET metadata for `statfin_evaa_pxt_13yw` — confirm primary activity value codes
- [x] GET metadata for `statfin_kvaa_pxt_152q` (age group) and `statfin_kvaa_pxt_152r` (education) — confirm variable codes; note whether geographic `Alue` dimension is also present (expected yes)
- [x] GET metadata for `statfin_euvaa_pxt_14ha` (age group) and `statfin_euvaa_pxt_14hb` (education)
- [x] GET metadata for `statfin_pvaa_pxt_14nk` (age group) and `statfin_pvaa_pxt_14nl` (education)
- [x] Extend variable code reference table (see Confirmed Variable Codes section) with remaining turnout tables (13yt, 13yu, 13yw, 152q, 152r, 14ha, 14hb, 14nk, 14nl)
- [x] Add `voter_background` and `voter_turnout_by_demographics` fields to `ElectionTableSet` interface
- [x] Add `findVoterBackgroundTableForType()` helper
- [x] Register tables in `election-tables.ts`:
  - parliamentary 2023: `voter_background: 'statfin_evaa_pxt_13su'` + all 5 turnout tables
  - municipal 2025: `voter_background: 'statfin_kvaa_pxt_14w4'` + all 5 turnout tables
  - eu_parliament 2024: 5 turnout tables (no voter_background)
  - presidential 2024: 5 turnout tables (no voter_background)

### Tests
- [x] `npm run build` exits 0
- [x] ~~Spot-check: `statfin_evaa_pxt_13su` metadata group dimension~~ — confirmed pre-phase
- [x] ~~Spot-check: `statfin_evaa_pxt_13yv` income quintile codes~~ — confirmed: 5 quintile values (01–05) + SSS total + 09 unknown
- [x] ~~Spot-check: `statfin_kvaa_pxt_14w4` years~~ — confirmed: 2012, 2017, 2021, 2025

---

## Phase 28: Loaders & Normalizers ✅ COMPLETE

**Goal:** Implement data loading and normalization for both data types.

### Tasks

**New types (src/data/types.ts):**
- [x] Add `VoterBackgroundRow`
- [x] Add `VoterTurnoutDemographicRow`

**New normalizers:**
- [x] `normalizeVoterBackground(rawResponse, electionType, group, dimension)` → `VoterBackgroundRow[]`
- [x] `normalizeVoterTurnoutByDemographics(rawResponse, electionType, dimension)` → `VoterTurnoutDemographicRow[]`

**New loaders:**
- [x] `loadVoterBackground(electionType, year, group, dimension, gender?)` → `VoterBackgroundRow[]`
- [x] `loadVoterTurnoutByDemographics(electionType, year, dimension, gender?)` → `VoterTurnoutDemographicRow[]`

### Tests
- [x] `normalizeVoterBackground` unit test: mock 13su response → correct `VoterBackgroundRow[]` for `eligible_voters` + `education`; verify `pros` → `share_pct` and `lkm1` → `count` mapping
- [x] `normalizeVoterBackground` unit test: 14w4 mock uses `Ehdokkaan sukupuoli` variable and `0001` eligible voter code correctly
- [x] `normalizeVoterTurnoutByDemographics` unit test (age_group parliamentary): mock 13ys response with groups {018, 019, 20-24, 25-29, 30-34} → correctly aggregated into {18-24, 25-34} using count measures, turnout_pct recomputed
- [x] `normalizeVoterTurnoutByDemographics` unit test (income_quintile): mock 13yv → 5 quintile rows; code 09 (Tuntematon) is stripped; SSS row is stripped
- [x] `loadVoterBackground` integration test: real API call parliamentary 2023 `eligible_voters` `education` → non-empty rows, share_pct values sum to ~100%
- [x] `loadVoterBackground` integration test: parliamentary 2011 `elected` `income_decile` → exactly 2 rows (des1, des10 — lowest and highest decile only)
- [x] `loadVoterBackground` error test: `eu_parliament` → throws with supported types listed
- [x] `loadVoterBackground` error test: parliamentary 2007 → throws with available years listed
- [x] `loadVoterTurnoutByDemographics` integration test: parliamentary 2023 `income_quintile` → 5 rows (no Tuntematon), highest turnout in Q5 (top income), lowest in Q1
- [x] `loadVoterTurnoutByDemographics` error test: parliamentary 2019 → throws with message stating 2023 is the only available year
- [x] `loadVoterTurnoutByDemographics` error test: `regional` → throws with supported list

---

## Phase 29: Tool Handlers ✅ COMPLETE

**Goal:** Implement and register both MCP tools.

### Tasks

**New file: `src/tools/demographics/index.ts`**

> File structure confirmed: pattern is `src/tools/{category}/index.ts` exporting `register{Category}Tools(server: McpServer): void`. New file is `src/tools/demographics/index.ts` exporting `registerDemographicsTools`. Register in `src/server.ts` alongside the other `register*Tools` calls.

- [x] Zod schema for `get_voter_background`
- [x] Zod schema for `get_voter_turnout_by_demographics`
- [x] `get_voter_background` handler
- [x] `get_voter_turnout_by_demographics` handler
- [x] Register both handlers in `src/server.ts`

### Tests
- [x] `get_voter_background` parliamentary 2023 `eligible_voters` `education` → non-empty analysis output with markdown table
- [x] `get_voter_background` parliamentary 2011 `elected` `income_decile` → exactly 2 rows in output (lowest and highest decile only); output includes caveat about limited decile coverage
- [x] `get_voter_background` municipal 2025 `candidates` `employment` → non-empty output; verifies 14w4 `Ehdokkaan sukupuoli` and `0001` mappings work
- [x] `get_voter_background` `eu_parliament` → structured error naming supported election types
- [x] `get_voter_background` parliamentary 2007 → structured error listing available years
- [x] `get_voter_turnout_by_demographics` parliamentary 2023 `income_quintile` `total` → 5 rows (no Tuntematon), highest turnout in Q5 (top income), lowest in Q1
- [x] `get_voter_turnout_by_demographics` parliamentary 2023 `age_group` → 7 age group rows aggregated from {018, 019, 5-year bins}; first group label is "18–24"
- [x] `get_voter_turnout_by_demographics` eu_parliament 2024 `education` → rows present
- [x] `get_voter_turnout_by_demographics` parliamentary 2019 → structured error stating 2023 is the only available year and why
- [x] `get_voter_turnout_by_demographics` `regional` → structured error naming supported types

---

## Phase 30: Live Validation & System Prompt ✅ COMPLETE

**Goal:** Validate both tools against real published data; add system prompt documentation.

### Tasks

- [x] Live test: `get_voter_turnout_by_demographics` parliamentary 2023 `income_quintile` — Q1=58.4%, Q5=85.1% ✅
- [x] Live test: `get_voter_background` parliamentary 2023 `elected` `education` vs 2011 — Master/research: 50%→58% ✅
- [x] Live test: `get_voter_turnout_by_demographics` eu_parliament 2024 `origin_language` — Finnish 40.1%, foreign-language 17.3% ✅
- [x] Live test: `get_voter_background` municipal 2025 `candidates` `employment` — employed 74.8%, retired 14.3% ✅
- [x] Add system prompt caveat text to `src/server.ts`
- [x] `npm run build` exits 0
- [x] `npm test` all pass — 132/132
- [x] Write logbook entry

---

## Coverage summary

| Data type | Parliamentary | Municipal | EU Parliament | Presidential | Regional |
|---|---|---|---|---|---|
| Background (voters/candidates/elected) | ✅ 2011–2023 | ✅ 2012–2025 | ❌ | ❌ | ❌ |
| Turnout by age group | ✅ 2023 | ✅ 2025 | ✅ 2024 | ✅ 2024 | ❌ |
| Turnout by education | ✅ 2023 | ✅ 2025 | ✅ 2024 | ✅ 2024 | ❌ |
| Turnout by income quintile | ✅ 2023 | ✅ 2025 | ✅ 2024 | ✅ 2024 | ❌ |
| Turnout by origin/language | ✅ 2023 | ✅ 2025 | ✅ 2024 | ✅ 2024 | ❌ |
| Turnout by primary activity | ✅ 2023 | ✅ 2025 | ✅ 2024 | ✅ 2024 | ❌ |

**Future potential (out of scope for this feature):**
- `get_party_supporter_demographics` — median income, family stats by party, using 13ss (parliamentary) and 14wb (municipal)
- Age × party × gender cross-tabulation — using 14wa (municipal)
