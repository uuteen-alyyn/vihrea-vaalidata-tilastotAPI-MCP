# Implementation plan — PxWeb contract migration

**Status:** IMPLEMENTED 28.08.2026. Kept as the record of what was measured and
why the design is what it is. Two things were found during implementation that
this plan did not anticipate — see §11.
**Written:** 27.08.2026
**Trigger:** every `elections_*` tool returns `Upstream data source returned 400`.
**Scope:** `vihrea-vaalidata-tilastotAPI-MCP` (this repo), consumed by
`vihrea-mcp-paatiedosto` as `submodules/elections`, currently pinned at `fc547e2`.

---

## 1. What actually broke

Statistics Finland changed the PxWeb contract for the **active `StatFin`
database**. Two independent changes, both breaking, plus a third that was easy
to miss:

1. **Table filenames lost their prefix.** `statfin_evaa_pxt_13sw.px` → `13sw.px`.
2. **Variable codes became versioned machine codes.** `Puolue` →
   `puolue_19_20230101`, `Vuosi` → `timeperiod_y`, `Tiedot` → `contentscode`.
3. **Content-value codes gained a subject prefix — for some election types only.**
   `aanet_yht` → `kvaa-aanet_yht`, but `evaa_aanet` is unchanged.

Upstream tables carry `updated: 2026-07-01`. This repo's last commit is
30.04.2026. The server has therefore been returning errors for roughly eight
weeks without anyone noticing, which is the more important problem — see §7.

The error text is misleading and contributed to the delay. `pxweb-client.ts:97`
and `:116` throw `Upstream data source returned ${res.status}` for any non-OK
response. "Upstream" is literally true but reads as *the source is down*, when
400 means **we sent a malformed request**. The URL and PxWeb's own error body go
only to `console.error`, never into the tool response.

---

## 2. Evidence — assumptions tested against the live API

Everything below was measured on 27.08.2026, not inferred. Raw captures are in
`/tmp/nodes.json` (node listings) and `/tmp/meta_full.json` (metadata for all 91
active tables); regenerate rather than trust them if this plan is picked up later.

| # | Assumption | Method | Result |
|---|---|---|---|
| A1 | The short-code rename resolves every registered table | Fetched node listings for 5 subjects × 2 databases; matched all registered IDs locally | **91/91** resolve in their declared database and subject |
| A2 | No table was silently removed or moved | Same listings | **0 missing, 0 relocated** |
| A3 | The old naming is gone, not merely deprecated | Scanned all 10 listings for `statfin_*` | **0 occurrences** — the rename is complete, so no dual-name fallback is needed |
| A4 | Archive tables changed too | Matched all 46 archive IDs against `StatFin_Passiivi` listings | **False — 46/46 unchanged.** The archive uses a different convention (`130_evaa_2019_tau_103`) and was not touched |
| A5 | The time variable is uniformly `timeperiod_y` | Metadata for all 91 | **91/91** |
| A6 | The content variable is uniformly `contentscode` | Metadata for all 91 | **91/91** |
| A7 | Variable `text` uniquely identifies a variable **within** a table | Metadata for all 91 | **91/91 unambiguous** — zero tables have duplicate texts |
| A8 | Variable `text` is unique **globally** | Same data | **False.** `'Puolue'` maps to 5 distinct codes across tables. Resolution must be per-table and at runtime |
| A9 | Every hardcoded schema variable still matches a live `text` | Cross-checked all 8 table→schema assignments, fields area/party/gender/measure | **32/32 OK** |
| A10 | Content codes are unchanged | Same cross-check | **False. 4 of 8 schemas fail** — municipal and regional now need `kvaa-` / `alvaa-` prefixes; parliamentary and EU are unchanged |
| A11 | Corrected queries return correct data | POST to `13sw`, `14z7`, `14y4` with resolved codes | **200 with correct values.** 2023 parliamentary total 3 095 604, Vihreät 217 795 = 7.0 % — matches the real result |
| A12 | The documented rate limit (10 req / 10 s) is accurate | Crawled 91 tables at 1.2 s spacing (≈8.3 req/10 s, inside the documented limit) | **False or incomplete.** 429 after ~54 requests, then blocked for several minutes. See §4.1 |

Two incidental findings worth recording:

* **`Alue/Äänestysalue` kept its old-style code.** In `13t2` and `13t6` the
  variable code is still literally `Alue/Äänestysalue`. The migration is **not
  uniform**, so any fix must handle both conventions rather than assuming all
  codes moved.
* **PxWeb returns `"."` for missing values.** The normalizers use
  `parseFloat(x) || 0`, which silently turns that into a real zero. Not caused by
  this migration; noted in §10.

---

## 3. What is NOT broken

Stating this explicitly, because it bounds the change and prevents collateral damage:

* **The archive half of the registry works.** 46 of 137 table IDs point at
  `StatFin_Passiivi` and were unaffected (A4). Those tables still use old-style
  variable codes (`Alue`, `Puolue`, `Puolueiden kannatus`, `Sar1`/`Sar2`).
  **The fix must not break them.** A blanket rename would.
* **Value codes are unchanged**: `SSS`, `VP##`, `KU###`, six-digit area codes,
  party codes. Only *content* codes moved, and only for some subjects.
* **Turnout-by-demographics content codes are unchanged**: `aoiky_al_evaa`,
  `a_al_evaa` still exist, so `demographics-normalizer.ts:185` is correct as written.
* **The server itself is healthy.** `https://vihrea-mcp.leinonensanteri.fi`
  returning `Missing Authorization: Bearer header` to a browser is the OAuth
  resource server behaving correctly.

---

## 4. Open questions to resolve before coding

### 4.1 What is the real rate limit? — **blocks §7**

`docs/api-notes.md` documents 10 requests / 10 s sliding window, and
`PxWebClient.throttle()` implements exactly that. Measurement contradicts it
(A12): sustained traffic *below* the documented rate was blocked after ~54
requests and stayed blocked for minutes, which looks like a longer-window quota
rather than a 10-second window.

Two consequences, and the second is the one that matters:

* A contract test that walks many tables will get itself blocked unless paced correctly.
* **The production client may be tripping this today.** A national candidate
  query fans out over 13 per-vaalipiiri tables; under a stricter real limit,
  some of those requests may be returning 429 — which the current code reports
  as the same opaque `Upstream data source returned 429`.

**Task:** characterise the limit deliberately (vary spacing, record where 429
begins and how long the block lasts), then correct both the throttle and the
documentation. Do this **first** — it changes the design of the contract test.

### 4.2 Is `text` stable enough to key on?

A7/A9 prove `text` is unambiguous and correct *today*. They cannot prove it is
stable across future revisions. Texts are Finnish display labels and already vary
across tables for the same concept (`Alue`, `Äänestysalue`, `Alue/Äänestysalue`;
`Sukupuoli`, `Ehdokkaan sukupuoli`, `Äänioikeutetun sukupuoli`).

This is the plan's main residual risk. Mitigations in §5.

### 4.3 Are there new years to add?

`14z7` now covers 1976–2025 and `14y4` covers 2022–2025. Out of scope for the
repair, but worth checking whether the registry advertises everything the tables
now contain. Separate change, separate commit.

---

## 5. Design

### The decision: resolve identifiers from metadata at runtime

**Rejected — hardcode the new codes in the registry.** It is the smallest diff
and it is a trap. The new codes embed classification version dates
(`puolue_19_20230101`, `kunta_128_20250101`); they are *designed* to change. A9
shows the registry's declared names still match live `text` values, so the names
are not wrong — only the assumption that a name is a *code* is wrong. Hardcoding
the current codes rebuilds the same fragility and guarantees a repeat, and A8
means it cannot even be done with a global rename table.

**Chosen — a single resolution layer.** One function that, given a table's
metadata plus the schema's declared roles, returns the concrete codes to use for
that table. Everything downstream — query builders *and* normalizers — consumes
resolved codes and nothing else.

Resolution order per role, strongest signal first:

| Role | Strategy | Justification |
|---|---|---|
| measure | literal `contentscode` | A6: 91/91 |
| year | literal `timeperiod_y`, falling back to the metadata `time: true` flag | A5: 91/91; the flag is a structural backstop that survives a rename |
| area / party / gender / candidate | exact match on `code`, then exact match on `text`, then an ordered candidate list | Handles new-style tables (A9), old-style archive tables and `Alue/Äänestysalue` (where `code === text`) with one mechanism |
| content values | exact match against the table's `contentscode` values, then unique-suffix match | A10: separator varies (`evaa_aanet` vs `kvaa-aanet_yht`), so suffix matching is safer than constructing a prefix |

Two rules that make this safe rather than merely clever:

1. **Suffix matching must assert exactly one match.** `endsWith('aanet_yht')`
   correctly excludes `kvaa-aanet_yht_medv_lkm`, but that is a property of
   today's data, not a guarantee. Ambiguity must throw.
2. **Failure must name what it looked for and what the table actually offers.**
   The whole reason this took eight weeks to surface is that the error said
   nothing. A resolution failure should read like
   `table 14z7: no variable matching role 'party' (tried code/text 'Puolue'); available: Vuosi, Alue, Puolue, Tiedot`.

### Why the registry gets rewritten anyway

Even though `withPx()` could strip the prefix in one line and fix all 91 IDs at
once, **rewrite the registry to the real IDs instead.** A3 shows there is no
old-form name left upstream, so a translation layer would exist only to preserve
strings that are now false — and those strings are not private: `tools/audit/index.ts`
publishes them to the model as documentation. A hidden regex would leave the
audit tool confidently telling users about tables that do not exist.

---

## 6. Work breakdown

Ordered by dependency. Each phase should be independently reviewable.

### Phase 0 — Establish the rate limit
Resolve §4.1. Correct `PxWebClient.throttle()` and `docs/api-notes.md`.
**Blocks Phase 3.**

### Phase 1 — Resolution layer
New module. Pure functions over metadata, no I/O, therefore fully unit-testable
against captured real metadata. Includes the error-message work.

### Phase 2 — Migrate call sites
Registry IDs (91 mechanical edits — generate them, do not hand-type), then every
consumer of a hardcoded identifier:

| File | Hits | Note |
|---|---|---|
| `src/data/election-tables.ts` | 148 | registry + 10 schema constants |
| `src/data/loaders.ts` | 41 | 8 loader functions, the main query builders |
| `src/data/normalizer.ts` | 20 | `buildKeyIndex`/`buildValueIndex` map response columns **by code** — breaks identically to the query side |
| `src/tools/audit/index.ts` | 20 | user-facing documentation strings |
| `src/data/demographics-normalizer.ts` | 9 | expects content columns `lkm1`/`pros`; live `13su` has `evaa-lkm1`/`evaa-pros` |
| `src/tools/retrieval/index.ts` | 5 | **builds a PxWeb query directly at :187, bypassing the loaders** — easy to miss |
| `src/tools/discovery/index.ts` | 4 | display labels only, no change needed |
| `src/data/candidate-index.ts` | 2 | `v.code === 'Ehdokas'` at :40 and :72 |

Also `docs/api-notes.md`, whose examples document the old contract throughout.

### Phase 3 — Tests (see §7)

### Phase 4 — Rollout (see §8)

---

## 7. Test strategy — the actual deliverable

**Every test in this repo is hermetic.** `normalizer.test.ts`,
`demographics-normalizer.test.ts` and `loaders.cache.test.ts` assert against
hand-written PxWeb fixtures; `bugs.regression.test.ts` is pure arithmetic. Only
`area-hierarchy.test.ts` mocks `fetch` at all. Nothing has ever touched the real
API.

So the full suite passed, and still passes, while **every single tool was
broken**. Repairing the codes without fixing that leaves the same blindness in
place, and the next revision will cost another eight weeks. The contract test is
the point of this work; the rename is incidental.

**7.1 Contract test — live, small, scheduled.** One assertion per shape that can
drift, not per tool:
* a registered table ID still resolves (GET metadata → 200)
* the declared role for each schema still resolves to a variable
* declared content codes still resolve to a `contentscode` value
* a golden query returns known-correct numbers — 2023 parliamentary Vihreät
  217 795 votes / 7.0 % is a good anchor because it is externally verifiable

Runs on a schedule (weekly is enough — the drift window was months, not hours)
and on demand, **not** on every PR, so a Statistics Finland outage cannot block
merges. It must be paced to whatever Phase 0 establishes.

**7.2 Regenerate fixtures from real responses.** Current fixtures encode the old
contract. Capture real responses once, commit them, and note in the file how they
were produced. A fixture nobody can regenerate becomes folklore.

**7.3 Unit-test the resolver against captured metadata** for all 91 tables — the
old-style archive shape, the new-style shape, and the mixed `Alue/Äänestysalue`
case. This is where coverage should be deep, because it is free and fast.

---

## 8. Rollout

1. Merge here; `submodules/elections` moves off `fc547e2`.
2. Bump the submodule pointer in `vihrea-mcp-paatiedosto`; CI builds and pushes
   `ghcr.io/...:<short-sha>`.
3. On the box: `docker compose pull && docker compose up -d vihrea-mcp`.
4. **Clear the persisted cache.** `cache.ts` writes `CACHE_FILE`
   (default `./cache-store.json`) and reloads it at startup, with a 7-day TTL for
   historical years. Nothing harmful is cached today — the requests all fail and
   failures are not cached — but the deploy should not depend on that reasoning
   holding.
5. Smoke-test through the OAuth endpoint, not just in-container: one
   `elections_*` call per election type, since parliamentary/EU and
   municipal/regional break differently (A10) and a parliamentary-only smoke test
   would have passed while municipal stayed broken.
6. Rollback is a redeploy of the previous `:<short-sha>`.

---

## 9. Definition of done

* [ ] All five election types return correct data through the deployed server
* [ ] Municipal and regional verified specifically (the A10 asymmetry)
* [ ] An archive-backed query (2019 or 2015 parliamentary) still works — proves §3 preserved
* [ ] Contract test exists, is scheduled, and has been observed to **fail** against a deliberately broken code — an alarm never heard is not known to work
* [ ] A resolution failure produces an error naming the table, the role and the available variables
* [ ] `docs/api-notes.md` and `tools/audit/index.ts` describe the current contract
* [ ] Rate limit measured, and throttle and docs agree with the measurement

---

## 10. Deferred

* `parseFloat(x) || 0` silently converts PxWeb's `"."` missing-value marker to a
  real zero. Pre-existing, not part of this migration, but a genuine correctness
  bug: an absent value and a zero vote count are not the same thing.
* `DATABASE.archive` is referenced by 6 registry entries, but `getDatabasePath()`
  resolves the database from the entry that actually carries the table, so the
  archive database path is never used for the multi-year fallback. Harmless
  today, confusing to read.
* Registry may under-advertise the years now available in `14z7` and `14y4` (§4.3).


---

## 11. Found during implementation — not anticipated by this plan

Both were pre-existing defects that the 400s had been masking. Neither was caused
by the migration; both stood between the candidate tools and working, so both
were fixed here.

### 11.1 Candidate queries exceeded PxWeb's cell limit

`loadCandidateResults` requested the three individual outcome codes
(1=elected, 2=varalla, 3=not_elected) across every area. For `13t6` that is
169 areas x 293 candidates x 3 outcomes x 2 measures = **297 102 cells**, and
PxWeb answers 403 above roughly 100 000. Using the `SSS` aggregate instead brings
it to 99 034 — evidently what the original cell budget was designed around, which
suggests the outcome-code change was made later without re-checking the size.

Fixed by fetching vote figures against the aggregate, then the per-candidate
outcome in a second query restricted to the geographic-unit row (~900 cells).
Vote figures are identical either way, because each candidate belongs to exactly
one outcome category.

### 11.2 Some candidate tables cannot be fetched in one request at all

Municipal Helsinki (`14v9`) is 167 äänestysalue x 983 candidates x 2 measures =
**328 322 cells**. No cell limit makes that a single request. Regional Pirkanmaa
(`151b`) has the same problem.

Fixed by estimating the cell count from metadata and paging along the candidate
dimension — the one dimension a caller does not need whole in a single response.
`14v9` now takes 4 requests and returns all 983 candidates.

**The lesson for §7:** the first version of the contract test asserted only on
party tables and reported everything healthy while every candidate tool was
returning 403. A query can be perfectly addressed and still be refused for being
too large. Size is part of the contract, and the live tests now cover it.

### 11.3 Rate limit — §4.1 resolved

Measured 28.08.2026:

| Workload | Result |
|---|---|
| 20 node-listing requests in 2.8 s | all 200 — far above the documented rate |
| 20 metadata requests in 6.2 s (442 KB) | **429 on the twentieth** |
| Recovery after a 429 | 10–15 s |

The limiter is weighted by response size, not request count, so the documented
"10 requests / 10 seconds" describes neither observation and no fixed request rate
is safe. Since recovery is fast, the fix is **retry with backoff on 429** rather
than a lower rate — robust without needing to know the exact policy.

### 11.4 Still owed

* `tools/audit/index.ts` claims `election_outcome` is available for municipal 2025
  and regional 2025. Their per-äänestysalue candidate tables (`14v9`, `151b`) have
  no `Valintatieto` dimension, so it is not. Documentation inaccuracy, predates
  this work, not fixed here.
* The hand-written fixtures in `normalizer.test.ts` and
  `demographics-normalizer.test.ts` still encode the pre-migration shape. They
  pass because the resolver handles both conventions, but they no longer describe
  what the API returns. §7.2 remains open.
