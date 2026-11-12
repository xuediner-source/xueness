// Adapted from dsh-context 0.77.0, bowenliang123, Apache-2.0.
// Upstream commit 7ddaae4cae5aef0fe3d7fbe3ca28029bbe598f4b; import path adapted for Xueness.
/** Mirrors the harness token-meter's fixed density on both sides (docs/compatibility.md §4). */

const CHARS_PER_TOKEN = 4
const BLOCK_OVERHEAD = 4

/** Price one text block exactly like the harness meter's text arm. */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
}

