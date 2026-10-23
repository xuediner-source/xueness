/**
 * Glob / Grep model text from the Xueness glob / grep results, in the shape of
 * ZCode v3.15.1 (aac4755, Apache-2.0) `core/src/tool/handlers/glob.ts`
 * (formatGlobModelContent) and `grep.ts` (formatGrepModelContent). The Xueness
 * output keeps its own notes for the lightweight runtime and the Python tools.
 */
import { isDict } from "@xueness/contracts";

type Row = Record<string, unknown>;
const XUENESS_NOTE = /^\[(?:results truncated|search stopped|skipped) /;
const plural = (count: number, noun: string): string => count === 1 ? noun : `${noun}s`;
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

export function globText(data: unknown): string | undefined {
  if (!isDict(data)) return undefined;
  const files = strings(data.files);
  if (!files.length) return "No files found";
  return data.truncated === true || data.walkTruncated === true
    ? `${files.join("\n")}\n(Results are truncated. Consider using a more specific path or pattern.)` : files.join("\n");
}

/** The Xueness grep lines without its trailing `[…]` notes. */
function grepBody(output: string): string {
  const blocks = output.split("\n\n");
  const last = blocks.at(-1) ?? "";
  if (blocks.length > 1 && last.split("\n").every((line) => XUENESS_NOTE.test(line))) blocks.pop();
  return blocks.join("\n\n");
}

export function grepText(data: unknown, input: Row | null, output: string): string | undefined {
  if (!isDict(data) || typeof data.mode !== "string") return undefined;
  const limit = typeof input?.head_limit === "number" ? input.head_limit : 250;
  const offset = typeof input?.offset === "number" ? input.offset : 0;
  // ZCode applyHeadLimit: the limit shows only when it cut the results, the offset whenever it is set.
  const limitInfo = [data.truncated === true ? `limit: ${limit}` : "", offset > 0 ? `offset: ${offset}` : ""].filter(Boolean).join(", ");
  const matched = Number(data.filesMatched ?? 0);
  if (data.mode === "content") {
    const content = matched ? grepBody(output) : "No matches found";
    return limitInfo ? `${content}\n\n[Showing results with pagination = ${limitInfo}]` : content;
  }
  if (data.mode === "count") {
    const counts = isDict(data.counts) ? Object.values(data.counts).filter((value): value is number => typeof value === "number") : [];
    const occurrences = counts.reduce((sum, value) => sum + value, 0);
    const content = matched ? grepBody(output) : "No matches found";
    return `${content}\n\nFound ${occurrences} total ${plural(occurrences, "occurrence")} across ${counts.length} ${plural(counts.length, "file")}.${limitInfo ? ` with pagination = ${limitInfo}` : ""}`;
  }
  const files = strings(data.files);
  if (!files.length) return "No files found";
  return `Found ${files.length} ${plural(files.length, "file")}${limitInfo ? ` ${limitInfo}` : ""}\n${files.join("\n")}`;
}
