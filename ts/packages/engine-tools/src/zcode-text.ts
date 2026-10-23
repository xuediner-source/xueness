/**
 * Texts and small rules the core tools share with ZCode v3.15.1 (aac4755, Apache-2.0):
 * `adapters/src/fs/text-range-reader.ts` (formatFileSize), `core/src/context/utils.ts`
 * (estimateTokens), `core/src/tool/handlers/read.ts` / `edit.ts` (missing-file
 * message with a similar-name hint), `core/src/tool/result-persistence-format.ts`.
 */
import { readdir } from "node:fs/promises";
import { basename, dirname, extname } from "node:path";

/** `shared/src/usage-stats.ts` ESTIMATED_TOKEN_CHAR_DIVISOR. */
const ESTIMATED_TOKEN_CHAR_DIVISOR = 3;

/** CJK ideographs count as two characters. */
export function estimateTokens(text: string): number {
  const chinese = (text.match(/[一-鿿]/g) || []).length;
  return Math.ceil((chinese * 2 + text.length - chinese) / ESTIMATED_TOKEN_CHAR_DIVISOR);
}

/** The file-system adapter's size text: `512B`, `1.5KB`, `3MB`. */
export function formatFileSize(bytes: number): string {
  const unit = (value: number): string => Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${unit(bytes / 1024)}KB`;
  return `${unit(bytes / (1024 * 1024))}MB`;
}

export function systemReminder(body: string): string {
  return `<system-reminder>${body}</system-reminder>`;
}

function levenshtein(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[right.length] ?? 0;
}

/** ZCode findSimilarFilename: a sibling with the same stem, else one within edit distance 3. */
export async function similarFilename(path: string): Promise<string | undefined> {
  try {
    const target = basename(path);
    const stem = basename(path, extname(path));
    const entries = (await readdir(dirname(path), { withFileTypes: true }))
      .filter((entry) => entry.isFile() || entry.isSymbolicLink()).map((entry) => entry.name).filter((name) => name !== target).sort();
    return entries.find((name) => basename(name, extname(name)) === stem) ?? entries.find((name) => levenshtein(name, target) <= 3);
  } catch {
    return undefined;
  }
}

export async function missingFileMessage(path: string, cwd: string): Promise<string> {
  const suggestion = await similarFilename(path);
  return `File does not exist. Note: your current working directory is ${cwd}.${suggestion ? ` Did you mean ${suggestion}?` : ""}`;
}

/** ZCode formatPersistedOutputEnvelope: a preview of large output and where the rest is. */
export function persistedOutputEnvelope(content: string, originalBytes: string, persistedPath: string, previewChars: number, previewSize: string): string {
  let preview = content;
  let more = false;
  if (content.length > previewChars) {
    const newline = content.slice(0, previewChars).lastIndexOf("\n");
    preview = content.slice(0, newline > previewChars * 0.5 ? newline : previewChars);
    more = true;
  }
  return ["<persisted-output>", `Output too large (${originalBytes}). Full output saved to: ${persistedPath}`, "", `Preview (first ${previewSize}):`, preview, ...(more ? ["..."] : []), "</persisted-output>"].join("\n");
}
