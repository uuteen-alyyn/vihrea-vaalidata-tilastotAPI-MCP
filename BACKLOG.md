# BACKLOG — FI Election Data MCP

Persistent work queue. Items are added when requested and removed only when explicitly marked done or dropped by the user.
**At the start of every session, check this file and surface any outstanding items.**

---

## ✅ Completed (from tool audit 2026-03-19)

### T1 — Tool consolidation ✅ DONE (2026-03-21)
All removals complete: `compare_elections`, `compare_across_elections`, `get_election_results`, `get_top_n`, `analyze_within_party_position`, `find_weak_zones`, `find_area_underperformance`, `analyze_vote_distribution`.
Functionality merged into survivors: `compare_across_dimensions`, `get_party_results`, `get_rankings`, `analyze_candidate_profile`, `find_strongholds`, `find_area_overperformance`.
Dead code blocks removed. Current tool count: 39 (including new `list_unit_keys`).

### T2 — Renames and description fixes ✅ DONE (2026-03-21)
All renames done: `get_candidate_trajectory`, `find_vote_decline_areas`, `rank_areas_for_party`.
All fixes done: `list_elections` presidential area levels, `get_turnout` rows_truncated flag + 5000 cap, `find_area_overperformance` min_votes default 50, `describe_election` regional label → `candidate_units`.

### T5 — System prompt + README ✅ DONE (2026-03-21)
- system_prompt.md rewritten: MCP Resources block, list_unit_keys step, current tool names, 2007/2011 boundary note, compare_across_dimensions example
- README: parliamentary candidate years corrected to 2007–2023; MCP Resources and MCP Prompts sections added; Known Limitations updated (stale 2019/2023 claim removed)

---

## 🟡 Medium priority

### T3 — Mathematical metric fixes
- Pedersen normalization: expose `pedersen_raw` as primary, label normalized as heuristic
- `rank_areas_for_party` c1 formula: fix cap to allow differentiation up to 3× national average
- `estimate_vote_transfer_proxy`: add Pearson r between loser/gainer changes across areas

### T4 — ENP and D'Hondt additions (new functionality)
- Add `compute_enp()` utility; expose in `analyze_party_profile`; register in `explain_metric`
- Add `computeDHondt()` utility + `SEATS_BY_VAALIPIIRI` static map; expose seat projection in `analyze_candidate_profile` for parliamentary elections

### T6 — Presidential multi-year vaalipiiri routing
- Wire `statfin_pvaa_pxt_14db` into `query_election_data` for presidential + vaalipiiri + multi-year queries

---

## Integration / live tests (not code changes)

### Phase 15 live test
- Run `compare_across_dimensions` for SDP across: municipal 2021, parliamentary 2023, regional 2025.
- Verify results are plausible and cross-type caveats appear correctly.
- (`compare_across_elections` was removed in T1 — use `compare_across_dimensions` instead.)

### Phase 16: System prompt test in Claude Desktop
- Test the full MCP server via Claude Desktop with a realistic analyst system prompt.
- **Prerequisite:** T5 (system prompt written and system_prompt.md exists).

---

## Process

- v1 created: 2026-03-18 (from SECURITY_AUDIT, POLSCI_AUDIT, MATH_AUDIT carry-overs)
- v2 updated: 2026-03-18 (added 18 missing items found by re-reading conversation transcript: NEW-SEC-7/8/9/10, FUNC-7, COST-3, EFF-2, QUAL-2/6, POL-6/7/8/12/13/14/15/16, STAT-2/4, Phase 20 plan note)
