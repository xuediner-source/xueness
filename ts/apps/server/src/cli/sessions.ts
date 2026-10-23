/**
 * Session commands (`sessions/cli.py` new/list/show/journal/answer and
 * `sessions/operator_cli.py` for the `sessions` group).
 */
import { closeSync, existsSync, fstatSync, linkSync, mkdirSync, openSync, readSync, realpathSync, statSync, unlinkSync, writeSync, fsyncSync, chmodSync, constants } from "node:fs";
import { basename, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { answerSession } from "@xueness/agent";
import { isDict, JsonFloat, pyJsonDumps, pyJsonLoads, pyLen, pySlice } from "@xueness/contracts";
import { archiveSession, CompactError, compactLeased, forkAtCheckpoint, forkTurn, importPortable, legacyEvents, listArchived, listSummaries, pinSession, portablePayload, renameSession, restoreSession, validateTitle } from "@xueness/plugin-sessions";
import { isLink, pyExceptionName, type SessionStore } from "@xueness/sessions";
import type { Parser } from "./argparse.ts";
import { dumps, err, errorText, out, type Cli } from "./host.ts";
import { renderEvent } from "./render.ts";

type Row = Record<string, any>;
const MAX_PORTABLE_BYTES = 4 * 1024 * 1024;

export function register(sub: ReturnType<Parser["subparsers"]>): void {
  sub.add("new", "create task and session").add("task").add("--root", { required: true });
  sub.add("list", "list local sessions (always JSON output)");
  sub.add("journal", "export the full session journal (contains prompts/tool output: keep private)").add("id");
  sub.add("answer", "answer an awaiting_user question; session becomes paused").add("id").add("text");
  sub.add("show", "show one session without full journal").add("id").add("--timeline", { action: "store_true", help: "append the derived event timeline (same vocabulary as the web view)" });
  const group = sub.add("sessions", "search, rename, pin, archive and restore sessions").subparsers("action", true);
  group.add("list").add("--archived", { action: "store_true" }).add("--root").add("--search", { default: "" });
  for (const action of ["rename", "pin", "unpin", "archive", "restore"]) { const p = group.add(action).add("id"); if (action === "rename") p.add("title"); }
  group.add("compact", "bound the prompt view now, without a model call").add("id").add("--instructions", { metavar: "TEXT", help: "what the compacted digest should keep in mind, at most 2000 characters" });
  group.add("export", "write a bounded redacted transcript into the local exports folder").add("id").add("--output", { help: "filename under <state>/exports (defaults to session id)" });
  group.add("import", "import a safe transcript as a new session").add("file").add("--root", { required: true, help: "existing workspace for the new session" });
  group.add("fork", "fork a session at a complete, safe user turn").add("id").add("--turn", { type: "int", help: "closed turn ordinal (defaults to latest safe turn)" }).add("--title", { help: "title for the forked session" });
  group.add("fork-checkpoint", "fork the turns before an automatic workspace checkpoint").add("id").add("--checkpoint", { help: "turn checkpoint id (git turn-checkpoints list)" })
    .add("--latest", { action: "store_true", help: "use the newest turn checkpoint" }).add("--turn", { type: "int", help: "fork before this turn's checkpoint" }).add("--title", { help: "title for the forked session" });
}

/** Python `os.stat().st_mtime`: seconds plus nanoseconds as one float. */
export function mtime(path: string): number {
  const ns = statSync(path, { bigint: true }).mtimeNs;
  return Number(ns / 1_000_000_000n) + Number(ns % 1_000_000_000n) * 1e-9;
}
const realish = (path: string): string => { try { return realpathSync(path); } catch { return resolve(path); } };

/** `operator_cli.list_sessions`: pinned first, then newest. */
export async function listSessions(store: SessionStore, options: { root?: string | null; search?: string; archived?: boolean } = {}): Promise<Row[]> {
  const items = options.archived ? listArchived(store) : await listSummaries(store);
  const source = options.archived ? join(store.directory, "deleted-sessions") : store.directory;
  const result: Row[] = [];
  for (const item of items as Row[]) {
    try {
      const file = join(source, item.id + ".json");
      const session = pyJsonLoads(readText(file)) as Row;
      if (options.root && realish(String(session.root)) !== realish(options.root)) continue;
      item.root = session.root;
      if (!(String(item.title ?? "") + " " + item.id).toLowerCase().includes((options.search ?? "").toLowerCase())) continue;
      item.updatedAt = mtime(file);
      result.push(item);
    } catch { continue; }
  }
  return result.sort((a, b) => Number(!a.pinned) - Number(!b.pinned) || b.updatedAt - a.updatedAt).map((item) => ({ ...item, updatedAt: new JsonFloat(item.updatedAt) }));
}

function readText(path: string, limit = 64 * 1024 * 1024): string {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!fstatSync(fd).isFile()) throw new Error("not a regular file");
    const buffer = Buffer.alloc(Math.min(limit + 1, Math.max(1, fstatSync(fd).size + 1)));
    let length = 0;
    for (let n = 1; n > 0 && length < buffer.length; length += n) n = readSync(fd, buffer, length, buffer.length - length, null);
    return buffer.subarray(0, length).toString("utf8");
  } finally { closeSync(fd); }
}

/** `_write_new`: a private file linked into place; an existing name is refused. */
function writeNew(path: string, content: Buffer): void {
  const parent = resolve(path, "..");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  try { chmodSync(parent, 0o700); } catch { /* best effort */ }
  if (isLink(path) || existsSync(path)) throw new Error("export destination already exists or is unsafe");
  const temporary = join(parent, ".xueness-export-" + randomBytes(6).toString("hex"));
  const fd = openSync(temporary, "wx", 0o600);
  try {
    try { writeSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
    try { linkSync(temporary, path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("export destination already exists"); throw error; }
  } finally { try { unlinkSync(temporary); } catch { /* gone */ } }
}

async function exportSession(store: SessionStore, sid: string, stateDir: string, filename: string | null): Promise<Row> {
  const name = filename || sid + ".xueness.json";
  if (!name || basename(name) !== name || name === "." || name === ".." || pyLen(name) > 160) throw new Error("export filename must be a single safe filename");
  const payload = await portablePayload(store, sid);
  const encoded = Buffer.from(pyJsonDumps(payload, { separators: [",", ":"] }), "utf8");
  if (encoded.length > MAX_PORTABLE_BYTES) throw new Error("redacted export exceeds size limit");
  const directory = join(realish(stateDir), "exports");
  if (isLink(directory)) throw new Error("exports directory must not be a symlink");
  const destination = join(directory, name);
  writeNew(destination, encoded);
  return { file: destination, bytes: encoded.length, messages: (payload.messages as unknown[]).length };
}

async function importSession(store: SessionStore, file: string, root: string): Promise<Row> {
  const base = realish(root);
  if (!existsSync(base) || !statSync(base).isDirectory()) throw new Error("import workspace must be an existing directory");
  if (isLink(file)) throw new Error("import file must not be a symlink");
  let raw: Buffer;
  try {
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (!fstatSync(fd).isFile()) throw new Error("import file must be a regular file");
      const buffer = Buffer.alloc(MAX_PORTABLE_BYTES + 1); let length = 0;
      for (let n = 1; n > 0 && length < buffer.length; length += n) n = readSync(fd, buffer, length, buffer.length - length, null);
      raw = buffer.subarray(0, length);
    } finally { closeSync(fd); }
  } catch (error) { if (errorText(error) === "import file must be a regular file") throw error; throw new Error("import file is not readable"); }
  if (raw.length > MAX_PORTABLE_BYTES) throw new Error("import file exceeds size limit");
  let data: unknown;
  try { data = pyJsonLoads(new TextDecoder("utf-8", { fatal: true }).decode(raw)); } catch { throw new Error("import file is not valid UTF-8 JSON"); }
  return importPortable(store, data, base);
}

async function group(cli: Cli): Promise<Row> {
  const args = cli.args, store = await cli.store();
  if (args.action === "export") return exportSession(store, args.id, cli.state, args.output);
  if (args.action === "compact") return compactLeased(store, args.id, args.instructions, { enabled: (id) => cli.enabled(id), source: "cli" });
  if (args.action === "import") return importSession(store, args.file, args.root);
  // CLI forks read the local journal directly: no web workspace allowlist (Python `enforce_workspace=False`).
  const forkContext = { store, stateDir: cli.state };
  if (args.action === "fork") return forkTurn(forkContext, args.id, { turn: args.turn, title: args.title });
  if (args.action === "fork-checkpoint") return forkAtCheckpoint(forkContext, args.id, { checkpoint: args.checkpoint, latest: args.latest, turn: args.turn, title: args.title });
  if (args.action === "list") return { sessions: await listSessions(store, { root: args.root, search: args.search, archived: args.archived }) };
  const lease = await store.lease(args.id);
  try {
    let s: Row;
    if (args.action === "rename") s = await renameSession(store, args.id, validateTitle(args.title));
    else if (args.action === "pin" || args.action === "unpin") s = await pinSession(store, args.id, args.action === "pin");
    else if (args.action === "archive") s = await archiveSession(store, args.id, cli.state);
    else s = await restoreSession(store, args.id);
    return { id: s.id, action: args.action };
  } finally { await lease.release(); }
}

export async function execute(cli: Cli): Promise<number | null> {
  const args = cli.args;
  if (args.cmd === "sessions") {
    try { out(dumps(await group(cli), 2)); return 0; }
    catch (error) {
      if (error instanceof CompactError) { out(dumps(error.payload(), 2)); return 1; }
      if (pyExceptionName(error) === "BlockingIOError") { err("ERROR: session is in use by another process"); return 1; }
      err("ERROR: " + errorText(error)); return 1;
    }
  }
  if (!["new", "list", "show", "answer", "journal"].includes(args.cmd)) return null;
  const store = await cli.store();
  if (args.cmd === "new") {
    const root = resolve(args.root);
    mkdirSync(root, { recursive: true });
    out(String((await store.new(args.task, root)).id));
    return 0;
  }
  if (args.cmd === "list") { out(dumps(await store.list(), 2)); return 0; }
  if (args.cmd === "show") {
    const s = await store.load(args.id) as Row;
    const tokenChars = pyLen(pyJsonDumps(s.messages || []));
    const summary: Row = {};
    for (const key of ["id", "task", "root", "status", "steps", "mode", "mode_history", "compactions", "completion", "todos", "pending_question"]) summary[key] = s[key] ?? null;
    Object.assign(summary, { title: pySlice(String(s.task || ""), 80), turnCount: s.steps ?? 0, tokenChars, estimatedTokens: Math.floor(tokenChars / 4) });
    out(dumps(summary, 2));
    if (args.timeline) {
      out("\n--- timeline ---");
      for (const event of legacyEvents(s)) renderEvent(event, { file: process.stdout, language: cli.language });
    }
    return 0;
  }
  if (args.cmd === "answer") {
    let s: Row;
    try {
      const lease = await store.lease(args.id);
      try { s = await answerSession(await store.load(args.id), store, args.text); } finally { await lease.release(); }
    } catch (error) {
      const name = pyExceptionName(error);
      if (name === "BlockingIOError") cli.error("session is in use by another process");
      if (name === "LookupError") cli.error("session is not awaiting a user answer");
      if ((error as { code?: unknown })?.code) throw error;
      if (isDict(error) || error instanceof Error) cli.error(errorText(error));
      throw error;
    }
    out(dumps({ id: s.id, status: s.status, pending_question: s.pending_question ?? null }, 2));
    return 0;
  }
  err("WARNING: full journal contains task text, tool output and model output. Keep it private.");
  out(dumps(await store.load(args.id), 2));
  return 0;
}
