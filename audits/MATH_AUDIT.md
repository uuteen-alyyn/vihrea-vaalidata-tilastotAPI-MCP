# Math & Logic Audit — FI Election Data MCP

**Audited:** 2026-03-17
**Files reviewed:** `src/tools/analytics/index.ts`, `src/tools/strategic/index.ts`, `src/tools/area/index.ts`, `src/tools/retrieval/index.ts`, `src/data/normalizer.ts`

---

## Severity legend

- 🔴 **Critical** — produces wrong numbers or actively misleads analysis
- 🟠 **High** — significant inconsistency or systematic misrepresentation
- 🟡 **Medium** — subtle error that could mislead in certain queries
- 🔵 **Low** — design flaw, labeling issue, or minor inefficiency

---

## 🔴 BUG-1: `analyze_candidate_profile` — `share_of_party_vote` is a ratio (0-1), not a percentage

**File:** `src/tools/analytics/index.ts:133`

```typescript
const shareOfPartyVote = partyTotalVotes > 0 ? round2(totalVotes / partyTotalVotes) : null;
```

`round2()` returns a value like `0.23`. The field is named `share_of_party_vote` with no `_pct` suffix, making it ambiguous. The exact same metric in `analyze_within_party_position` (line 789) is computed correctly as:

```typescript
pct(targetRow.votes / partyTotalVotes * 100)  // → 23.0
```

**Impact:** A candidate who has 23% of their party's vote would be reported as `0.23`, which an LLM will read as "0.23 percent". The discrepancy between tools for the same quantity will cause inconsistent analysis.

**Fix:** Change to:
```typescript
const shareOfPartyVote = partyTotalVotes > 0 ? pct(totalVotes / partyTotalVotes * 100) : null;
```
And rename the field to `share_of_party_vote_pct`.

---

## 🔴 BUG-2: `buildPartyAnalysis` — double-counts votes by summing both kunta AND vaalipiiri rows

**File:** `src/tools/retrieval/index.ts:356–365`

```typescript
for (const row of rows) {
  if (!row.party_id || row.area_level === 'koko_suomi') continue;
  // BUG: also sums vaalipiiri rows, which are already the sum of kunta rows
  existing.total_votes += row.votes;
```

When `loadPartyResults()` is called without an `area_id` filter (as in `get_party_results`, `get_election_results`, `get_area_results` with `analysis` mode), the returned `rows` contains rows at ALL area levels — kunta, vaalipiiri, AND koko_suomi. The code correctly excludes `koko_suomi`, but does **not** exclude `vaalipiiri`. Since `vaalipiiri.votes = Σ kunta.votes` for each party, every party's votes are summed approximately **twice** (once per kunta + once per vaalipiiri per kunta).

`buildCandidateAnalysis` handles this correctly by only using `aanestysalue` rows.

**Impact:** `get_party_results(output_mode='analysis')` and `get_election_results(output_mode='analysis')` return party totals that are roughly double the real figures.

**Fix:** Add an area level filter:
```typescript
if (!row.party_id || row.area_level !== 'kunta') continue;
```
Or alternatively, filter to the finest available non-aggregate level before summing.

---

## 🔴 BUG-3: `find_exposed_vote_pools` — `total_estimated_lost_votes` mislabels vote share decline as vote count loss

**File:** `src/tools/strategic/index.ts:233–236`

```typescript
const totalLostVotes = exposed.reduce(
  (s, a) => s + ((a.votes_year1 ?? 0) - (a.votes_year2 ?? 0)),
  0
);
```

Areas are selected because their vote **share** fell by ≥ `min_vote_loss_pp`. But actual vote **counts** can increase even as share falls — if overall turnout rose significantly, a party can gain raw votes while losing share. In such cases, `votes_year1 - votes_year2` would be **negative**, and `total_estimated_lost_votes` would report a negative number while the narrative says "these voters may be looking for alternatives."

Furthermore, a party can lose share in many areas but gain nationally in raw votes. The variable name `total_estimated_lost_votes` is structurally wrong.

**Fix:** Rename the output field to `net_vote_count_change_in_exposed_areas` and add a note that this is not directly equivalent to lost votes. Optionally add a separate field showing total vote share points lost across the exposed areas.

---

## 🟠 BUG-4: `rank_target_areas` — c1 (support) and c4 (upside) are perfectly anti-correlated, making the composite a disguised single-component score

**File:** `src/tools/strategic/index.ts:446–472`

```typescript
const c1_current_support = Math.min(1, share / (nationalShare * 2));
// ...
const gap = nationalShare - share;
const c4_upside = Math.max(0, Math.min(1, 0.5 + gap / (nationalShare * 2)));
```

**Mathematical proof:** Before clamping, when `share` is in the normal range (0 ≤ share ≤ 2×nationalShare):
- `c1 = share / (2 * nationalShare)`
- `c4 = 0.5 + (nationalShare - share) / (2 * nationalShare) = 1 - share / (2 * nationalShare) = 1 - c1`

Therefore **c4 = 1 - c1** exactly. They are not independent dimensions. The combined contribution to the composite is:

```
0.35 × c1 + 0.20 × c4 = 0.35 × c1 + 0.20 × (1 - c1) = 0.20 + 0.15 × c1
```

This is just a rescaled version of c1. The tool claims to compute "4 independent scoring components" but c4 adds no new information — it merely shrinks the effective weight of c1 from 0.35 to 0.15 net.

The real consequence: areas with **above-average** share score higher on c1 (0.55 weight) but lower on c4 (-0.20 weight), meaning the "current support" dimension is effectively weighted 0.15 instead of the claimed 0.35. The methodology disclosure is wrong.

**Fix:** Make c4 a genuinely independent metric — e.g., **relative growth potential** based on demographic indicators or turnout gap, or simply remove it and adjust weights. At minimum, the `scoring_methodology` description in the output must be corrected.

---

## 🟠 BUG-5: `concentrationMetrics` returns 0-1 fractions, but outputs are inconsistently labeled

**File:** `src/tools/analytics/index.ts:24–43` (function); usage at lines 150, 230, 682, 710

The `concentrationMetrics()` function returns `top1_share`, `top3_share`, etc. as **fractions (0–1)**:
```typescript
const topShare = (n: number) =>
  Math.round((sorted.slice(0, n).reduce((s, v) => s + v, 0) / total) * 1000) / 1000;
```

In `analyze_geographic_concentration` (lines 690–692), this is correctly handled with `× 100` in the interpretation:
```typescript
top1_share: `${pct(conc.top1_share * 100)}% of votes come from...`
```

But in `analyze_candidate_profile` (line 167) and `analyze_party_profile` (line 244), the raw `concentration` object is returned **directly** without any interpretation strings or unit labeling. An LLM receiving `{ "top1_share": 0.31 }` will likely interpret it as "31%" only by guessing.

**Impact:** No mathematical error, but high risk of misinterpretation. `0.31` could be read as "0.31%" rather than "31%".

**Fix:** Either rename fields to `top1_share_fraction` and add an `interpretation` block (consistent with `analyze_geographic_concentration`), or multiply by 100 and rename to `top1_share_pct` across all uses.

---

## 🟡 BUG-6: `analyze_candidate_profile` — `total_votes` fallback sums äänestysalue rows, which may be incomplete

**File:** `src/tools/analytics/index.ts:119`

```typescript
const totalVotes = vpRow?.votes ?? candidateRows.filter((r) => r.area_level === 'aanestysalue').reduce((s, r) => s + r.votes, 0);
```

If no VP-level aggregate row is found, votes are summed from äänestysalue rows. However, candidate data is loaded per vaalipiiri — if only one unit is loaded and the candidate ran across multiple vaalipiiri (not possible in Finnish parliamentary elections, but possible for EU/presidential), this would give partial totals.

More practically: if `unit_key` is omitted for a parliamentary election, `loadCandidateResults` may fail or return incomplete data, and the fallback silently returns a partial sum with no warning.

**Fix:** When falling back to äänestysalue aggregation, add a `warning` field to the output indicating that the total is reconstructed from äänestysalue rows and may be incomplete.

---

## 🟡 BUG-7: `analyze_area_volatility` and `get_area_profile` — Pedersen index can be inflated by party splits/mergers creating ghost changes

**File:** `src/tools/area/index.ts:294–301`, `139–149`

The Pedersen index is computed from `party_id` keys. If a party changes its `party_id` between elections (e.g., due to a name change, split, or merger), the algorithm treats the old party as having gone to 0 and the new party as having appeared from 0 — adding both the full old share AND the full new share to the volatility sum. This can result in a Pedersen value of e.g. 20pp when the actual voter movement was near zero.

The `area_tools` implementation at line 56 excludes `SSS` (party total) but not `'00'` (which appears in retrieval rankings as a code to filter) or other meta-codes. If meta-codes slip through, they add phantom volatility.

**Fix:** Document this limitation clearly in the `method` output. Optionally filter out party_id codes that appear in only one of the two years but represent >5% of the total (flagging them as structural rather than behavioral volatility).

---

## 🟡 BUG-8: `estimate_vote_transfer_proxy` — "co-movement" classification ignores magnitude

**File:** `src/tools/strategic/index.ts:319–322`

```typescript
co_movement: (loser_change !== null && gainer_change !== null)
  ? (loser_change < 0 && gainer_change > 0 ? 'consistent_with_transfer' : 'inconsistent')
  : 'insufficient_data',
```

An area is classified `consistent_with_transfer` if the losing party lost **any** votes (even 1) and the gaining party gained **any** votes (even 1). A municipality where party A lost 1,000 votes and party B gained 2 votes would be labeled "consistent with transfer" — but that's noise, not signal.

The `top_transfer_areas` output sorts by `|loser_change|` which helps, but the `n_consistent_with_transfer` and `pct_consistent` summary metrics are inflated by these noise cases.

**Fix:** Add a minimum threshold: e.g., require `|loser_change| >= min_votes` AND `gainer_change >= 0.1 * |loser_change|` to classify as consistent. At minimum, add `loser_change` and `gainer_change` to the aggregate summary so users can see the typical magnitudes.

---

## 🔵 BUG-9: `rank_target_areas` — `allVotesByArea` is computed but never used; c3 does not measure "electorate size"

**File:** `src/tools/strategic/index.ts:420–424, 457–458`

```typescript
const allVotesByArea = new Map<string, number>();
for (const r of allSubnatRows) {
  allVotesByArea.set(r.area_id, (allVotesByArea.get(r.area_id) ?? 0) + r.votes);
}
// ...
const c3_size = maxVotes > 0 ? r.votes / maxVotes : 0;  // ← uses party votes, NOT allVotesByArea
```

`allVotesByArea` (total votes from all parties per municipality) is computed but then ignored. `c3_size` uses the party's own votes relative to the party's peak municipality. The `scoring_methodology` output labels this as "electorate size" — which is wrong. It actually measures **party vote volume** in that area, which is highly correlated with c1 (current support × area size) and less useful as an independent component.

**Fix:** Use `allVotesByArea.get(r.area_id) / maxTotalVotesByArea` if the intent is to measure electorate size. Rename `c3_size` to `c3_party_vote_volume` in the methodology description if keeping current behavior.

---

## 🔵 BUG-10: `detect_inactive_high_vote_candidates` — name normalization (ä→a, ö→o) can produce false collisions

**File:** `src/tools/strategic/index.ts:27–30`

```typescript
return name.toLowerCase().replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/å/g, 'a')...
```

Finnish surnames differing only by diacritics become identical after normalization:
- "Mäki" and "Maki" → both become "maki"
- "Törmä" and "Torma" → both become "torma"

If candidate A ("Mäki") ran in 2019 and is inactive in 2023, but a different candidate "Maki" ran in 2023, the normalization would falsely conclude Mäki is still active. The inactive candidate (and their vote pool) would be **silently omitted** from results.

In Finnish, this is not rare — the pair (Hämäläinen / Hamalainen) could be two distinct real people.

**Fix:** Add a `caution` note in the output when multiple to-year candidates have the same normalized name, indicating possible false non-detection. Alternatively, use a secondary check (party match) before concluding a name match.

---

## Summary table

| ID | Tool | Severity | Type |
|---|---|---|---|
| BUG-1 | `analyze_candidate_profile` | 🔴 Critical | Wrong unit (ratio vs %) |
| BUG-2 | `buildPartyAnalysis` (analysis mode) | 🔴 Critical | Double-counting votes |
| BUG-3 | `find_exposed_vote_pools` | 🔴 Critical | Wrong variable semantics |
| BUG-4 | `rank_target_areas` | 🟠 High | c1/c4 anti-correlation, misleading methodology |
| BUG-5 | `analyze_candidate_profile`, `analyze_party_profile` | 🟠 High | Fraction vs. % inconsistency in output |
| BUG-6 | `analyze_candidate_profile` | 🟡 Medium | Silent partial totals on fallback |
| BUG-7 | `analyze_area_volatility`, `get_area_profile` | 🟡 Medium | Pedersen inflated by party ID changes |
| BUG-8 | `estimate_vote_transfer_proxy` | 🟡 Medium | Co-movement classification ignores magnitude |
| BUG-9 | `rank_target_areas` | 🔵 Low | Dead variable, mislabeled component |
| BUG-10 | `detect_inactive_high_vote_candidates` | 🔵 Low | Name normalization false collisions |

---

## Complete tool inventory (38 tools)

Bugs reference the IDs above. Tools with no bug reference passed the audit.

### Discovery (4 tools) — all clean ✅

| Tool | Status | Notes |
|---|---|---|
| `list_elections` | ✅ Clean | Static metadata, no math |
| `list_area_levels` | ✅ Clean | Static reference data |
| `describe_election` | ✅ Clean | Metadata lookup only |
| `get_area_hierarchy` | ✅ Clean | Static reference data |

### Entity Resolution (4 tools) — all clean ✅

| Tool | Status | Notes |
|---|---|---|
| `resolve_party` | ✅ Clean | Fuzzy match + alias map. Bigram similarity formula is correct. |
| `resolve_area` | ✅ Clean | Same fuzzy match approach, correct scoring. |
| `resolve_candidate` | ✅ Clean | Name order reversal (surname-first swap) works correctly. |
| `resolve_entities` | ✅ Clean | Batch wrapper around the three above; logic identical. |

### Canonical Retrieval (7 tools)

| Tool | Status | Notes |
|---|---|---|
| `get_party_results` (data mode) | ✅ Clean | Raw normalized rows, no derived math. |
| `get_party_results` (analysis mode) | 🔴 BUG-2 | `buildPartyAnalysis` double-counts votes at multiple area levels. Only triggered when `output_mode='analysis'` and no `area_id` filter is used. |
| `get_candidate_results` | ✅ Clean | Raw rows or clean candidate analysis (sums only `aanestysalue` rows). |
| `get_turnout` | ✅ Clean | Passthrough of raw API data with measure descriptions. No derived math. |
| `get_area_results` (data mode) | ✅ Clean | Raw rows. |
| `get_area_results` (analysis mode) | 🔴 BUG-2 | Uses same `buildPartyAnalysis` — same double-counting issue. |
| `get_election_results` (analysis mode) | 🔴 BUG-2 | Same. |
| `get_election_results` (data mode) | ✅ Clean | |
| `get_rankings` | ✅ Clean | Ranks at a single area level; no cross-level summation. |
| `get_top_n` | ✅ Clean | Delegate to `get_rankings`. |

### Deterministic Analytics (10 tools)

| Tool | Status | Notes |
|---|---|---|
| `analyze_candidate_profile` | 🔴 BUG-1, 🟠 BUG-5, 🟡 BUG-6 | `share_of_party_vote` is a 0-1 ratio while `analyze_within_party_position` returns the same metric as a percentage. Geographic concentration fractions unlabeled. Fallback total may be silent/partial. |
| `analyze_party_profile` | 🟠 BUG-5 | `geographic_concentration` fractions returned without unit context or interpretation strings. Otherwise correct. |
| `compare_candidates` | ✅ Clean | Votes and ranks from a single area level. No cross-level math. |
| `compare_parties` | ✅ Clean | Single-area query; ranks computed from the same filtered row set. |
| `compare_elections` | ✅ Clean | Vote change and share change in pp are straightforward and correctly signed. Rank change sign convention (positive = improved) is stated in the output. |
| `find_area_overperformance` | ✅ Clean | Overperformance_pp = area_share − baseline. Both are from the same unit scale (%). Baseline clearly documented. |
| `find_area_underperformance` | ✅ Clean | Mirror of overperformance, correctly implemented as baseline − area_share. |
| `analyze_geographic_concentration` | ✅ Clean | Correctly multiplies concentration fractions by 100 for human-readable interpretation strings. |
| `analyze_within_party_position` | ✅ Clean | `share_of_party_vote_pct` correctly computed as `votes / partyTotal × 100`. Votes-behind and votes-ahead calculations are correct. |
| `analyze_vote_distribution` | ✅ Clean | Mean, median, variance, std dev all computed correctly from sorted array. Population variance (÷ n) is appropriate for a complete dataset, not a sample. Histogram logic is correct. |

### Strategic Opportunity (4 tools)

| Tool | Status | Notes |
|---|---|---|
| `detect_inactive_high_vote_candidates` | 🔵 BUG-10 | Name normalization (ä→a) can create false matches. Otherwise logic is sound. |
| `find_exposed_vote_pools` | 🔴 BUG-3 | `total_estimated_lost_votes` conflates vote-share decline with raw vote loss. |
| `estimate_vote_transfer_proxy` | 🟡 BUG-8 | Co-movement binary flag ignores magnitude; aggregate statistics inflated by noise. Core correlation logic and disclaimer text are otherwise appropriate. |
| `rank_target_areas` | 🟠 BUG-4, 🔵 BUG-9 | c1/c4 are anti-correlated (not independent); `allVotesByArea` computed but unused. |

### Area-Centric (5 tools)

| Tool | Status | Notes |
|---|---|---|
| `get_area_profile` | 🟡 BUG-7 | Pedersen index can be inflated by party ID renames across elections. Historical trend correctly tracks top-N parties from reference year. |
| `compare_areas` | ✅ Clean | Side-by-side comparison at each area's native level. No cross-level aggregation. |
| `analyze_area_volatility` | 🟡 BUG-7 | Same Pedersen concern. Biggest-gainer / biggest-loser computed correctly from per-period sorted arrays. |
| `find_strongholds` | ✅ Clean | Simple sort-by-vote-share at the appropriate area level. Min-votes filter applied correctly. |
| `find_weak_zones` | ✅ Clean | Mirror of `find_strongholds`, ascending sort. Correct. |

### Audit & Transparency (4 tools) — largely clean ✅

| Tool | Status | Notes |
|---|---|---|
| `explain_metric` | ⚠️ Stale docs | The `share_of_party_vote` metric registry entry documents `unit: 'ratio (0–1)'`, which aligns with `analyze_candidate_profile` but contradicts `analyze_within_party_position` (which uses `_pct` suffix and ×100). The documentation is internally inconsistent with the tool implementations. |
| `trace_result_lineage` | ✅ Clean | Static documentation. |
| `validate_comparison` | ✅ Clean | Static rule-based validation. All 6 comparison types and their warnings are accurate. |
| `get_data_caveats` | ✅ Clean | Static registry. Caveats are accurate; notable that BUG-2 (double-counting in analysis mode) is not yet listed here. |

---

## Quick reference: which tools are safe to use as-is

**Fully safe (no issues found):**
`list_elections`, `list_area_levels`, `describe_election`, `get_area_hierarchy`, `resolve_party`, `resolve_area`, `resolve_candidate`, `resolve_entities`, `get_party_results` (data mode), `get_candidate_results`, `get_turnout`, `get_area_results` (data mode), `get_election_results` (data mode), `get_rankings`, `get_top_n`, `compare_candidates`, `compare_parties`, `compare_elections`, `find_area_overperformance`, `find_area_underperformance`, `analyze_geographic_concentration`, `analyze_within_party_position`, `analyze_vote_distribution`, `compare_areas`, `find_strongholds`, `find_weak_zones`, `trace_result_lineage`, `validate_comparison`, `get_data_caveats`

**Use with awareness of documented caveats:**
`detect_inactive_high_vote_candidates` (BUG-10), `estimate_vote_transfer_proxy` (BUG-8), `analyze_area_volatility` (BUG-7), `get_area_profile` (BUG-7), `analyze_party_profile` (BUG-5)

**Fix before trusting output:**
`analyze_candidate_profile` (BUG-1, BUG-5, BUG-6), `find_exposed_vote_pools` (BUG-3), `rank_target_areas` (BUG-4), all `analysis` mode outputs from `get_party_results` / `get_area_results` / `get_election_results` (BUG-2)
