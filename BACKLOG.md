# BACKLOG — FI Election Data MCP

Persistent work queue. Items are added when requested and removed only when explicitly marked done or dropped by the user.
**At the start of every session, check this file and surface any outstanding items.**

---

## 🔴 Critical (fix before production use)

### NEW-SEC-5: No TLS
- **File:** `src/server-http.ts`
- **Issue:** Service runs plain HTTP.
- **Fix:** Infrastructure-level — reverse proxy, Cloudflare, or Azure TLS offload. No application code change needed.

---

## 🟡 Medium priority

### COST-3: Year in cache key causes redundant API calls in `compare_elections`
- **Issue:** Each election year is a separate cache entry; `compare_elections` calls the API N times when data could be batched. Investigated Phase 24 — architectural change needed; deferred indefinitely.

### QUAL-6: System prompt data coverage audit
- **Issue:** Must be done via live server (system prompt registered at runtime via `server.registerPrompt()`). Deferred to Phase 26 live tests.

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
