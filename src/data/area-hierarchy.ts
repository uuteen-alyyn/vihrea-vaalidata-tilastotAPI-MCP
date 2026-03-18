/**
 * Area hierarchy utilities for Finnish election data.
 *
 * D2 — parseKuntaCode + KUNTA_TO_VAALIPIIRI
 *
 * Enables cross-election joins by mapping:
 *   äänestysalue code → kunta code → vaalipiiri key
 *
 * These boundaries have been stable since the 2012 vaalipiiri reform.
 * A future national boundary change (requiring legislation) would require
 * an intentional update — this is not silent data staleness.
 *
 * SCOPE LIMITATION:
 * Regional elections (hyvinvointialue, HV01–HV21) do not map unambiguously
 * onto vaalipiiri boundaries. Cross-election joins mixing `regional` with other
 * election types at vaalipiiri level are not supported.
 */

import type { ElectionType } from './types.js';

// ─── Vaalipiiri prefix map ────────────────────────────────────────────────────
//
// The first two digits of an äänestysalue code (PPKKKXXXL format) or a
// vaalipiiri+kunta 6-digit code (PPKKK0 format) identify the vaalipiiri.
// Source: 13sw `Vaalipiiri ja kunta vaalivuonna` variable — aggregate codes
// ending in `0000` have format PP0000 where PP=vaalipiiri prefix.

export const VAALIPIIRI_PREFIX_MAP: Readonly<Record<string, string>> = {
  '01': 'helsinki',
  '02': 'uusimaa',
  '03': 'lounais-suomi',
  '04': 'satakunta',
  '05': 'hame',
  '06': 'pirkanmaa',
  '07': 'kaakkois-suomi',
  '08': 'savo-karjala',
  '09': 'vaasa',
  '10': 'keski-suomi',
  '11': 'oulu',
  '12': 'lappi',
  '13': 'ahvenanmaa',
};

// ─── parseKuntaCode ───────────────────────────────────────────────────────────

/**
 * Extract the 3-digit kunta code from an äänestysalue area code.
 *
 * For parliamentary, municipal, and presidential elections, area codes follow
 * the format PPKKKXXXL where PP=vaalipiiri_prefix, KKK=kunta_code (3 digits),
 * XXX=district number, L=letter suffix. Positions 2–4 are the kunta code.
 *
 * Examples:
 *   '01091001A' → '091'  (Helsinki)
 *   '06837001A' → '837'  (Tampere)
 *
 * For EU parliament (14gw), the area code format must be verified against live
 * metadata before implementing — the table may already contain KU### kunta rows.
 * Returns null until verified.
 *
 * Does NOT go stale from voting-district reorganizations — the kunta code at
 * positions 2–4 only changes if the municipality itself merges (a national
 * administrative event requiring legislation).
 */
export function parseKuntaCode(code: string, electionType: ElectionType): string | null {
  if (
    electionType === 'parliamentary' ||
    electionType === 'municipal' ||
    electionType === 'presidential'
  ) {
    // Äänestysalue codes: at least 5 digits, first 5 are numeric (PPKKK...)
    if (/^\d{5}/.test(code)) return code.slice(2, 5);
  }
  // EU: implement after verifying 14gw area code format
  return null;
}

/**
 * Extract the vaalipiiri key from a full äänestysalue area code.
 * Only valid for parliamentary/municipal/presidential (PPKKKXXXL format).
 *
 * Examples:
 *   '01091001A' → 'helsinki'
 *   '06837001A' → 'pirkanmaa'
 */
export function getVaalipiiriFromAanestysalueCode(code: string): string | null {
  if (/^\d{2}/.test(code)) {
    return VAALIPIIRI_PREFIX_MAP[code.slice(0, 2)] ?? null;
  }
  return null;
}

// ─── KUNTA_TO_VAALIPIIRI (lazy build from 13sw metadata) ─────────────────────
//
// Maps 3-digit kunta code → vaalipiiri key.
//
// Rather than hardcoding ~310 entries (which are derived data and could contain
// transcription errors), this map is built lazily on first use from the 13sw
// `Vaalipiiri ja kunta vaalivuonna` PxWeb variable. The 6-digit codes in that
// variable encode both the vaalipiiri prefix (positions 0–1) and the kunta code
// (positions 2–4): format PPKKK0.
//
// Aggregate (vaalipiiri-total) rows end in `0000` and are skipped.
// National total (SSS) is skipped.
//
// This map is stable since the 2012 vaalipiiri boundary reform. If a reform
// occurs, the source metadata changes first — the lazy build here picks it up
// automatically on next cold start.

let _kuntaToVaalipiiri: Record<string, string> | null = null;
let _buildPromise: Promise<Record<string, string>> | null = null;

/**
 * Get the vaalipiiri key for a given 3-digit kunta code.
 * Builds the lookup table lazily from 13sw metadata on first use.
 *
 * @param loader Function that fetches 13sw metadata variables
 */
export async function getKuntaToVaalipiiri(
  loader: () => Promise<Array<{ code: string; valueText: string }>>
): Promise<Record<string, string>> {
  if (_kuntaToVaalipiiri) return _kuntaToVaalipiiri;

  // Coalesce concurrent first-use calls into a single fetch
  if (!_buildPromise) {
    _buildPromise = (async () => {
      const values = await loader();
      const map: Record<string, string> = {};
      for (const { code } of values) {
        if (code === 'SSS') continue;
        if (!/^\d{6}$/.test(code)) continue;
        if (code.endsWith('0000')) continue; // vaalipiiri aggregate row
        const prefix = code.slice(0, 2);
        const kunta  = code.slice(2, 5);
        const vp     = VAALIPIIRI_PREFIX_MAP[prefix];
        if (vp && kunta) map[kunta] = vp;
      }
      _kuntaToVaalipiiri = map;
      return map;
    })();
  }
  return _buildPromise;
}

/** Clear the cached map (for testing). */
export function _clearKuntaToVaalipiiriCache(): void {
  _kuntaToVaalipiiri = null;
  _buildPromise = null;
}
