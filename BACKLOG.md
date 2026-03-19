# BACKLOG — FI Election Data MCP

Persistent work queue. Items are added when requested and removed only when explicitly marked done or dropped by the user.
**At the start of every session, check this file and surface any outstanding items.**

---

## 🔴 High priority (from tool audit 2026-03-19)

### T1 — Tool consolidation (46 → ~36 tools)
Plan: `Implementation_plan_tool_update.md` Section 2 and Phase T1.
- Remove `compare_elections`, `compare_across_elections`, `get_election_results`, `get_top_n`, `analyze_within_party_position`, `find_weak_zones`, `find_area_underperformance`
- Merge functionality into surviving tools via new parameters
- Drop or merge `analyze_vote_distribution`

### T2 — Renames and description fixes
- Rename: `scrape_candidate_trajectory` → `get_candidate_trajectory`; `find_exposed_vote_pools` → `find_vote_decline_areas`; `rank_areas_by_party_presence` → `rank_areas_for_party`
- Fix `list_elections` presidential area level advertisement
- Fix `get_turnout` 500-row silent cap (add `rows_truncated` flag, raise to 5000)
- Fix `find_area_overperformance` default `min_votes` 0 → 50
- Fix `describe_election` `candidate_vaalipiirit` label for regional elections

### T5 — System prompt + README (can parallel with T2)
- Write `system_prompt.md` (see Implementation_plan_tool_update.md Section 5)
- Update README: fix municipal candidate years (2021, 2025 not just 2025); add system prompt section; add known limitations section; fix Azure deployment description

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
- Run `compare_across_elections` for SDP across: municipal 2021, parliamentary 2023, regional 2025.
- Verify results are plausible and cross-type caveats appear correctly.
- **Note:** `compare_across_elections` will be removed in T1 — re-run this test using `compare_across_dimensions` after T1.

### Phase 16: System prompt test in Claude Desktop
- Test the full MCP server via Claude Desktop with a realistic analyst system prompt.
- **Prerequisite:** T5 (system prompt written and system_prompt.md exists).

---

## Process

- v1 created: 2026-03-18 (from SECURITY_AUDIT, POLSCI_AUDIT, MATH_AUDIT carry-overs)
- v2 updated: 2026-03-18 (added 18 missing items found by re-reading conversation transcript: NEW-SEC-7/8/9/10, FUNC-7, COST-3, EFF-2, QUAL-2/6, POL-6/7/8/12/13/14/15/16, STAT-2/4, Phase 20 plan note)
