/**
 * Edit match result types.
 *
 * Ported from apps/zcode-cli/packages/core/src/tool/edit-matchers.ts
 * (v3.15.1 @ aac4755666d09fdcd70272fcf063c077a639015f).
 */

export type EditMatchStrategy =
  | "exact"
  | "quote_normalized"
  | "line_number_prefix_stripped"
  | "escape_normalized"
  | "unicode_escape_normalized"
  | "line_trimmed"
  | "indentation_flexible"
  | "block_anchor";

export type EditMatchResult =
  | {
      status: "matched";
      actualString: string;
      strategy: EditMatchStrategy;
      candidateCount: number;
    }
  | {
      status: "ambiguous";
      strategy: EditMatchStrategy;
      candidateCount: number;
    }
  | { status: "not_found" };

/** One slice of the original content a strategy is willing to replace. */
export interface Candidate {
  value: string;
  index: number;
}
