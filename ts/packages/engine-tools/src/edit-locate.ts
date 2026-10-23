/**
 * Edit: from old_string to the exact spans to replace.
 *
 * Follows the ZCode v3.15.1 (aac4755, Apache-2.0) Edit handler order:
 * findEditMatch → occurrence count gate → normalizeReplacementForMatch →
 * preserveQuoteStyle → literal replacement. Three guards are added where the
 * ZCode handler could change the wrong place:
 *
 * 1. A non-exact strategy that resolves to empty or whitespace-only file text
 *    (for example a whitespace-only old_string trimmed onto blank lines) is
 *    not_found. An empty actual string also made ZCode's countOccurrences loop.
 * 2. The ambiguity gate also uses the matcher's candidate count, so two
 *    overlapping line windows (`a\na` in `a\na\na`) are ambiguous instead of
 *    silently taking the first.
 * 3. Curly-quote restyling of new_string only follows a quote_normalized
 *    match, and only for a quote kind the matched text uses exclusively; a
 *    whitespace-only difference or mixed straight/curly text keeps new_string
 *    as written, so straight code quotes are never curled.
 */
import { countOccurrences, editSpans, type EditSpan } from "./edit-matchers-apply.ts";
import { findEditMatch, normalizeReplacementForMatch, preserveQuoteStyle, type EditMatchStrategy } from "./edit-matchers.ts";

export type EditLocation =
  | { status: "matched"; strategy: EditMatchStrategy; actualOldString: string; actualNewString: string; spans: EditSpan[]; candidateCount: number }
  | { status: "ambiguous"; strategy: EditMatchStrategy; count: number }
  | { status: "not_found" };

/** Inputs are LF text (see normalizeLineEndings). */
export function locateEdit(content: string, oldString: string, newString: string, replaceAll: boolean): EditLocation {
  const match = findEditMatch({ content, search: oldString, replaceAll });
  if (match.status === "not_found") return match;
  if (match.status === "ambiguous") return { status: "ambiguous", strategy: match.strategy, count: match.candidateCount };
  const actualOldString = match.actualString;
  if (actualOldString === "" || (match.strategy !== "exact" && actualOldString.trim() === "")) return { status: "not_found" };
  const count = Math.max(countOccurrences(content, actualOldString), match.candidateCount);
  if (!replaceAll && count > 1) return { status: "ambiguous", strategy: match.strategy, count };
  const normalized = normalizeReplacementForMatch(match.strategy, newString);
  const actualNewString = restyleQuotes(match.strategy, oldString, actualOldString, normalized);
  return {
    status: "matched",
    strategy: match.strategy,
    actualOldString,
    actualNewString,
    spans: editSpans(content, actualOldString, actualNewString, replaceAll),
    candidateCount: match.candidateCount,
  };
}

function restyleQuotes(strategy: EditMatchStrategy, oldString: string, actualOldString: string, newString: string): string {
  if (strategy !== "quote_normalized") return newString;
  const mixedDouble = /[\u201c\u201d]/.test(actualOldString) && actualOldString.includes('"');
  const mixedSingle = /[\u2018\u2019]/.test(actualOldString) && actualOldString.includes("'");
  if (mixedDouble || mixedSingle) return newString;
  return preserveQuoteStyle(oldString, actualOldString, newString);
}
