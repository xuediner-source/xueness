/**
 * Which Memory Ocean memories enter a run, and how they read.
 *
 * Ranking is BM25 over each memory's summary, text and tags (tags count
 * twice), lifted by importance and, a little, by recency. A memory that does
 * not match still comes along when it is core: a preference of importance 4
 * or more, or anything of importance 5. Selection is bounded by a count and a
 * character budget, smaller for the lightweight runtime; a selected memory
 * shows its full text only while the budget allows, otherwise its summary.
 *
 * The block is computed once per run and stays fixed for that run, so the
 * prompt prefix a local server caches does not move between steps.
 */
import { bm25, termIndex, terms } from "./memory-ocean-terms.ts";
import type { OceanMemory } from "./memory-ocean-store.ts";

export interface RecallLimits { maxEntries: number; maxChars: number }
export const STANDARD_RECALL: RecallLimits = Object.freeze({ maxEntries: 8, maxChars: 2400 });
export const LIGHTWEIGHT_RECALL: RecallLimits = Object.freeze({ maxEntries: 5, maxChars: 1200 });
export const OCEAN_HEADER = "## Memory Ocean (saved by earlier conversations)\n"
  + "Use a memory only if it applies to the current task; the current instructions win. "
  + "To correct one, call memory_remember with `supersedes` set to its id.";

export interface RankedMemory { memory: OceanMemory; score: number; reason: "match" | "core" }

const DAY = 86_400_000;
const chars = (value: string): number => Array.from(value).length;
const cut = (value: string, max: number): string => chars(value) <= max ? value : Array.from(value).slice(0, max - 1).join("") + "…";

function documentTerms(memory: OceanMemory): string[] {
  const tags = memory.tags.flatMap((tag) => [tag, ...terms(tag)]);
  return [...terms(`${memory.summary} ${memory.text}`), ...tags, ...tags];
}

/** Every memory that matches `query` or is core, best first. */
export function rankMemories(memories: readonly OceanMemory[], query: string, nowMs = Date.now()): RankedMemory[] {
  const documents = memories.map(documentTerms);
  const index = termIndex(documents);
  const wanted = terms(query);
  const ranked: RankedMemory[] = [];
  memories.forEach((memory, position) => {
    const lexical = bm25(wanted, documents[position]!, index);
    if (lexical > 0) {
      const age = Math.max(0, (nowMs - Date.parse(memory.updatedAt)) / DAY);
      const recency = Number.isFinite(age) ? 0.4 * Math.exp(-age / 45) : 0;
      ranked.push({ memory, score: lexical * (1 + 0.15 * (memory.importance - 3)) + recency, reason: "match" });
    } else if (memory.importance >= 5 || memory.kind === "preference" && memory.importance >= 4) {
      ranked.push({ memory, score: 0.05 * memory.importance, reason: "core" });
    }
  });
  return ranked.sort((a, b) => b.score - a.score || b.memory.importance - a.memory.importance || b.memory.updatedAt.localeCompare(a.memory.updatedAt));
}

function line(memory: OceanMemory, withText: boolean): string {
  const scope = memory.scope === "global" ? ", global" : "";
  const head = `- (${memory.id}) [${memory.kind}${scope}] ${memory.summary}`;
  const text = memory.text.replace(/\s+/gu, " ").trim();
  return withText && text !== memory.summary ? `${head}: ${cut(text, 320)}` : head;
}

/** The recall block for one run, with the ids it contains; empty when nothing qualifies. */
export function renderOceanRecall(ranked: readonly RankedMemory[], limits: RecallLimits): { text: string; ids: string[] } {
  const lines: string[] = [], ids: string[] = [];
  let used = chars(OCEAN_HEADER);
  for (const { memory } of ranked) {
    if (ids.length >= limits.maxEntries) break;
    const full = line(memory, true), short = line(memory, false);
    const chosen = used + chars(full) + 1 <= limits.maxChars ? full : used + chars(short) + 1 <= limits.maxChars ? short : null;
    if (!chosen) continue;
    lines.push(chosen); ids.push(memory.id); used += chars(chosen) + 1;
  }
  return lines.length ? { text: `${OCEAN_HEADER}\n${lines.join("\n")}`, ids } : { text: "", ids: [] };
}

/** The text of a message: plain content, or the text parts of a multi-part one. */
export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "text" ? String((part as { text?: unknown }).text ?? "") : "").join("\n");
}

/** What a run is about: its latest real user message (not guidance or notices), bounded. */
export function recallQuery(messages: unknown): string {
  const rows = Array.isArray(messages) ? messages : [];
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index] as Record<string, unknown> | null;
    if (!row || typeof row !== "object" || row.role !== "user" || row._meta_source || row._input_kind === "background_notice") continue;
    return cut(messageText(row.content), 2000);
  }
  return "";
}
