# Code Audit — FI Election Data MCP

**Audited:** 2026-03-17
**Auditor:** Claude Sonnet 4.6 (20+ year cybersecurity perspective)
**Scope:** Full codebase — security, cost-efficiency, computational efficiency, and general code quality
**Files reviewed:** All `src/**/*.ts`, `server-http.ts`, `cache/cache.ts`, `api/pxweb-client.ts`, `data/*`, `tools/**`, `package.json`, `.gitignore`, `.claude/settings.local.json`

> **Note:** Math/logic bugs in analytics tools are documented in `MATH_AUDIT.md`. This audit focuses on security, infrastructure, efficiency, and cross-cutting concerns not covered there.

---

## Severity legend

- 🔴 **Critical** — exploitable vulnerability or data-integrity risk requiring immediate fix
- 🟠 **High** — significant risk or correctness issue in normal production use
- 🟡 **Medium** — real problem that could cause issues under specific conditions
- 🔵 **Low** — best-practice violation, dead code, or minor inefficiency

---

## Section 1 — Security

---

### 🔴 SEC-1: `.claude/` directory not in `.gitignore` — GitHub PAT at risk of accidental commit

**File:** `.gitignore`, `.claude/settings.local.json`

The `.gitignore` contains:
```
node_modules/
dist/
.env
*.log
audits/
```

The `.claude/` directory is **not listed**. The file `.claude/settings.local.json` contains a GitHub Personal Access Token in plaintext inside bash command allowlists:
```
github_pat_11BQVDFMQ04litVm8oxnZc_...
```

If this file is ever committed (e.g. `git add -A`, `git add .`, or accidentally staged), the token is permanently in git history even after deletion.

**Fix:**
```
# Add to .gitignore:
.claude/
```
Also rotate the GitHub PAT immediately if there is any chance it was previously committed, and consider using an environment variable or credential manager instead of hardcoding tokens in config files.

---

### 🟡 SEC-2: HTTP server has no per-IP rate limiting — upstream API budget can be exhausted by one client

**File:** `src/server-http.ts:32–38`

**Context:** Open access is intentional for this service. The data served is already public (Tilastokeskus open data), the service is read-only, and requiring passwords would create unnecessary friction for election candidates using the service. This is the right design.

The real risk is narrower: one aggressive client can exhaust the global upstream rate limit (10 req/10s to `pxdata.stat.fi`), starving all other users. A single `resolve_candidate` call without a vaalipiiri hint fires 13 API calls — a loop of these ties up the upstream budget continuously.

**Fix:** Add per-IP rate limiting at the infrastructure level, not in application code. This adds zero friction for legitimate users while blocking abuse:

**Option A — nginx reverse proxy (recommended for Azure VM):**
```nginx
limit_req_zone $binary_remote_addr zone=mcp_per_ip:10m rate=30r/m;
server {
  location /mcp {
    limit_req zone=mcp_per_ip burst=10 nodelay;
    limit_req_status 429;
    proxy_pass http://localhost:3000;
  }
}
```

**Option B — Cloudflare Rate Limiting rule** (if using Cloudflare in front of Azure):
- Rule: `(http.request.uri.path contains "/mcp")` → Rate limit: 30 requests/minute per IP
- Response: 429 with a JSON body

**Option C — Azure API Management** policy:
```xml
<rate-limit-by-key calls="30" renewal-period="60" counter-key="@(context.Request.IpAddress)" />
```

**User-facing error message** (return this in the 429 response body so the user understands what happened):
```json
{
  "error": "rate_limit_exceeded",
  "message": "You have made too many requests in a short time. Please wait a moment and try again. If you need higher limits for campaign use, contact [admin contact].",
  "retry_after_seconds": 60
}
```

---

### 🟠 SEC-3: No request timeout on upstream API calls

**File:** `src/api/pxweb-client.ts:54–69`

```typescript
private async get<T>(url: string): Promise<T> {
  await this.throttle();
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  // ...
}
```

`fetch()` is called with no `signal` or timeout. If `pxdata.stat.fi` is slow, unreachable, or returns a partial response, the call hangs indefinitely. In Node.js 20, this will eventually hit the default socket timeout (~2 minutes), but that blocks the entire request handler thread.

In HTTP mode with concurrent clients, one hung upstream request can cause all subsequent requests to queue behind the rate limiter until the timeout fires.

**Fix:**
```typescript
const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), 30_000); // 30s
try {
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: controller.signal,
  });
  // ...
} finally {
  clearTimeout(timeoutId);
}
```

---

### 🟠 SEC-4: Internal URL and error details exposed to MCP clients

**File:** `src/api/pxweb-client.ts:57,68`

```typescript
throw new Error(`PxWeb GET ${url} → ${res.status} ${res.statusText}`);
throw new Error(`PxWeb POST ${url} → ${res.status} ${res.statusText}`);
```

These errors propagate through the tool handlers (via `String(err)`) directly to the MCP response:
```typescript
return errResult(`Failed to load candidate data: ${String(err)}`);
```

This exposes the full PxWeb API URL (including database paths and table IDs) to any connected MCP client. While this data is not secret in itself, leaking internal endpoint structure is a security best-practice violation.

**Fix:** Log full error details server-side, return sanitized messages to clients:
```typescript
console.error(`PxWeb error: GET ${url} → ${res.status} ${res.statusText}`);
throw new Error(`Upstream data source returned ${res.status}`);
```

---

### 🟠 SEC-5: Recursive `throttle()` can stack overflow under sustained load

**File:** `src/api/pxweb-client.ts:13–25`

```typescript
private async throttle(): Promise<void> {
  // ...
  if (this.requestTimestamps.length >= RATE_LIMIT_REQUESTS) {
    const waitMs = RATE_LIMIT_WINDOW_MS - (now - oldest) + 50;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return this.throttle();  // ← recursive call
  }
```

Each call to `throttle()` that hits the rate limit waits ~10 seconds then calls itself recursively. Under sustained concurrent load (e.g., 20 concurrent tool calls queued), the call stack grows to N recursive frames. While the async await means the stack is technically unwound between iterations, a fast re-entry condition could exhaust the stack.

**Fix:** Replace recursion with a loop:
```typescript
private async throttle(): Promise<void> {
  while (true) {
    const now = Date.now();
    this.requestTimestamps = this.requestTimestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
    if (this.requestTimestamps.length < RATE_LIMIT_REQUESTS) {
      this.requestTimestamps.push(Date.now());
      return;
    }
    const oldest = this.requestTimestamps[0]!;
    const waitMs = RATE_LIMIT_WINDOW_MS - (now - oldest) + 50;
    await new Promise(resolve => setTimeout(resolve, waitMs));
  }
}
```

---

### 🟡 SEC-6: No input length constraints on string parameters

**File:** `src/tools/entity-resolution/index.ts:273,391,474`; all tool schemas

All `z.string()` parameters (`query`, `candidate_id`, `party_id`, `unit_key`) have no `.max()` constraint. The `bigramSimilarity` function builds Set objects for every character bigram:

```typescript
const bigrams = (s: string): Set<string> => {
  const set = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
};
```

A pathologically long query string (e.g., 100,000 characters) would create a 100,000-element Set and iterate over every candidate, creating a DoS condition in `resolve_candidate` without vaalipiiri (which fetches ~500+ candidates).

**Fix:** Add `.max(200)` to all string parameters used in fuzzy matching:
```typescript
query: z.string().max(200).describe('...')
```

---

### 🟡 SEC-7: `parseInt()` on command-line port argument with no validation

**File:** `src/server-http.ts:16`

```typescript
const PORT = parseInt(process.argv[2] ?? process.env.PORT ?? '3000', 10);
```

If `process.argv[2]` is a non-numeric string, `parseInt` returns `NaN`. `http.listen(NaN)` picks a random available port, which the server then logs — but the intended port is not used. An operator might not notice the discrepancy.

Additionally, no range check: `PORT=0` picks a random OS port; `PORT=80` or `PORT=443` requires root privileges and silently fails on Linux.

**Fix:**
```typescript
const rawPort = parseInt(process.argv[2] ?? process.env.PORT ?? '3000', 10);
if (isNaN(rawPort) || rawPort < 1024 || rawPort > 65535) {
  console.error(`Invalid PORT: ${process.argv[2] ?? process.env.PORT}. Using 3000.`);
}
const PORT = (isNaN(rawPort) || rawPort < 1024 || rawPort > 65535) ? 3000 : rawPort;
```

---

### 🟡 SEC-8: Prototype pollution surface in `buildKeyIndex` / `buildValueIndex`

**File:** `src/data/normalizer.ts:9–27`

```typescript
export function buildKeyIndex(columns: PxWebColumn[]): Record<string, number> {
  return Object.fromEntries(
    columns
      .filter((c) => c.type === 'd' || c.type === 't')
      .map((c, i) => [c.code, i])
  );
}
```

Column codes come directly from the external PxWeb API response. If the Tilastokeskus API were compromised or a MITM attack replaced the response, injecting column codes like `__proto__`, `constructor`, or `toString` would produce objects with poisoned prototypes. This is a low-probability threat for a public government API, but worth noting in a hardened implementation.

**Fix:** Use `Object.create(null)` instead of `Object.fromEntries()` to create prototype-free lookup objects, or validate that column codes match the expected alphanumeric pattern before insertion.

---

## Section 2 — Cost Effectiveness

---

### 🟠 COST-1: In-memory cache lost on every process restart — cold start hits API unnecessarily

**File:** `src/cache/cache.ts`

The cache is an in-memory `Map`. Every server restart (deployment, crash, container restart) loses all cached data. For an election data service where the underlying data changes only every 1–4 years, this is extremely wasteful.

In practice:
- Each restart triggers re-fetching metadata for all accessed tables (~20+ API calls for a warm session)
- Azure container restarts (daily health checks, deployments) mean the cache is regularly cold

**Fix:** Persist the cache to a JSON file on disk (simplest) or use Redis/SQLite for shared multi-instance scenarios. A file-based cache with atomic writes would be straightforward:
```typescript
// On startup: load cache.json if it exists
// On cacheSet: write updated cache.json asynchronously
```

---

### 🟠 COST-2: `getCandidatesAllVaalipiirit` fires 13 parallel API calls without pre-checking cache

**File:** `src/tools/entity-resolution/index.ts:256–262`

```typescript
async function getCandidatesAllVaalipiirit(year: number): Promise<CandidateEntry[]> {
  const keys = Object.keys(tables.candidate_by_aanestysalue);
  const results = await Promise.all(keys.map((k) => getCandidateList(year, k)));
  return results.flat();
}
```

This fires 13 concurrent `getTableMetadata` calls. The rate limiter serializes them (10 per 10s window), so this takes ~13 seconds on a cold cache. Worse: each call is `getTableMetadata` only (for candidate names), not the full data query. The metadata response is cached, but on a cold start, one `resolve_candidate` without a vaalipiiri hint costs 13 API calls.

**Fix:**
1. Strongly document in the tool description that omitting `vaalipiiri` costs 13 API calls (it already says "~15s" — keep this).
2. Pre-warm the cache for all candidate table metadata on server startup in a background task.
3. Consider building a flat candidate name→ID lookup from metadata and caching it as a single structure.

---

### 🟡 COST-3: Multi-year table queried once per year instead of once per table

**File:** `src/data/loaders.ts:110`

```typescript
const cacheKey = `data:${tableId}:${electionType}:${year}:${areaId ?? 'all'}`;
```

The cache key includes `year`, so `compare_elections` with `[2015, 2019, 2023]` makes 3 separate API calls to the same multi-year table (13sw), each filtered to one year. The three responses are cached separately. On a cold cache, this is 3 API calls instead of 1.

This is a minor inefficiency because the year-filtered responses are smaller, but it inflates the API call count for `compare_elections`.

**Fix:** For multi-year party tables, consider caching the full unfiltered response under a key without the year, then applying year filtering in memory. The 13sw table response is large but static.

---

### 🔵 COST-4: No cache eviction policy — unbounded memory growth

**File:** `src/cache/cache.ts`

The cache `store` (a `Map`) has no size limit. TTL eviction only happens lazily on `cacheGet`. If many unique queries are made (different `candidateId`, `year`, `areaId` combinations), the map grows without bound. The `cacheDelete` and `cacheClear` functions exist but are never called.

For a long-running HTTP server receiving diverse queries, this is a memory leak over time.

**Fix:** Add an LRU (Least Recently Used) eviction policy with a configurable max entry count. A simple implementation:
```typescript
const MAX_CACHE_ENTRIES = 500;
// In cacheSet: if (store.size >= MAX_CACHE_ENTRIES) evict oldest
```

---

## Section 3 — Computational Efficiency

---

### 🟠 EFF-1: `resolve_entities` processes entities sequentially — parallelism wasted

**File:** `src/tools/entity-resolution/index.ts:587–700`

```typescript
for (const entity of entities) {
  // ...
  if (entity.entity_type === 'area') {
    const areas = await getAreaList(year);  // API call
  } else if (entity.entity_type === 'candidate') {
    cands = await getCandidatesAllVaalipiirit(year);  // up to 13 API calls
  }
}
```

The batch `resolve_entities` tool processes entities one by one in a serial `for` loop, even though all API calls within it are independent. A batch of 5 candidate resolutions takes 5× the time of one.

**Fix:** Use `Promise.all` for independent entity resolutions, deduplicate API calls by year+type using a shared promise:
```typescript
const results = await Promise.all(entities.map(entity => resolveOne(entity)));
```

---

### 🟠 EFF-2: Multiple linear scans on the same array in analytics tools

**File:** `src/tools/analytics/index.ts:124–132`

```typescript
const allVpRows = allRows.filter(/* ... */).sort(/* ... */);
const overallRank = allVpRows.findIndex(/* ... */) + 1;           // O(n)
const partyVpRows = allVpRows.filter(/* ... */).sort(/* ... */);  // O(n log n)
const rankWithinParty = partyVpRows.findIndex(/* ... */) + 1;    // O(n)
const partyTotalVotes = partyVpRows.reduce(/* ... */, 0);        // O(n)
```

Each of these is a separate linear pass. Additionally, `sort()` is called on `allVpRows` (full dataset) and then `partyVpRows` (subset), when a single sort of the full set + index lookup would suffice.

Similarly in `compare_candidates` (line 288):
```typescript
const rank = allVpRows.findIndex((r) => r.candidate_id === cid) + 1;
```
This is inside a `.map()` over `candidate_ids`, so it's O(C × N) where C is candidates to compare and N is all candidates — should be a pre-built `Map<string, number>` lookup.

**Fix:** Pre-build `Map<candidateId, rank>` and `Map<candidateId, row>` once, then do O(1) lookups per candidate.

---

### 🟡 EFF-3: Histogram uses O(10n) filter instead of O(n) single pass

**File:** `src/tools/analytics/index.ts:866–872`

```typescript
for (let i = 0; i < 10; i++) {
  const from = min + i * bucketSize;
  const to = from + bucketSize - 1;
  const count = sorted.filter((v) => v >= from && v <= to).length;  // O(n) × 10 buckets
  buckets.push({ from, to, count });
}
```

This is 10 full array scans instead of 1. For large datasets (thousands of polling stations), this is 10× slower than needed.

**Fix:** Single O(n) pass using integer division:
```typescript
const counts = new Array(10).fill(0);
for (const v of sorted) {
  const idx = Math.min(9, Math.floor((v - min) / bucketSize));
  counts[idx]++;
}
```

---

### 🟡 EFF-4: `bigramSimilarity` builds Set for every comparison — no memoization

**File:** `src/tools/entity-resolution/index.ts:26–38`

```typescript
function bigramSimilarity(a: string, b: string): number {
  const bigrams = (s: string): Set<string> => { /* ... */ };
  const aSet = bigrams(a);  // rebuilt on every call
  const bSet = bigrams(b);
}
```

In `resolve_candidate` without vaalipiiri, `bigramSimilarity` is called for the query string against each of ~500+ candidate names. The query's bigram Set is rebuilt on every comparison. Pre-computing the query bigrams once saves significant work:

**Fix:**
```typescript
function bigramSimilarity(aSet: Set<string>, b: string): number {
  const bSet = buildBigrams(b);
  // ...
}
// Caller: const queryBigrams = buildBigrams(queryNorm);
```

---

### 🔵 EFF-5: `compare_elections` makes N sequential API calls instead of using `Promise.all`

**File:** `src/tools/analytics/index.ts:393–408`

```typescript
for (const year of years.sort((a, b) => a - b)) {
  const { rows, tableId } = await loadPartyResults(year, effectiveArea, electionType);
```

Each year is awaited serially. With `[1983, 1987, 1991, 1995, 1999, 2003, 2007, 2011, 2015, 2019, 2023]` (11 elections), this makes 11 sequential API calls. The rate limiter handles concurrency to the upstream API correctly, but serial awaiting means maximum latency even when cache hits could resolve immediately.

**Fix:** Use `Promise.all` for the year queries, then sort results afterward. The rate limiter will naturally serialize any actual API calls.

---

## Section 4 — Code Quality and Other Issues

---

### 🟠 QUAL-1: Zero test coverage — "deterministic analytics" service has no tests

**Files:** entire `src/` tree

The `package.json` has no test runner (no Jest, Vitest, or similar). There are no `*.test.ts` or `*.spec.ts` files anywhere. The `MATH_AUDIT.md` identified 10 math bugs — all found by manual inspection, not automated tests.

For a service explicitly designed as a "deterministic analytics" layer consumed by LLM systems, the absence of tests means:
- Any code change can silently break vote share calculations
- The 10 bugs in `MATH_AUDIT.md` could have been caught before shipping
- Regression testing before adding Phase 12–15 features is impossible

**Fix:** Add a test framework (Vitest is lightweight and ESM-native). Start with:
1. Unit tests for all pure math functions (`concentrationMetrics`, `pct`, `round2`, Pedersen index)
2. Snapshot tests for normalizer output against known PxWeb API responses (use recorded fixtures)
3. Integration tests for key tools against the live API (or mocked responses)

---

### 🟠 QUAL-2: Critical `analysis` mode bugs not documented in `get_data_caveats`

**File:** `src/tools/audit/index.ts` (static `DATA_CAVEATS` registry)

The `get_data_caveats` tool provides consumers with known data limitations. However, it does not mention:
- **BUG-2** (double-counting in `analysis` mode for `get_party_results`, `get_area_results`, `get_election_results`) — returns ~2× the correct votes
- **BUG-1** (`share_of_party_vote` returned as ratio not percentage in `analyze_candidate_profile`)

An LLM using `get_data_caveats` before doing analysis would not be warned about these active bugs. The audit tools are supposed to be the transparency layer, but they reflect an idealized system, not the actual one.

**Fix:** Add entries to `DATA_CAVEATS` for each known active bug until those bugs are fixed. Remove the caveat entry once the bug is resolved.

---

### 🟠 QUAL-3: Silently swallowed errors create invisible failure modes

Multiple locations catch exceptions and discard them without logging:

**File:** `src/tools/analytics/index.ts:405`
```typescript
} catch (_) {
  yearResults.push({ year, votes: null, vote_share_pct: null, rank: null, error: `No data for ${year}` });
}
```

**File:** `src/tools/entity-resolution/index.ts:371`
```typescript
} catch (_) {
  // metadata fetch failed — fall through to no-match response
}
```

**File:** `src/tools/strategic/index.ts:411`
```typescript
} catch (_) {
  trendRows = null;
}
```

These patterns:
1. Make debugging impossible — there is no way to know *why* an API call failed (network error? 429? table not found?)
2. Can mask configuration errors (wrong table ID, wrong database path) that appear as "no data" to the user
3. In the analytics case, the tool returns a partial result that *looks* complete

**Fix:** Log errors at minimum:
```typescript
} catch (err) {
  console.error(`[rank_target_areas] trend year ${trend_year} failed:`, err);
  trendRows = null;
}
```

---

### 🟡 QUAL-4: No structured logging or request tracing

**Files:** `src/server-http.ts`, all tools

In HTTP mode, there is no request logging at all. No request ID, no timing, no tool name, no input parameters, no outcome. When something goes wrong in production:
- Which tool was called?
- What parameters caused the failure?
- How long did the upstream API call take?
- Is the rate limiter consistently triggering?

**Fix:** Add structured logging (e.g., with `pino` or `winston`) at the HTTP handler level and at each tool entry/exit point. At minimum, log: timestamp, tool name, parameters hash, duration, cache_hit, error if any.

---

### 🟡 QUAL-5: `ELECTION_TYPE_PARAM` is duplicated in every tool file

**Files:** `src/tools/analytics/index.ts:6–8`, `src/tools/strategic/index.ts:7–9`, `src/tools/area/index.ts` (likely), `src/tools/retrieval/index.ts` (likely)

The same Zod schema definition is copy-pasted into at least 2 confirmed locations:
```typescript
const ELECTION_TYPE_PARAM = z.enum(['parliamentary', 'municipal', 'eu_parliament', 'presidential', 'regional'])
  .optional()
  .describe('Election type. Defaults to "parliamentary".');
```

Similarly, `subnatLevel()`, `matchesParty()`, `pct()`, `round2()`, `mcpText()`, and `errResult()` are duplicated across `analytics/index.ts` and `strategic/index.ts`.

**Fix:** Extract shared constants and helper functions into `src/tools/shared.ts` and import from there.

---

### 🟡 QUAL-6: System prompt is out of date

**File:** `src/server.ts:57`

```
## Data coverage

Parliamentary elections: party data 1983–2023 (13sw); candidate data 2023 only (per-vaalipiiri tables).
```

This is wrong. The system now also has:
- Parliamentary candidate data for 2019
- Municipal candidate data for 2025
- Regional candidate data for 2025
- EU Parliament candidate data for 2019 and 2024
- Presidential candidate data for 2024 (rounds 1 & 2)

An LLM reading this system prompt would refuse to attempt EU or presidential candidate queries because it believes the data doesn't exist.

**Fix:** Update the system prompt to reflect actual data coverage. This is Phase 15 in the implementation plan — move it higher in priority.

---

### 🔵 QUAL-7: `@deprecated` field still emitted in API responses

**File:** `src/data/loaders.ts:29–31`, `229`

```typescript
/** @deprecated Use unit_code instead */
vaalipiiri_code: string;
// ...
return { rows, tableId, cache_hit, unit_code, vaalipiiri_code: unit_code };
```

The deprecated `vaalipiiri_code` field is still set and returned. No tools consume it (they use `unit_code`). It adds noise to responses and LLM context.

**Fix:** Remove the `vaalipiiri_code` field from `CandidateLoadResult` entirely. Since this is an internal type not part of the public MCP API, it is a safe breaking change.

---

### 🔵 QUAL-8: `cache_hit` metadata exposed in every tool response — LLM noise

**Files:** All analytics, retrieval, and strategic tools

Every tool response includes:
```json
"method": {
  "source_table": "13sw",
  "cache_hit": true
}
```

`cache_hit` is an internal implementation detail that is irrelevant to the LLM consumer and adds tokens to every response. The LLM reads `"cache_hit": false` as meaningful information and may include it in its reasoning.

**Fix:** Remove `cache_hit` from all tool outputs. Retain `source_table` and `description` in the `method` block as those are genuinely useful for transparency.

---

### 🔵 QUAL-9: `.gitignore` excludes `audits/` — audit documentation not version-controlled

**File:** `.gitignore:6`

```
audits/
```

The `MATH_AUDIT.md` and this `CODE_AUDIT.md` are excluded from git. This means:
- Audit findings are not tracked in version control
- They cannot be linked from commits or PRs
- They will be lost if the working directory is deleted
- Pull request reviewers cannot see the audit history

**Fix:** Remove `audits/` from `.gitignore` and commit the audit documents. If the intention was to prevent large binary audit artifacts (screenshots, exported reports) from being committed, add a more specific pattern instead:
```
audits/*.pdf
audits/*.png
```

---

## Summary Table

| ID | Category | Severity | File(s) | Issue |
|---|---|---|---|---|
| SEC-1 | Security | 🔴 Critical | `.gitignore`, `.claude/settings.local.json` | GitHub PAT not protected by .gitignore |
| SEC-2 | Security | 🟡 Medium | `server-http.ts` | No per-IP rate limiting — one client can exhaust upstream API budget |
| SEC-3 | Security | 🟠 High | `pxweb-client.ts` | No timeout on upstream API calls |
| SEC-4 | Security | 🟠 High | `pxweb-client.ts`, tools | Internal URLs leaked in error messages |
| SEC-5 | Security | 🟠 High | `pxweb-client.ts` | Recursive throttle() can stack overflow |
| SEC-6 | Security | 🟡 Medium | All tool schemas | No max length on string params — DoS via bigram |
| SEC-7 | Security | 🟡 Medium | `server-http.ts` | No port validation — NaN port accepted |
| SEC-8 | Security | 🟡 Medium | `normalizer.ts` | Prototype pollution surface from API keys |
| COST-1 | Cost | 🟠 High | `cache.ts` | In-memory cache lost on restart |
| COST-2 | Cost | 🟠 High | `entity-resolution/index.ts` | 13 parallel API calls per candidate resolve |
| COST-3 | Cost | 🟡 Medium | `loaders.ts` | Year in cache key causes N queries per compare |
| COST-4 | Cost | 🔵 Low | `cache.ts` | No cache size limit — unbounded memory growth |
| EFF-1 | Efficiency | 🟠 High | `entity-resolution/index.ts` | `resolve_entities` is serial, not parallel |
| EFF-2 | Efficiency | 🟠 High | `analytics/index.ts` | Multiple linear scans on same data |
| EFF-3 | Efficiency | 🟡 Medium | `analytics/index.ts` | Histogram O(10n) instead of O(n) |
| EFF-4 | Efficiency | 🟡 Medium | `entity-resolution/index.ts` | Bigram Set rebuilt for query on every comparison |
| EFF-5 | Efficiency | 🔵 Low | `analytics/index.ts` | `compare_elections` awaits years serially |
| QUAL-1 | Quality | 🟠 High | entire `src/` | Zero test coverage on deterministic analytics service |
| QUAL-2 | Quality | 🟠 High | `audit/index.ts` | Active math bugs not in `get_data_caveats` |
| QUAL-3 | Quality | 🟠 High | multiple tools | Silent error swallowing — no logging |
| QUAL-4 | Quality | 🟡 Medium | `server-http.ts` | No structured logging or request tracing |
| QUAL-5 | Quality | 🟡 Medium | `analytics/`, `strategic/` | Helpers duplicated across tool files |
| QUAL-6 | Quality | 🟡 Medium | `server.ts` | System prompt documents wrong data coverage |
| QUAL-7 | Quality | 🔵 Low | `loaders.ts` | `@deprecated vaalipiiri_code` still emitted |
| QUAL-8 | Quality | 🔵 Low | all tools | `cache_hit` in every tool response adds LLM noise |
| QUAL-9 | Quality | 🔵 Low | `.gitignore` | Audit documents excluded from version control |

---

## Prioritized Fix Roadmap

### Immediate (before any cloud deployment)

1. **SEC-1** — Add `.claude/` to `.gitignore` and rotate the GitHub PAT
2. **SEC-3** — Add a 30-second timeout to all upstream `fetch()` calls
3. **SEC-2** — Configure per-IP rate limiting at the infrastructure level (nginx/Cloudflare/Azure APIM) with a user-friendly 429 message including admin contact info

### Short-term (before production use)

4. **QUAL-1** — Add a test framework; write tests for all math helper functions first
5. **QUAL-2** — Document BUG-2 and BUG-1 in `get_data_caveats` until they are fixed
6. **QUAL-3** — Add `console.error` (minimum) to all silently-caught errors
7. **SEC-5** — Replace recursive `throttle()` with a while-loop
8. **QUAL-6** — Update system prompt data coverage

### Medium-term (operational hardening)

9. **COST-1** — Persist cache to disk (JSON file or SQLite)
10. **SEC-4** — Sanitize error messages returned to clients
11. **EFF-1** — Parallelize `resolve_entities`
12. **EFF-2** — Pre-build candidate rank Maps in analytics tools
13. **QUAL-5** — Extract shared helpers to `src/tools/shared.ts`
14. **QUAL-4** — Add structured request logging
15. **QUAL-9** — Remove `audits/` from `.gitignore`

---

*This audit covers infrastructure, security, and efficiency concerns. Mathematical correctness of individual tools is documented separately in `MATH_AUDIT.md`.*
