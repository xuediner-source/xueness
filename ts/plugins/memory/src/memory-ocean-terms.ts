/**
 * Terms for Memory Ocean recall and linking, with no model and no embeddings:
 * small local models must not pay an extra call per turn for memory.
 *
 * Latin-script words become lower-case terms (two characters or more, minus a
 * short stop list). Runs of CJK characters have no spaces, so each run becomes
 * its overlapping character pairs ("记忆系统" → 记忆, 忆系, 系统); a lone CJK
 * character stands for itself.
 */
const WORD = /[\p{L}\p{N}_]+/gu;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const STOP = new Set(["the", "and", "for", "with", "that", "this", "are", "was", "you", "your", "not", "but", "from", "have", "has", "use", "uses", "using", "into", "when", "then", "than", "its", "our", "can", "will", "should", "would", "about", "they", "them", "there", "here", "what", "which", "who", "how", "all", "any"]);

export function terms(text: string): string[] {
  const out: string[] = [];
  for (const match of String(text).toLowerCase().matchAll(WORD)) {
    const word = match[0];
    let latin = "";
    const flush = (): void => { if (latin.length >= 2 && !STOP.has(latin)) out.push(latin); latin = ""; };
    const chars = Array.from(word);
    for (let index = 0; index < chars.length; index += 1) {
      const char = chars[index]!;
      if (!CJK.test(char)) { latin += char; continue; }
      flush();
      const next = chars[index + 1];
      if (next !== undefined && CJK.test(next)) out.push(char + next);
      else if (index === 0 || !CJK.test(chars[index - 1]!)) out.push(char);
    }
    flush();
  }
  return out;
}

/** Jaccard overlap of two term lists (as sets). */
export function similarity(left: readonly string[], right: readonly string[]): number {
  if (!left.length || !right.length) return 0;
  const a = new Set(left), b = new Set(right);
  let shared = 0;
  for (const term of a) if (b.has(term)) shared += 1;
  return shared / (a.size + b.size - shared);
}

export interface TermIndex {
  /** Documents in the index. */
  readonly size: number;
  /** Mean document length in terms. */
  readonly average: number;
  readonly df: ReadonlyMap<string, number>;
}

export function termIndex(documents: readonly (readonly string[])[]): TermIndex {
  const df = new Map<string, number>();
  let total = 0;
  for (const document of documents) {
    total += document.length;
    for (const term of new Set(document)) df.set(term, (df.get(term) ?? 0) + 1);
  }
  return { size: documents.length, average: documents.length ? total / documents.length : 0, df };
}

/** BM25 of one document for the query terms (k1 1.2, b 0.75). */
export function bm25(query: readonly string[], document: readonly string[], index: TermIndex): number {
  if (!query.length || !document.length) return 0;
  const tf = new Map<string, number>();
  for (const term of document) tf.set(term, (tf.get(term) ?? 0) + 1);
  const norm = 1 - 0.75 + 0.75 * (document.length / (index.average || 1));
  let score = 0;
  for (const term of new Set(query)) {
    const count = tf.get(term);
    if (!count) continue;
    const df = index.df.get(term) ?? 0;
    const idf = Math.log(1 + (index.size - df + 0.5) / (df + 0.5));
    score += idf * (count * 2.2) / (count + 1.2 * norm);
  }
  return score;
}
