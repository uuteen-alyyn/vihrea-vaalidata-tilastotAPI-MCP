/**
 * LIVE contract tests against Statistics Finland's PxWeb API.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * On 2026-07-01 Statistics Finland renamed every table and every variable code.
 * Every tool in this server broke. The full test suite — 169 tests — kept passing,
 * because every one of them asserts against a hand-written fixture. The suite was
 * green for eight weeks while the product returned nothing but errors.
 *
 * These tests talk to the real API. They are the only tests here that can notice
 * the contract moving underneath us.
 *
 * They are SKIPPED BY DEFAULT and run with:
 *
 *     RUN_LIVE_TESTS=1 npm test
 *
 * Opt-in rather than always-on so a Statistics Finland outage cannot block an
 * unrelated pull request. Run them on a schedule instead — the drift window that
 * caused the incident was months long, so weekly is ample.
 *
 * CACHING: run these with a throwaway CACHE_FILE (see the `test:live` script).
 * The disk cache persists across runs with a 7-day TTL for historical years, so a
 * contract test sharing the normal cache would assert against last week's
 * responses and report health it never verified.
 *
 * PACING: the published rate limit (10 requests / 10 s) does not describe the real
 * policy. Measured 27.08.2026: twenty node-listing requests in 2.8 s all passed,
 * while twenty metadata requests (442 KB) were blocked at the twentieth — the
 * limit is weighted by response size. Blocks cleared in 10–15 s. PxWebClient
 * retries 429s; the sequential ordering here keeps that from being needed often.
 */

import { describe, it, expect } from 'vitest';
import { pxwebClient } from './api/pxweb-client.js';
import {
  resolvePartySchema,
  findYearVariable,
  findMeasureVariable,
  requireVariable,
  AREA_HINTS,
  CANDIDATE_HINTS,
} from './api/variable-resolver.js';
import {
  ALL_ELECTION_TABLES,
  getDatabasePath,
  getElectionTables,
} from './data/election-tables.js';
import {
  loadPartyResults,
  loadCandidateResults,
  loadVoterTurnoutByDemographics,
  loadVoterBackground,
} from './data/loaders.js';

const LIVE = process.env.RUN_LIVE_TESTS === '1';
const d = LIVE ? describe : describe.skip;

/** Long timeout: real network, plus up to three 429 backoffs of ~12 s each. */
const TIMEOUT = 120_000;

d('PxWeb contract — table addressing', () => {
  it('every registered party table still resolves and exposes its declared roles', async () => {
    const checked: string[] = [];

    for (const entry of ALL_ELECTION_TABLES) {
      if (!entry.party_by_kunta || !entry.party_schema) continue;
      const dbPath = getDatabasePath(entry);
      const tableId = entry.party_by_kunta;

      const metadata = await pxwebClient.getTableMetadata(dbPath, tableId);
      expect(metadata.variables.length, `${tableId} returned no variables`).toBeGreaterThan(0);

      // Throws VariableResolutionError naming the table and role if drifted.
      const resolved = resolvePartySchema(metadata, entry.party_schema, tableId);

      expect(metadata.variables.map((v) => v.code)).toContain(resolved.area_var);
      expect(metadata.variables.map((v) => v.code)).toContain(resolved.party_var);
      expect(metadata.variables.map((v) => v.code)).toContain(resolved.measure_var);

      const measure = metadata.variables.find((v) => v.code === resolved.measure_var)!;
      expect(measure.values, `${tableId} votes code`).toContain(resolved.votes_code);
      expect(measure.values, `${tableId} share code`).toContain(resolved.share_code);

      checked.push(tableId);
    }

    expect(checked.length).toBeGreaterThanOrEqual(4);
  }, TIMEOUT);

  it('candidate tables still expose a candidate and area dimension', async () => {
    const entry = getElectionTables('parliamentary', 2023)!;
    const tableId = entry.candidate_by_aanestysalue!['helsinki']!;
    const metadata = await pxwebClient.getTableMetadata(getDatabasePath(entry), tableId);

    expect(() => requireVariable(metadata, CANDIDATE_HINTS, 'candidate', tableId)).not.toThrow();
    expect(() => requireVariable(metadata, AREA_HINTS, 'area', tableId)).not.toThrow();
    expect(findYearVariable(metadata)).toBeDefined();
    expect(findMeasureVariable(metadata)).toBeDefined();
  }, TIMEOUT);
});

d('PxWeb contract — golden values', () => {
  /**
   * Externally verifiable anchors. If the addressing breaks these throw; if the
   * addressing silently changes *meaning* — a different measure, a gender filter
   * dropped so male+female+total are summed — the numbers move and these fail.
   * That second class is why the assertions are on values, not just on success.
   */
  it('parliamentary 2023 national matches the published result', async () => {
    const { rows } = await loadPartyResults(2023, 'SSS', 'parliamentary');
    expect(rows.length).toBeGreaterThan(5);

    const total = rows.reduce((sum, r) => sum + r.votes, 0);
    expect(total).toBeGreaterThan(3_000_000);
    expect(total).toBeLessThan(3_200_000);

    // party_name is the abbreviation from PxWeb's valueTexts ('VIHR'), not 'Vihreät'.
    const greens = rows.find((r) => r.party_name === 'VIHR');
    expect(greens, 'VIHR row present').toBeDefined();
    expect(greens!.votes).toBe(217_795);
    expect(greens!.vote_share).toBeCloseTo(7.0, 1);
  }, TIMEOUT);

  it('municipal 2025 national works — the election type whose content codes were re-prefixed', async () => {
    const { rows } = await loadPartyResults(2025, 'SSS', 'municipal');
    expect(rows.length).toBeGreaterThan(5);

    const total = rows.reduce((sum, r) => sum + r.votes, 0);
    expect(total).toBeGreaterThan(2_000_000);
    expect(total).toBeLessThan(2_600_000);

    const shares = rows.map((r) => r.vote_share ?? 0);
    expect(Math.max(...shares)).toBeLessThan(30);
  }, TIMEOUT);

  it('regional 2025 national works', async () => {
    const { rows } = await loadPartyResults(2025, 'SSS', 'regional');
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.reduce((s, r) => s + r.votes, 0)).toBeGreaterThan(1_000_000);
  }, TIMEOUT);

  it('EU 2024 national works', async () => {
    const { rows } = await loadPartyResults(2024, undefined, 'eu_parliament');
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.reduce((s, r) => s + r.votes, 0)).toBeGreaterThan(500_000);
  }, TIMEOUT);
});

d('PxWeb contract — candidate tables and the cell budget', () => {
  /**
   * These exist because the first version of this file asserted only on party
   * tables and reported everything healthy while every candidate tool was
   * returning 403. A query can be perfectly addressed and still be refused for
   * being too large, so size is part of the contract and belongs here.
   */
  it('parliamentary 2023 Helsinki returns candidates with their outcome', async () => {
    const { rows, unit_code } = await loadCandidateResults(2023, 'helsinki', undefined, 'parliamentary');
    expect(rows.length).toBeGreaterThan(10_000);

    const inUnit = rows.filter((r) => r.area_id === unit_code);
    const top = inUnit.slice().sort((a, b) => b.votes - a.votes)[0]!;
    expect(top.candidate_name).toBe('Valtonen Elina');
    expect(top.votes).toBe(32_562);
    expect(top.election_outcome).toBe('1');           // 1 = elected

    // The aggregate code must never leak through as an outcome.
    expect(rows.some((r) => r.election_outcome === 'SSS')).toBe(false);
  }, TIMEOUT);

  it('municipal 2025 Helsinki pages a table too large for one request', async () => {
    // 167 äänestysalue x 983 candidates x 2 measures = 328 322 cells, so this
    // cannot be fetched in a single query at any cell limit.
    const { rows } = await loadCandidateResults(2025, 'helsinki', undefined, 'municipal');
    const candidates = new Set(rows.map((r) => r.candidate_id));
    expect(candidates.size).toBeGreaterThan(900);
    expect(rows.length).toBeGreaterThan(100_000);
  }, TIMEOUT);

  it('the un-migrated archive still works', async () => {
    // StatFin_Passiivi was never renamed and still uses old-style codes
    // (Puolue, Äänestysalue, Sar1/Sar2). The resolver must keep handling it.
    const { rows, tableId } = await loadCandidateResults(2019, 'helsinki', undefined, 'parliamentary');
    expect(tableId).toBe('170_evaa_2019_tau_170');
    expect(rows.length).toBeGreaterThan(1_000);
    expect(rows.reduce((s, r) => s + r.votes, 0)).toBeGreaterThan(500_000);
  }, TIMEOUT);
});

d('PxWeb contract — demographics', () => {
  it('turnout by education, parliamentary 2023', async () => {
    const rows = await loadVoterTurnoutByDemographics('parliamentary', 2023, 'education');
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.turnout_pct).toBeGreaterThan(0);
      expect(r.turnout_pct).toBeLessThanOrEqual(100);
      expect(r.eligible_voters).toBeGreaterThan(0);
    }
  }, TIMEOUT);

  it('voter background by education, parliamentary 2023 — content codes were re-prefixed here too', async () => {
    const rows = await loadVoterBackground('parliamentary', 2023, 'eligible_voters', 'education');
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.count).toBeGreaterThan(0);
      expect(r.share_pct).toBeGreaterThanOrEqual(0);
    }
  }, TIMEOUT);
});
