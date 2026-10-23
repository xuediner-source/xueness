/** Machine-oriented one-shot session runner, sharing the native CLI agent path. */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { appendUserTurn, turnId } from "@xueness/agent";
import { isDict } from "@xueness/contracts";
import { pendingDenials, snapshot } from "@xueness/plugin-sessions";
import { enqueueAttachment, pyExceptionName, realish, type Attachment, type Session, type SessionStore } from "@xueness/sessions";
import type { Args, Parser } from "./argparse.ts";
import { applyTarget, addAgentFlags, agentHost, persistPermissionMode, prepareAgent, runAgent, type Prepared } from "./run.ts";
import { dumps, err, errorText, type Cli } from "./host.ts";
import { eventRenderer } from "./render.ts";
import { listSessions } from "./sessions.ts";

type Row = Record<string, any>;
export const HEADLESS_SCHEMA = "xueness.headless.v1";

export interface HeadlessRequest { kind: "new" | "resume" | "continue"; prompt: string | null; root: string | null; sessionId: string | null; attachments: string[] }

/** Validate the command's creation/resume modes independently of store access. */
export function headlessRequest(args: Args): HeadlessRequest {
  const prompt = typeof args.prompt === "string" ? args.prompt : null;
  const root = typeof args.root === "string" ? args.root : null;
  const sessionId = typeof args.resume_id === "string" ? args.resume_id : null;
  const hasSessionId = sessionId !== null;
  const continuing = args.continue_session === true;
  const attachments = Array.isArray(args.attach) ? args.attach.map(String) : [];
  if (hasSessionId && !sessionId) throw new Error("--resume requires a session id");
  if (hasSessionId && continuing) throw new Error("--resume and --continue are mutually exclusive");
  if (!hasSessionId && !continuing && prompt === null) throw new Error("headless needs --prompt TEXT --root DIR, --resume ID, or --continue --root DIR");
  if ((!hasSessionId || continuing) && !root) throw new Error("--root is required when creating a session or using --continue");
  if (attachments.length && prompt === null) throw new Error("--attach requires --prompt");
  return { kind: hasSessionId ? "resume" : continuing ? "continue" : "new", prompt, root, sessionId, attachments };
}

/** Final visible assistant body for the chosen turn; reasoning and tool calls stay private. */
export function assistantResultForTurn(session: Row, turn: string): string {
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const message = [...messages].reverse().find((item) => isDict(item) && item.role === "assistant" && item._turn_id === turn);
  if (Array.isArray(message?.tool_calls) && message.tool_calls.length) return "";
  return typeof message?.content === "string" ? message.content : "";
}

/** Stable JSON packet shared by json and stream-json output. */
export function resultEnvelope(session: Row, result: string): Row {
  return { schema: HEADLESS_SCHEMA, type: "result", sessionId: session.id, status: session.status, result, steps: session.steps ?? 0,
    mode: session.mode ?? "build", completion: session.completion ?? null, pending: pendingDenials(session as Session),
    pending_question: session.pending_question ?? null, usage: session.usage ?? session.provider_usage ?? null };
}

export function register(sub: ReturnType<Parser["subparsers"]>): void {
  const p = sub.add("headless", "run one task through the native agent and emit its final answer");
  p.add(["-p", "--prompt"], { help: "create a new task, or append one user message when resuming" })
    .add("--resume", { dest: "resume_id", metavar: "ID", help: "resume this session; optionally append --prompt" })
    .add("--continue", { dest: "continue_session", action: "store_true", help: "resume the latest non-archived session under --root" })
    .add("--root", { help: "workspace root for a new session or --continue; with --resume, optionally verify its root" })
    .add("--attach", { action: "append", default: [], metavar: "PATH", help: "attach a workspace file to --prompt (repeatable)" })
    .add("--output-format", { choices: ["text", "json", "stream-json"], default: "text", help: "final assistant text, one result object, or NDJSON runtime events" });
  addAgentFlags(p).add("--stream", { action: "store_true", help: "print human-readable runtime events to stderr" });
}

async function attachmentsFor(root: string, names: readonly string[]): Promise<Attachment[]> {
  const attachments: Attachment[] = [];
  for (const name of names) enqueueAttachment(attachments, await snapshot(root, name));
  return attachments;
}

async function checkedAttachments(cli: Cli, root: string, names: readonly string[]): Promise<Attachment[]> {
  try { return await attachmentsFor(root, names); } catch (error) { cli.error(`无法添加附件: ${errorText(error)}`); }
}

function pathKey(path: string): string { const value = realish(path); return process.platform === "win32" ? value.toLowerCase() : value; }
function sameRoot(left: unknown, right: string): boolean { return typeof left === "string" && pathKey(left) === pathKey(right); }

function writePacket(packet: Row): void { process.stdout.write(dumps(packet) + "\n"); }

async function chooseContinueSession(store: SessionStore, root: string): Promise<string> {
  const candidates = (await listSessions(store)).filter((item) => sameRoot(item.root, root));
  candidates.sort((left, right) => Number(right.updatedAt) - Number(left.updatedAt) || String(right.id).localeCompare(String(left.id)));
  const id = candidates[0]?.id;
  if (typeof id !== "string") throw new Error("no non-archived session exists for --root");
  return id;
}

async function headlessCommand(cli: Cli): Promise<number> {
  let request: HeadlessRequest;
  try { request = headlessRequest(cli.args); } catch (error) { cli.error(errorText(error)); }
  const format = String(cli.args.output_format ?? "text");
  const { host, io } = await agentHost(cli);
  const store = host.store;
  let session: Session;
  let prepared: Prepared | null = null;
  let staged: Row | null = null;
  let id = request.sessionId;

  if (request.kind === "new") {
    const root = resolve(request.root!);
    mkdirSync(root, { recursive: true });
    staged = { root };
    prepared = prepareAgent(cli, host, staged);
    const attachments = await checkedAttachments(cli, root, request.attachments);
    session = await store.new(request.prompt!, root, { attachments });
    id = String(session.id);
  } else {
    id ??= await chooseContinueSession(store, resolve(request.root!));
    session = await store.load(id);
  }

  let turn = "turn-1";
  try {
    const lease = await store.lease(id!);
    try {
      session = await store.load(id!);
      if (request.root && !sameRoot(session.root, resolve(request.root))) cli.error("session root does not match --root");
      if (request.prompt !== null && request.kind !== "new") {
        const root = String(session.root ?? "");
        await appendUserTurn(session, store, request.prompt, { attachments: await checkedAttachments(cli, root, request.attachments) });
      }
      if (cli.args.mode === null && session.mode === "plan") cli.args.mode = "plan";
      await applyTarget(cli, store, session);
      if (prepared === null) prepared = prepareAgent(cli, host, session);
      else if (staged?.model_selection) session.model_selection = staged.model_selection;
      if (cli.args.permission_mode !== null) persistPermissionMode(session, cli.args.permission_mode);
      session.skill_catalog = cli.args.skill_catalog;
      await store.save(session);
      turn = turnId(session);
    } finally { await lease.release(); }
  } catch (error) {
    if (pyExceptionName(error) === "BlockingIOError") cli.error("session is in use by another process");
    io.terminal.close();
    throw error;
  }

  const sessionId = String(session.id);
  const resumed = request.kind !== "new";
  if (format === "stream-json") writePacket({ schema: HEADLESS_SCHEMA, type: "init", sessionId, resumed });
  const renderHuman = cli.args.stream ? eventRenderer(cli.language) : null;
  const onEvent = format === "stream-json" || renderHuman ? (event: Row): void => {
    if (format === "stream-json") writePacket({ schema: HEADLESS_SCHEMA, type: "event", sessionId, event });
    renderHuman?.(event);
  } : null;

  let failed: unknown = null;
  let result = "";
  try {
    session = await runAgent(cli, host, io, session, prepared!, onEvent);
    result = assistantResultForTurn(session as Row, turn);
  } catch (error) {
    failed = error;
    try { session = await store.load(sessionId); } catch { /* keep the last durable snapshot */ }
  } finally { io.terminal.close(); }

  if (failed === null && format === "text" && result) process.stdout.write(result);
  if (format === "json" || format === "stream-json") writePacket(resultEnvelope(session as Row, failed === null ? result : ""));
  if (failed !== null) throw failed;
  err(`HEADLESS STATUS: ${String(session.status)} (${Number(session.steps ?? 0)} steps)`);
  if (session.status === "awaiting_user" && session.pending_question) err("AWAITING USER: " + String(session.pending_question));
  return session.status === "completed" ? 0 : 2;
}

export async function execute(cli: Cli): Promise<number | null> {
  return cli.args.cmd === "headless" ? headlessCommand(cli) : null;
}
