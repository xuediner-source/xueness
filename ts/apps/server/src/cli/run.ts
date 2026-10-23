/**
 * `xueness run` and the shared agent preparation (`sessions/cli.py`
 * `_add_agent_flags`, `_prepare_agent`, `_apply_cli_target`, `_print_summary`).
 */
import { existsSync, mkdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { isDict, pyUtcNow } from "@xueness/contracts";
import { configurationError, REASONING_LEVELS } from "@xueness/plugin-providers";
import { pendingDenials, rejectLegacyFake, snapshot, validateRun, type RunPolicy } from "@xueness/plugin-sessions";
import { stageGoal } from "@xueness/plugin-planning";
import { enqueueAttachment, pyExceptionName, type Attachment, type Session, type SessionStore } from "@xueness/sessions";
import type { AgentProvider } from "@xueness/agent";
import type { ApplicationApi } from "../application-api.ts";
import type { Args, Parser } from "./argparse.ts";
import { dumps, err, errorText, out, type Cli } from "./host.ts";
import { cliApprover, eventRenderer, Terminal, type CliTerminal, type GateFlags } from "./render.ts";
import { chatCommand } from "./chat.ts";

type Row = Record<string, any>;

export function addAgentFlags(p: Parser): Parser {
  return p.add("--provider-id", { help: "saved provider profile id" }).add("--model", { help: "override model for this session" })
    .add("--reasoning-effort", { choices: REASONING_LEVELS, help: "provider-declared reasoning effort" })
    .add("--runtime-profile", { choices: ["standard", "lightweight"], help: "small-context local model runtime (saved with the session)" })
    .add("--lightweight", { dest: "runtime_profile", action: "store_const", const: "lightweight", help: "enable the lightweight local-model runtime" })
    .add("--max-wall-seconds", { type: "float", help: "cooperative run time budget, at most 3600 seconds" })
    .add("--allow-write", { action: "store_true", help: "approve all writes in workspace for this invocation" })
    .add("--allow-exec", { action: "store_true", help: "approve all subprocesses for this invocation" })
    .add("--allow-network", { action: "store_true", help: "approve network search/fetch tools for this invocation" })
    .add("--allow-edit", { action: "store_true", help: "approve all edits in workspace for this invocation (default follows --allow-write)" })
    .add("--interactive", { action: "store_true", help: "prompt for each write/edit/exec" })
    .add("--mode", { choices: ["plan", "build"], help: "kernel ceiling: plan denies write/edit/exec before any approval lookup, including the plan draft; build keeps deny-by-default" })
    .add("--permission-mode", { choices: ["build", "edit", "yolo", "plan", "guarded"], help: "build asks; edit auto-approves workspace writes; yolo auto-approves writes, local commands and network but still asks for remote SSH; guarded auto-runs ordinary commands and asks each time for recognized dangerous commands; plan is read-only plus this session's plan draft. Legacy --allow-* flags stay in force for build. --mode plan is a hard ceiling over every permission mode" })
    .add("--disallow-tools", { default: "", help: "comma-separated tool deny list, e.g. 'exec,edit'; denied even with --allow-write/--allow-exec" })
    .add("--steps", { type: "int", default: 8 }).add("--max-chars", { type: "int", default: 24000 })
    .add("--max-tokens", { type: "int", help: "standard: advisory chars/4 estimate; lightweight: input estimate budget; neither calls a model" })
    .add("--memory-root", { help: "read-only dsh-grok-memory root; inject curated MEMORY.md/USER.md/KEY.md tracks as untrusted data" })
    .add("--skill-catalog", { action: "store_true", help: "load skill descriptions first; expose bounded skill_read on demand" })
    .add("--inject-skills", { action: "store_true", help: "inject enabled skills from <state>/resources/skills as untrusted context" })
    .add("--allow-hooks", { action: "store_true", help: "run enabled PreToolUse/PostToolUse/SessionStart/Stop hooks (executes commands)" })
    .add("--allow-mcp", { action: "store_true", help: "connect enabled stdio MCP servers, expose their tools, and approve those calls for this invocation (spawns processes; the web UI instead requires one approval per call)" })
    .add("--allow-subagents", { action: "store_true", help: "expose the read-only task tool so the model can delegate sub-tasks" })
    .add("--grant-plugin-capability", { action: "append", default: [], choices: ["command", "network", "filesystem-write"], help: "grant a stored plugin manifest the named power (repeatable): command / network / filesystem-write" })
    .add("--target", { metavar: "TEXT", help: "persistent session goal owned by the planning plugin: injected before every model request and verified when the run claims completion" })
    .add("--target-replace", { action: "store_true", help: "replace the session's existing goal; without it --target refuses to overwrite" });
}

export function register(sub: ReturnType<Parser["subparsers"]>): void {
  const run = sub.add("run", "resume a session (or create+run one-shot with --prompt)").add("id", { nargs: "?", help: "session id to resume" })
    .add(["--resume", "--continue"], { dest: "resume", action: "store_true", help: "explicit resume alias for the positional id (identical behaviour, for scripting clarity)" })
    .add("--prompt", { help: "one-shot mode: create a new session for this task under --root, then run it" })
    .add("--attach", { action: "append", default: [], metavar: "PATH", help: "attach a workspace text/image/PDF/video file to --prompt (repeatable)" })
    .add("--root", { help: "workspace root; required with --prompt, ignored with an explicit id" })
    .add("--output-format", { choices: ["text", "json", "stream-json"], default: "text", help: "text: pretty JSON summary (default); json: machine-readable {id,status,steps,mode,completion,pending}; stream-json: one JSON line per live event, final line type==summary" });
  addAgentFlags(run).add("--stream", { action: "store_true", help: "print live tool/status events to stderr (stdout summary unchanged)" });
  const chat = sub.add("chat", "interactive multi-turn session: type a message, watch steps stream, approve inline").add("id", { nargs: "?", help: "session id; omit to start a new conversation" })
    .add("--attach", { action: "append", default: [], metavar: "PATH", help: "queue a workspace text/image/PDF/video file for the next input (repeatable)" })
    .add("--select", { action: "store_true", help: "choose an existing session interactively" }).add("--search", { default: "", help: "filter --select by title or id" })
    .add("--root", { help: "workspace for a new chat or --continue (default cwd)" })
    .add(["--continue", "-c"], { dest: "continue_chat", action: "store_true", help: "resume the most recently saved live session in this workspace" })
    .add("--tui", { action: "store_true", help: "fullscreen chat: scrolling history, multiline input and inline approvals (requires a TTY)" });
  addAgentFlags(chat).setDefaults({ interactive: true })
    .add("--non-interactive", { dest: "interactive", action: "store_false", help: "never prompt for approvals; mutations denied unless explicitly allowed" })
    .add("--stream", { action: "store_true", default: true, help: "streaming is always on in chat; flag kept for symmetry" });
}

export function checkBudgets(cli: Cli, chat = false): void {
  const a = cli.args;
  if (chat) { if (a.steps < 1 || a.max_chars < 1000 || (a.max_tokens !== null && a.max_tokens < 1)) cli.error("--steps/--max-tokens must be positive and --max-chars >= 1000"); return; }
  if (a.steps < 1 || a.max_chars < 1000) cli.error("--steps must be positive and --max-chars >= 1000");
  if (a.max_tokens !== null && a.max_tokens < 1) cli.error("--max-tokens must be a positive integer");
}

/** `parse_disallow_list` through the sessions run validation (same known-tool set). */
export function checkDisallow(cli: Cli, host: ApplicationApi, message?: string): void {
  try { validateRun({ disallow_tools: cli.args.disallow_tools }, host.agent.knownTools()); } catch (error) { cli.error(message ?? errorText(error)); }
}

export function selectionRecord(providerId: unknown, model: unknown, effort: unknown): Row {
  const record: Row = { provider_id: providerId ?? null, model: model ?? null };
  if (effort !== null && effort !== undefined) record.reasoning_effort = effort;
  return record;
}

/** `_apply_cli_target`: the planning plugin's persistent goal, refused without --target-replace. */
export async function applyTarget(cli: Cli, store: SessionStore, session: Session): Promise<void> {
  const text = cli.args.target;
  if (text === null || text === undefined) return;
  if (!cli.enabled("planning")) cli.error("插件已禁用或依赖不可用: planning");
  try { stageGoal(session, text, { enabled: (id: string) => cli.enabled(id), replace: cli.args.target_replace === true, source: "cli" }); }
  catch (error) { cli.error(errorText(error)); }
  await store.save(session);
}

export function effectivePermissionMode(args: Args, session: Row | null): string | null {
  if (args.permission_mode !== null && args.permission_mode !== undefined) return args.permission_mode;
  return session?.permission_mode === "plan" ? "plan" : null;
}

/** `_persist_cli_permission_mode`: the new mode, with a bounded history of changes. */
export function persistPermissionMode(session: Row, mode: string | null): void {
  if (!mode || !session.id || !["build", "edit", "yolo", "plan", "guarded"].includes(mode)) return;
  const previous = session.permission_mode ?? "build";
  if (previous !== mode) {
    const history = (session.permission_mode_history ??= []) as Row[];
    history.push({ from: previous, to: mode, at: pyUtcNow() });
    if (history.length > 50) history.splice(0, history.length - 50);
  }
  session.permission_mode = mode;
}

export interface Prepared { provider: AgentProvider; policy: RunPolicy; flags: GateFlags }

/** `_prepare_agent`: budgets, the provider for the session's selection, and the run policy. */
export function prepareAgent(cli: Cli, host: ApplicationApi, session: Row): Prepared {
  const a = cli.args;
  checkBudgets(cli);
  checkDisallow(cli, host);
  if (session.id) { try { rejectLegacyFake(session as Session); } catch (error) { cli.error(errorText(error)); } }
  const saved = isDict(session.model_selection) ? session.model_selection as Row : {};
  const providerId = a.provider_id || saved.provider_id || null, model = a.model || saved.model || null, effort = a.reasoning_effort || saved.reasoning_effort || null;
  let runtime: string | null = a.runtime_profile ?? null;
  let provider: AgentProvider;
  try { provider = host.agent.resolveProvider({ providerId, model, reasoningEffort: effort, runtimeProfile: runtime }, String(session.id ?? "")); }
  catch (error) { return cli.error(configurationError(error)); }
  if (runtime === null && (providerId !== (saved.provider_id ?? null) || model !== (saved.model ?? null))) runtime = provider.runtimeProfile ?? "standard";
  if (runtime !== null) session.runtime_profile = runtime;
  if (providerId || model || effort) session.model_selection = selectionRecord(providerId, model, effort);
  if (a.max_wall_seconds !== null && !(a.max_wall_seconds > 0 && a.max_wall_seconds <= 3600)) cli.error("--max-wall-seconds must be greater than zero and at most 3600");
  if (a.memory_root !== null && cli.enabled("memory")) {
    if (!existsSync(a.memory_root) || !statSync(a.memory_root).isDirectory()) cli.error("--memory-root must be an existing directory");
    process.env.XUENESS_MEMORY_ROOT = resolve(a.memory_root);
  }
  const permissionMode = effectivePermissionMode(a, session);
  const request: Row = { mode: a.mode ?? "build", disallow_tools: a.disallow_tools, allow_mcp: a.allow_mcp, allow_hooks: a.allow_hooks, allow_subagents: a.allow_subagents,
    skill_catalog: a.skill_catalog, inject_skills: a.inject_skills, grant_plugin_capability: a.grant_plugin_capability ?? [] };
  const validated = validateRun(request, host.agent.knownTools());
  const policy: RunPolicy = { ...validated.policy, permissionMode: (permissionMode ?? session.permission_mode ?? "build") as RunPolicy["permissionMode"],
    selection: { providerId, model, reasoningEffort: effort, runtimeProfile: a.runtime_profile ?? null } };
  const flags: GateFlags = { allowWrite: a.allow_write, allowEdit: a.allow_edit || a.allow_write, allowExec: a.allow_exec, allowMcp: a.allow_mcp, allowNetwork: a.allow_network,
    interactive: a.interactive === true, permissionMode: policy.permissionMode };
  return { provider, policy, flags };
}

/** The live sink, terminal and gate flags shared by the host's agent service. */
export interface RunIo { terminal: CliTerminal; flags: GateFlags; sink: (event: Row) => void }
export async function agentHost(cli: Cli, terminal: CliTerminal = new Terminal()): Promise<{ host: ApplicationApi; io: RunIo }> {
  const io: RunIo = { terminal, flags: { allowWrite: false, allowEdit: false, allowExec: false, allowMcp: false, allowNetwork: false, interactive: false, permissionMode: "build" }, sink: () => {} };
  const host = await cli.host({ approver: cliApprover(() => io.flags, terminal), onEvent: (sid, event) => { terminal.event?.({ ...event, sessionId: sid }); io.sink(event as Row); } });
  return { host, io };
}

/**
 * One agent run under the CLI's gate; Ctrl+C asks it to stop. The runner takes
 * the session lease itself, so a caller holding it releases it first.
 */
export async function runAgent(cli: Cli, host: ApplicationApi, io: RunIo, session: Session, prepared: Prepared, onEvent: ((event: Row) => void) | null): Promise<Session> {
  io.flags = prepared.flags;
  io.sink = onEvent ?? (() => {});
  io.terminal.running = true; io.terminal.stopRequested = false;
  io.terminal.watch();
  try {
    const runner = host.agent.createRunner(session, prepared.provider, prepared.policy);
    const a = cli.args;
    return await runner.run(session, { maxSteps: a.steps, maxChars: a.max_chars, ...(a.max_tokens !== null ? { maxTokens: a.max_tokens } : {}), ...(a.max_wall_seconds !== null ? { maxWallSeconds: a.max_wall_seconds } : {}), shouldStop: () => io.terminal.stopRequested });
  } finally { io.terminal.running = false; io.sink = () => {}; }
}

export function printSummary(s: Row, json: boolean): void {
  const body: Row = { id: s.id, status: s.status, steps: s.steps, mode: s.mode ?? "build", completion: s.completion ?? null };
  if (json) out(dumps({ ...body, pending: pendingDenials(s as Session), pending_question: s.pending_question ?? null }));
  else out(dumps({ ...body, pending_question: s.pending_question ?? null }, 2));
}

async function runCommand(cli: Cli): Promise<number> {
  const a = cli.args;
  checkBudgets(cli);
  const { host, io } = await agentHost(cli);
  checkDisallow(cli, host);
  const store = host.store;
  let s: Session, prepared: Prepared | null = null, preparedSession: Row | null = null;
  if (a.prompt !== null) {
    if (!a.root) cli.error("--prompt requires --root");
    if (a.id) cli.error("--prompt cannot be combined with a session id");
    const root = resolve(a.root);
    preparedSession = { root };
    prepared = prepareAgent(cli, host, preparedSession);
    mkdirSync(root, { recursive: true });
    const attachments: Attachment[] = [];
    try { for (const name of a.attach) enqueueAttachment(attachments, await snapshot(root, name)); }
    catch (error) { cli.error(`无法添加附件: ${errorText(error)}`); }
    s = await store.new(a.prompt, root, { attachments });
  } else {
    if (a.attach.length) cli.error("run --attach requires --prompt; use chat to attach files to an existing session");
    if (!a.id) cli.error("run needs a session id (or --prompt TASK --root DIR)");
    s = await store.load(a.id);
  }
  if (prepared === null && a.mode === null && s.mode === "plan") a.mode = "plan";
  try {
    const lease = await store.lease(String(s.id));
    try {
      s = await store.load(String(s.id));
      await applyTarget(cli, store, s);
      if (prepared === null) prepared = prepareAgent(cli, host, s);
      else if (preparedSession?.model_selection) s.model_selection = preparedSession.model_selection;
      if (a.permission_mode !== null) persistPermissionMode(s, a.permission_mode);
      s.skill_catalog = a.skill_catalog;
      await store.save(s);
    } finally { await lease.release(); }
    const sink = a.output_format === "stream-json" ? (event: Row) => out(dumps(event)) : a.stream ? eventRenderer(cli.language) : null;
    s = await runAgent(cli, host, io, s, prepared, sink);
  } catch (error) {
    if (pyExceptionName(error) === "BlockingIOError") cli.error("session is in use by another process");
    throw error;
  } finally { io.terminal.close(); }
  if (s.status === "awaiting_user" && s.pending_question) err("AWAITING USER: " + s.pending_question);
  if (a.output_format === "stream-json") out(dumps({ type: "summary", id: s.id, status: s.status, steps: s.steps, mode: s.mode ?? "build", completion: s.completion ?? null, pending: pendingDenials(s), pending_question: s.pending_question ?? null }));
  else printSummary(s, a.output_format === "json");
  return s.status === "completed" ? 0 : 2;
}

export async function execute(cli: Cli): Promise<number | null> {
  if (cli.args.cmd === "run") return runCommand(cli);
  if (cli.args.cmd === "chat") return chatCommand(cli);
  return null;
}
