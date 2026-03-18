# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**FI Election Data MCP** — A Model Context Protocol (MCP) service providing structured election data and deterministic analytics for Finnish elections. Primary data source: **Tilastokeskus (Statistics Finland) PxWeb API**.

The service is designed to be consumed by LLM-based analyst systems, research tools, and campaign analysis workflows.

## Required Project Files

Per project good practices (`CLAUDE CODE_GOOD PRACTICES.md`), always maintain:

- **Implementation_plan.md** — Step-by-step plan split into phases, each with goals and tests (create before coding)
- **BACKLOG.md** — Persistent work queue. Check at the start of every session and surface any outstanding items. Add items whenever the user requests work. Remove items only when the user explicitly says the task is done or dropped.
- **Logbook.md** — Logbook is always priority 1. Write the logbook entry before anything else when completing a phase or significant work unit.
- **Logbook.md** — Append-only activity log. New entries go at the **bottom only**. Never remove existing entries. Each entry format:
  ```
  ## ENTRY DESCRIPTIVE TITLE YYYY-MM-DD HH:MM:SS
  [what was done]
  [decisions made]
  [test results]
  [notes]
  ```

## Architecture

### Core Design Principle

Strict separation of responsibilities:

- **MCP layer** (this service): data retrieval, normalization, entity resolution, deterministic computations, reusable election metrics, comparability checks
- **LLM layer** (consumers): query interpretation, tool orchestration, pattern interpretation, hypothesis generation, strategic reasoning

> Push all reusable, deterministic math-based election logic into the MCP. Keep LLMs focused on orchestration and reasoning.

### Three Abstraction Layers

1. **Discovery Layer** — List elections, describe datasets, area hierarchies
2. **Canonical Data Retrieval Layer** — Normalized access to candidates, parties, areas, elections
3. **Deterministic Election Analytics Layer** — Reusable political science metrics

### Tool Categories (40+ tools)

| Category | Examples |
|---|---|
| Discovery (4) | `list_elections`, `describe_election`, `list_area_levels`, `get_area_hierarchy` |
| Entity Resolution (4) | `resolve_candidate`, `resolve_party`, `resolve_area`, `resolve_entities` |
| Canonical Retrieval (7) | `get_candidate_results`, `get_party_results`, `get_area_results`, `get_turnout` |
| Deterministic Analytics (11) | `analyze_candidate_profile`, `compare_candidates`, `find_area_overperformance` |
| Strategic Opportunity (4) | `detect_inactive_high_vote_candidates`, `find_exposed_vote_pools`, `rank_target_areas` |
| Area-Centric (4) | `get_area_profile`, `compare_areas`, `analyze_area_volatility`, `find_strongholds` |
| Audit & Transparency (4) | `explain_metric`, `trace_result_lineage`, `validate_comparison`, `get_data_caveats` |

### Canonical Data Schema

All election data is normalized to:
```
election_type, year, area_level, area_id, area_name,
candidate_id, candidate_name, party_id, party_name,
votes, vote_share, rank_within_party, rank_overall
```

### Geographic Hierarchy

From finest to coarsest:
1. Äänestysalue (voting district/polling area)
2. Kunta (municipality)
3. Vaalipiiri (electoral district)
4. Koko Suomi (national)

### Finnish Electoral System Context

Finnish elections use multi-party proportional representation with open candidate lists. Voters vote for individual candidates whose votes also contribute to party totals. This means analytics must handle:
- Candidate performance
- Party performance
- Geographic variation
- Rank within party
- Vote distribution
- Cross-election change

## Commands

```bash
npm run build   # TypeScript compile — must pass before any commit
npm test        # Vitest test suite (src/**/*.test.ts)
```

## Git & GitHub Workflow

**Commit after every completed phase or significant self-contained change.** Do not accumulate multiple phases in one commit.

### When to commit
- After each phase is complete and tests pass
- After any standalone bug fix with a passing test
- After documentation-only changes (logbook, implementation plan, CLAUDE.md)
- Before switching to a different task area

### Commit checklist (always run before committing)
1. `npm run build` — must exit 0
2. `npm test` — all tests must pass; include count in logbook
3. Stage specific files (never `git add .` blindly — avoid committing `.env`, `cache-store.json`, secrets)
4. Write a concise commit message: `Phase N: <what changed>` or `fix: <what and why>`

### Push cadence
- Push to GitHub (`git push`) after every commit, or at minimum at the end of every working session.
- The remote is the source of truth. Never let local diverge from remote by more than one session.
- GitHub token is documented in the memory file `reference_github.md`.

### Never commit
- `cache-store.json` (runtime cache — already in `.gitignore`)
- `.env` files or any file containing tokens/credentials
- `node_modules/`

## Deployment Notes

- **Target platform: Azure App Service (NGO free plan).** Azure terminates TLS at the infrastructure level — the Node.js process serves plain HTTP on its internal port; Azure provides the public HTTPS endpoint. No application-level TLS code is needed or appropriate.

- **Rate limiter is per-process.** The in-process sliding-window rate limiter in `server-http.ts` counts requests per IP within each Node.js instance. In a multi-instance deployment (e.g. Azure App Service with multiple workers), the effective limit is `RATE_LIMIT_REQUESTS × instance-count`. For global enforcement across instances, swap in a Redis-backed counter (see NEW-SEC-8 comment in `server-http.ts`). Until then, keep instance count = 1.

## Development Notes

- Full tool specifications and output schemas are defined in [PRD.md](PRD.md)
- Each tool should support two output modes: **data mode** (normalized rows) and **analysis mode** (deterministic summary with tables and methodology)
- Strategic tool name: `rank_areas_by_party_presence` (renamed from `rank_target_areas` in Phase 19)
- Breaking output field renames since Phase 19: `share_of_party_vote` → `share_of_party_vote_pct`, `top1_share` → `top1_share_pct` (etc.), `total_orphaned_votes` → `total_votes_from_inactive_candidates`
