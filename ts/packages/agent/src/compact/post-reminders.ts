/**
 * Context re-attached after a compaction.
 * Read state: ZCode v3.15.1 (aac4755, Apache-2.0) `core/runtime/helpers/compact-post-reminders.ts`
 * (selection limits, skip rules and texts). Xueness keeps no separate read-state map, so the
 * candidates are the successful Read results in the summarized journal slice, newest first;
 * a file later written, edited or patched is skipped, as ZCode's read state is replaced by
 * the write. Todos: ZCode `runtime-reminders.ts` buildTodoReminderBody text; ZCode relies on
 * its periodic todo reminder, which Xueness does not yet produce, so one is attached here.
 */
import { isAbsolute, resolve } from "node:path";
import { ESTIMATED_TOKEN_CHAR_DIVISOR } from "./policy.ts";

type Row = Record<string, unknown>;
export interface PostCompactReminder { source: "resume_referenced_session_context" | "todo_reminder"; content: string }
interface ReadCandidate { path: string; offset?: number; limit?: number; output: string }

const isRow = (value: unknown): value is Row => typeof value === "object" && value !== null && !Array.isArray(value);
function parseArgs(call: Row): Row {
  const fn = isRow(call.function) ? call.function : {};
  if (isRow(fn.arguments)) return fn.arguments;
  try { const parsed = JSON.parse(String(fn.arguments ?? "{}")); return isRow(parsed) ? parsed : {}; } catch { return {}; }
}
function resultOf(session: Row, message: Row | undefined, id: string): Row | null {
  const results = isRow(session.results) ? session.results : {};
  if (isRow(results[id])) return results[id] as Row;
  if (typeof message?.content !== "string") return null;
  try { const parsed = JSON.parse(message.content); return isRow(parsed) ? parsed : null; } catch { return null; }
}
const normalize = (path: string): string => path.replace(/\\/g, "/");
const absolute = (root: string, path: string): string => normalize(isAbsolute(path) ? path : resolve(root, path));
const skipped = (path: string): boolean => path.includes("/.codex/memories/") || path.includes("/docs/superpowers/plans/") || path.includes("/.git/");

function patchedPaths(text: string): string[] {
  return [...text.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map((match) => match[1]!.trim());
}

/** Paths each message's tool calls write (write/edit/apply_patch) or read (read). */
function callsOf(message: Row): { id: string; name: string; args: Row }[] {
  if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) return [];
  return message.tool_calls.filter(isRow).map((call) => ({ id: String(call.id ?? ""), name: String(isRow(call.function) ? call.function.name : ""), args: parseArgs(call) }));
}
function writtenPaths(root: string, messages: readonly Row[]): Set<string> {
  const paths = new Set<string>();
  for (const message of messages) for (const call of callsOf(message)) {
    if (["write", "edit"].includes(call.name) && typeof call.args.path === "string") paths.add(absolute(root, call.args.path));
    if (call.name === "apply_patch" && typeof call.args.patch_text === "string") for (const path of patchedPaths(call.args.patch_text)) paths.add(absolute(root, path));
  }
  return paths;
}

export function collectReadCandidates(session: Row, root: string, summarized: readonly Row[], preserved: readonly Row[]): ReadCandidate[] {
  const toolMessages = new Map<string, Row>();
  for (const message of [...summarized, ...preserved]) if (message.role === "tool" && typeof message.tool_call_id === "string") toolMessages.set(message.tool_call_id, message);
  const preservedReads = new Set<string>();
  for (const message of preserved) for (const call of callsOf(message)) if (call.name === "read" && typeof call.args.path === "string") preservedReads.add(absolute(root, call.args.path));
  const candidates: ReadCandidate[] = []; const seen = new Set<string>();
  const laterWrites = new Set<string>(writtenPaths(root, preserved));
  for (let index = summarized.length - 1; index >= 0; index -= 1) {
    const message = summarized[index]!;
    const calls = callsOf(message);
    for (const call of [...calls].reverse()) {
      if (call.name !== "read" || typeof call.args.path !== "string") continue;
      const path = absolute(root, call.args.path);
      const offset = typeof call.args.offset === "number" ? call.args.offset : undefined;
      const limit = typeof call.args.limit === "number" ? call.args.limit : undefined;
      const key = [path, offset ?? 1, limit ?? ""].join("\0");
      if (seen.has(key) || laterWrites.has(path) || preservedReads.has(path) || skipped(path)) continue;
      seen.add(key);
      const result = resultOf(session, toolMessages.get(call.id), call.id);
      const output = result && result.ok === true && typeof result.output === "string" ? result.output : "";
      // Empty files and partial views carry a system-reminder instead of content.
      if (!output || output.startsWith("<system-reminder>")) continue;
      candidates.push({ path, ...offset !== undefined ? { offset } : {}, ...limit !== undefined ? { limit } : {}, output });
    }
    for (const path of writtenPaths(root, [message])) laterWrites.add(path);
  }
  return candidates;
}

export function readStateReminders(candidates: readonly ReadCandidate[], limits: { maxFiles?: number; maxFileApproxTokens?: number; maxTotalApproxTokens?: number } = {}): PostCompactReminder[] {
  const maxFiles = limits.maxFiles ?? 5, maxFile = limits.maxFileApproxTokens ?? 5_000, maxTotal = limits.maxTotalApproxTokens ?? 50_000;
  const selected: PostCompactReminder[] = []; let total = 0;
  for (const entry of candidates) {
    if (selected.length >= maxFiles) break;
    const tokens = Math.ceil(entry.output.length / ESTIMATED_TOKEN_CHAR_DIVISOR);
    const reference = `Note: ${entry.path} was read before the last conversation was summarized, but the contents are too large to include. Use Read tool if you need to access it.`;
    if (tokens > maxFile || total + tokens > maxTotal) { selected.push({ source: "resume_referenced_session_context", content: reference }); continue; }
    total += tokens;
    const input = JSON.stringify({ file_path: entry.path, ...entry.offset === undefined ? {} : { offset: entry.offset }, ...entry.limit === undefined ? {} : { limit: entry.limit } });
    selected.push({ source: "resume_referenced_session_context", content: [`Called the Read tool with the following input: ${input}`, "Result of calling the Read tool:", entry.output].join("\n") });
  }
  return selected;
}

export function todoReminder(todos: unknown): PostCompactReminder | null {
  const items = Array.isArray(todos) ? todos.filter(isRow) : [];
  const lines = items.map((todo) => ({ status: typeof todo.status === "string" ? todo.status : todo.done === true ? "completed" : "pending", content: String(todo.content ?? todo.text ?? "") }))
    .filter((todo) => todo.content.trim());
  if (!lines.length) return null;
  const list = `[${lines.map((todo, index) => `${index + 1}. [${todo.status}] ${todo.content}`).join("\n")}]`;
  return { source: "todo_reminder", content: [
    "The TodoWrite tool hasn't been used recently. If you're working on tasks that would benefit from tracking progress, consider using the TodoWrite tool to track progress. Also consider cleaning up the todo list if has become stale and no longer matches what you are working on. Only use it if it's relevant to the current work. This is just a gentle reminder - ignore if not applicable.",
    "", "Here are the existing contents of your todo list:", "", list,
  ].join("\n") };
}

export function buildPostCompactReminders(session: Row, root: string, summarized: readonly Row[], preserved: readonly Row[]): PostCompactReminder[] {
  const todo = todoReminder(session.todos);
  return [...readStateReminders(collectReadCandidates(session, root, summarized, preserved)), ...todo ? [todo] : []];
}
