/**
 * Rules offered for "always allow" when a call asks: exact ones for this
 * call, and broad ones (the program and its subcommand, the directory, the
 * tool, the domain). The user picks; nothing is remembered on its own.
 */
import { shellQuote } from "@xueness/engine-tools";
import { EDIT_KINDS, type PermissionRequest, type RememberOptions } from "./decision.ts";
import { unwrapCommand } from "./readonly.ts";

/** Programs whose second word picks what runs (`git push`, `npm test`, `node build.js`). */
const SUBCOMMANDS = new Set([
  "git", "npm", "pnpm", "yarn", "bun", "npx", "cargo", "go", "docker", "kubectl", "gh", "pip", "pip3", "uv", "poetry", "dotnet",
  "make", "node", "python", "python3", "deno", "ruby", "bundle", "rake", "mvn", "gradle", "terraform", "helm", "brew",
]);

/** Interpreters: `node build.js *` is fine to offer, `node *` or `python -c *` is not. */
const INTERPRETERS = new Set(["node", "python", "python3", "ruby", "perl", "php", "deno", "bun"]);
/** Programs that run whatever they are given: only the exact command is offered. */
const RUNNERS = new Set([
  "sh", "bash", "zsh", "dash", "ksh", "fish", "env", "sudo", "doas", "su", "xargs", "eval", "exec", "command", "builtin", "ssh",
  "find", "fd", "fdfind", "watch", "parallel", "setsid", "chroot", "flock", "awk", "gawk", "osascript", "powershell", "pwsh", "cmd",
]);

/** The wider pattern for one command, or its exact words when widening would allow running anything. */
function broadCommand(words: readonly string[]): string {
  let inner: readonly string[] = words;
  for (let next = unwrapCommand(inner); next?.length; next = unwrapCommand(inner)) inner = next;
  const [program = "", second, third] = inner;
  const exact = words.map(shellQuote).join(" ");
  if (RUNNERS.has(program.replace(/^.*\//, "")) || program.includes("/")) return exact;
  const operand = second !== undefined && !second.startsWith("-");
  if (INTERPRETERS.has(program) && !operand) return exact;
  const head = !SUBCOMMANDS.has(program) || !operand ? [program]
    : second === "run" && third !== undefined && !third.startsWith("-") ? [program, second, third] : [program, second as string];
  return `${head.map(shellQuote).join(" ")} *`;
}

const escapeGlob = (path: string): string => path.replace(/[*?[\]{}\\]/g, "\\$&");
const unique = (items: string[]): string[] => [...new Set(items)];

/**
 * `open` holds the words of each command of the line that nothing allows yet;
 * null when no rule could ever allow the line (expansions, assignments, writing
 * redirections).
 */
export function suggestRules(request: PermissionRequest, open: readonly (readonly string[])[] | null): RememberOptions | null {
  const { tool, kind, subject, subjectKind } = request;
  let exact: string[];
  let broad: string[];
  if (subjectKind === "command") {
    if (!open?.length) return null;
    exact = open.map((words) => `${tool}(${words.map(shellQuote).join(" ")})`);
    broad = open.map((words) => `${tool}(${broadCommand(words)})`);
  } else if (subjectKind === "path") {
    const family = EDIT_KINDS.has(kind) ? "edit" : tool;
    const slash = subject.lastIndexOf("/");
    exact = [`${family}(${slash < 0 ? "/" : ""}${escapeGlob(subject)})`];
    broad = slash > 0 ? [`${family}(${escapeGlob(subject.slice(0, slash))}/**)`] : [];
  } else {
    exact = subject && !subject.includes("*") && subject.length <= 2000 ? [`${tool}(${subject})`] : [];
    let host = "";
    try {
      host = kind === "web_fetch" ? new URL(subject).hostname : "";
    } catch {
      host = "";
    }
    broad = [host ? `${tool}(domain:${host})` : tool];
  }
  return exact.length || broad.length ? { exact: unique(exact), broad: unique(broad) } : null;
}
