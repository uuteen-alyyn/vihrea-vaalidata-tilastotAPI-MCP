# Tool Parameter & Design Audit — 2026-03-21

Triggered by live testing bugs: year-as-string validation errors, wrong parameter names passed by LLM, missing geographic routing for EU/presidential. All 9 tool files read in full.

**Severity levels:**
- 🔴 **Critical** — causes tool failure or silent wrong results
- 🟡 **Medium** — causes LLM confusion, likely wrong parameter, recoverable
- 🟢 **Minor** — inconsistency or description gap, no failure

---

## 1. Parameter name mismatch risks

The LLM uses parameter names it infers from context. Ambiguous or asymmetric names cause wrong calls.

### 🔴 `find_vote_decline_areas` — `year1` / `year2`
`strategic/index.ts`. No indication of which is baseline and which is comparison. LLM may pass them in wrong order, or pass `from_year`/`to_year`, or `baseline_year`/`comparison_year`.
**Fix:** rename to `baseline_year` + `comparison_year`.

### 🔴 `estimate_vote_transfer_proxy` — `year1` / `year2`
Same file, same problem.
**Fix:** rename to `baseline_year` + `comparison_year`.

### 🟡 `get_area_profile` — `reference_year` + `history_years`
`area/index.ts`. Asymmetric naming: one is singular, one is plural, different prefix. LLM may expect `year` + `comparison_years` or `from_year` + `to_years`.
**Fix:** rename to `year` + `comparison_years` (or leave as-is and document clearly — lower priority).

### 🟡 `detect_inactive_high_vote_candidates` — `year` + `from_year`
`strategic/index.ts`. `year` is the target election (formerly `to_year`); `from_year` is the past election. Names are asymmetric — LLM may try to set `to_year` or `target_year`. Partially fixed already (added `year`), but the pairing is still non-obvious.
**Note:** Already improved in 2026-03-21 session. Lower priority to rename further.

### 🟡 `get_candidate_trajectory` — `query`
`comparison/index.ts`. Can be either a candidate name OR a numeric candidate_id. The name `query` doesn't convey this dual-mode. LLM may try `candidate_name` or `candidate_id`.
**Fix:** rename to `candidate_query` or add parenthetical to description.

### 🟡 `rank_areas_for_party` — `trend_year`
`strategic/index.ts`. Optional, but if omitted, the c2 trend component defaults to 0.5 for all areas (neutral), making the composite score less differentiated. LLM won't know to provide it. Should auto-detect the preceding election year.
**Fix:** auto-detect via `prevCandidateYear()` (same pattern as `detect_inactive_high_vote_candidates`).

---

## 2. Required parameters that should have defaults

### 🟡 `query_election_data` — `area_level` required
`retrieval/index.ts`. All other tools with geographic parameters either default to `koko_suomi` or infer the level. LLM often passes an election context and forgets area_level, causing a validation error.
**Fix:** make optional, default `koko_suomi`; add note "Use vaalipiiri for district breakdowns."

### 🟡 `compare_across_dimensions` — `area_level` required
`comparison/index.ts`. Same issue. Most cross-election comparisons are at `koko_suomi` level.
**Fix:** make optional, default `koko_suomi`.

### 🟢 `explain_metric` — `metric` required
`audit/index.ts`. If omitted, could return all metric names as a discovery list. Currently forces LLM to guess the exact metric key.
**Fix (low priority):** make optional; return list of valid metric keys if omitted.

### 🟢 `get_voter_background` — `group` and `dimension` required
`demographics/index.ts`. Sensible defaults exist (`eligible_voters`, `employment`). Makes the tool harder to explore.
**Fix (low priority):** make optional with defaults.

---

## 3. Optional parameters that should be required (or conditionally required)

### 🔴 `get_candidate_results` — `unit_key` always optional
`retrieval/index.ts`. For parliamentary/municipal/regional elections, omitting `unit_key` triggers a full fan-out across all 12–21 vaalipiiri/hyvinvointialue tables (~10–30s, rate-limited). The LLM cannot tell from the schema that this is expensive.
The description says "If unsure, call list_unit_keys first" — but unit_key is marked optional, so the LLM doesn't treat it as a strong requirement.
**Fix:** Add `unit_key_required: true` to `list_unit_keys` response already does this. Description needs a stronger warning: "Omitting unit_key for parliamentary/municipal/regional triggers a slow fan-out across all units. Always call list_unit_keys first."

### 🟡 `find_strongholds` — `unit_key` optional when `subject_type='candidate'`
`area/index.ts`. For candidates, unit_key is optional (defaults to a national lookup). For parliamentary/municipal/regional candidates, national candidate data doesn't exist — it must be fetched per-vaalipiiri. Without unit_key, the tool may silently return empty or national-only results.
**Fix:** Add validation: if `subject_type='candidate'` and election_type is parliamentary/municipal/regional, unit_key is effectively required. Return error with hint if omitted.

### 🟡 `rank_areas_for_party` — `trend_year` optional without auto-detection
See Issue 1 / `trend_year` above.

---

## 4. Inconsistent naming across tools

### 🟡 Year parameter in comparison tools
| Tool | Param name for past year | Param name for current/target year |
|---|---|---|
| `detect_inactive_high_vote_candidates` | `from_year` | `year` |
| `find_vote_decline_areas` | `year1` | `year2` |
| `estimate_vote_transfer_proxy` | `year1` | `year2` |
| `get_area_profile` | `history_years` | `reference_year` |
| `analyze_area_volatility` | `years` (array) | — |
| `compare_across_dimensions` | `years` (array) | — |

**No single naming convention is used.** An LLM working across tools may map wrong names.
**Fix:** standardize comparison-pair tools to `baseline_year` + `comparison_year`.

### 🟢 Party identifier: `party_id` vs `party` vs `subject_id`
Most tools: `party_id`. Demographics tools: `party` in some output fields. `query_election_data`: `subject_ids` (generic array). Inconsistent but not failure-causing.
**Fix (low priority):** standardize to `party_id` in schemas; `subject_ids` in `query_election_data` is acceptable as a generic parameter.

---

## 5. Missing election type routing / silent failures

### 🟡 `get_area_profile` — no validation that `area_id` format matches `election_type`
`area/index.ts`. If user passes `area_id='HV01'` (hyvinvointialue) with `election_type='parliamentary'`, the tool will attempt to load parliamentary party data for a regional area code and get empty results or a silent failure. Same in reverse.
**Fix:** add a check: if `election_type='regional'`, area_id must start with `HV`. If `election_type` in parliamentary/municipal/EU, area_id should be `KU###`/`VP##`/`SSS` format. Return error with format guidance if mismatch detected.

### 🟡 `find_vote_decline_areas` — unclear behavior for EU/presidential
`strategic/index.ts`. Tool accepts all election types but is documented around party vote. EU and presidential have different table structures. Unclear whether it works correctly for those types.
**Fix:** test EU/presidential paths; add a note in description if those types are unsupported.

### 🟢 `describe_election` — `available_years` already returns filter, but no validation of the query
`discovery/index.ts`. Currently good — already returns `hint: "Read election://coverage"` on error. No action needed.

---

## 6. Missing `election://coverage` hints in error paths

### 🟡 `detect_inactive_high_vote_candidates`
`strategic/index.ts`. Error for "no candidate data for year X" does not include coverage hint.
**Fix:** add `hint: "Read election://coverage for available candidate years."` to the `errResult()` calls at the top of the handler.

### 🟡 `find_vote_decline_areas`
Same file. Error paths for invalid year combinations do not reference coverage.
**Fix:** same pattern.

### 🟡 `estimate_vote_transfer_proxy`
Same file. Same issue.

### 🟡 `rank_areas_for_party`
Same file. If called for an unsupported election type or year, no coverage hint.

---

## 7. z.coerce.number() verification

All numeric parameters across all 9 files now use `z.coerce.number()`. No plain `z.number()` remaining. ✅

---

## 8. Description quality issues

### 🟡 `compare_areas` — no guidance on when to use vs. related tools
`area/index.ts`. Doesn't distinguish itself from `find_comparable_areas` or `compare_across_dimensions`. LLM may pick the wrong tool.
**Fix:** add: "Use this for same-election cross-area comparison. For multi-election trends use `analyze_area_volatility`. For finding similar municipalities use `find_comparable_areas`."

### 🟡 `find_comparable_areas` — doesn't clarify this is vote-pattern similarity, not demographic similarity
`area/index.ts`. An analyst looking for persuadable voters might use this expecting demographic matching. It ranks by historical vote-share Euclidean distance — a very different thing.
**Fix:** add: "Matches by historical vote-share pattern, not by demographics or persuadability. For voter demographics, use `get_voter_background`."

### 🟢 `trace_result_lineage` — description is vague
`audit/index.ts`. Says "trace a result back to its source" but doesn't specify what is returned.
**Fix (low priority):** expand to: "Returns the source Tilastokeskus table ID, variable selection (Vuosi/Sukupuoli/Alue filters), normalization steps, and any transformations applied."

---

## 9. Output field naming inconsistencies

### 🟡 `find_strongholds` — output key changes based on `direction` parameter
`area/index.ts`. Output key is `strongholds` when `direction='strongholds'` and `weak_zones` when `direction='weak_zones'`. LLM must know the direction it passed to parse the output.
**Fix:** Always return both keys; populate only the relevant one: `{ strongholds: [...], weak_zones: [] }`.

### 🟢 `rank_areas_for_party` — dynamic key `` `n_${areaLvl}s_scored` ``
`strategic/index.ts`. Key name is constructed from `areaLvl` at runtime (e.g., `n_kuntas_scored`, `n_vaalipiiri_scored`). LLM cannot predict the key from the schema.
**Fix (low priority):** use stable key: `areas_scored` with `area_level` as a separate field.

---

## Priority summary

| Priority | Issues | Action |
|---|---|---|
| 🔴 Fix immediately | `year1`/`year2` in `find_vote_decline_areas` + `estimate_vote_transfer_proxy`; `unit_key` warning in `get_candidate_results` | Rename params, improve description |
| 🟡 Fix soon | `query_election_data` + `compare_across_dimensions` area_level defaults; coverage hints in all strategic error paths; `get_area_profile` area_id validation; `find_strongholds` candidate unit_key; `compare_areas` + `find_comparable_areas` descriptions; `find_strongholds` output key | Code + description changes |
| 🟢 Low priority | `explain_metric` optional, voter background defaults, `trace_result_lineage` description, `rank_areas_for_party` dynamic key | Description changes only |

---

*Audit completed: 2026-03-21. Next: implement 🔴 critical fixes, then 🟡 medium priority in a follow-up session.*
