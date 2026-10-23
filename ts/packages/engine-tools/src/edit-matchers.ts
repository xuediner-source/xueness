/**
 * Locating an Edit old_string inside file text.
 *
 * The first strategy that yields any candidate wins. `replaceAll` skips the
 * broad strategies (line trim, flexible indent, block anchor). Callers still
 * reject a matched string that `countOccurrences` finds more than once when
 * `replaceAll` is false. Empty `old_string` is the caller's short-circuit;
 * this function does not treat it as "not found".
 *
 * Ported from apps/zcode-cli/packages/core/src/tool/edit-matchers.ts
 * (v3.15.1 @ aac4755666d09fdcd70272fcf063c077a639015f).
 */
import {
  collectBlockAnchorCandidates,
  collectIndentationFlexibleCandidates,
  collectLineTrimmedCandidates,
} from "./edit-matchers-blocks.ts";
import { collectQuoteNormalizedCandidates } from "./edit-matchers-quotes.ts";
import {
  collectSubstringCandidates,
  stripReadLineNumberPrefixes,
  unescapeUnicodeCharacters,
  unescapeVisibleCharacters,
} from "./edit-matchers-text.ts";
import type { Candidate, EditMatchResult, EditMatchStrategy } from "./edit-matchers-types.ts";

export type { EditMatchResult, EditMatchStrategy } from "./edit-matchers-types.ts";
export { applyEditToContent, countOccurrences, editSpans, type EditSpan } from "./edit-matchers-apply.ts";
export { preserveQuoteStyle } from "./edit-matchers-quotes.ts";
export { normalizeLineEndings, stripReadLineNumberPrefixes } from "./edit-matchers-text.ts";

const BROAD_MATCHERS = new Set<EditMatchStrategy>([
  "line_trimmed",
  "indentation_flexible",
  "block_anchor",
]);

export function findEditMatch(input: {
  content: string;
  search: string;
  replaceAll: boolean;
}): EditMatchResult {
  const exact = collectExactCandidates(input.content, input.search);
  if (exact.length > 0) {
    return toMatchResult("exact", exact);
  }

  const strategies: EditMatchStrategy[] = [
    "quote_normalized",
    "line_number_prefix_stripped",
    "escape_normalized",
    "unicode_escape_normalized",
    "line_trimmed",
    "indentation_flexible",
    "block_anchor",
  ];

  for (const strategy of strategies) {
    if (input.replaceAll && BROAD_MATCHERS.has(strategy)) continue;
    const candidates = collectCandidates(strategy, input.content, input.search);
    if (candidates.length === 0) continue;
    return toMatchResult(strategy, candidates);
  }

  return { status: "not_found" };
}

export function normalizeReplacementForMatch(
  strategy: EditMatchStrategy,
  newString: string,
): string {
  return strategy === "escape_normalized" ? unescapeVisibleCharacters(newString) : newString;
}

function collectCandidates(
  strategy: EditMatchStrategy,
  content: string,
  search: string,
): Candidate[] {
  switch (strategy) {
    case "exact":
      return collectExactCandidates(content, search);
    case "quote_normalized":
      return collectQuoteNormalizedCandidates(content, search);
    case "line_number_prefix_stripped":
      return collectLineNumberPrefixCandidates(content, search);
    case "escape_normalized":
      return collectEscapeNormalizedCandidates(content, search);
    case "unicode_escape_normalized":
      return collectUnicodeEscapeNormalizedCandidates(content, search);
    case "line_trimmed":
      return collectLineTrimmedCandidates(content, search);
    case "indentation_flexible":
      return collectIndentationFlexibleCandidates(content, search);
    case "block_anchor":
      return collectBlockAnchorCandidates(content, search);
  }
}

function toMatchResult(strategy: EditMatchStrategy, candidates: Candidate[]): EditMatchResult {
  const uniqueValues = [...new Set(candidates.map((candidate) => candidate.value))];
  if (uniqueValues.length !== 1) {
    return { status: "ambiguous", strategy, candidateCount: candidates.length };
  }

  return {
    status: "matched",
    actualString: uniqueValues[0] ?? "",
    strategy,
    candidateCount: candidates.length,
  };
}

function collectExactCandidates(content: string, search: string): Candidate[] {
  return collectSubstringCandidates(content, search);
}

function collectLineNumberPrefixCandidates(content: string, search: string): Candidate[] {
  const stripped = stripReadLineNumberPrefixes(search);
  if (stripped === null || stripped === search) return [];
  return collectSubstringCandidates(content, stripped);
}

function collectEscapeNormalizedCandidates(content: string, search: string): Candidate[] {
  const unescaped = unescapeVisibleCharacters(search);
  if (unescaped === search) return [];
  return collectSubstringCandidates(content, unescaped);
}

function collectUnicodeEscapeNormalizedCandidates(content: string, search: string): Candidate[] {
  const unescaped = unescapeUnicodeCharacters(search);
  if (unescaped === search) return [];

  // Unicode 转义回退允许 old_string 里的 \uXXXX 匹配文件中的真实字符。
  // 这里直接返回文件中的真实片段，后续 replacement 会按真实片段写入。
  return collectSubstringCandidates(content, unescaped);
}
