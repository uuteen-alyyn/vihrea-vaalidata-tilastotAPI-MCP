# BACKLOG — FI Election Data MCP

Persistent work queue. Items are added when requested and removed only when explicitly marked done or dropped by the user.
**At the start of every session, check this file and surface any outstanding items.**

---

## 🔴 Critical (fix before production use)

### STAT-2: BUG-5 fix may be incomplete — `analyze_candidate_profile` and `analyze_party_profile` may still return fractions from `concentrationMetrics`
- **File:** `src/tools/analytics/index.ts`
- **Issue:** Phase 19 fixed `concentrationMetrics()` to return `_pct` fields, but only `analyze_geographic_concentration` was explicitly updated to use the new field names. The same `concentrationMetrics` function is used in `analyze_candidate_profile` and `analyze_party_profile` — those callers may still reference old field names (`top1_share` etc.) and receive fractions.
- **Fix:** Audit all callers of `concentrationMetrics()` and update to `top1_share_pct`, `top3_share_pct`, etc.

### NEW-SEC-5: No TLS
- **File:** `src/server-http.ts`
- **Issue:** Service runs plain HTTP.
- **Fix:** Add TLS termination (reverse proxy or direct).

---

## 🟡 Medium priority

### POL-10: `find_area_overperformance` doesn't contextualise by area size
- **Issue:** A 5pp overperformance in a 1,000-voter municipality ≠ 5pp in a 100,000-voter city.

### COST-3: Year in cache key causes redundant API calls in `compare_elections`
- **Issue:** Each election year is a separate cache entry; `compare_elections` calls the API N times when data could be batched. Investigated in Phase 24 — architectural change needed; deferred.

### QUAL-6: System prompt may document wrong data coverage
- **Issue:** No system prompt file found in-repo (external Claude Desktop prompt). Cannot audit in-tree.

---

## Integration / live tests (not code changes)

### Phase 15 live test
- Run `compare_across_elections` for SDP across: municipal 2021, parliamentary 2023, regional 2025.
- Verify results are plausible and cross-type caveats appear correctly.

### Phase 16: System prompt test in Claude Desktop
- Test the full MCP server via Claude Desktop with a realistic analyst system prompt.

---

## Process

- v1 created: 2026-03-18 (from SECURITY_AUDIT, POLSCI_AUDIT, MATH_AUDIT carry-overs)
- v2 updated: 2026-03-18 (added 18 missing items found by re-reading conversation transcript: NEW-SEC-7/8/9/10, FUNC-7, COST-3, EFF-2, QUAL-2/6, POL-6/7/8/12/13/14/15/16, STAT-2/4, Phase 20 plan note)
