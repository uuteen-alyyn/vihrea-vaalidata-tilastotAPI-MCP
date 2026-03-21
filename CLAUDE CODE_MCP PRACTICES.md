# Good Practices — MCP Projects

MCP-specific practices for building Model Context Protocol services consumed by LLMs. Apply these in addition to the general practices in `CLAUDE CODE_GOOD PRACTICES.md`.

---

## Architecture

### Strict layer separation

- **MCP layer**: data retrieval, normalization, entity resolution, deterministic computations, metric definitions
- **LLM layer**: query interpretation, tool orchestration, pattern interpretation, hypothesis generation, strategic reasoning

Push all reusable, deterministic, math-based logic into the MCP. Keep LLMs focused on orchestration. If you find yourself writing a complex computation in a system prompt, move it into a tool.

### Orphaned loaders are bugs

If a data loader or utility function exists but is not reachable via any registered tool, it is dead code and a maintenance liability. Every loader must have a clear tool that calls it. Audit for orphaned loaders before shipping.

---

## Designing Tools for LLM Consumption

### Parameter types

- **Always use `z.coerce.number()`** (not `z.number()`) for numeric parameters. LLMs frequently pass numbers as strings (e.g. `"2023"` instead of `2023`). Coercion silently handles this.
- Use descriptive, unambiguous parameter names. Avoid generic names like `year1`/`year2` — use `baseline_year`/`comparison_year` to remove ordering ambiguity.
- Make parameters optional with sensible defaults wherever possible. Fewer required parameters = fewer validation failures from the LLM.

### Error responses

Every error response should include two things:
1. What went wrong (specific, not generic)
2. How to recover — a concrete next step or a resource to read

```typescript
// Good
return errResult(
  `No candidate data for parliamentary 2018.`,
  'Read election://coverage for available candidate years.'
);

// Too generic
return errResult('Invalid year.');
```

### Output field stability

- Output keys must be predictable from the schema. **Never construct output keys at runtime** (e.g. `` `n_${areaLvl}s_scored` `` is bad — the LLM cannot know the key without running the tool).
- For binary-direction outputs (e.g. `direction='strongholds'` vs `direction='weak_zones'`), **always return both keys** and populate only the relevant one. Dynamic keys make output unparseable without knowing what you passed.

### Tool descriptions

- **Disambiguate similar tools**: if two tools overlap, say explicitly in each description when to use that one vs the other.
- **Document constraints in the parameter description, not just docs**: if omitting a parameter triggers an expensive fan-out, say so with a WARNING label in the parameter's `describe()` string.
- Clarify what a tool does NOT do: if a tool ranks by vote-share pattern and not by demographics, say so explicitly.

### Discoverability resources

Provide machine-readable MCP Resources that let the LLM check data availability before making tool calls. Examples:
- `election://coverage` — what data exists
- `election://unit-keys` — valid geographic keys by election type
- `election://metrics` — metric definitions

Reference these in error paths: `hint: 'Read election://coverage for available years.'`

---

## System Prompt

The system prompt (both embedded in `server.ts` and exported to `system_prompt.md`) should document:
- Domain context the LLM needs to reason correctly
- Standard workflow (numbered steps, in order)
- Data coverage table
- Key conventions and gotchas
- Election/domain-specific constraints that affect tool behavior

**Keep both files in sync** — don't let them diverge from each other.

---

## MCP Prompts

Register complex multi-step workflows as MCP Prompts. This lets users invoke standard workflows by name instead of orchestrating 4–5 tool calls manually. Prompts should:
- List the steps in order with exact tool calls and parameter values
- Use `argsSchema` (Zod shape), not an `arguments` array
- Cover the common failure case (e.g. unknown unit_key → call list_unit_keys first)

---

## Live Testing

**Never declare an MCP done without a live test session using a real LLM.** Schedule this as an explicit phase in the implementation plan.

Expect to find:
- Year-as-string validation errors → fix with `z.coerce.number()`
- Wrong parameter names passed → fix with clearer naming and descriptions
- LLM picking the wrong tool → fix with disambiguation in descriptions
- LLM not checking coverage before querying → fix with workflow steps in system prompt
- Orphaned loaders that no tool calls → fix by wiring them up or removing them

Document all bugs found and their fixes in the logbook.
