/**
 * Stored sub-agent definitions (Python `bundled_plugins/subagents/subagents.py`):
 * `<state>/resources/subagents/<id>.json`, loaded read-only, links refused,
 * plus Python's `select` fallbacks, allowlist and prompt helpers.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { isDict, pyTruthy, pyDecodeUtf8, pyJsonLoads, pyLen, pyRstrip, pySlice, pyStrip } from "@xueness/contracts";
import { isLink, readRegularBeneath } from "@xueness/sessions";

export type Row = Record<string, unknown>;
export const PROMPT_MAX_CHARS = 4000;
export const TASK_TOOL_NAME = "task";
export const TRUNCATION_SUFFIX = "\n…(truncated)";
export const PROMPT_SEPARATOR = "\n\n---\n\n# Sub-agent\n\n";
export const PROMPT_KEYS = ["systemPrompt", "prompt", "description"] as const;
/** Python's child-only exclusions (durable workflow writes). */
export const SUBAGENT_DENIED_TOOL_NAMES: readonly string[] = Object.freeze(["workflow_create", "workflow_amend"]);
const MAX_RESOURCE_BYTES = 16 * 1024 * 1024;

/** Python `str` ordering (code points, not UTF-16 units). */
export function pyCompare(a: string, b: string): number {
  const left = Array.from(a, (c) => c.codePointAt(0)!);
  const right = Array.from(b, (c) => c.codePointAt(0)!);
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) if (left[index] !== right[index]) return left[index]! - right[index]!;
  return left.length - right.length;
}

/** Python `clip`. */
export function clip(text: string, maxChars: number): string {
  if (!maxChars || pyLen(text) <= maxChars) return text;
  const keep = Math.max(0, maxChars - pyLen(TRUNCATION_SUFFIX));
  if (keep === 0) return pySlice(TRUNCATION_SUFFIX, maxChars);
  return pyRstrip(pySlice(text, keep)) + TRUNCATION_SUFFIX;
}

function readJson(stateDir: string, name: string): Row | null {
  const read = readRegularBeneath(stateDir, `resources/subagents/${name}`, MAX_RESOURCE_BYTES);
  if (!read || read.size > read.raw.length) return null;
  try { const value = pyJsonLoads(pyDecodeUtf8(read.raw)); return isDict(value) ? value : null; } catch { return null; }
}

/** Python `load`: every usable definition, ascending id; links, disabled and nameless entries skipped. */
export function loadSubagents(stateDir: string): Row[] {
  const resources = join(stateDir, "resources");
  const directory = join(resources, "subagents");
  if (!stateDir || isLink(stateDir) || isLink(resources) || isLink(directory)) return [];
  let names: string[];
  try { names = readdirSync(directory); } catch { return []; }
  const windows = process.platform === "win32";
  const items: Row[] = [];
  for (const name of names.filter((entry) => windows ? entry.toLowerCase().endsWith(".json") : entry.endsWith(".json")).sort(pyCompare)) {
    if (isLink(join(directory, name))) continue;
    const item = readJson(stateDir, name);
    if (item === null) continue;
    const { id, name: label } = item;
    if (typeof id !== "string" || !pyStrip(id) || typeof label !== "string" || !pyStrip(label) || item.enabled === false) continue;
    items.push({ ...item, id: pyStrip(id), name: pyStrip(label) });
  }
  return items.sort((a, b) => pyCompare(a.id as string, b.id as string));
}

const lower = (text: string): string => text.toLowerCase();
export const GENERAL_PURPOSE_FALLBACK: Row = Object.freeze({ id: "general-purpose", name: "general-purpose",
  description: "General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks.", tools: ["*"] }) as Row;
export const EXPLORE_FALLBACK: Row = Object.freeze({ id: "explore", name: "explore",
  description: "Read-only exploration agent for fast code search and directory inspection.",
  tools: ["read", "list", "glob", "grep", "web_fetch", "web_search", "todo_read", "todo_write"] }) as Row;

/** Python `select`: id or name, exact then case-insensitive; then the built-in fallbacks. */
export function selectSubagent(agents: unknown, name: unknown): Row | null {
  if (typeof name !== "string" || !pyStrip(name)) return null;
  const list = Array.isArray(agents) ? agents : [];
  const clean = lower(pyStrip(name));
  for (const agent of list) {
    if (!isDict(agent)) continue;
    const aid = pyStrip(String(agent.id || "")); const aname = pyStrip(String(agent.name || ""));
    if (aid === name || aname === name || lower(aid) === clean || lower(aname) === clean) return agent;
  }
  if (clean === "general-purpose" || clean === "general_purpose") return { ...GENERAL_PURPOSE_FALLBACK, tools: ["*"] };
  if (clean === "explore") return { ...EXPLORE_FALLBACK, tools: [...EXPLORE_FALLBACK.tools as string[]] };
  return null;
}

/** Python `agent_tool_allowlist`: null inherits; unknown entries never grant. `known` is the live tool names. */
export function agentToolAllowlist(agent: unknown, known: Iterable<string>, alias: (name: string) => string = (name) => name): Set<string> | null {
  if (!isDict(agent) || !("tools" in agent) || agent.tools === null || agent.tools === undefined) return null;
  const values = agent.tools;
  if (!Array.isArray(values)) return new Set();
  if (values.some((value) => typeof value === "string" && pyStrip(value) === "*")) return null;
  const names = new Set(known);
  const byLower = new Map([...names].map((name) => [lower(name), name]));
  const result = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const v = pyStrip(value); const aliased = alias(v);
    if (names.has(v)) result.add(v);
    else if (aliased !== v && names.has(aliased)) result.add(aliased);
    else if (byLower.has(lower(v))) result.add(byLower.get(lower(v))!);
    else if (lower(v) === "websearch" && names.has("web_search")) result.add("web_search");
  }
  return result;
}

/** Python `normalize_disallowed_tools`: rule arguments stripped, both cases kept. */
export function normalizeDisallowedTools(disallowed: unknown): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(disallowed) && !(disallowed instanceof Set)) return out;
  for (const item of disallowed) {
    if (typeof item !== "string") continue;
    const trimmed = pyStrip(item);
    if (!trimmed) continue;
    const paren = trimmed.indexOf("(");
    const base = paren > 0 ? pyStrip(trimmed.slice(0, paren)) : trimmed;
    if (!base) continue;
    out.add(base); out.add(lower(base));
    if (lower(base) === "websearch") out.add("web_search");
  }
  return out;
}

/** The disallowed list a definition carries (`disallowedTools`, Python's fallback `disallowed_tools`). */
export const agentDisallowed = (agent: unknown): Set<string> =>
  isDict(agent) ? normalizeDisallowedTools(pyTruthy(agent.disallowedTools) ? agent.disallowedTools : pyTruthy(agent.disallowed_tools) ? agent.disallowed_tools : []) : new Set();

/** Python `_agent_prompt_text`: `systemPrompt` → `prompt` → `description`. */
export function agentPromptText(agent: unknown): string {
  if (!isDict(agent)) return "";
  for (const key of PROMPT_KEYS) { const value = agent[key]; if (typeof value === "string" && pyStrip(value)) return pyStrip(value); }
  return "";
}

/** Python `build_system_prompt`. */
export function buildSystemPrompt(agent: unknown, baseSystem: unknown): string {
  const base = typeof baseSystem === "string" ? baseSystem : "";
  const text = agentPromptText(agent);
  return text ? clip(base + PROMPT_SEPARATOR + text, PROMPT_MAX_CHARS) : base;
}
