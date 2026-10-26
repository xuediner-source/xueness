/**
 * F08.01 — deepened agent configuration and context inheritance.
 *
 * Three pure rule sets every child run is built from, so a child role can
 * only ever narrow what its parent declared:
 *
 * - `branchHistory`: the bounded, sanitized copy of the parent's transcript a
 *   child may inherit (`task` with `inherit_history: true`). The parent's own
 *   journal is never touched — the branch is fresh objects, the child's
 *   `delegation.contextInherited` records what it got.
 * - `childToolGrant`: the child's tool set is the profile's allowlist
 *   intersected with the parent's live tools and minus every denial (the
 *   child-forced, durable-workflow and parent-run exclusions). A child can
 *   never receive a tool its parent did not offer or was denied.
 * - `clampModelSelection`: a definition's model override only applies inside
 *   the parent's allowed models; anything wider falls back to the parent's
 *   selection instead of escalating.
 */
import { isDict, pyJsonDumps, pyJsonLoads, pyLen, pyStrip } from "@xueness/contracts";
import { agentToolAllowlist, normalizeDisallowedTools, type Row } from "./definitions.ts";
import { CHILD_FORCED_DISALLOWED } from "./profiles.ts";

export const INHERIT_HISTORY_MAX_MESSAGES = 20;
export const INHERIT_HISTORY_MAX_CHARS = 12000;
export const INHERITED_SOURCE = "inherited_history";

const clone = (value: Row): Row => pyJsonLoads(pyJsonDumps(value), { lossless: true }) as Row;
const contentChars = (message: Row): number => {
  const content = message.content;
  if (typeof content === "string") return pyLen(content);
  if (Array.isArray(content)) return content.reduce((total, part) => total + (isDict(part) && typeof part.text === "string" ? pyLen(part.text) : 0), 0);
  return 0;
};

/**
 * The parent messages a child may see: plain user/assistant turns only.
 * Excluded: the system prompt, guide inputs, hidden background notices,
 * metadata-injected reminders and assistant turns that are pure tool calls.
 */
export function inheritableParentMessages(parent: unknown): Row[] {
  const messages = isDict(parent) && Array.isArray(parent.messages) ? parent.messages : [];
  const keep: Row[] = [];
  for (const raw of messages) {
    if (!isDict(raw)) continue;
    if (raw.role !== "user" && raw.role !== "assistant") continue;
    // The extension's agent-type listing and the background receipts are
    // request-time reminders, not dialogue the child should inherit.
    if (raw._input_kind === "guide" || raw._background_task_notice !== undefined || raw._meta_source === "agent_listing_delta" || raw._meta_source === "task_status") continue;
    if (raw.role === "assistant" && Array.isArray(raw.tool_calls) && raw.tool_calls.length && !raw.content) continue;
    if ((raw.role === "user" || raw.role === "assistant") && contentChars(raw) === 0 && !Array.isArray(raw.tool_calls)) continue;
    keep.push(clone(raw));
  }
  return keep;
}

/** The bounded branch: the newest inheritable turns, in chronological order. */
export function branchHistory(parent: unknown, limits: { maxMessages?: number; maxChars?: number } = {}): { messages: Row[]; truncated: boolean; chars: number } {
  const maxMessages = limits.maxMessages ?? INHERIT_HISTORY_MAX_MESSAGES;
  const maxChars = limits.maxChars ?? INHERIT_HISTORY_MAX_CHARS;
  const candidates = inheritableParentMessages(parent);
  const kept: Row[] = [];
  let chars = 0;
  let truncated = false;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const message = candidates[index]!;
    const size = contentChars(message);
    if (kept.length >= maxMessages || (chars + size > maxChars && kept.length > 0)) { truncated = true; break; }
    kept.unshift(message);
    chars += size;
  }
  return { messages: kept, truncated, chars };
}

/**
 * Attach a branch to a fresh child: the inherited turns sit between the
 * system prompt and the task prompt, each marked with its inherited source so
 * the child can tell narration from its own assignment. Only the child row is
 * written; `contextInherited` and the counts land in its durable delegation.
 */
export function childWithInheritedHistory(child: Row, branch: { messages: Row[]; truncated?: boolean }): Row {
  if (!isDict(child) || !Array.isArray(child.messages)) throw new TypeError("child messages");
  if (!isDict(child.delegation)) throw new TypeError("delegation");
  const system = child.messages[0];
  const prefix = branch.messages.map((message) => ({ ...message, _meta_source: INHERITED_SOURCE }));
  child.messages = isDict(system) && system.role === "system" ? [system, ...prefix, ...child.messages.slice(1)] : [...prefix, ...child.messages];
  child.delegation.contextInherited = branch.messages.length > 0;
  child.delegation.inheritedMessages = branch.messages.length;
  if (branch.truncated) child.delegation.inheritedTruncated = true;
  return child;
}

const MODEL_KEYS = ["provider_id", "model", "reasoning_effort"] as const;

/**
 * A definition's model override within the parent's ceiling: `allowed` null
 * means unbounded (no configured ceiling). An override outside the ceiling —
 * or a partial override that would land on an unknown model — falls back to
 * the parent's own selection for that key. Pure: returns a fresh row.
 */
export function clampModelSelection(childSelection: Row, parentSelection: Row, allowed: readonly string[] | null): { selection: Row; clamped: string[] } {
  const parent = isDict(parentSelection) ? parentSelection : {};
  const base = isDict(childSelection) ? childSelection : {};
  const ceiling = allowed === null ? null : new Set(allowed);
  const out: Row = {};
  const clamped: string[] = [];
  for (const key of MODEL_KEYS) {
    const wanted = typeof base[key] === "string" ? (base[key] as string) : undefined;
    if (wanted === undefined) continue;
    if (ceiling === null || key !== "model" || ceiling.has(wanted)) { out[key] = wanted; continue; }
    clamped.push(key);
    if (typeof parent[key] === "string") out[key] = parent[key];
  }
  return { selection: out, clamped };
}

export interface ToolGrantInput {
  /** The profile's declared tools (`undefined`/`["*"]` inherits) and denials. */
  profile: { tools?: readonly string[] | null; disallowedTools?: readonly string[] | null };
  /** Every tool name the child runtime actually knows. */
  known: readonly string[];
  /** The parent's offered tools; null means the parent offered everything known. */
  parentAllowed?: readonly string[] | null;
  /** Tools the parent's own run was denied (the child never gets more). */
  parentDisallowed?: readonly string[];
  /** The host's additional durable exclusions, already in `known`'s name space. */
  forcedDenied?: readonly string[];
  /** Maps a declared tool name into `known`'s name space when they differ. */
  alias?: (name: string) => string;
}

/**
 * The child's effective tool set. Invariants: it is a subset of the parent's
 * offered tools (when declared), it intersects nothing denied, and an
 * inheriting profile (`tools` undefined or `["*"]`) gets exactly the parent's
 * set minus denials — never the raw universe.
 */
export function childToolGrant(input: ToolGrantInput): { effective: string[]; denied: string[]; inherits: boolean } {
  const universe = input.parentAllowed == null ? [...input.known] : input.known.filter((name) => input.parentAllowed!.includes(name));
  const alias = input.alias ?? ((name: string) => name);
  const denied = new Set<string>();
  for (const name of [...CHILD_FORCED_DISALLOWED, ...input.forcedDenied ?? [], ...input.parentDisallowed ?? []]) { denied.add(name); denied.add(name.toLowerCase()); }
  for (const name of normalizeDisallowedTools(input.profile.disallowedTools ?? [])) {
    denied.add(name);
    const mapped = alias(name);
    if (mapped !== name) { denied.add(mapped); denied.add(mapped.toLowerCase()); }
  }
  const allow = input.profile.tools == null ? null : agentToolAllowlist({ tools: [...input.profile.tools] }, universe, alias);
  const inherits = allow === null;
  const effective = new Set<string>(allow ?? universe);
  for (const name of [...effective]) {
    if (denied.has(name) || denied.has(name.toLowerCase())) effective.delete(name);
  }
  const sortNames = (names: string[]): string[] => [...new Set(names)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { effective: sortNames([...effective].filter((name) => universe.includes(name))), denied: sortNames([...denied].filter((name) => universe.includes(name))), inherits };
}
