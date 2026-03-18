/**
 * Shared fuzzy matching utilities for name resolution.
 * Used by entity-resolution and trajectory tools.
 */

export function normalizeStr(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/ä/g, 'a')
    .replace(/å/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/ü/g, 'u')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildBigrams(s: string): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

/**
 * Dice-coefficient bigram similarity.
 * For strings shorter than 2 chars, falls back to exact/prefix match.
 */
export function bigramSimilarity(a: string, aSet: Set<string>, b: string): number {
  if (a.length < 2 || b.length < 2) {
    if (a === b) return 1.0;
    if (b.startsWith(a) || a.startsWith(b)) return 0.5;
    return 0;
  }
  if (aSet.size === 0) return 0;
  const bSet = buildBigrams(b);
  if (bSet.size === 0) return 0;
  let intersection = 0;
  for (const bg of aSet) if (bSet.has(bg)) intersection++;
  return (2 * intersection) / (aSet.size + bSet.size);
}

export function scoreMatch(query: string, candidate: string): number {
  const qLow = query.toLowerCase().trim();
  const cLow = candidate.toLowerCase().trim();
  if (qLow === cLow) return 1.0;
  const qNorm = normalizeStr(query);
  const cNorm = normalizeStr(candidate);
  if (qNorm === cNorm) return 0.95;
  if (cLow.startsWith(qLow) || cLow.includes(` ${qLow}`) || cLow.includes(`${qLow} `)) return 0.88;
  if (cNorm.startsWith(qNorm) || cNorm.includes(qNorm)) return 0.82;
  return bigramSimilarity(qNorm, buildBigrams(qNorm), cNorm);
}

/** Pre-computed scorer — avoids rebuilding query bigrams on every iteration. */
export function scoreMatchFast(
  qLow: string, qNorm: string, qBigrams: Set<string>,
  cLow: string, cNorm: string,
): number {
  if (qLow === cLow) return 1.0;
  if (qNorm === cNorm) return 0.95;
  if (cLow.startsWith(qLow) || cLow.includes(` ${qLow}`) || cLow.includes(`${qLow} `)) return 0.88;
  if (cNorm.startsWith(qNorm) || cNorm.includes(qNorm)) return 0.82;
  return bigramSimilarity(qNorm, qBigrams, cNorm);
}

export function confidenceLabel(score: number): 'exact' | 'high' | 'medium' | 'low' {
  if (score >= 0.95) return 'exact';
  if (score >= 0.8) return 'high';
  if (score >= 0.55) return 'medium';
  return 'low';
}
