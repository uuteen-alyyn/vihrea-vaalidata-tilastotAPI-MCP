# Implementation Plan: Tool Audit, Consolidation & System Prompt

**Created:** 2026-03-19
**Scope:** Mathematical/political audit of all 46 tools; redundancy elimination; API utilisation review; context window efficiency; system prompt design; README update.

This plan is the direct result of a full code audit of all tool implementations after the `Implementation_plan_dynamic_queries.md` work completed.

---

## 1. Mathematical and Political Analysis — Tool by Tool

### 1.1 Discovery tools

| Tool | Assessment | Issues |
|---|---|---|
| `list_elections` | Sound. Returns a registry view. | Underadvertises presidential area levels — `get_candidate_results` can return vaalipiiri and kunta for presidential, but `list_elections` only shows `koko_suomi` and `aanestysalue`. Fix needed. |
| `list_area_levels` | Sound. Static reference data. | None. |
| `describe_election` | Sound. Pulls live metadata from registry. | `geographic_unit_type` is not reflected in the `candidate_vaalipiirit` label when `election_type === 'regional'` — the field is always called `candidate_vaalipiirit` even for regional elections where the units are hyvinvointialueet. Rename to `candidate_units` in output. |
| `describe_available_data` | Sound. New tool. Well-structured. | None. |
| `get_area_hierarchy` | Sound. Static reference data. | None. |

### 1.2 Entity Resolution tools

| Tool | Assessment | Issues |
|---|---|---|
| `resolve_party` | Sound. Three-pass resolution (exact alias → fuzzy alias → metadata). | Correct. The bigram-based `scoreMatch()` is appropriate for Finnish party names. |
| `resolve_area` | Sound. Fetches from live metadata for fresh area codes. | The `hyvinvointialue` path uses `six_digit` codes from `14y4` (e.g. `020000`), but the B3 spec described `HV07`-style codes. Need to verify that downstream tools (e.g. `get_party_results` for regional elections) accept the same six-digit format that `resolve_area` returns. If not, a mapping step is missing. |
| `resolve_candidate` | Sound. Election-type-aware since B1/B2 implementation. The `scoreMatchFast()` bigram approach handles Finnish name order variations well. | Fan-out to 21 hyvinvointialue tables for regional elections without a `unit_key` is expensive (21 API calls). The tool description warns about this but does not estimate latency for regional. |
| `resolve_entities` | Sound. Batch wrapper. Parallelises correctly. | Good design — reduces LLM round-trips for multi-entity workflows. Keep as-is. |

### 1.3 Retrieval tools

**`get_party_results`**
- Mathematically sound. Returns normalised rows.
- Political context: correct to expose vote share alongside absolute votes. Party vote share is the primary metric in proportional representation — percentage points are the unit of political analysis.
- Issue: the routing still references `13sw` for some paths. Verify that all area-level queries route to `13t2`/`14vm`/`14h2` and never hit `13sw` for area-disaggregated results. A 403 from `13sw` in production would be a user-facing failure.

**`get_candidate_results`**
- Sound. Handles `unit_key` routing and round parameter.
- Issue: when `unit_key` is omitted, the tool fans out across all units. The description warns about this. No issue with the math.

**`get_turnout`**
- Sound.
- Issue: **500-row cap is silent.** For äänestysalue-level turnout data (~2000 areas), the cap will truncate results without a warning in the returned data. The cap should be documented in the return value or raised/removed.

**`get_area_results`**
- Sound. Combines party and optional candidate results for one area.
- Issue: the tool is essentially `get_party_results(area_id=X)` with optional candidate merge. See redundancy section.

**`get_election_results`**
- Functionally identical to `get_party_results` with an added `area_level` filter.
- **REDUNDANT.** See Section 2.

**`get_rankings`**
- Sound. Deterministic sort by votes.
- Issue: the `subject` parameter uses the string values `"parties"` or `"candidates"` — real-world test found that LLMs guessed `"party"` and `"candidate"` (singular). The parameter should either accept both forms or use an enum.

**`get_top_n`**
- Mathematically identical to `get_rankings` with `limit = n`.
- **REDUNDANT.** See Section 2.

**`query_election_data`**
- Sound. The best-designed retrieval tool. Multi-type, multi-year, normalized schema.
- This is the correct foundational tool. The older single-election retrieval tools should delegate to it or be pruned.

### 1.4 Analytics tools

**`analyze_candidate_profile`**
- Sound. Computes: rank_within_party, share_of_party_vote_pct, top-N area dependence (concentration), strongest/weakest areas.
- Political context: rank_within_party in the Finnish system determines seat eligibility within each vaalipiiri via D'Hondt. The tool computes this rank correctly from within-party vote ordering but does not tell the LLM whether the rank corresponds to a seat. This is a meaningful gap for campaign analysis — knowing you ranked 3rd within a party that won 4 seats is very different from ranking 3rd in a party that won 2 seats.
- **Recommended addition:** a `seat_eligible` flag or `seats_won_by_party` field from D'Hondt projection.

**`analyze_party_profile`**
- Sound. Concentration metrics (top1/3/5/10 share) are appropriate.
- Missing: **Effective Number of Parties (ENP)** is the standard Laakso-Taagepera metric for Finnish political science (ENP = 1 / Σpi²). No tool in the MCP computes it. `analyze_party_profile` would be the natural home for the party's "effective share" relative to system fragmentation.
- Missing: the profile does not include comparison to prior election. Parties are almost always evaluated relative to their previous result. A `comparison_year` parameter (like `analyze_within_party_position` has) should be added.

**`compare_candidates`**
- Sound. Side-by-side comparison within the same unit.
- Issue: restricted to the same `unit_key` (vaalipiiri). Cross-vaalipiiri candidate comparison is not supported. This is by design (different voter pools) but should be stated explicitly in the description.

**`compare_parties`**
- Sound. National-level comparison.

**`compare_elections`**
- Compares one subject between exactly two years of the same election type.
- **Functionally subsumed** by `compare_across_dimensions` which handles multiple elections, multiple subjects, and multiple vary modes. Having `compare_elections` as a separate tool creates choice paralysis.
- Political context issue: the tool computes `vote_change` (absolute votes) and `share_change_pp` — both are correct and necessary.
- **REDUNDANT.** See Section 2.

**`find_area_overperformance`**
- Sound. Overperformance_pp = area_share − baseline_share.
- Political context: "overperformance" is the correct framing for identifying areas where a party punches above its national weight — a core campaign targeting concept.
- Issue: the baseline options are `'national'` and `'unit'` (vaalipiiri). The national baseline is appropriate for parties. The unit baseline is appropriate for candidate analysis (candidate vs. their vaalipiiri party total). Both are correct.
- Mathematical note: overperformance at äänestysalue level is noisy due to small N. The tool should flag areas with fewer than some threshold votes (currently `min_votes` param exists, but the default of 0 is too low — should default to 50 or 100 for meaningful overperformance analysis).

**`find_area_underperformance`**
- Mirror of `find_area_overperformance`. Mathematically identical, direction inverted.
- **Consolidation candidate:** merge into `find_area_overperformance` with a `direction: 'over' | 'under'` parameter. Two separate tools for this is redundant.

**`analyze_geographic_concentration`**
- Sound. Computes cumulative share of votes from top-N areas — a clean, interpretable metric.
- Uses top_n_list parameter (default [1,3,5,10]) — correct.
- **Overlap with `analyze_candidate_profile`** which already computes top-N share. The standalone tool adds value for party-level concentration analysis where the profile tool doesn't apply. Keep, but document the difference clearly.

**`analyze_within_party_position`**
- Sound. Computes rank_within_party, share_of_party_vote_pct, optional trend.
- **Overlap with `analyze_candidate_profile`**: 90% of what this tool computes is already in the profile tool. The only addition is `comparison_year` trend.
- **CONSOLIDATION CANDIDATE:** Add `comparison_year` to `analyze_candidate_profile` and drop this tool.

**`analyze_vote_distribution`**
- Mathematically sound: computes Herfindahl-Hirschman Index and Gini coefficient.
- **HHI (Herfindahl-Hirschman Index):** HHI = Σ(si²) where si = share of votes in area i. This is correct. Higher HHI = more geographic concentration. Valid as a concentration metric though originally from industrial economics.
- **Gini coefficient:** Measuring inequality of vote distribution across geographic units. The political interpretation is non-obvious (Gini = 0 means the party gets exactly the same share everywhere; Gini = 1 means all votes are in one area). While mathematically valid, this is rarely used in Finnish electoral analysis and will confuse most users.
- **Recommended:** Replace Gini with the Pedersen-Concentration metric or just keep top-N share metrics which are more interpretable. The HHI is fine.
- **Overlap:** `analyze_geographic_concentration` already covers this with more interpretable output.
- **CONSOLIDATION CANDIDATE:** Merge into `analyze_geographic_concentration` or drop entirely.

**`compare_across_elections`**
- Takes `elections: [{election_type, year}]` array and subject. Uses `queryElectionData()`.
- **Nearly identical scope to `compare_across_dimensions`** which also takes an elections array, supports multiple subjects, and has vary modes.
- The only practical difference: `compare_across_elections` focuses on one subject across many elections; `compare_across_dimensions` can also vary by area or by subject.
- **REDUNDANT.** See Section 2.

### 1.5 Comparison tools

**`compare_across_dimensions`**
- Sound. The most powerful comparison tool in the MCP.
- Supports vary='election' (rows=elections, cols=areas) and vary='subject' (rows=subjects).
- PP-change correctly computed only between same-election-type consecutive years.
- **This is the one comparison tool the LLM should reach for first.**

**`scrape_candidate_trajectory`**
- Sound. Fuzzy name matching with explicit confidence thresholds (0.95 confirmed, 0.55–0.95 ambiguous).
- `election_types` required — correct design (avoids 100+ API calls from unconstrained search).
- **Naming issue:** "scrape" implies web scraping. This fetches from a structured API. Rename to `get_candidate_trajectory`.

### 1.6 Area tools

**`get_area_profile`**
- Sound. Returns party history + Pedersen volatility.
- **Pedersen normalization issue (non-standard):** The implementation normalizes Pedersen by `years_between` (e.g., divides by 4 for a 4-year gap and projects onto a 4-year cycle). This is NOT standard academic usage. The Pedersen index is reported as a per-period value, not annualized. Finnish academic sources (e.g. Grönlund & Westinen) use raw per-period Pedersen. Normalizing makes it impossible to compare with published Finnish political science literature.
  - **Fix:** Remove the `pedersen_per_4yr_cycle` field or rename it clearly as a custom heuristic, and always include the raw `pedersen_raw` for the period. The normalized value can coexist but must be labeled as non-standard.

**`compare_areas`**
- Sound. Side-by-side area comparison.
- Issue: the note "all areas must be comparable — e.g. all kunta, or all vaalipiiri" is in the description but the tool does not enforce this. Comparing a kunta to a vaalipiiri will produce misleading relative numbers (a vaalipiiri has 10–20× more votes than an average kunta). The tool should validate that all `area_ids` are at the same area_level, or at minimum warn when they are not.

**`analyze_area_volatility`**
- Same Pedersen normalization issue as `get_area_profile`. See above.
- Political context: Pedersen volatility is the correct metric for Finnish electoral volatility research. The tool correctly identifies biggest gainers/losers, excludes micro-parties. Sound otherwise.

**`find_strongholds`**
- Sound. Absolute vote share leaders — a party's best areas.
- Political framing: "stronghold" correctly means where the party wins its highest share, regardless of national context. This is distinct from overperformance (which is relative). Both concepts are analytically useful and serve different questions.
- **NOT redundant** with `find_area_overperformance` — they answer different questions.

**`find_weak_zones`**
- Sound. Inverse of find_strongholds.
- **CONSOLIDATION CANDIDATE:** Merge into `find_strongholds` with `direction: 'strongholds' | 'weak_zones'` parameter. No need for a separate tool.

**`find_comparable_areas`**
- Sound. Euclidean distance on normalized vote-share vectors.
- Mathematical note: normalizing each dimension to [0,1] across all kunnat before computing Euclidean distance is correct — without this, subjects with higher base vote shares would dominate the distance metric. The normalization ensures equal weighting.
- Political context: This is a genuine political science metric for identifying "electoral twins" — municipalities that behave alike across elections. Useful for campaign resource allocation. Well-implemented.

### 1.7 Strategic tools

**`detect_inactive_high_vote_candidates`**
- Sound. Identifies dormant vote pools from retired candidates.
- Political context: "orphaned votes" is a real campaign concept — when a popular candidate retires, their votes may be available if a suitable successor emerges. The tool correctly frames this as a targeting input, not a prediction.
- Issue: name collision detection (normalizeCandidateName) may fail for common Finnish surnames ("Mäkinen", "Korhonen"). The tool mentions collision detection but this is an inherent limitation of name-based cross-election matching.

**`find_exposed_vote_pools`**
- Sound. Identifies areas where a party lost vote share between elections.
- Political context: "exposed pools" = demobilised or persuasion-lost voters. The tool correctly notes the ambiguity (demobilisation vs. switching). This is legitimate campaign targeting logic.
- **Naming issue:** "exposed vote pools" is campaign jargon not universally understood. Consider renaming to `find_party_vote_losses` or `find_vote_decline_areas`.

**`estimate_vote_transfer_proxy`**
- The co-movement classification is mathematically sound but the thresholds are ad hoc (gainer_change ≥ 10% of |loser_change|).
- Political context: True vote transfer requires individual-level data (e.g. survey panels or ecological inference). Area-level co-movement is a structural proxy and should never be presented as evidence of actual voter movement. The tool correctly labels this as a proxy with explicit caveats — well-designed.
- Issue: the tool does not compute **statistical significance** of the co-movement (e.g. correlation coefficient across areas). Adding a Pearson r between loser_change and gainer_change across all areas would make the proxy estimate much more interpretable.

**`rank_areas_by_party_presence`**
- The composite score formula is a heuristic: 0.40 × (share / 2×national) + 0.35 × (percentile rank of Δshare) + 0.25 × (area_size / max_area_size).
- **Politically, this is reasonable but the weights are arbitrary.** The tool's own `methodology_warning` acknowledges this.
- The percentile rank for c2 (trend component) is smart — it avoids the problem of absolute vs. relative change magnitudes.
- Issue: the c1 normalization cap at 1.0 (area_share / 2×national_share) means any area where the party has more than double its national share gets c1=1.0. This collapses differentiation at the top — Helsinki constituencies for SDP vs. tiny rural strongholds would both get c1=1.0 despite very different strategic value.
- **Recommended fix for c1:** Use min(area_share / national_share, 3) / 3 to allow differentiation up to 3× the national average (or use log-scale normalization).

### 1.8 Audit tools

| Tool | Assessment |
|---|---|
| `explain_metric` | Sound. The METRIC_REGISTRY is a good design. **Missing:** ENP (Laakso-Taagepera), Gallagher index, D'Hondt seat allocation. |
| `trace_result_lineage` | Sound. Valuable for transparency. |
| `validate_comparison` | Sound. The comparison validation matrix is a useful guardrail. |
| `get_data_caveats` | Sound. Good severity classification. **Should be called proactively** by other tools instead of requiring manual LLM invocation. |

### 1.9 Demographics tools

| Tool | Assessment |
|---|---|
| `get_voter_background` | Sound. The SISU-based background data is among the richest in Finnish political data. Parameters correctly limited to parliamentary and municipal. |
| `get_voter_turnout_by_demographics` | Sound. The most reliable tool in the system — consistently returned clean results in real-world testing. |

---

## 2. Redundancy and Complexity — Consolidation Plan

### 2.1 The redundancy map

The 46 current tools contain at least **8 clearly redundant tools** and **3 tools with major overlap** that inflate the tool list without adding capability:

```
COMPARISON CLUSTER (3 tools → 1)
  compare_elections             ← subsumed by compare_across_dimensions
  compare_across_elections      ← subsumed by compare_across_dimensions
  compare_across_dimensions     ← KEEP, this is the correct tool

RETRIEVAL CLUSTER (3 tools → 2)
  get_party_results             ← KEEP (simple single-election query)
  get_election_results          ← merge into get_party_results (add area_level filter)
  query_election_data           ← KEEP (multi-election unified engine)

RANKINGS CLUSTER (2 tools → 1)
  get_rankings                  ← KEEP (add limit param)
  get_top_n                     ← DROP (identical to get_rankings with limit=n)

WITHIN-PARTY ANALYSIS (2 tools → 1)
  analyze_within_party_position ← merge into analyze_candidate_profile (add comparison_year)
  analyze_candidate_profile     ← KEEP, absorbs above

WEAK GEOGRAPHIC PERFORMANCE (2 tools → 1)
  find_strongholds              ← KEEP, rename: add direction param
  find_weak_zones               ← DROP (merge as direction='weak_zones')

UNDERPERFORMANCE (2 tools → 1)
  find_area_overperformance     ← KEEP, add direction param
  find_area_underperformance    ← DROP (merge as direction='under')

VOTE DISTRIBUTION (potential merge)
  analyze_vote_distribution     ← CANDIDATE FOR DROP (overlap with analyze_geographic_concentration)
  analyze_geographic_concentration ← KEEP
```

### 2.2 Specific consolidation actions

**Action 1 — Remove `compare_elections` and `compare_across_elections`**

Both are strict subsets of `compare_across_dimensions`. Removing them saves 2 tool slots without losing any capability. LLMs calling the old tools were already ignoring them in favour of the newer tool in test sessions.

Migration: `compare_elections(subject, year1, year2)` maps to `compare_across_dimensions(elections=[{type, year1}, {type, year2}], vary='election')`.

**Action 2 — Merge `get_election_results` → `get_party_results`**

`get_party_results` already accepts `area_id`. Adding an `area_level` filter parameter (to return all areas at a given level) completes the merge. `get_election_results` can be removed.

**Action 3 — Merge `get_top_n` → `get_rankings`**

Add `limit` parameter to `get_rankings`, drop `get_top_n`. Fix the `subject` parameter to accept both singular and plural forms (`"party"/"parties"`, `"candidate"/"candidates"`).

**Action 4 — Merge `analyze_within_party_position` → `analyze_candidate_profile`**

Add `comparison_year` parameter to `analyze_candidate_profile`. The within-party position section is already computed in the profile — the only gap is historical comparison. One merged tool is cleaner.

**Action 5 — Merge `find_weak_zones` → `find_strongholds`**

Add `direction: 'strongholds' | 'weak_zones'` (default `'strongholds'`). The logic is exactly inverted.

**Action 6 — Merge `find_area_underperformance` → `find_area_overperformance`**

Add `direction: 'over' | 'under'` (default `'over'`). Same pattern.

**Action 7 — Evaluate `analyze_vote_distribution`**

This tool computes Herfindahl index and Gini coefficient for geographic vote distribution. The Gini is non-standard for electoral analysis and the HHI overlaps with `analyze_geographic_concentration`. **Recommended: drop `analyze_vote_distribution`** and add the HHI computation to `analyze_geographic_concentration`.

**After consolidation: 46 → ~36 tools**

This is still above the ideal ~25 for reliable LLM selection, but significantly better. The system prompt (Section 5) will do the remaining work to guide tool selection.

### 2.3 Rename actions

| Current name | Proposed name | Reason |
|---|---|---|
| `scrape_candidate_trajectory` | `get_candidate_trajectory` | "scrape" implies web scraping — misleading |
| `find_exposed_vote_pools` | `find_vote_decline_areas` | More descriptive, less jargon |
| `rank_areas_by_party_presence` | `rank_areas_for_party` | Shorter, unambiguous |

---

## 3. Tilastokeskus API Structure — Effectiveness Audit

### 3.0 API-first principle (updated after full table audit)

A systematic check of all registered and unregistered tables revealed that **the API already computes several values we are currently calculating ourselves**. The rule going forward: before implementing any computation, verify that Tilastokeskus does not already publish the result directly. This section documents all confirmed cases.

### 3.1 Pre-computed pp-change (vote share change)

Three multi-year party tables include **vote share change in percentage points** vs. the previous election of the same type, pre-computed by Tilastokeskus:

| Table | Coverage | Pre-computed Tiedot field |
|---|---|---|
| `13sw` | Parliamentary 1983–2023, kunta + vaalipiiri | `Osuus äänistä, muutos edelliseen eduskuntavaaliin (pros. yksikkö)` |
| `14z7` | Municipal 1976–2025, kunta + vaalipiiri | `Osuus äänistä, muutos edelliseen kuntavaaliin (pros. yksikkö)` |
| `14y4` | Regional 2022–2025, hyvinvointialue + kunta | `Osuus äänistä, muutos edelliseen aluevaaliin (pros. yksikkö)` |
| `14h3` | EU 2024 vs 2019, kunta + vaalipiiri | `Muutos edellisiin vaaleihin (%-yks.)` |
| `13sv` | Parl turnout 1983–2023, kunta + vaalipiiri | `Äänestysprosentti, muutos... (pros. yksikkö)` |
| `14z6` | Municipal turnout 1976–2025, kunta + vaalipiiri | `Äänestysprosentti, muutos... (pros. yksikkö)` |

**Important scope note:** `14gv` (EU multi-year) does NOT have pre-computed change. For cross-year EU party comparison, the diff must be computed from two separate year queries, or `14h3` used for 2024 vs 2019 at kunta level.

**Impact on tools:**

| Tool | Current (wrong) approach | Correct API-first approach |
|---|---|---|
| `compare_across_dimensions` pp-change (parl/municipal/regional) | Load year1 + year2 separately, compute diff | Query `13sw`/`14z7`/`14y4` for year2 with muutos field → **1 API call** |
| `find_vote_decline_areas` | Load year1 + year2, compute loss per area | Query `14z7` for year2 only, filter `muutos < -threshold` → **1 API call** |
| `analyze_area_volatility` (Pedersen inputs) | Load year1 + year2 per pair, compute Δpi per party | Query `13sw`/`14z7` with muutos field, Σ\|muutos\| / 2 directly → **1 API call per period** |
| `get_area_profile` historical trends | N queries for N years | One `13sw`/`14z7` query with all years + muutos → **1 API call** |
| `analyze_party_profile` | No change shown | Add pp-change from muutos field in same party results call |

### 3.2 Pre-computed municipal seat counts

**`14z7`** (the municipal multi-year party table already in use) contains two fields that are completely unexposed in any current tool:

- `Valittujen lukumäärä` — seats won per party, per municipality, all elections 1976–2025
- `Osuus valituista %` — seat share per party

This is the municipal equivalent of a D'Hondt seat allocation — Tilastokeskus computes it and publishes it directly. No computation needed. Should be surfaced in:
- `analyze_party_profile` for municipal elections: add `seats_won` and `seat_share_pct` fields
- `get_area_results` for municipal: include seat data alongside vote data

**Note:** Parliamentary and regional equivalents are NOT in the multi-year party tables. For parliamentary, the Vertausluku (comparison number) in candidate tables enables determination, but the seat count per party per vaalipiiri is not a pre-computed measure in the party tables.

### 3.3 Election outcome: Valintatieto

**Tilastokeskus already publishes election outcome (elected / substitute / not elected) directly in the API.** No D'Hondt computation is required.

**Critical update after full candidate table audit:** The already-mapped per-vaalipiiri parliamentary candidate tables (`13t6`–`13ti`) already have `Valintatieto` as a filterable **dimension** (not just a Tiedot measure). This means you can query for elected candidates only by including `Valintatieto=['1']` in the filter — no post-processing needed. These tables also include `Vertausluku` (D'Hondt comparison number) in `Tiedot`.

| Election | Table | Where outcome lives | Incumbent flag |
|---|---|---|---|
| Parliamentary 2023 | `13t6`–`13ti` (already mapped) | `Valintatieto` dimension (Valittu/Varalla/Ei valittu) | Not available |
| Parliamentary 2023 | `13t3` (national summary, not yet mapped) | `Valintatieto` dimension + `vluku` (Vertausluku) | Not available |
| Municipal 2025 | `14uk`–`14v8` (partially mapped) | `Tiedot: kvaa_valinta` (1/2/3) | `kvaa_kunnanvalt` (1=was councillor, 3=no) |
| Regional 2025 | `14z8`–`14zt` (not mapped) | `Tiedot: alvaa_valinta` (1/2/3) | `alvaa_aluevalt` (1=was councillor, 3=no) |
| EU 2024 | `14gz` (not mapped) | Table contains elected MEPs only | Not available |
| Presidential | `14d5` (mapped) | No flag — winner has >50% in round 2 | Not applicable |

**Note:** Municipal (`14v9`–`14vk`) and regional (`14zu`–`151p`) per-unit candidate tables do NOT contain Valintatieto — they only have votes. The outcome data lives in separate per-vaalipiiri/per-hyvinvointialue outcome tables (`14uk`–`14v8`, `14z8`–`14zt`).

### 3.4 Socioeconomic area classification

`13yh` (parliamentary, 2019+2023) and `14yb` (municipal, 2017+2021+2025) classify all municipalities along two axes simultaneously:

1. **Party support level**: high/medium/low for KOK, SDP, KESK, VIHR, VAS, KD, RKP, PS
2. **Socioeconomic factors**: income level (high/medium/low), economic structure (agricultural/industrial/service), urbanization (urban/semi-urban/rural), pensioner share, child (under-7) share, unemployment rate

Each municipality falls into one cell of this classification matrix. The tables report vote share and pp-change (`Kannatuksen muutos %`) for each cell.

This enables questions like "How did VIHR do in high-urbanization, high-income areas vs. low-urbanization, low-income areas?" without computing the classification ourselves. These tables are not currently registered and no tool uses them.

**Note:** These tables are at vaalipiiri level (not kunta level), which limits granularity. They are a useful reference but not a replacement for kunta-level analysis.

### 3.5 Candidate count and composition

`14vm` (municipal 2025 year-specific party table, already registered) and `14yj` (municipal 2025 maakunta level, not registered) contain:
- `Ehdokkaiden lukumäärä` — candidate count per party
- `Osuus ehdokkaista %` — share of candidates per party

This enables gender/party composition of candidate lists, which the current tools do not expose. The gender dimension is also in these tables (`Ehdokkaan sukupuoli`), enabling questions like "What share of VIHR candidates were women in Helsinki in 2025?"

### 3.6 What genuinely must be computed (cannot be pulled from API)

| Computation | Used in | Notes |
|---|---|---|
| ENP (Laakso-Taagepera) | `analyze_party_profile` | Not published |
| Pedersen volatility index | `analyze_area_volatility`, `get_area_profile` | Not published, but **inputs are now pre-fetched** via muutos field — sum \|muutos\| / 2 |
| Geographic concentration (top-N, HHI) | `analyze_geographic_concentration` | Not published |
| Overperformance vs. national baseline | `find_area_overperformance` | Not published |
| Vote transfer co-movement + Pearson r | `estimate_vote_transfer_proxy` | Not published |
| Euclidean distance for comparable areas | `find_comparable_areas` | Not published |
| Composite strategic scoring | `rank_areas_for_party` | Not published |

### 3.7 Underutilised registered tables

**3.7.1 `statfin_pvaa_pxt_14db` — Presidential multi-year vaalipiiri**

This table (1994–2024, all candidates, koko_suomi + 13 vaalipiirit, includes both rounds) is registered in the `candidate_multiyr_vaalipiiri` field but not yet routed in any tool. `get_candidate_results` for presidential elections still routes to `14d5` (2024 only, äänestysalue level). The multi-year vaalipiiri table enables cross-year presidential trajectory analysis and should be wired into `query_election_data` for presidential + vaalipiiri + multi-year queries.

**3.7.2 Historical parliamentary party tables (Passiivi: 2019, 2015, 2011)**

The `party_by_aanestysalue` tables for 2019, 2015, and 2011 are registered and schema-mapped. Verify they are correctly routed in `loadPartyResults` when `areaId` is omitted. If not, area-level party queries for parl:2019/2015/2011 silently fall back to national totals.

**3.7.3 `get_turnout` 500-row silent cap**

The turnout table for äänestysalue-level data has ~2000 rows. The cap truncates silently. Raise to 5000 and add `rows_truncated` + `total_rows` fields to output.

### 3.8 Missing ENP computation

**Effective Number of Parties (ENP)** = 1 / Σ(pi²) where pi = party's national vote share fraction. This is the single most cited metric in Finnish comparative politics and is not published by Tilastokeskus. It must be computed from existing party results — no extra API call needed.

**Recommended:** Add ENP computation to `analyze_party_profile` and register in `explain_metric`.

**Recommended:** Add `election_outcome` and optionally `incumbent` fields to `analyze_candidate_profile` output by fetching from the appropriate outcome table. See Phase T4 for implementation spec.

### 3.5 Pearson correlation in `estimate_vote_transfer_proxy`

Adding a Pearson r between `loser_change` and `gainer_change` across all areas (or within a vaalipiiri) would turn an ad hoc co-movement count into a statistically meaningful proxy estimate. This requires no additional API calls — it's a computation over the already-fetched data.

---

## 4. Context Window Efficiency

### 4.1 The problem

An LLM connecting to this MCP receives approximately **6,500–7,500 tokens** of tool schema definitions (46 tools × ~150 tokens average per tool including name, description, and parameter schemas). This is before any conversation content.

Research and practitioner consensus suggest LLM tool selection accuracy degrades meaningfully above ~20–25 well-differentiated tools. With 46 tools, two failure modes emerge:
- **Selection paralysis:** the LLM deliberates between redundant tools (e.g. `compare_elections` vs. `compare_across_elections` vs. `compare_across_dimensions`) instead of acting
- **Recency bias:** the LLM preferentially uses tools that appear earlier in the schema list, causing later tools to be systematically underused

### 4.2 Consolidation impact

Reducing from 46 to ~36 tools saves approximately **1,000–1,500 tokens** of schema context and — more importantly — removes the ambiguity that causes selection paralysis. The consolidation in Section 2 is as much a context efficiency fix as a code quality fix.

### 4.3 Tool category grouping

Currently tools are registered across 9 source files but the LLM sees them as a flat list. The **system prompt** (Section 5) must compensate by giving the LLM a mental model of tool categories and decision rules for choosing between them.

### 4.4 Output size discipline

Several tools return large raw payloads (äänestysalue-level data, full party result sets). These consume the context window when the LLM processes them. Current mitigations:
- `output_mode: 'analysis'` exists on most tools — the analysis mode returns a summary, not raw rows
- `limit` parameter exists on some tools

**Missing:** `get_candidate_results` has no `limit` parameter. At äänestysalue level for a full vaalipiiri, this returns thousands of rows. The LLM cannot consume this effectively. A `top_n` parameter should be added.

**Recommendation:** Default `output_mode` for all retrieval tools should be `'analysis'` (not `'data'`). The LLM should opt into raw data explicitly, not the other way around. This single change would meaningfully reduce context consumption in the median use case.

---

## 5. System Prompt Plan

### 5.1 Design principles

The system prompt must be:
- **Short** (~400–600 tokens) — it runs on every session, context is precious
- **Workflow-oriented** — not a manual; a decision tree
- **Politically grounded** — the LLM needs enough Finnish electoral context to interpret data correctly
- **Error-preventive** — focus on the mistakes observed in the real LLM test session

### 5.2 Structure

The prompt should have exactly five sections:

**Section 1 — Role and data source (2 sentences)**
```
You are a Finnish election data analyst with access to Tilastokeskus (Statistics Finland) election data
via structured MCP tools. Data covers parliamentary (1983–2023), municipal (1976–2025),
regional/aluevaalit (2022–2025), EU parliament (1996–2024), and presidential (2024).
```

**Section 2 — Finnish electoral system basics (4–6 sentences)**

Covers:
- Open-list proportional representation (voters vote for a candidate, votes aggregate to party)
- D'Hondt seat allocation within each vaalipiiri
- 13 vaalipiirit for parliamentary/municipal/EU; 21 hyvinvointialueet for regional
- Why vote share ≠ seat share; why candidate rank within party matters

**Section 3 — Recommended call sequence**

```
Standard workflow:
1. describe_available_data(election_type, year) — confirm what area levels exist before querying
2. resolve_party/resolve_area/resolve_candidate — get canonical IDs (never guess an area_id)
3. query_election_data or get_party_results — fetch normalized data
4. analytics tools — compute metrics from fetched data
5. explain_metric if a user asks what a number means
6. get_data_caveats before presenting any cross-election comparison to a user
```

**Section 4 — Key constraints (bullet list)**

- Never compare vote shares across different election types without calling `validate_comparison` first (EU elections have lower and different electorates)
- Party vote share + candidate vote share ≠ 100% — they are the same votes counted differently
- `candidate_id` values are reissued each election — never use an ID from year X to query year Y
- Area codes differ by election type: KU### for kunta, VP## for vaalipiiri, HV## for hyvinvointialue
- `compare_across_dimensions` is the preferred comparison tool — use it instead of the older `compare_elections` or `compare_across_elections`

**Section 5 — Example question → tool chains (3 examples)**

```
Q: "How did VIHR do in Uusimaa across parliamentary elections?"
→ resolve_party("VIHR") → resolve_area("Uusimaa", area_level="vaalipiiri")
→ compare_across_dimensions(party="VIHR", elections=[{parl:2015},{parl:2019},{parl:2023}], area_ids=["VP02"])

Q: "Find municipalities most similar to Tampere for Green support"
→ resolve_area("Tampere") → find_comparable_areas(reference=KU837, subjects=["VIHR"], elections=[{parl:2023}])

Q: "Did Atte Harjanne run for EU parliament?"
→ scrape_candidate_trajectory("Atte Harjanne", election_types=["eu_parliament","parliamentary"], years=[2023,2024])
```

### 5.3 Delivery format

The system prompt should be saved as `system_prompt.md` in the project root. For Claude Desktop: paste into the system prompt field in the MCP settings. For API usage: include as the `system` parameter.

---

## 6. README Update Plan

### 6.1 Stale content to fix

**Data coverage table — municipal candidate years wrong:**

Current:
```
| Municipal | 1976–2025 | 2025 |
```
Correct:
```
| Municipal | 1976–2025 | 2021, 2025 |
```

**Add: system prompt section**

After the "Data coverage" table, add a "System prompt" section explaining:
- Why a system prompt is recommended
- Where to paste it (Claude Desktop: Settings → Model → System Prompt)
- Link to `system_prompt.md`

**Add: known limitations section**

Brief honest summary of current gaps:
- Election outcome (elected/not elected) available for parliamentary 2023, municipal 2025, regional 2025, and EU 2024 via Tilastokeskus Valintatieto data; not yet exposed as a tool output (planned in T4)
- ENP (Effective Number of Parties) not yet computed as a tool output (planned in T4)
- Presidential party data not available — only individual candidate vote totals
- Regional election candidate data: 2025 only (2022 has no candidate tables from Tilastokeskus)
- Incumbent flag (was candidate a sitting councillor?) available for municipal and regional but not parliamentary

**Fix: HTTP deployment section**

Option B currently describes an Azure Linux VM with port 3000 exposed. CLAUDE.md says target is Azure App Service (NGO free plan), which is different. Align README Option B with the actual Azure App Service deployment model, or add Option C for App Service.

**Add: system prompt recommendation to Option A (local setup)**

After the "You're done" note in Option A, add:
```
For best results, add a system prompt to Claude Desktop that describes the election data context.
See system_prompt.md in this project for a ready-made system prompt to paste in.
```

---

## 7. Implementation Phases

### Phase T0 — API-first routing for pp-change and municipal seats

**Goal:** Stop computing what Tilastokeskus already publishes. No tool interface changes — only internal routing improvements and new fields added to existing tool outputs.

**0.1 — Use pre-computed muutos field for pp-change**

Affected: `compare_across_dimensions`, `find_vote_decline_areas`, `analyze_area_volatility`, `get_area_profile`, `analyze_party_profile`.

For parliamentary and municipal consecutive-year comparisons, add a `loadPartyResultsWithChange(year, electionType, areaId?)` path that:
- Queries `13sw` (parliamentary) or `14z7` (municipal) or `14y4` (regional) with the muutos Tiedot code included
- Returns rows with `pp_change_vs_previous` populated from the API-computed muutos field
- Avoids a second API call for year1 data

For `analyze_area_volatility` (Pedersen): instead of loading year1 + year2 and subtracting, load year2 with muutos → Σ|muutos| / 2 directly. Single API call per period.

For `find_vote_decline_areas`: query year2 with muutos, filter `pp_change < -min_loss`. One API call.

For EU consecutive-year comparison: still requires two separate year queries or use `14h3` kunta-level table (which has change vs 2019 pre-computed for 2024).

**Tiedot codes to add to schemas:**

| Table | Schema field | Code | Label |
|---|---|---|---|
| `13sw` | parliamentary multi-year | `pp_change_code` | `Osuus äänistä, muutos edelliseen eduskuntavaaliin (pros. yksikkö)` |
| `14z7` | municipal multi-year | `pp_change_code` | `Osuus äänistä, muutos edelliseen kuntavaaliin (pros. yksikkö)` |
| `14y4` | regional multi-year | `pp_change_code` | `Osuus äänistä, muutos edelliseen aluevaaliin (pros. yksikkö)` |

**0.2 — Expose municipal seat counts from `14z7`**

`14z7` already contains `Valittujen lukumäärä` and `Osuus valituista %`. Add these Tiedot codes to the municipal party schema. Expose in:
- `analyze_party_profile` for municipal: add `seats_won` + `seat_share_pct` fields
- `get_area_results` for municipal: include seat columns in area output

No new tables. No new API calls. Just expose fields that are already fetched but not returned.

**0.3 — Expose Valintatieto from already-mapped parliamentary candidate tables**

`13t6`–`13ti` have `Valintatieto` as a dimension (Valittu/Varalla/Ei valittu) and `Vertausluku` in Tiedot. These are already queried by `analyze_candidate_profile`. Simply include these fields in the normalized output:
- Add `election_outcome: 'elected' | 'varalla' | 'not_elected'` to parliamentary candidate results
- Add `comparison_number: number` (Vertausluku) to parliamentary candidate results

No new tables. No routing changes. These fields are in the existing query response — the normalizer is currently dropping them.

**Tests:** Verify pp_change, seats_won, and election_outcome appear in tool outputs. Existing 159 tests must still pass.

**Commit:** `Phase T0: API-first — pp-change, municipal seats, Valintatieto from existing tables`

### Phase T1 — Consolidation (removals and merges)

**Goal:** Reduce to ~36 tools. No new functionality.

Actions:
1. Remove `compare_elections` (analytics/index.ts)
2. Remove `compare_across_elections` (analytics/index.ts)
3. Remove `get_election_results` — add `area_level` filter to `get_party_results`
4. Remove `get_top_n` — add `limit` param to `get_rankings`; fix `subject` enum to accept singular/plural
5. Remove `analyze_within_party_position` — add `comparison_year` to `analyze_candidate_profile`
6. Merge `find_weak_zones` into `find_strongholds` with `direction` param
7. Merge `find_area_underperformance` into `find_area_overperformance` with `direction` param
8. Drop or merge `analyze_vote_distribution` into `analyze_geographic_concentration` (add HHI)

**Tests:** 159 existing tests must still pass. Add tests for merged parameter paths.

**Commit:** `Phase T1: tool consolidation — 46 → 36 tools`

### Phase T2 — Rename and description polish

**Goal:** Fix misleading names and sharpen descriptions.

Actions:
1. Rename `scrape_candidate_trajectory` → `get_candidate_trajectory`
2. Rename `find_exposed_vote_pools` → `find_vote_decline_areas`
3. Rename `rank_areas_by_party_presence` → `rank_areas_for_party`
4. Fix `list_elections` to correctly advertise presidential area levels (vaalipiiri + kunta available via `14d5`)
5. Fix `describe_election` `candidate_vaalipiirit` → `candidate_units` label for regional elections
6. Fix `get_area_results` and `compare_areas` to warn when area_ids span different area levels
7. Fix `get_turnout` 500-row silent cap: add `rows_truncated` + `total_rows` to output; raise cap to 5000
8. Fix `find_area_overperformance` default `min_votes` from 0 to 50

**Tests:** Existing tests; update any hardcoded tool name assertions.

**Commit:** `Phase T2: tool renames and description accuracy fixes`

### Phase T3 — Mathematical fixes

**Goal:** Correct non-standard or misleading metrics.

Actions:
1. **Pedersen normalization:** In `get_area_profile` and `analyze_area_volatility`, remove `pedersen_per_4yr_cycle` or rename to `pedersen_normalized_heuristic` (non-standard). Always include `pedersen_raw` as the primary value. Add note in `explain_metric` entry for Pedersen.
2. **`rank_areas_for_party` c1 formula:** Change from `share / (2 × national_share)` to `min(share / national_share, 3) / 3` to allow differentiation up to 3× national average.
3. **`estimate_vote_transfer_proxy`:** Add Pearson r computation between `loser_change` and `gainer_change` across all areas. Include in output as `area_correlation_r` with interpretation note.
4. **`analyze_vote_distribution`:** If not dropped in T1, remove Gini coefficient or rename it clearly as "Gini of geographic vote distribution" with explicit interpretation guide.

**Commit:** `Phase T3: metric corrections — Pedersen normalization, composite score, correlation`

### Phase T4 — ENP + election outcome from Valintatieto

**Goal:** Add the two most important missing Finnish electoral outputs. Both use existing Tilastokeskus data — no algorithmic computation required.

**4.1 — ENP (Effective Number of Parties)**

Formula: ENP = 1 / Σ(pi²) where pi = party's share of total votes (as fraction, not percentage).

Actions:
- Add `computeEnp(partyRows: ElectionRecord[])` utility in `src/data/normalizer.ts`
  - Filter to `area_level === 'koko_suomi'` rows
  - Filter out party_total_code rows (SSS / "Yhteensä")
  - Compute ENP from `vote_share` values (converted to fractions: divide by 100)
- Expose in `analyze_party_profile` output as `election_enp` (the system-level ENP, not party-specific — this is a property of the full election, not the individual party)
- Expose in `get_area_profile` as `area_enp` computed from area-level party shares
- Add to `explain_metric` METRIC_REGISTRY:
  ```typescript
  { key: 'enp', name: 'Effective Number of Parties', formula: '1 / Σ(pi²)', unit: 'dimensionless',
    notes: 'Laakso-Taagepera (1979). Finland typically 5–7 for parliamentary elections.' }
  ```

**4.2 — Election outcome from Valintatieto**

Tilastokeskus publishes election outcome (elected / substitute / not elected) directly in the API. No D'Hondt computation needed.

**Data sources (confirmed via live API metadata):**

- **Parliamentary 2023:** `13t6`–`13ti` (already mapped) have `Valintatieto` as a filterable **dimension** AND `Vertausluku` in Tiedot. No new table needed. Filter `Valintatieto=['1']` to get elected candidates only.
- **Parliamentary 2023 (national view):** `13t3` (not yet mapped) has the same `Valintatieto` dimension + `vluku` (Vertausluku) at national level. Useful for looking up any candidate by ID without knowing their vaalipiiri.
- **Municipal 2025:** Per-unit tables `14v9`–`14vk` (already mapped) do NOT have outcome data. Outcome is in separate `14uk`–`14v8` tables (`Tiedot: kvaa_valinta`) + incumbent flag (`kvaa_kunnanvalt`). Route from candidate_id prefix (first 2 digits = vaalipiiri code).
- **Regional 2025:** Per-unit tables `14zu`–`151p` (already mapped) do NOT have outcome data. Outcome in `14z8`–`14zt` (`Tiedot: alvaa_valinta`) + incumbent flag (`alvaa_aluevalt`).
- **EU 2024:** `14gz` (not mapped) contains only elected MEPs. Presence = elected.
- **Presidential:** No flag; winner is implicit (round 2 >50%).

**Implementation approach:**

For parliamentary — the simplest case: the candidate's Valintatieto is already in the `13t6`–`13ti` table that `analyze_candidate_profile` already queries. Just include `Valintatieto` in the query response and expose it. No new table fetch needed.

For a general `loadCandidateOutcome(electionType, year, candidateId)` function:
1. Parliamentary: reuse the already-fetched vaalipiiri candidate data from `13t6`–`13ti`, read `Valintatieto` dimension value
2. Municipal: determine vaalipiiri from candidate_id prefix (2 digits), query `14uk`–`14v8` for that vaalipiiri, read `kvaa_valinta` and `kvaa_kunnanvalt`
3. Regional: same pattern with `14z8`–`14zt`
4. EU: query `14gz`, check if candidate_id appears → elected; absent → not elected
5. Presidential: derive from vote data (round 2 winner has >50%)

Returns: `{ election_outcome: 'elected' | 'varalla' | 'not_elected' | 'unknown', incumbent: boolean | null, comparison_number: number | null }`

**Expose in `analyze_candidate_profile`:**
```typescript
election_outcome: 'elected' | 'varalla' | 'not_elected' | 'unknown',
incumbent: true | false | null,     // null for parliamentary (no incumbent data); true/false for municipal/regional
comparison_number: number | null,   // Vertausluku from 13t6-13ti; null for other election types
```

**Register tables:** Add `candidate_outcome_national?: string` to `ElectionTableSet` for `13t3` and `14gz`. For per-unit outcome tables, add `candidate_outcome_by_unit?: Record<string, string>` mirroring the `candidate_by_aanestysalue` pattern. The 14uk–14v8 and 14z8–14zt tables use the same vaalipiiri/hyvinvointialue key structure.

**Register in `trace_result_lineage`** and add caveats:
- Parliamentary: `Valintatieto` from 13t3 is Tilastokeskus's official outcome — authoritative, no caveats
- Incumbent flag: only available for municipal and regional, not parliamentary

**Commit:** `Phase T4: ENP computation + election outcome from Valintatieto`

### Phase T5 — System prompt and README

**Goal:** Documentation complete; ready for real-world LLM testing.

Actions:
1. Write `system_prompt.md` per Section 5 design
2. Update README per Section 6 plan
3. Update `get_data_caveats` registry to include:
   - Election outcome data: `Valintatieto` is the official Tilastokeskus outcome — authoritative for all elections that publish it
   - Incumbent flag (`kvaa_kunnanvalt` / `alvaa_aluevalt`): only available for municipal and regional, not parliamentary
   - ENP limitation: computed from votes, not seats; vote-ENP and seat-ENP differ in proportional systems
   - Pedersen normalization caveat (non-standard — raw period value is the academic standard)
4. Update BACKLOG: mark Phase 16 (system prompt test) as ready to execute

**Commit:** `Phase T5: system prompt, README updates, caveat registry additions`

### Phase T6 — Presidential multi-year vaalipiiri routing

**Goal:** Wire `14db` into `query_election_data` for presidential + vaalipiiri + multi-year queries.

This is the only unrouted registered table. It enables cross-year presidential candidate vaalipiiri analysis (e.g., "How did Stubb's support in Pirkanmaa change from 2018 to 2024?").

**Commit:** `Phase T6: route 14db presidential multi-year vaalipiiri in query engine`

---

## 8. What Does NOT Need to Change

- The caching layer (`withCache`) — works correctly
- The fuzzy matching logic (`scoreMatch`, `scoreMatchFast`) — validated in real-world tests
- The `compare_across_dimensions` implementation — the best-designed tool in the MCP
- The demographics tools (`get_voter_background`, `get_voter_turnout_by_demographics`) — performed flawlessly in testing
- The audit tools (`explain_metric`, `trace_result_lineage`, `validate_comparison`, `get_data_caveats`) — correct design, only need content additions
- The canonical data schema — already supports multi-election joins
- The HTTP transport fix — implemented correctly in Phase 0

---

## 9. Priority Summary

| Phase | Effort | Impact | Recommended order |
|---|---|---|---|
| **T0 — API-first routing** | Small-Medium | HIGH — stops computing what's already in the API; adds free pp-change, municipal seats, Valintatieto to existing tools | **1st** |
| T1 — Consolidation | Medium | HIGH — reduces LLM confusion immediately | 2nd |
| T2 — Renames and descriptions | Small | HIGH — fixes misleading names that cause bad tool selection | 3rd |
| T5 — System prompt + README | Small | HIGH — without a system prompt, testing is unreliable | 4th (parallelize with T2) |
| T3 — Mathematical fixes | Small | MEDIUM — Pedersen normalization is wrong but not user-harmful today | 5th |
| T4 — ENP + Valintatieto (municipal/regional/EU outcome) | Medium | HIGH political value — ENP; extends outcome coverage beyond parliamentary | 6th |
| T6 — 14db routing | Small | MEDIUM — unlocks presidential multi-year vaalipiiri | Last |
