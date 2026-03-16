# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**FI Election Data MCP** — A Model Context Protocol (MCP) service providing structured election data and deterministic analytics for Finnish elections. Primary data source: **Tilastokeskus (Statistics Finland) PxWeb API**.

The service is designed to be consumed by LLM-based analyst systems, research tools, and campaign analysis workflows.

## Required Project Files

Per project good practices (`CLAUDE CODE_GOOD PRACTICES.md`), always maintain:

- **Implementation_plan.md** — Step-by-step plan split into phases, each with goals and tests (create before coding)
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

> No build/test infrastructure exists yet. This section will be updated as the project is implemented.

## Development Notes

- Full tool specifications and output schemas are defined in [PRD.md](PRD.md)
- Each tool should support two output modes: **data mode** (normalized rows) and **analysis mode** (deterministic summary with tables and methodology)
