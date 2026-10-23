/**
 * Permission rules: `Tool` or `Tool(specifier)`.
 *
 * The tool part is a tool name (`exec`, `write`, `mcp__github__create_issue`)
 * or a Gate kind, and may end in `*` (`mcp__github__*`); `*` alone is any
 * tool. `read(…)` also covers list, glob and grep, and `edit(…)` also covers
 * write: the file-reading and file-changing families.
 *
 * The specifier is read according to the subject:
 * - command: `npm test` (exact), `npm run test:*` or `git log *` (that
 *   command with any further arguments), other `*` match any text. It is
 *   matched against each simple command of a line, never the whole line.
 * - path: a glob relative to the workspace (`src/**`, `*.md`, `/build/**`;
 *   a leading `/` anchors at the workspace root, a pattern without `/`
 *   matches at any depth, and one naming a directory covers its contents).
 * - text: `*` wildcards over the subject, or `domain:example.com` for URLs
 *   (that host or a subdomain).
 * `Tool(*)` is the same as `Tool`.
 */
import { compileGlob } from "@xueness/engine-tools";
import { commandSubjects, matchesInvocationRule, ruleNeedle } from "./bash-rules.ts";
import { flattenShell, parseShell, shellScript } from "./shell-parse.ts";
import { unwrapCommand } from "./readonly.ts";

export type SubjectKind = "command" | "path" | "text";

export interface PermissionRule {
  /** Canonical text, e.g. `exec(git log *)`. */
  readonly text: string;
  readonly tool: string;
  readonly specifier: string | null;
}

export class RuleSyntaxError extends Error {
  override name = "RuleSyntaxError";
  readonly code = "invalid_rule";
}

const RULE = /^([a-z*][a-z0-9_]*\*?)(?:\(([\s\S]*)\))?$/;
const FAMILIES: Record<string, readonly string[]> = { read: ["read", "list", "glob", "grep"], edit: ["edit", "write"] };

/** Parse one rule; throws RuleSyntaxError. */
export function parseRule(text: string): PermissionRule {
  if (typeof text !== "string") throw new RuleSyntaxError("a permission rule must be a string");
  const match = RULE.exec(text.trim());
  if (!match || (match[1] as string).slice(0, -1).includes("*")) {
    throw new RuleSyntaxError(`invalid permission rule ${JSON.stringify(text)}: expected Tool or Tool(specifier), * only at the end of the tool name`);
  }
  const tool = match[1] as string;
  let specifier = match[2] === undefined ? null : (match[2] as string).trim();
  if (specifier === "" || specifier === "*") specifier = null;
  if (specifier !== null && specifier.length > 2000) throw new RuleSyntaxError("a rule specifier is limited to 2000 characters");
  return Object.freeze({ text: specifier === null ? tool : `${tool}(${specifier})`, tool, specifier });
}

/** Parse a rule list, collecting problems instead of throwing (for settings validation). */
export function parseRules(texts: readonly unknown[]): { rules: PermissionRule[]; issues: string[] } {
  const rules: PermissionRule[] = [];
  const issues: string[] = [];
  for (const [index, text] of texts.entries()) {
    try {
      rules.push(parseRule(text as string));
    } catch (error) {
      issues.push(`[${index}] ${(error as Error).message}`);
    }
  }
  return { rules, issues };
}

/** Does the rule's tool part name this tool (by name, Gate kind or family)? */
export function ruleCoversTool(rule: PermissionRule, tool: string, kind: string): boolean {
  if (rule.tool === "*") return true;
  if (rule.tool.endsWith("*")) return tool.startsWith(rule.tool.slice(0, -1));
  return rule.tool === tool || rule.tool === kind || (FAMILIES[rule.tool]?.includes(kind) ?? false);
}

function escapeRegex(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

function wildcard(text: string): string {
  return text.split("*").map(escapeRegex).join(".*");
}

const commandPatterns = new Map<string, RegExp>();

/** The words a command pattern stands for, or null when it is not one simple command. */
function patternRegex(pattern: string): RegExp | null {
  const cached = commandPatterns.get(pattern);
  if (cached) return cached;
  let body = pattern.trim();
  let prefix = false;
  if (body.endsWith(":*") || body === "*" || body.endsWith(" *")) {
    prefix = true;
    body = body.slice(0, body === "*" ? 0 : -2).trimEnd();
  }
  const parsed = parseShell(body);
  if (parsed.unsafe.length || parsed.commands.length > 1) return null;
  const words = parsed.commands[0]?.words ?? [];
  const source = wildcard(words.join(" "));
  const regex = new RegExp(prefix ? (source ? `^${source}(?: [\\s\\S]*)?$` : "^[\\s\\S]*$") : `^${source}$`);
  if (commandPatterns.size > 1000) commandPatterns.clear();
  commandPatterns.set(pattern, regex);
  return regex;
}

/** Problems with a rule's specifier for a subject kind (e.g. a command pattern with `&&`). */
export function specifierIssue(rule: PermissionRule, kind: SubjectKind): string | null {
  if (rule.specifier === null || kind !== "command") return null;
  return patternRegex(rule.specifier) ? null : `${rule.text}: a command pattern must be one simple command without expansions; write one rule per command`;
}

/** Does a command pattern match these words (also through timeout/nice/nohup/time/stdbuf)? */
export function commandMatches(pattern: string, words: readonly string[]): boolean {
  if (!patternRegex(pattern)) return false;
  const needle = ruleNeedle(pattern);
  return commandSubjects(words).some((subject) => matchesInvocationRule(subject, needle));
}

/** Workspace-relative path glob; a leading `/` anchors at the workspace root. */
export function pathMatches(pattern: string, path: string): boolean {
  if (pattern.startsWith("~") || pattern.startsWith("//")) return false;
  const normalized = path === "." ? "" : path.replace(/^\.\//, "");
  const trimmed = pattern.replace(/\/+$/, "");
  const last = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  try {
    if (compileGlob(pattern, { backslashEscapes: true }).test(normalized)) return true;
    // `src`, `/build` and `docs/` name directories: they also cover what is inside.
    if (!last || /[*?[{]/.test(last)) return false;
    return compileGlob(trimmed.includes("/") ? `${trimmed}/**` : `**/${trimmed}/**`, { backslashEscapes: true }).test(normalized);
  } catch {
    return false;
  }
}

export function textMatches(pattern: string, subject: string): boolean {
  if (pattern.startsWith("domain:")) {
    const domain = pattern.slice("domain:".length).toLowerCase().replace(/^\*\./, "");
    let host: string;
    try {
      host = new URL(subject).hostname.toLowerCase();
    } catch {
      return false;
    }
    return host === domain || host.endsWith(`.${domain}`);
  }
  return new RegExp(`^${wildcard(pattern)}$`).test(subject);
}

/**
 * Every command a line can run, for deny and ask rules: nested ones, wrapped
 * ones (`env`, `sudo`, `xargs`, `find -exec`, `eval`, `bash -c`) and
 * programs by path (`/bin/rm` is also checked as `rm`). Over-inclusive on
 * purpose, and still best effort: a script file can run anything.
 */
export function commandsForDeny(line: string): string[][] {
  const result: string[][] = [];
  const queue: (readonly string[])[] = flattenShell(line).commands.map((command) => command.words);
  const seen = new Set<string>();
  while (queue.length && result.length < 256) {
    const words = queue.shift() as readonly string[];
    const key = words.join("\0");
    if (!words.length || seen.has(key)) continue;
    seen.add(key);
    result.push([...words]);
    const head = words[0] as string;
    if (head.includes("/")) queue.push([head.replace(/^.*\//, ""), ...words.slice(1)]);
    const inner = unwrapCommand(words);
    if (inner) queue.push(inner);
    const script = shellScript(words);
    if (script !== null) queue.push(...flattenShell(script, 1).commands.map((command) => command.words));
    queue.push(...runs(words));
  }
  return result;
}

/** Commands a runner may start with its arguments. */
function runs(words: readonly string[]): (readonly string[])[] {
  const [head = "", ...rest] = words;
  if (head === "exec" || head === "command" || head === "builtin") {
    return /^-[vV]$/.test(rest[0] ?? "") ? [] : [rest.filter((word, index) => index > 0 || !word.startsWith("-"))];
  }
  if (["env", "sudo", "doas", "xargs", "nohup", "setsid", "chroot", "flock", "watch", "parallel"].includes(head)) {
    // Option values are not told apart from commands, so try every word that could start one.
    return rest.flatMap((word, index) => (word.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word) ? [] : [rest.slice(index)]));
  }
  if (head === "eval") return flattenShell(rest.join(" "), 1).commands.map((command) => command.words);
  const exec = head === "find" ? /^-(?:exec|execdir|ok|okdir)$/ : head === "fd" || head === "fdfind" ? /^(?:-x|-X|--exec|--exec-batch)$/ : null;
  if (!exec) return [];
  const found: string[][] = [];
  rest.forEach((word, index) => {
    if (!exec.test(word)) return;
    const end = rest.findIndex((item, at) => at > index && (item === ";" || item === "+"));
    found.push(rest.slice(index + 1, end < 0 ? undefined : end));
  });
  return found;
}

/** Does a rule match this request's subject? (The tool part is checked by `ruleCoversTool`.) */
export function subjectMatches(rule: PermissionRule, kind: SubjectKind, subject: string, words?: readonly string[]): boolean {
  if (rule.specifier === null) return true;
  if (kind === "command") return words ? commandMatches(rule.specifier, words) : false;
  if (kind === "path") return pathMatches(rule.specifier, subject);
  return textMatches(rule.specifier, subject);
}
