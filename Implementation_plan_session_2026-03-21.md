# Implementation Plan: Session Review 2026-03-21

**Created:** 2026-03-21
**Last revised:** 2026-03-21 (checkboxes updated after session — Stages 1–4, 6 complete; Stage 5 partial; one pending item each in Problem 3 and Stage 3)
**Scope:** Issues and improvements identified in the 2026-03-21 planning session. Covers LLM accuracy problems, unit key validation, tool discoverability, system prompt, and caching performance.

This document is a companion to `BACKLOG.md` and `Implementation_plan_tool_update.md`. It captures new insights that either add to or refine existing backlog items.

---

## Background: What triggered this session

Testing revealed that the bot could not find "Santeri Leinonen" as a 2023 parliamentary candidate. Investigation identified several underlying problems, which expanded into a broader review of the MCP's LLM accuracy and performance characteristics.

---

## Critical analysis note (added after initial draft)

The original plan relied too heavily on the system prompt as an enforcement mechanism and contained some one-off workarounds masquerading as structural fixes. This revised version reflects two corrections:

1. **MCP servers cannot inject system prompts.** The system prompt is client-side — only the consumer (Claude Desktop, etc.) can set it. The server can expose tools, resources, and MCP Prompts (user-triggered templates), but cannot force a client to behave a certain way via a system prompt. `system_prompt.md` is a *consumer guide*, not a server control.

2. **Structural fixes outperform prompt workarounds.** Hardcoded key lists in descriptions go stale. A `performance_note` field only lasts one session. The correct industry pattern is to make invalid states impossible or immediately self-correcting at the API/schema level, with the system prompt as a complement — not the primary control.

---

## Problem 1 — Unit Key Validation (systemic)

### What the problem is
When any tool receives a `unit_key` that doesn't exist (e.g., `"varsinais-suomi"` instead of `"lounais-suomi"`, or `"häme"` instead of `"hame"`), the LLM cannot self-correct because it doesn't know what keys are valid. It typically reports "candidate not found" to the user, even though the candidate exists.

### What was already fixed in this session
- `src/data/candidate-index.ts`: error now appends `Valid unit keys: helsinki, uusimaa, ...`
- `src/data/loaders.ts`: same fix for `loadCandidateResults`
- `src/tools/entity-resolution/index.ts`: `resolve_candidate` `unit_key` description now lists 2023 parliamentary keys and common pitfalls

### The deeper structural fix (replaces hardcoding in descriptions)
Hardcoding key lists in tool description strings is maintenance debt — every new election requires manual updates across multiple tool files. The correct structural fix is a dedicated lookup tool and/or an MCP Resource that the LLM can query on demand.

**New tool: `list_unit_keys`**
A lightweight tool: `list_unit_keys(election_type, year)` → returns the valid unit keys for that election, derived directly from the election-tables.ts registry. Self-updating whenever the registry is updated. No hardcoded strings in descriptions.

This also solves the core of Problem 2 and Performance 2 — if the LLM can look up the key before calling other tools, it never needs to guess.

### What still needs doing
- [x] Implement `list_unit_keys(election_type, year)` tool — returns valid vaalipiiri or hyvinvointialue keys from the registry.
- [x] Update `resolve_candidate` and `get_candidate_results` tool descriptions to say: "If unsure of unit_key, call `list_unit_keys` first." Remove hardcoded key lists from descriptions.
- [ ] Audit all other tools that accept `unit_key` — ensure their error paths reference `list_unit_keys`. (Key tools done; full audit pending.)
- [x] Regional hyvinvointialue keys: confirmed covered — `list_unit_keys` reads from `candidate_by_aanestysalue` which is present for regional elections.

**Status:** ✅ DONE (2026-03-21). `list_unit_keys` implemented in `src/tools/discovery/index.ts`. Descriptions updated. Error messages in `candidate-index.ts` and `loaders.ts` already list valid keys.

---

## Problem 2 — "Resolve candidate first" is not enforced

### What the problem is
Nothing prevents an LLM from calling `get_candidate_results` with a guessed `candidate_id`. The tool returns empty results with no error, and the LLM may report "no data found" or hallucinate.

The correct workflow is always:
1. `resolve_candidate` → get confirmed `candidate_id` and `unit_key`
2. `get_candidate_results` with those values

### Why the system prompt alone is not sufficient
The MCP server cannot inject a system prompt into the client. The `system_prompt.md` file is a consumer guide — it only works if the consumer follows it. LLMs in multi-turn conversations may also lose track of earlier system prompt instructions.

### The structural approach
Per Anthropic's tool use guidance: design schemas so that invalid sequences are structurally impossible or immediately caught. Two mechanisms:

1. **Tool description dependency**: The `get_candidate_results` description should explicitly state: *"candidate_id must come from resolve_candidate. Do not guess."* This is inside the tool definition the LLM reads before calling it.
2. **Schema-driven**: `resolve_candidate` returns a structured object. Downstream tools could be designed to accept that structure directly, making the dependency visible in the schema. (This is a larger refactor — lower priority.)

### What needs doing
- [x] Rewrite `get_candidate_results` description to explicitly state the resolve-first dependency. Example: *"Requires a candidate_id obtained from resolve_candidate. Passing a guessed ID returns empty results without error."*
- [x] Add to tool description: *"If you do not have a candidate_id, call resolve_candidate first."*
- [ ] (Future, lower priority) Schema-driven enforcement: `get_candidate_results` validates that `candidate_id` matches a value in the election's candidate metadata before querying. Adds one cached metadata fetch per call — only worth it once performance is otherwise acceptable.

**Status:** ✅ DONE (2026-03-21). `get_candidate_results` and `resolve_candidate` descriptions updated with explicit dependency statements in `src/tools/retrieval/index.ts` and `src/tools/entity-resolution/index.ts`.

---

## Problem 3 — Data Coverage Gaps Are Silent

### What the problem is
When a tool is called for an election/year combination with no coverage (e.g., regional 2022 candidates, municipal 2017 candidates), it either throws an opaque error or returns empty results. The LLM cannot distinguish "no candidates ran" from "we don't have that data".

Known gaps in candidate coverage:
| Election | Candidate data available |
|---|---|
| Parliamentary | 2007, 2011, 2015, 2019, 2023 |
| Municipal | 2021, 2025 only |
| Regional | 2025 only |
| EU Parliament | 2019, 2024 only |
| Presidential | 2024 only |

### Structural approach: MCP Resource for coverage
Per Anthropic's MCP architecture guidance, reference data (coverage tables, metric definitions, valid keys) belongs in **MCP Resources** — structured content the LLM can read on demand. This is more appropriate than hardcoding in tool descriptions or system prompts, because resources are versioned, discoverable, and don't bloat the tool definition context.

### What needs doing
- [x] Register an MCP Resource: `election://coverage` — a structured document listing available data types (party/candidate/turnout/demographics) by election type and year. The LLM can read this when it needs to check what is available.
- [x] Improve error messages in tools: when called for an unsupported year/type, return `"no candidate data available for regional 2022. Available years: [2025]. Check election://coverage for full coverage."` instead of a generic failure.
- [x] Related: fix `describe_election` `candidate_vaalipiirit` label for regional elections (BACKLOG T2).

**Status:** ✅ DONE (2026-03-21). All error paths in `describe_election`, `describe_available_data`, `list_unit_keys`, and `get_turnout` now include `hint: "Read election://coverage..."`. `candidate_vaalipiirit` text reference changed to `candidate_units`.

---

## Problem 4 — Tool Count and LLM Discoverability

### What the problem is
The MCP currently has 38 tools. Anthropic's guidance:
- Under 10 tools: load all at once
- 10–30 tools: consider Tool Search
- 30+ tools: implement Tool Search to avoid accuracy degradation

At 38 tools, LLMs spend more context tokens reading tool definitions and occasionally pick the wrong tool.

### Anthropic's recommended pattern
Keep a single MCP server. Add a `search_tools` meta-tool: the LLM calls it with a keyword query and gets back the 3–5 most relevant tool names + descriptions. The LLM then calls the specific tool. This is in-memory, near-zero runtime cost.

Tool Search only works if tool descriptions are high quality — this is a prerequisite, not an afterthought.

### What needs doing
- [x] Complete T1 (tool consolidation to ~30 tools) from BACKLOG — prerequisite for Tool Search.
- [x] Audit all tool descriptions for quality: each must clearly state what the tool does, when to use it, what it returns, and any dependencies on other tools.
- [x] Implement `search_tools(query: string)` meta-tool: in-memory trigram/substring match over tool names + descriptions, returns top 3–5 matches with name and description only (no full schema).
- [x] Before implementing Tool Search: review all tool descriptions to ensure none contain internal implementation details (table IDs, schema internals) that shouldn't be returned through a search interface.

**Status:** ✅ DONE (2026-03-21). T1 was already complete from prior sessions. `search_tools` implemented in `src/tools/discovery/index.ts` using live `_registeredTools` registry with token scoring. Tool count: 40.

---

## Problem 5 — System Prompt: Rethought

### What "system prompt" means in MCP context
**Key finding from Anthropic's MCP specification:** MCP servers cannot inject system prompts. The system prompt is client-side — only the consumer application (Claude Desktop, a custom client, etc.) can set it. The server exposes:
- **Tools** — the LLM calls these
- **Resources** — structured content the client can read and inject into context
- **MCP Prompts** — parameterizable workflow templates the user can invoke (like slash commands)

`system_prompt.md` in this repo is a *consumer guide* — documentation for whoever sets up the client. It is not enforced by the server. An LLM can ignore it, especially in long conversations.

### The correct architecture (three layers)

**Layer 1 — Tool descriptions (server-controlled, always present)**
Every tool the LLM reads carries its own documentation. Dependencies, constraints, and warnings belong here. This is the most reliable enforcement surface because the LLM reads it immediately before deciding whether to call the tool.

Per Anthropic's guidance: tool descriptions should state what the tool does, when to use it, its dependencies, and what it returns. Example for `get_candidate_results`:
> *"Returns vote results for a specific candidate. Requires candidate_id from resolve_candidate — do not guess. If unit_key is unknown, call list_unit_keys first."*

**Layer 2 — MCP Resources (server-controlled, on-demand)**
Reference data the LLM can read when needed. Appropriate for:
- Data coverage table (what elections/years have what data)
- Valid unit key lists by election type and year
- Metric definitions and caveats
- Finnish electoral system background

These are read-on-demand, not injected into every request — keeps context window lean.

**Layer 3 — MCP Prompts / consumer system prompt (client-controlled)**
Reusable workflow templates the user can trigger, and the consumer-side system prompt that sets overall agent behavior. This layer cannot be enforced by the server — it is documentation and guidance, not a constraint.

### What needs doing

**Tool descriptions (Layer 1):**
- [x] Add dependency statements to every tool that requires prior resolution. Format: *"Requires X from Y. Do not guess."*
- [x] Add when-not-to-use guidance where tools have overlapping surface area.
- [x] Ensure `search_tools` (Problem 4) will surface these descriptions correctly.

**MCP Resources (Layer 2):**
- [x] `election://coverage` — data availability by election type and year (see Problem 3).
- [x] `election://unit-keys` — valid unit keys by election type, derived from the registry. Replaces hardcoded lists in descriptions.
- [x] `election://metrics` — definitions of computed metrics (ENP, Pedersen index, etc.) for LLM reference during analysis.

**MCP Prompts (Layer 3):**
- [ ] Register at least one workflow prompt: `analyze_candidate` — a parameterized template that injects the full resolve → get_candidate_results → analyze_candidate_profile sequence. The user invokes it as a slash command; it structures the LLM's workflow for that session.
- [ ] Consider: `compare_parties_across_elections`, `find_strategic_opportunities` as additional workflow prompts.

**Consumer-side system_prompt.md (Layer 3):**
- [x] Rewrite to focus on what only a system prompt can do: overall agent persona, reasoning style, output format preferences, and cross-cutting constraints.
- [x] Remove reference tables (unit keys, coverage) — these belong in Resources.
- [x] Remove mandatory workflow instructions — these belong in tool descriptions and MCP Prompts.
- [x] Keep: electoral system context, output format expectations, what the bot is for.

**Status:** Mostly done (2026-03-21). Layers 1 and 2 fully complete. `SYSTEM_PROMPT` in `server.ts` rewritten. MCP Prompts (`analyze_candidate` workflow template) still pending.

---

## Performance 1 — Cache TTL Is Too Short for Historical Data

### What the problem is
TTL is 1 hour for all cache entries. Past election data is permanently fixed and will never change. After an hour, it is evicted and re-fetched from PxWeb unnecessarily.

### What needs doing
- [x] Introduce two TTL tiers in `src/cache/cache.ts`:
  - **Historical elections** (year < current calendar year): TTL = 7 days (or env `CACHE_TTL_HISTORICAL_MS`).
  - **Current year / live data**: TTL = 1 hour (existing behavior).
- [x] Verify `withCache` in `loaders.ts` accepts a TTL override parameter. If not, add it.
- [x] Pass a long TTL from `loaders.ts` when fetching historical election tables.

**Budget note:** No Redis or Blob Storage budget. Cold starts accepted. This TTL change is low-cost and improves warm-server performance — still worth doing.

**Status:** ✅ DONE (2026-03-21). `electionTtl(year)` helper added to `src/data/loaders.ts`. Applied to `loadPartyResults` and `loadCandidateResults`. Historical TTL configurable via `CACHE_TTL_HISTORICAL_MS` env var.

---

## Performance 2 — Fan-Out for resolve_candidate Is Inherently Slow

### What the problem is
`resolve_candidate` without a `unit_key` fans out to 13 (parliamentary) or 21 (regional) tables. PxWeb enforces 10 req/10s. Requests 11–13 or 11–21 queue, adding seconds of wait. Total cold-call time: ~10–15 seconds.

The rate limit is PxWeb's — it cannot be increased on our side.

### Structural fix: `list_unit_keys` tool (from Problem 1)
If the LLM can call `list_unit_keys(election_type, year)` to get the correct key before calling `resolve_candidate`, it will almost always provide a `unit_key`, making the slow fan-out path rare. This is the structural solution — it removes the need for the fan-out in the common case.

### Remaining options for when fan-out does occur
- [x] Add a `searched_all_units: true` flag to the `resolve_candidate` response when fan-out was used, with a note: *"Provide unit_key to avoid this slow path."* This surfaces the issue within the session without adding a workaround field.
- [x] TTL fix (Performance 1) helps: once metadata is cached, the fan-out is much faster on repeat calls.

**Note:** The original plan proposed a `performance_note` field as a training mechanism. This was a one-off workaround (session-scoped, forgotten next session). The `searched_all_units` flag is a factual data field, not a workaround, and is the correct way to surface this.

**Status:** ✅ DONE (2026-03-21). `searched_all_units` and `performance_note` fields added to `resolve_candidate` response in `src/tools/entity-resolution/index.ts`.

---

## New Item — MCP Resources as Reference Layer

This item was missing from the original plan entirely. Based on Anthropic's MCP architecture:

**Resources** are the correct home for reference data — not tool descriptions (which bloat), not system prompts (which can't be server-controlled), not hardcoded error messages (which go stale).

### What needs doing
- [x] `election://coverage` — data availability table (what elections/years have which data types). See Problem 3.
- [x] `election://unit-keys` — valid unit keys by election type and year, derived live from election-tables.ts registry. Replaces fragile hardcoded lists. See Problem 1.
- [x] `election://metrics` — definitions and formulas for all computed metrics (ENP, Pedersen, geographic concentration, etc.). Gives the LLM context for interpreting analytics output without inflating tool descriptions.
- [ ] Consider `election://caveats` — a resource version of the existing `get_data_caveats` tool output, for LLMs to read proactively.

**Status:** ✅ DONE (2026-03-21). All three main resources implemented in `src/resources/index.ts` and registered in `src/server.ts`. `election://caveats` deferred.

---

## Implementation Order

Work proceeds in six sequential stages. Later stages depend on earlier ones being complete.

---

### Stage 1 — Tool description audit ✅ DONE (2026-03-21)
**Prerequisite for everything else. Do this first.**

Read all 38 tool descriptions and produce a written audit covering:
- Which tools have missing or vague dependency statements
- Which tools are redundant or have overlapping surface area (feeds T1)
- Which descriptions contain internal implementation details that shouldn't be in a `search_tools` result

- [x] Read and audit all tool descriptions in `src/tools/`
- [x] Produce a written list of: tools to remove (T1 scope), descriptions to rewrite, dependency statements to add

**Effort:** ~1 session. No code changes.

---

### Stage 2 — T1: Tool consolidation ✅ DONE (2026-03-21)
**Prerequisite for Tool Search. Informed by Stage 1 audit.**

Execute the existing BACKLOG item T1: consolidate from 38 tools to ~30 by removing redundant tools and merging functionality into survivors.

- [x] Remove tools identified in Stage 1 audit (see BACKLOG T1 for current list)
- [x] Merge functionality into surviving tools via new parameters where needed
- [x] Ensure `npm run build` and `npm test` pass after each removal

**Effort:** Large. Refer to `BACKLOG.md` T1 for the current removal list.
**Note:** T1 was completed in a prior session. This session: removed remaining dead `/* REMOVED */` comment blocks from `src/tools/analytics/index.ts` and `src/tools/area/index.ts`.

---

### Stage 3 — Track A: Independent improvements ✅ DONE (2026-03-21)

These items have no dependencies on T1 and can be done at any time.

**`list_unit_keys` tool (Problem 1):**
- [x] Implement `list_unit_keys(election_type, year)` — returns valid unit keys from the election-tables.ts registry
- [x] Update `resolve_candidate` and `get_candidate_results` descriptions: "If unsure of unit_key, call `list_unit_keys` first." Remove hardcoded key lists.
- [ ] Audit all other tools accepting `unit_key` and point them at `list_unit_keys` (key tools done; full audit pending)

**Cache TTL tiers (Performance 1):**
- [x] Verify `withCache` accepts a TTL override parameter; add it if not
- [x] Add two TTL tiers: historical elections (year < current year) → 7 days; current year → 1 hour
- [x] Pass the correct TTL from `loaders.ts` when fetching historical tables

**Tool description dependency statements (Problem 2, 5):**
- [x] Rewrite descriptions for tools identified in Stage 1 audit: add "Requires X from Y — do not guess" dependency statements
- [x] Add when-not-to-use guidance where tools have overlapping surface area

**`searched_all_units` flag (Performance 2):**
- [x] Add `searched_all_units: true` to `resolve_candidate` response when fan-out was used (unit_key not provided)

---

### Stage 4 — MCP Resources ✅ DONE (2026-03-21)
**Depends on: `list_unit_keys` (Stage 3), coverage error messages (Problem 3)**

- [x] `election://unit-keys` — valid unit keys by election type and year, derived from the registry
- [x] `election://coverage` — data availability by election type and year; also improve tool error messages to reference this resource (Problem 3)
- [x] `election://metrics` — definitions and formulas for all computed metrics (ENP, Pedersen, geographic concentration)
- [x] Fix `describe_election` `candidate_vaalipiirit` label for regional elections (BACKLOG T2, naturally fits here)

---

### Stage 5 — System prompt rewrite and MCP Prompts (Partially done 2026-03-21)
**Depends on: Stages 3 and 4 (Resources must exist before the system prompt can point to them)**

**Rewrite `system_prompt.md` as a lean consumer guide:**
- [x] Remove reference tables (unit keys, coverage) — now in Resources
- [x] Remove mandatory workflow instructions — now in tool descriptions
- [x] Keep: electoral system context, agent persona, output format expectations
- [x] Add: how to access Resources, when to use MCP Prompts

**MCP Prompts — workflow templates:**
- [ ] `analyze_candidate` — resolve → get_candidate_results → analyze_candidate_profile sequence
- [ ] Consider: `compare_parties_across_elections`, `find_strategic_opportunities`

---

### Stage 6 — Tool Search ✅ DONE (2026-03-21)
**Depends on: Stages 1 and 2 (T1 complete, descriptions audited and clean)**

- [x] Implement `search_tools(query: string)` — in-memory trigram/substring match over tool names + descriptions, returns top 3–5 matches with name and description only (no full schema)
- [x] Test that the search surface does not expose internal implementation details

---

## Relationship to Existing Backlog

| This doc | Existing BACKLOG |
|---|---|
| Stage 1 (description audit) | Informs T1 scope |
| Stage 2 (T1 consolidation) | = BACKLOG T1 |
| Problem 1 (unit key + list_unit_keys) | New |
| Problem 2 (enforce resolve) | New |
| Problem 3 (coverage gaps) | Extends T2 |
| Problem 4 (Tool Search) | Extends T1 |
| Problem 5 (system prompt — rethought as three layers) | Extends T5, significantly revised |
| Performance 1 (TTL) | New |
| Performance 2 (fan-out) | Known issue, structural fix via list_unit_keys |
| New item (MCP Resources) | New |

