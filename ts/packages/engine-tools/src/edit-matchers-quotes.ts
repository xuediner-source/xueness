/**
 * Curly-quote folding and quote-style preservation for Edit.
 *
 * Ported from apps/zcode-cli/packages/core/src/tool/edit-matchers.ts
 * (v3.15.1 @ aac4755666d09fdcd70272fcf063c077a639015f).
 */
import type { Candidate } from "./edit-matchers-types.ts";

const LEFT_SINGLE_CURLY_QUOTE = "\u2018";
const RIGHT_SINGLE_CURLY_QUOTE = "\u2019";
const LEFT_DOUBLE_CURLY_QUOTE = "\u201c";
const RIGHT_DOUBLE_CURLY_QUOTE = "\u201d";

export function preserveQuoteStyle(
  oldString: string,
  actualOldString: string,
  newString: string,
): string {
  if (oldString === actualOldString) {
    return newString;
  }

  let result = newString;
  if (
    actualOldString.includes(LEFT_DOUBLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_DOUBLE_CURLY_QUOTE)
  ) {
    result = applyCurlyDoubleQuotes(result);
  }
  if (
    actualOldString.includes(LEFT_SINGLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_SINGLE_CURLY_QUOTE)
  ) {
    result = applyCurlySingleQuotes(result);
  }
  return result;
}

export function collectQuoteNormalizedCandidates(content: string, search: string): Candidate[] {
  return collectNormalizedCandidates(content, search, normalizeQuotes);
}

function collectNormalizedCandidates(
  content: string,
  search: string,
  normalize: (value: string) => string,
): Candidate[] {
  const normalizedContent = normalize(content);
  const normalizedSearch = normalize(search);
  const candidates: Candidate[] = [];
  let position = 0;
  while (position <= normalizedContent.length) {
    const index = normalizedContent.indexOf(normalizedSearch, position);
    if (index === -1) break;
    // Quote folding keeps one code unit per character, so this slice is the file text.
    candidates.push({ value: content.slice(index, index + search.length), index });
    position = index + Math.max(normalizedSearch.length, 1);
  }
  return candidates;
}

function normalizeQuotes(value: string): string {
  return value
    .replaceAll(LEFT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(RIGHT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(LEFT_DOUBLE_CURLY_QUOTE, '"')
    .replaceAll(RIGHT_DOUBLE_CURLY_QUOTE, '"');
}

function applyCurlyDoubleQuotes(value: string): string {
  return [...value]
    .map((char, index, chars) => {
      if (char !== '"') return char;
      return isOpeningQuoteContext(chars, index)
        ? LEFT_DOUBLE_CURLY_QUOTE
        : RIGHT_DOUBLE_CURLY_QUOTE;
    })
    .join("");
}

function applyCurlySingleQuotes(value: string): string {
  return [...value]
    .map((char, index, chars) => {
      if (char !== "'") return char;
      const previous = chars[index - 1];
      const next = chars[index + 1];
      if (isLetter(previous) && isLetter(next)) {
        return RIGHT_SINGLE_CURLY_QUOTE;
      }
      return isOpeningQuoteContext(chars, index)
        ? LEFT_SINGLE_CURLY_QUOTE
        : RIGHT_SINGLE_CURLY_QUOTE;
    })
    .join("");
}

function isOpeningQuoteContext(chars: string[], index: number): boolean {
  if (index === 0) return true;
  const previous = chars[index - 1];
  return (
    previous === " " ||
    previous === "\t" ||
    previous === "\n" ||
    previous === "\r" ||
    previous === "(" ||
    previous === "[" ||
    previous === "{" ||
    previous === "\u2014" ||
    previous === "\u2013"
  );
}

function isLetter(value: string | undefined): boolean {
  return value !== undefined && /\p{L}/u.test(value);
}
