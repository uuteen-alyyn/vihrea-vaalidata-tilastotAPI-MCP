/**
 * Resolution layer between this codebase's stable, human-readable names for
 * PxWeb variables and the concrete codes a given table actually uses.
 *
 * WHY THIS EXISTS
 * ---------------
 * Until July 2026 Statistics Finland used the display name as the variable code:
 * a table's party dimension was literally coded `Puolue`. Table filenames were
 * equally readable (`statfin_evaa_pxt_13sw.px`). Both assumptions were baked into
 * this repo as string literals, and both stopped being true on 2026-07-01, when
 * every table moved to versioned machine codes (`puolue_19_20230101`) and short
 * filenames (`13sw.px`). Every request the server sent became a 400, for eight
 * weeks, undetected.
 *
 * The lesson is not "update the codes". The new codes embed classification
 * version dates and are *designed* to be replaced — hardcoding them rebuilds the
 * same trap. What proved stable is the `text` field: measured across all 91 active
 * tables on 27.08.2026, every declared name in this repo still matched a live
 * variable `text` exactly, and no table had two variables sharing a text.
 *
 * So callers declare a ROLE ('area', 'party', …) plus hints, and this module
 * resolves it against the metadata of the specific table being queried. The same
 * mechanism handles both conventions, which matters because the migration was not
 * uniform: `Alue/Äänestysalue` kept its old-style code, and the whole
 * `StatFin_Passiivi` archive was never renamed at all.
 *
 * MEASURED FACTS behind the ordering below (all 91 active tables, 27.08.2026):
 *   - `timeperiod_y` is the time variable in 91/91
 *   - `contentscode` is the content variable in 91/91
 *   - variable `text` is unique within a table in 91/91
 *   - variable `text` is NOT unique across tables — 'Puolue' maps to five
 *     different codes — so resolution must be per-table and at request time
 */

import type { PxWebTableMetadata, PxWebVariable, PxWebColumn } from './types.js';
import type { PartyTableSchema } from '../data/election-tables.js';

/** A semantic role a query builder or normalizer needs from a table. */
export type VariableRole =
  | 'year' | 'measure' | 'area' | 'party' | 'gender' | 'candidate'
  | 'outcome' | 'round' | 'background_group' | 'background_dimension';

/**
 * Thrown when a declared role cannot be resolved. The message names the table,
 * the role, what was tried and what the table actually offers — deliberately
 * verbose, because the opaque `Upstream data source returned 400` is precisely
 * why the July 2026 breakage went unnoticed for eight weeks.
 */
export class VariableResolutionError extends Error {
  constructor(tableId: string, role: string, hints: string[], metadata: PxWebTableMetadata) {
    const available = metadata.variables
      .map((v) => `${v.code} [${v.text}]`)
      .join(', ');
    super(
      `PxWeb table ${tableId}: could not resolve the '${role}' variable. ` +
      `Tried (as code, then as text): ${hints.join(', ')}. ` +
      `Table offers: ${available}. ` +
      `This usually means Statistics Finland renamed a variable — check the live ` +
      `metadata and update the hints for this role.`
    );
    this.name = 'VariableResolutionError';
  }
}

/** Thrown when a content-value code matches more than one candidate. */
export class ContentCodeAmbiguityError extends Error {
  constructor(tableId: string, logical: string, matches: string[]) {
    super(
      `PxWeb table ${tableId}: content code '${logical}' matches ${matches.length} ` +
      `values (${matches.join(', ')}). Suffix matching requires exactly one match — ` +
      `declare the full code explicitly instead.`
    );
    this.name = 'ContentCodeAmbiguityError';
  }
}

/**
 * Find a variable by trying every hint as a `code`, then every hint as a `text`.
 *
 * Code before text across the whole hint list, not per hint: `code` is the
 * authoritative identifier, so an exact code match on a later hint should still
 * beat a text match on an earlier one.
 */
export function findVariable(
  metadata: PxWebTableMetadata,
  hints: readonly string[]
): PxWebVariable | undefined {
  for (const hint of hints) {
    const byCode = metadata.variables.find((v) => v.code === hint);
    if (byCode) return byCode;
  }
  for (const hint of hints) {
    const byText = metadata.variables.find((v) => v.text === hint);
    if (byText) return byText;
  }
  return undefined;
}

/** As findVariable, but throws a diagnostic error when nothing matches. */
export function requireVariable(
  metadata: PxWebTableMetadata,
  hints: readonly string[],
  role: string,
  tableId: string
): PxWebVariable {
  const found = findVariable(metadata, hints);
  if (!found) throw new VariableResolutionError(tableId, role, [...hints], metadata);
  return found;
}

/** Convenience: resolved code, or undefined when the variable is absent. */
export function findVariableCode(
  metadata: PxWebTableMetadata,
  hints: readonly string[]
): string | undefined {
  return findVariable(metadata, hints)?.code;
}

// ─── Role-specific resolvers ──────────────────────────────────────────────────

/**
 * The time variable.
 *
 * `timeperiod_y` covers 91/91 active tables; the `time: true` flag is a
 * structural backstop that survives a further rename; the text hints cover the
 * un-migrated archive.
 */
export function findYearVariable(metadata: PxWebTableMetadata): PxWebVariable | undefined {
  return metadata.variables.find((v) => v.code === 'timeperiod_y')
    ?? metadata.variables.find((v) => v.time === true)
    ?? findVariable(metadata, ['Vuosi']);
}

/**
 * The content/measure variable.
 *
 * `contentscode` covers 91/91 active tables. The extra hints cover archive
 * tables, where the measure is a *dimension* whose values are Sar1/Sar2 rather
 * than a content column — same lookup, different downstream handling.
 */
export const MEASURE_HINTS = ['Tiedot', 'Äänestystiedot', 'Puolueiden kannatus'] as const;

export function findMeasureVariable(
  metadata: PxWebTableMetadata,
  extraHints: readonly string[] = []
): PxWebVariable | undefined {
  return metadata.variables.find((v) => v.code === 'contentscode')
    ?? findVariable(metadata, [...MEASURE_HINTS, ...extraHints]);
}

/** Area dimension, most specific name first. Absent in national-only tables. */
export const AREA_HINTS = [
  'Alue/Äänestysalue', 'Äänestysalue', 'Vaalipiiri ja kunta vaalivuonna', 'Alue', 'Vaalipiiri',
] as const;

/** Candidate dimension. EU 14gx mixes party aggregates into 'Puolue ja ehdokas'. */
export const CANDIDATE_HINTS = ['Ehdokas', 'Puolue ja ehdokas'] as const;

/** Gender dimension. The label varies by what the table counts. */
export const GENDER_HINTS = [
  'Sukupuoli', 'Ehdokkaan sukupuoli', 'Äänioikeutetun sukupuoli',
] as const;

/** Election-outcome dimension (elected / reserve / not elected). */
export const OUTCOME_HINTS = ['Valintatieto'] as const;

/** Presidential round dimension. */
export const ROUND_HINTS = ['Kierros'] as const;

/** Voter-background table dimensions. */
export const BACKGROUND_GROUP_HINTS = ['Äänioikeutetut, ehdokkaat ja valitut'] as const;
export const BACKGROUND_DIMENSION_HINTS = ['Taustamuuttujat'] as const;

// ─── Content-value codes ──────────────────────────────────────────────────────

/**
 * Resolve a logical content code (`aanet_yht`) to the code this table uses
 * (`kvaa-aanet_yht`).
 *
 * The July 2026 change prefixed content codes with the subject — but only for
 * some election types, and with an inconsistent separator: parliamentary kept
 * `evaa_aanet` while municipal became `kvaa-aanet_yht` and voter-background
 * became `evaa-lkm1`. Constructing the prefix would therefore need a per-subject
 * separator table that is itself a guess, so match on the suffix instead and
 * insist the match is unique.
 */
export function resolveContentCode(
  variable: PxWebVariable | undefined,
  logical: string,
  tableId = '(unknown)'
): string | undefined {
  if (!variable) return undefined;
  if (variable.values.includes(logical)) return logical;

  const matches = variable.values.filter(
    (v) => v.endsWith(`-${logical}`) || v.endsWith(`_${logical}`)
  );
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new ContentCodeAmbiguityError(tableId, logical, matches);
  return undefined;
}

/** As resolveContentCode, but throws when the value cannot be found at all. */
export function requireContentCode(
  variable: PxWebVariable | undefined,
  logical: string,
  tableId: string
): string {
  const resolved = resolveContentCode(variable, logical, tableId);
  if (!resolved) {
    throw new Error(
      `PxWeb table ${tableId}: content code '${logical}' not found in ` +
      `'${variable?.code ?? '(no measure variable)'}'. ` +
      `Available: ${(variable?.values ?? []).join(', ')}.`
    );
  }
  return resolved;
}

/**
 * Find the votes and share content codes by their Finnish value texts.
 *
 * Used by the candidate tables, which have no schema declaring measure codes.
 * This predates the migration and still works, because value *texts* were not
 * touched — kept as a helper so the behaviour lives in one place.
 */
export function findMeasureCodesByText(
  variable: PxWebVariable | undefined
): { votes?: string; share?: string } {
  if (!variable) return {};
  const at = (i: number) => (variable.valueTexts[i] ?? '').toLowerCase();
  const votes = variable.values.find(
    (_, i) => at(i).includes('äänimäärä') || at(i).includes('äänet')
  );
  const share = variable.values.find((_, i) => at(i).includes('osuus'));
  return { votes, share };
}

// ─── Party-table schema resolution ────────────────────────────────────────────

/**
 * Return a copy of a PartyTableSchema with every variable and content code
 * replaced by the code this table actually uses.
 *
 * Downstream query builders and normalizers then work unchanged: they still read
 * `schema.area_var`, it simply now holds `kunta_109_20230101` instead of
 * `Vaalipiiri ja kunta vaalivuonna`.
 *
 * A declared-but-unresolvable `gender_var` is a hard error rather than a dropped
 * filter. Omitting it would let PxWeb return every gender, and the normalizer
 * would emit male, female and total as separate rows — silently tripling the
 * national vote count instead of failing.
 */
export function resolvePartySchema(
  metadata: PxWebTableMetadata,
  schema: PartyTableSchema,
  tableId: string
): PartyTableSchema {
  const areaVar = requireVariable(metadata, [schema.area_var, ...AREA_HINTS], 'area', tableId);
  const partyVar = requireVariable(metadata, [schema.party_var, 'Puolue'], 'party', tableId);

  const measureVar = findMeasureVariable(metadata, [schema.measure_var]);
  if (!measureVar) {
    throw new VariableResolutionError(
      tableId, 'measure', [schema.measure_var, ...MEASURE_HINTS], metadata
    );
  }

  const resolved: PartyTableSchema = {
    ...schema,
    area_var:    areaVar.code,
    party_var:   partyVar.code,
    measure_var: measureVar.code,
    votes_code:  requireContentCode(measureVar, schema.votes_code, tableId),
    share_code:  requireContentCode(measureVar, schema.share_code, tableId),
  };

  if (schema.gender_var) {
    resolved.gender_var = requireVariable(
      metadata, [schema.gender_var, ...GENDER_HINTS], 'gender', tableId
    ).code;
  }

  return resolved;
}

// ─── Response-column helpers ──────────────────────────────────────────────────

/**
 * The time column of a data response.
 *
 * Uses the structural `type: 't'` marker in preference to any name, since that
 * is the one part of the contract PxWeb defines rather than Statistics Finland.
 */
export function findYearColumn(columns: readonly PxWebColumn[]): PxWebColumn | undefined {
  return columns.find((c) => c.type === 't')
    ?? columns.find((c) => c.code === 'timeperiod_y' || c.code === 'Vuosi' || c.text === 'Vuosi');
}
