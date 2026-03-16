# PRD.md

**FI Election Data MCP (Finnish Elections Analytics Platform)**

## 1. Overview

This document defines the Product Requirements for the **FI Election Data MCP (Model Context Protocol service)** designed to provide structured election data and deterministic analytics for **Finnish elections**.

The MCP will serve **LLM-based analyst systems**, research tools, and campaign analysis workflows.

The system must provide:

1. **Reliable retrieval of official election results**
2. **Normalized election data structures**
3. **Deterministic reusable election analytics**
4. **Flexible outputs usable by different analyst LLM agents**

The system will support queries about:

* Candidates
* Parties
* Geographic areas
* Elections across years
* Voting districts (äänestysalue)
* Municipalities (kunta)
* Electoral districts (vaalipiiri)

Primary data sources include:

* **Tilastokeskus (Statistics Finland) PxWeb API**
* Official election datasets
* Additional election studies MCPs (for voter transfer polling studies)

---

# 2. Core Design Principle

### Separation of Responsibilities

The system is designed around a strict separation between:

### MCP Responsibilities

The MCP must handle:

* Data retrieval
* Data normalization
* Entity resolution
* Deterministic computations
* Reusable election metrics
* Data comparability checks

The MCP is the **authoritative computational layer**.

### LLM Responsibilities

LLMs must handle:

* Query interpretation
* Tool orchestration
* Pattern interpretation
* Hypothesis generation
* Strategic reasoning
* Narrative explanation

### Guiding Principle

> Push all reusable, deterministic math based election logic downward into the MCP.
> Keep the LLM focused on orchestration, explanation, hypothesis generation, and strategic judgment.

---

# 3. Election System Context

Finnish elections primarily use **multi-party proportional representation with open candidate lists**.

Key properties:

* Voters vote for **individual candidates**
* Candidate votes contribute to **party totals**
* Multiple candidates represent the same party
* Candidates compete both:

  * **Between parties**
  * **Within their party**

This system structure makes several analytical dimensions important:

* Candidate performance
* Party performance
* Geography
* Rank within party
* Vote distribution
* Cross-election change

The MCP must provide tools that support these analytical perspectives.

---

# 4. Geographic Hierarchy

The MCP must support the hierarchy of Finnish election geography.

Primary levels:

| Level        | Description                    |
| ------------ | ------------------------------ |
| Äänestysalue | Voting district / polling area |
| Kunta        | Municipality                   |
| Vaalipiiri   | Electoral district             |
| Koko Suomi   | National totals                |

Tools must allow navigation between these levels.

---

# 5. System Architecture

The MCP should support **three abstraction layers**.

## Layer 1: Discovery

Allows LLMs to understand what data exists.

Examples:

* list elections
* describe datasets
* area hierarchies

---

## Layer 2: Canonical Data Retrieval

Normalized election data access.

Examples:

* candidate results
* party results
* area results
* election summaries

---

## Layer 3: Deterministic Election Analytics

Reusable political science metrics.

Examples:

* candidate rank within party
* vote share
* geographic concentration
* overperformance
* cross-election change
* vote pool exposure

---

# 6. Canonical Data Schema

All election data returned by the MCP should follow a normalized schema where possible.

Example row structure:

```
election_type
year
area_level
area_id
area_name
candidate_id
candidate_name
party_id
party_name
votes
vote_share
rank_within_party
rank_overall
```

Not all fields will exist for all queries.

---

# 7. MCP Tool Catalog

## 7.1 Discovery Tools

### list_elections

Returns all available elections.

Fields:

* election_type
* year
* available_area_levels
* candidate_data_available

---

### describe_election

Returns detailed metadata for a specific election.

Includes:

* election type
* year
* geography coverage
* candidate coverage
* data caveats

---

### list_area_levels

Returns supported geographic levels.

---

### get_area_hierarchy

Returns parent-child relationships.

Example:

```
äänestysalue -> kunta -> vaalipiiri
```

---

# 7.2 Entity Resolution Tools

### resolve_candidate

Resolves candidate names.

Returns:

* candidate_id
* canonical_name
* match_confidence
* possible alternatives

---

### resolve_party

Resolves party names and abbreviations.

---

### resolve_area

Resolves area names.

Handles:

* municipality names
* district names
* spelling variations
* Finnish / Swedish forms

---

### resolve_entities

Batch resolver for mixed inputs.

---

# 7.3 Canonical Retrieval Tools

### get_candidate_results

Returns results for one or more candidates.

Parameters:

* candidate
* election
* area scope
* area level

---

### get_party_results

Returns party-level results.

---

### get_area_results

Returns results for a geographic area.

Examples:

* all parties in municipality
* all candidates in area

---

### get_election_results

General retrieval tool for election datasets.

---

### get_rankings

Returns rankings of candidates or parties within a defined scope.

Examples:

* top candidates in municipality
* candidate rank within party

---

### get_top_n

Convenience tool for common ranking queries.

---

### get_turnout

Returns turnout statistics.

---

# 7.4 Deterministic Analytical Tools

These tools implement reusable election analytics.

---

### analyze_candidate_profile

Returns a structured candidate analysis.

Includes:

* total votes
* vote share
* rank overall
* rank within party
* share of party vote
* strongest areas
* weakest areas
* geographic concentration

---

### analyze_party_profile

Returns party footprint analysis.

Includes:

* vote totals
* vote share
* strongest areas
* geographic spread

---

### compare_candidates

Compares candidates across geography.

Includes:

* side-by-side vote results
* area comparisons
* leadership areas

Note: This tool **does not find similar candidates**.
Candidate lists must be supplied externally.

---

### compare_parties

Side-by-side party comparison.

---

### compare_elections

Compares the same subject across elections.

Returns:

* vote change
* share change
* rank change
* geographic movement

---

### find_area_overperformance

Identifies areas where a candidate or party performs above baseline.

Possible definitions:

* candidate share vs party share
* party share vs broader geography

---

### find_area_underperformance

Opposite of overperformance.

---

### analyze_geographic_concentration

Measures concentration of support.

Possible metrics:

* top area dependence
* concentration index

---

### analyze_within_party_position

Measures candidate position within party.

Includes:

* rank within party
* share of party vote
* distance to next candidate

---

### analyze_vote_distribution

Analyzes vote distribution across geography.

---

# 7.5 Strategic Opportunity Tools

### detect_inactive_high_vote_candidates

Identifies previously strong candidates who are not running in the next election.

Returns:

* candidate
* prior vote totals
* strongest areas
* party

---

### find_exposed_vote_pools

Identifies geographic areas where votes may be politically available.

Signals may include:

* inactive candidates
* weak party retention
* stable electorate size

---

### estimate_vote_transfer_proxy

Estimates possible voter transfer patterns based on vote changes.

Important:

These are **proxy estimates**, not direct measurements.

Metadata must include:

```
proxy_method: election result inference
confidence: structural indicator
```

Additional note:

Official parliamentary election studies exist that estimate voter transfers using **polling data**.

Those studies are available through **other MCP services**.

Proxy estimates should therefore be interpreted alongside polling-based transfer estimates.

---

### rank_target_areas

Ranks areas by strategic opportunity.

Score components may include:

* prior support
* overperformance
* inactive candidate vote pools
* electorate size
* turnout trends

Scores must be transparent.

---

# 7.6 Area-Centric Tools

### get_area_profile

Returns structured area profile.

Includes:

* turnout
* top parties
* top candidates
* historical trend
* volatility

---

### compare_areas

Compares municipalities or districts.

---

### analyze_area_volatility

Measures change across elections.

---

### find_strongholds

Returns strongest areas for candidate or party.

---

### find_weak_zones

Returns weakest areas.

---

# 7.7 Audit and Transparency Tools

### explain_metric

Returns the definition of a metric.

---

### trace_result_lineage

Returns data provenance.

Includes:

* source tables
* transformations
* filters

---

### validate_comparison

Checks whether a comparison is methodologically valid.

---

### get_data_caveats

Returns limitations for a dataset.

---

# 8. Output Modes

Many tools should support two output modes.

## Mode: data

Returns normalized rows.

Example:

```
{
 "mode": "data",
 "rows": [...]
}
```

---

## Mode: analysis

Returns deterministic summary.

Example:

```
{
 "mode": "analysis",
 "summary": {...},
 "tables": {...},
 "method": {...}
}
```

---

# 9. System Prompt for the MCP

The MCP must provide the following system prompt to LLMs.

---

## Compact MCP System Prompt

You have access to an **Election Data MCP** that provides structured data and deterministic analytics for **Finnish elections** using official datasets (e.g., Statistics Finland / Tilastokeskus).

The MCP exposes normalized results and analytical tools for:

* candidates
* parties
* geographic areas (äänestysalue, municipality, electoral district)
* elections across multiple years

Finnish elections use **multi-party proportional representation with candidate votes**, meaning:

* voters vote for candidates
* votes also contribute to party totals
* candidates compete both **between parties** and **within their party**

The MCP performs **deterministic data retrieval and election analytics**.
You should use MCP tools whenever possible to obtain:

* official vote counts
* rankings
* vote shares
* geographic breakdowns
* cross-election comparisons
* derived metrics such as overperformance or concentration

Treat MCP outputs as the **authoritative computational layer**.

Your role is to:

* select appropriate tools
* combine results from multiple tools if necessary
* interpret patterns
* generate hypotheses and explanations

Do **not reconstruct metrics manually** if MCP tools provide them.

Some tools estimate **voter transfer proxies** using election results.
These are **inferred structural indicators**, not direct measurements of voter behavior.

Other MCP services include **official parliamentary election studies based on polling data**, which provide survey-based estimates of voter transfers.
When analyzing voter transfers, compare proxy results with those polling-based studies when available.

Use MCP results as evidence and apply reasoning to explain patterns, identify uncertainties, and suggest further analysis.

---

# 10. Future Extensions

The MCP architecture should allow integration of additional data sources.

Possible extensions:

* demographic datasets
* socioeconomic indicators
* candidate biography data
* campaign spending data
* voter turnout models
* historical electoral boundary changes

---

# 11. Key Implementation Principle

The MCP must expose **stable political-science analytical primitives** rather than only raw data.

Examples of primitives:

* rank
* vote share
* overperformance
* concentration
* volatility
* exposed vote pool
* geographic stronghold

These primitives allow many different LLM analyst agents to build flexible analytical workflows.

---

**End of PRD**
