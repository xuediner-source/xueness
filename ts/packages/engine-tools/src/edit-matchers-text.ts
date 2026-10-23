/**
 * Literal search, line-number stripping and escape folding for Edit.
 *
 * Ported from apps/zcode-cli/packages/core/src/tool/edit-matchers.ts
 * (v3.15.1 @ aac4755666d09fdcd70272fcf063c077a639015f).
 */
import type { Candidate } from "./edit-matchers-types.ts";

export function normalizeLineEndings(content: string): string {
  return content.replaceAll("\r\n", "\n");
}

export function collectSubstringCandidates(content: string, search: string): Candidate[] {
  if (search.length === 0) return [];
  const candidates: Candidate[] = [];
  let position = 0;
  while (position <= content.length) {
    const index = content.indexOf(search, position);
    if (index === -1) break;
    candidates.push({ value: search, index });
    position = index + Math.max(search.length, 1);
  }
  return candidates;
}

/**
 * Read views are `<lineNumber>: <text>` or the older `<lineNumber>\t<text>`.
 * Every line must carry a prefix; otherwise the paste is left unchanged.
 */
export function stripReadLineNumberPrefixes(search: string): string | null {
  const lines = search.split("\n");
  const stripped = lines.map((line) => {
    const colonMatch = line.match(/^\d+: (.*)$/);
    if (colonMatch) return colonMatch[1] ?? "";
    const tabMatch = line.match(/^\d+\t(.*)$/);
    if (tabMatch) return tabMatch[1] ?? "";
    return null;
  });
  return stripped.every((line): line is string => line !== null) ? stripped.join("\n") : null;
}

export function unescapeVisibleCharacters(search: string): string {
  return search.replace(/\\([ntr"'`\\$])/g, (match, token: string) => {
    switch (token) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case '"':
      case "'":
      case "`":
      case "\\":
      case "$":
        return token;
      default:
        return match;
    }
  });
}

export function unescapeUnicodeCharacters(search: string): string {
  return search.replace(/(\\\\)|\\u([0-9a-fA-F]{4})/g, (match, escapedBackslash, hex: string) => {
    if (escapedBackslash !== undefined) return match;
    return String.fromCharCode(Number.parseInt(hex, 16));
  });
}
