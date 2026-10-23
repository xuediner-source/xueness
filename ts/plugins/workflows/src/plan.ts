/**
 * Plan validation and digests (Python `workflows.validate_plan`,
 * `workflow_plan_digest`, `workspace_fingerprint`). Plans are literal JSON
 * DAGs: command nodes run an approved argv, agent nodes a bounded prompt.
 */
import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readdirSync, readlinkSync, readSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { isDict, isPyIntValue, isPyNumeric, numericValue, pyFloatValue, pyJsonDumps, pyLen, pySlice, pyStr, pyStrip, PyValueError } from "@xueness/contracts";
import { pyCodeCompare, realish } from "@xueness/sessions";

export type Row = Record<string, unknown>;
export const ID = /^[a-f0-9]{32}$/;
export const NODE = /^[A-Za-z0-9_-]{1,64}$/;
export const ACTIVE: ReadonlySet<unknown> = new Set(["queued", "running", "stopping", "pausing"]);
const FINGERPRINT_FILE_LIMIT = 10_000;
const FINGERPRINT_BYTE_LIMIT = 256 * 1024 * 1024;
const NODE_FIELDS = new Set(["id", "needs", "kind", "argv", "prompt", "cwd", "timeout", "provider_id", "model", "writable", "phase"]);

export const nowSeconds = (): number => Date.now() / 1000;
/** `time.time()` as stored: always a float, like Python writes it. */
export const stamp = (): unknown => pyFloatValue(nowSeconds());
const fail = (message: string): never => { throw new PyValueError(message); };

/** `Path.resolve()`; a NUL byte is Python's `ValueError: embedded null byte`. */
export function resolvePath(path: string): string {
  if (path.includes("\0")) fail("embedded null byte");
  return realish(path);
}

export function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

/** `Path.is_relative_to` on resolved paths. */
export function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel));
}

function between(value: unknown, low: number, high: number, lowInclusive = true): boolean {
  const number = numericValue(value);
  return number !== null && (lowInclusive ? number >= low : number > low) && number <= high;
}

export function validatePlan(value: unknown, rootPath: string): Row {
  const root = resolvePath(rootPath);
  if (!isDict(value) || Object.keys(value).some((key) => !["name", "nodes", "concurrency"].includes(key))) fail("plan fields: name, nodes, concurrency");
  const plan = value as Row;
  const nodes = Object.hasOwn(plan, "nodes") ? plan.nodes : null;
  const concurrency = Object.hasOwn(plan, "concurrency") ? plan.concurrency : 2;
  if (!isPyIntValue(concurrency) || !between(concurrency, 1, 8)) fail("concurrency must be 1..8");
  if (!Array.isArray(nodes) || nodes.length < 1 || nodes.length > 64) fail("nodes must contain 1..64 entries");
  const clean: Row[] = [], ids = new Set<string>();
  for (const node of nodes as unknown[]) {
    if (!isDict(node) || Object.keys(node).some((key) => !NODE_FIELDS.has(key))) fail("invalid node fields");
    const row = node as Row;
    const get = (key: string, fallback: unknown): unknown => Object.hasOwn(row, key) ? row[key] : fallback;
    const name = get("id", null);
    if (typeof name !== "string" || !NODE.test(name) || ids.has(name)) fail("node ids must be unique names");
    ids.add(name as string);
    const kind = get("kind", "command");
    if (kind !== "command" && kind !== "agent") fail("kind must be command or agent");
    const needs = get("needs", []);
    if (!Array.isArray(needs) || needs.some((item) => typeof item !== "string") || new Set(needs).size !== needs.length) fail("needs must be unique node ids");
    const cwdValue = get("cwd", ".");
    if (typeof cwdValue !== "string") fail("node cwd must be a string");
    const cwd = resolvePath(resolve(root, cwdValue as string));
    if (!isInside(root, cwd) || !isDirectory(cwd)) fail("node cwd must be an existing directory inside root");
    const timeout = get("timeout", 300);
    if (typeof timeout === "boolean" || !isPyNumeric(timeout) || !between(timeout, 0, 3600, false)) fail("node timeout must be 0..3600 seconds");
    const out: Row = { ...row };
    out.kind = kind; out.needs = needs; out.cwd = relative(root, cwd) || "."; out.timeout = timeout;
    if (kind === "command") {
      const argv = row.argv;
      if (!Array.isArray(argv) || !argv.length || argv.length > 128 || argv.some((item) => typeof item !== "string" || item.includes("\0") || pyLen(item) > 16000) || !argv[0]) fail("command argv must be a nonempty string array");
    } else if (typeof row.prompt !== "string" || pyLen(row.prompt) < 1 || pyLen(row.prompt) > 5000) fail("agent prompt must be 1..5000 characters");
    if (Object.hasOwn(row, "writable") && (typeof row.writable !== "boolean" || kind !== "agent")) fail("writable is an explicit boolean opt-in for agent nodes only");
    if (Object.hasOwn(row, "phase") && (typeof row.phase !== "string" || !pyStrip(row.phase) || pyLen(row.phase) > 120)) fail("phase must be a nonempty title up to 120 characters");
    for (const key of ["provider_id", "model"]) {
      if (Object.hasOwn(row, key) && (typeof row[key] !== "string" || !row[key] || pyLen(row[key] as string) > 200)) fail("invalid model selection");
    }
    clean.push(out);
  }
  const done = new Set<string>();
  while (done.size < ids.size) {
    const ready = clean.filter((node) => !done.has(node.id as string) && (node.needs as string[]).every((need) => done.has(need))).map((node) => node.id as string);
    if (!ready.length) fail("dependency cycle or unknown dependency");
    for (const id of ready) done.add(id);
  }
  return { name: pySlice(pyStr(Object.hasOwn(plan, "name") ? plan.name : "Workflow"), 120), nodes: clean, concurrency };
}

/** sha256 of the compact, key-sorted `{root, plan}` JSON. */
export function workflowPlanDigest(record: Row): string {
  const body = pyJsonDumps({ root: record.root, plan: record.plan }, { sortKeys: true, ensureAscii: false, separators: [",", ":"] });
  return createHash("sha256").update(body, "utf8").digest("hex");
}

function isDirFollowing(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

/**
 * Hash every workspace file for conservative result reuse. A tree that is too
 * large, or a file that changes while it is read, disables reuse (null).
 */
export function workspaceFingerprint(rootPath: string, stateDir?: string): string | null {
  const root = resolvePath(rootPath);
  const ignored = stateDir === undefined ? null : resolvePath(stateDir);
  const digest = createHash("sha256");
  let count = 0, total = 0;
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  const walk = (current: string): boolean => {
    let entries: string[];
    try { entries = readdirSync(current); } catch { return true; }
    const dirs: string[] = [], files: string[] = [];
    for (const name of entries) (isDirFollowing(join(current, name)) ? dirs : files).push(name);
    const keptDirs = dirs.filter((name) => name !== ".git" && (ignored === null || resolvePath(join(current, name)) !== ignored)).sort(pyCodeCompare);
    for (const name of [...keptDirs, ...files].sort(pyCodeCompare)) {
      const path = join(current, name);
      if (ignored !== null && resolvePath(path) === ignored) continue;
      const rel = relative(root, path).split(sep).join("/");
      const info = lstatSync(path, { bigint: true });
      digest.update(Buffer.concat([Buffer.from(rel, "utf8"), Buffer.from([0])]));
      if (info.isSymbolicLink()) { digest.update(Buffer.concat([Buffer.from("L"), Buffer.from(readlinkSync(path), "utf8")])); continue; }
      if (!isRegularFollowing(path)) { digest.update("D"); continue; }
      count += 1; total += Number(info.size);
      if (count > FINGERPRINT_FILE_LIMIT || total > FINGERPRINT_BYTE_LIMIT) return false;
      digest.update(`F:${info.size}:${info.mtimeNs}:${Number(info.mode & 0o777n)}\0`);
      const fd = openSync(path, "r");
      try { for (let read = readSync(fd, chunk); read > 0; read = readSync(fd, chunk)) digest.update(chunk.subarray(0, read)); }
      finally { closeSync(fd); }
      if (statSync(path, { bigint: true }).mtimeNs !== info.mtimeNs) return false;
    }
    for (const name of keptDirs) {
      const path = join(current, name);
      if (!lstatSync(path).isSymbolicLink() && !walk(path)) return false;
    }
    return true;
  };
  try { return walk(root) ? digest.digest("hex") : null; }
  catch { return null; }
}

function isRegularFollowing(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}
