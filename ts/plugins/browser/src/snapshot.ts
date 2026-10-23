/**
 * Bounded formatting for the browser accessibility snapshot: a port of
 * `bundled_plugins/browser/snapshot.py` (`format_snapshot`). The worker already
 * narrows Playwright's AI-mode aria JSON; this is the boundary the model sees.
 * Role, accessible name, indentation and interactable refs are kept; node and
 * character truncation is marked. Nothing here launches a browser or runs page script.
 */
import { pyJsonDumps, pyLen, pySlice, pyStrip } from "@xueness/contracts";

// Keep these numeric caps identical to the SNAPSHOT_MAX_* constants in bridge.mjs.
export const MAX_SNAPSHOT_NODES = 200;
export const MAX_SNAPSHOT_DEPTH = 24;
export const MAX_SNAPSHOT_NAME = 120;
export const MAX_SNAPSHOT_CHARS = 12_000;
export const MAX_SNAPSHOT_SCAN = 5000;

const ROLE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
// Python's `\d` on str is any Unicode decimal digit (category Nd).
const REF = /^(?:f\p{Nd}+)?e\p{Nd}+$/u;
// Python's `\s` on str: ASCII whitespace plus every str.isspace() character (no U+FEFF, unlike JS).
const SPACE_RUN = /[\t\n\v\f\r \x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/g;

type Node = Record<string, unknown>;
export interface FormattedSnapshot { tree: string; nodeCount: number; totalNodes: number; truncated: boolean; charTruncated: boolean }

const isDict = (value: unknown): value is Node => typeof value === "object" && value !== null && !Array.isArray(value);
const isPyInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);

function asNode(value: unknown): Node | null {
  if (typeof value === "string") return pyStrip(value) ? { role: "text", name: value } : null;
  return isDict(value) ? value : null;
}

function pushChildren(stack: [Node, number][], children: unknown[], depth: number): void {
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const node = asNode(children[index]);
    if (node) stack.push([node, depth]);
  }
}

function cleanName(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  return pySlice(pyStrip(pySlice(value, 2000).replace(SPACE_RUN, " ")), MAX_SNAPSHOT_NAME);
}

function roleAndName(node: Node): [string, string] {
  const role = typeof node.role === "string" && ROLE.test(node.role) ? node.role : "";
  let name = cleanName(node.name);
  if (!name && role === "text") name = cleanName(node.text);
  return [role, name];
}

function render(role: string, name: string, node: Node, depth: number): string {
  let head = role;
  if (name) head += " " + pyJsonDumps(name);
  const flags: string[] = [];
  if (typeof node.ref === "string" && REF.test(node.ref)) flags.push("ref=" + node.ref);
  if (node.disabled === true) flags.push("disabled");
  if (node.checked === true) flags.push("checked");
  else if (node.checked === "mixed") flags.push("checked=mixed");
  if (isPyInt(node.level) && node.level >= 1 && node.level <= 9) flags.push("level=" + String(node.level));
  head += flags.map((flag) => " [" + flag + "]").join("");
  return "  ".repeat(depth) + "- " + head;
}

function marker(nodeTruncated: boolean, charTruncated: boolean, kept: number, seen: number, scanHit: boolean): string {
  const parts: string[] = [];
  if (nodeTruncated) parts.push("node limit");
  if (charTruncated) parts.push("character limit");
  const label = parts.join(", ") || "limit";
  if (nodeTruncated && seen > kept) return `[truncated: ${label}, kept ${kept} of ${scanHit ? "at least " + seen : String(seen)}]`;
  return `[truncated: ${label}]`;
}

function withMarker(lines: string[], nodeTruncated: boolean, charTruncated: boolean, seen: number, scanHit: boolean): [string, number, boolean] {
  if (!nodeTruncated && !charTruncated) return [lines.join("\n"), lines.length, false];
  for (;;) {
    const mark = marker(nodeTruncated, charTruncated, lines.length, seen, scanHit);
    const tree = [...lines, mark].join("\n");
    if (pyLen(tree) <= MAX_SNAPSHOT_CHARS) return [tree, lines.length, charTruncated];
    if (!lines.length) return [pySlice(mark, MAX_SNAPSHOT_CHARS), 0, true];
    lines.pop();
    charTruncated = true;
    nodeTruncated = true;
  }
}

/** A bounded indented tree for one untrusted aria-node list; anything but a list is rejected. */
export function formatSnapshot(nodes: unknown, options: { reportedTotal?: unknown; reportedTruncated?: boolean } = {}): FormattedSnapshot {
  if (!Array.isArray(nodes)) throw Object.assign(new Error("invalid snapshot"), { code: "invalid_argument" });
  const lines: string[] = [];
  let used = 0, kept = 0, seen = 0, walked = 0;
  let nodeTruncated = false, charTruncated = false, scanHit = false;
  const stack: [Node, number][] = [];
  pushChildren(stack, nodes, 0);
  while (stack.length) {
    if (walked >= MAX_SNAPSHOT_SCAN) { scanHit = true; nodeTruncated = true; break; }
    const [node, depth] = stack.pop()!;
    walked += 1;
    const [role, name] = roleAndName(node);
    const children = Array.isArray(node.children) ? node.children as unknown[] : [];
    if (!role || (role === "text" && !name)) {
      // A junk wrapper or blank text node is not a row: unwrap one level, without spending the budget.
      if (children.length && depth < MAX_SNAPSHOT_DEPTH) pushChildren(stack, children, depth);
      else if (children.length) nodeTruncated = true;
      continue;
    }
    seen += 1;
    if (depth > MAX_SNAPSHOT_DEPTH || kept >= MAX_SNAPSHOT_NODES || charTruncated) nodeTruncated = true;
    else {
      const line = render(role, name, node, depth);
      const extra = pyLen(line) + (lines.length ? 1 : 0);
      if (used + extra > MAX_SNAPSHOT_CHARS) { charTruncated = true; nodeTruncated = true; }
      else { lines.push(line); used += extra; kept += 1; }
    }
    if (!children.length) continue;
    if (depth >= MAX_SNAPSHOT_DEPTH) { nodeTruncated = true; continue; }
    // Past the node or character budget, keep walking only to count rows.
    pushChildren(stack, children, depth + 1);
  }
  const total = options.reportedTotal;
  if (isPyInt(total) && total >= 0 && total <= MAX_SNAPSHOT_SCAN && total > seen) seen = total;
  if (options.reportedTruncated || seen > kept) nodeTruncated = true;
  const [tree, count, chars] = withMarker(lines, nodeTruncated, charTruncated, seen, scanHit);
  return { tree, nodeCount: count, totalNodes: seen, truncated: nodeTruncated || chars, charTruncated: chars };
}
