/**
 * Minimal fuzzy matcher for the command palette: case-insensitive subsequence
 * match with a small score (consecutive-char and word-start bonuses). Returns
 * -1 when the needle is not a subsequence. Deliberately dependency-free.
 */

export function fuzzyMatch(needle: string, haystack: string): number {
  const n = needle.toLowerCase();
  const h = haystack.toLowerCase();
  if (!n) return 0;
  let score = 0;
  let hIndex = 0;
  let streak = 0;
  for (let i = 0; i < n.length; i++) {
    const char = n[i];
    const found = h.indexOf(char, hIndex);
    if (found === -1) return -1;
    // Consecutive characters and word-start hits score higher.
    if (found === hIndex) {
      streak += 1;
      score += 2 + streak;
    } else {
      streak = 0;
      score += 1;
      const prev = found > 0 ? h[found - 1] : "";
      if (prev === "/" || prev === "-" || prev === "_" || prev === " " || prev === ".") score += 2;
    }
    hIndex = found + 1;
  }
  // Shorter haystacks sort ahead at equal structure.
  return score - h.length * 0.01;
}

export function fuzzyFilter<T>(
  items: T[],
  text: (item: T) => string,
  needle: string,
): { item: T; score: number }[] {
  const hits: { item: T; score: number }[] = [];
  for (const item of items) {
    const score = fuzzyMatch(needle, text(item));
    if (score >= 0) hits.push({ item, score });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits;
}
