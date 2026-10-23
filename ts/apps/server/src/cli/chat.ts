/**
 * `xueness chat` (`sessions/cli.py` `_chat_loop_owned` and the chat branch
 * of `_execute_cli_impl`): one leased session, slash commands, inline
 * approvals, and a live event stream per turn. The chat holds the session
 * lease while it waits for input and hands it to the agent runner for each run.
 */
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { appendUserTurn, answerSession } from "@xueness/agent";
import { attachmentMetadata, enqueueAttachment, pyExceptionName, withAttachments, type Attachment, type Session, type SessionStore } from "@xueness/sessions";
import { snapshot, FullscreenChatTerminal, fullscreenAvailable, pendingQuestions, forkTurn } from "@xueness/plugin-sessions";
import { expandCommand, loadCommands } from "@xueness/plugin-commands";
import { pyLen } from "@xueness/contracts";
import { dumps, err, errorText, type Cli } from "./host.ts";
import { eventRenderer } from "./render.ts";
import { captureClipboardImage, multiline } from "./input.ts";
import { agentHost, applyTarget, checkBudgets, checkDisallow, persistPermissionMode, prepareAgent, printSummary, runAgent, selectionRecord, type Prepared, type RunIo } from "./run.ts";
import { CHAT_HELP, CHAT_HELP_EN, chatSwitch, dispatchSlash, manifestCommands, reportCompaction, reportDynamicRuns, shlexSplit } from "./chat-commands.ts";
import { listSessions } from "./sessions.ts";
import { Terminal } from "./render.ts";
import { routeCliOutput } from "./output.ts";
import { connectChatTui } from "./chat-tui.ts";
import type { ApplicationApi } from "../application-api.ts";

type Row = Record<string, any>;
const realish = (path: string): string => { try { return realpathSync(path); } catch { return resolve(path); } };

/** `_latest_chat`: the most recently saved live session of this workspace. */
async function latestChat(store: SessionStore, root: string): Promise<Session | null> {
  let best: [bigint, string, Session] | null = null;
  let names: string[] = [];
  try { names = readdirSync(store.directory).filter((name) => /^[0-9a-f]{32}\.json$/.test(name)); } catch { return null; }
  for (const name of names) {
    const path = join(store.directory, name), stem = name.slice(0, -5);
    try {
      if (lstatSync(path).isSymbolicLink()) continue;
      const s = await store.load(stem);
      if (s.id !== stem || realish(String(s.root)) !== root) continue;
      const key = statSync(path, { bigint: true }).mtimeNs;
      if (!best || key > best[0] || (key === best[0] && stem > best[1])) best = [key, stem, s];
    } catch { continue; }
  }
  return best ? best[2] : null;
}

function commandItems(cli: Cli, root: string): Row[] {
  if (!cli.enabled("commands")) return [];
  try { return loadCommands({ stateDir: cli.state, root, language: cli.args.language, manifestCommands: new Set(manifestCommands(cli).keys()) }); } catch { return []; }
}

/** The chat's own hold on one session lease (Python's `ExitStack` of `lease`). */
function leaseHolder(store: SessionStore) {
  let held: { sid: string; release(): Promise<void> } | null = null;
  return {
    async hold(sid: string): Promise<void> {
      if (held?.sid === sid) return;
      await this.drop();
      const lease = await store.lease(sid);
      held = { sid, release: async () => { await lease.release(); } };
    },
    async drop(): Promise<void> { const current = held; held = null; await current?.release(); },
  };
}

/** `/mode`: plan and build move the kernel ceiling; edit, yolo, and guarded only select a permission mode. */
async function applyMode(cli: Cli, store: SessionStore, s: Row | null, prepared: Prepared | null, selected: string): Promise<void> {
  const a = cli.args;
  if (!["build", "edit", "yolo", "plan", "guarded"].includes(selected)) { err(cli.zh("用法: /mode build|edit|yolo|plan|guarded", "usage: /mode build|edit|yolo|plan|guarded")); return; }
  a.tui_mode = selected;
  const kernelPlan = a.mode === "plan" || prepared?.policy.mode === "plan" || s?.mode === "plan";
  if ((selected === "edit" || selected === "yolo" || selected === "guarded") && kernelPlan) { err(cli.zh("计划模式的内核上限仍在；请先 /mode build，再切换到 edit、yolo 或 guarded", "plan ceiling is still on; use /mode build before edit, yolo, or guarded")); return; }
  if (selected === "plan" || selected === "build") {
    a.mode = selected; a.permission_mode = selected;
    if (prepared) { prepared.policy.mode = selected; prepared.policy.permissionMode = selected; prepared.flags.permissionMode = selected; }
    if (s?.id) { s.mode = selected; ((s.mode_history ??= []) as Row[]).push({ mode: selected, steps: s.steps ?? 0 }); persistPermissionMode(s, selected); await store.save(s as Session); }
  } else {
    a.permission_mode = selected;
    if (prepared) { prepared.policy.permissionMode = selected as Prepared["policy"]["permissionMode"]; prepared.flags.permissionMode = selected; }
    if (s?.id) { persistPermissionMode(s, selected); await store.save(s as Session); }
  }
  err(`mode: ${a.mode ?? "build"} · permission: ${selected}`);
}

async function chatLoop(cli: Cli, host: ApplicationApi, io: RunIo, session: Session | null): Promise<Session | null> {
  const a = cli.args, store = host.store, terminal = io.terminal, en = cli.language === "en";
  const lease = leaseHolder(store);
  try {
    let s: Session | null = session;
    if (s) { await lease.hold(String(s.id)); s = await store.load(String(s.id)); }
    let root = s ? realish(String(s.root)) : realish(a.root ?? process.cwd());
    if (!existsSync(root) || !statSync(root).isDirectory()) cli.error("chat workspace must be an existing directory");
    a.mode = a.mode || (s ? s.mode ?? "build" : "build");
    err(en ? `Xueness · workspace ${root} · mode ${a.mode} · /help` : `Xueness · root ${root} · mode ${a.mode} · /help`);
    if (s) { await applyTarget(cli, store, s); err(`chat ${s.id} · ${s.status}`); }
    if (s && Array.isArray(s.messages)) terminal.history?.(s.messages as { role: string; content: unknown }[]);
    let prepared: Prepared | null = null;
    let pendingMode: string | null = null;
    const tui = connectChatTui(cli, host, terminal, { root: () => root, session: () => s, commands: () => commandItems(cli, root),
      async setMode(mode) { if (terminal.running) pendingMode = mode; else await applyMode(cli, store, s, prepared, mode); return mode; } });
    const attachments: Attachment[] = [];
    try { for (const name of a.attach) enqueueAttachment(attachments, await snapshot(root, name)); }
    catch (error) { cli.error(`无法添加附件: ${errorText(error)}`); }
    for (;;) {
      if (pendingMode) { await applyMode(cli, store, s, prepared, pendingMode); pendingMode = null; }
      const savedSelection = s?.model_selection as Row | undefined;
      terminal.setContext?.({ root, sessionId: String(s?.id ?? ""), model: prepared?.provider.model ?? a.model ?? savedSelection?.model ?? "", mode: a.tui_mode ?? prepared?.flags.permissionMode ?? a.permission_mode ?? a.mode, effort: a.reasoning_effort ?? savedSelection?.reasoning_effort });
      const awaiting = !!(s && s.status === "awaiting_user" && s.pending_question);
      if (awaiting) err(`\n${en ? "Question" : "问题"}: ${s!.pending_question}`);
      const questions = awaiting ? pendingQuestions(s!) : [];
      let line = questions.length && terminal.questions ? await terminal.questions(questions as any) : await terminal.prompt(en ? (awaiting ? "Answer > " : "> ") : (awaiting ? "回答 › " : "› "));
      if (line === null && questions.length) line = await terminal.prompt(en ? "Answer or /exit > " : "回答或 /exit › ");
      if (line === null) break;
      let text = questions.length && line === "" ? (en ? "User skipped all questions." : "用户跳过了所有问题。") : line.trim();
      if (tui) for (const item of tui.consumeAttachments(terminal.takeAttachments?.() ?? [])) enqueueAttachment(attachments, item);
      if (!text) continue;
      if (text === "/exit" || text === "/quit") break;
      const space = text.search(/\s/);
      let command = space < 0 ? text : text.slice(0, space);
      if (command === "/variant") command = "/effort";
      const argument = space < 0 ? "" : text.slice(space).trim();
      if (["/new", "/resume", "/fork"].includes(command)) {
        if (command === "/resume" && !argument && terminal.openMenu) { terminal.openMenu("session"); continue; }
        const previous = s, previousRoot = root;
        await lease.drop();
        try {
          s = command === "/new" ? null : command === "/resume" ? await store.load(argument) : previous ? await store.load(String((await forkTurn({ store, stateDir: cli.state }, String(previous.id), {})).id)) : null;
          if (command === "/fork" && !previous) throw new Error("no session to fork");
          if (s) { root = realish(String(s.root)); await lease.hold(String(s.id)); }
          prepared = null; attachments.length = 0;
          terminal.reset?.(String(s?.id ?? ""));
          terminal.setContext?.({ sessionId: String(s?.id ?? ""), root });
          if (s && Array.isArray(s.messages)) terminal.history?.(s.messages as any);
        } catch (error) { s = previous; root = previousRoot; if (s) await lease.hold(String(s.id)); err(`! ${errorText(error)}`); }
        continue;
      }
      let literal = false;
      if (command === "/paste-image") {
        try {
          if (argument) throw new Error("/paste-image takes no arguments");
          const item = await captureClipboardImage(root);
          enqueueAttachment(attachments, item);
          err(en ? `Clipboard PNG queued (${item.size} bytes, sha256 ${item.sha256.slice(0, 12)}).` : `已暂存剪贴板 PNG（${item.size} bytes，SHA-256 ${item.sha256.slice(0, 12)}）。`);
        } catch (error) { err((en ? "! Clipboard image unavailable: " : "! 剪贴板图片不可用：") + errorText(error)); }
        continue;
      }
      if (command === "/paste") {
        err("多行输入：/end 提交，/cancel 或 Ctrl+C 取消；\\/end 输入字面 /end。");
        let pasted: string | null | undefined;
        try { pasted = await multiline((label) => terminal.prompt(label)); } catch (error) { err(`! ${errorText(error)}`); continue; }
        if (pasted === undefined) break;
        if (pasted === null || !pasted.trim()) { err("多行输入未提交，附件队列保留。"); continue; }
        text = pasted; literal = true; command = "";
      }
      if (command === "/attach" || command === "/attachments" || command === "/detach") {
        try {
          if (command === "/attach") {
            const paths = shlexSplit(argument);
            if (paths.length !== 1) throw new Error('用法: /attach "path with spaces.txt"');
            const item = await snapshot(root, paths[0]!);
            enqueueAttachment(attachments, item);
            err(`已暂存 ${dumps(item.path)}（${item.size} bytes），随下一条输入发送。`);
          } else if (command === "/detach") {
            if (argument === "all") attachments.length = 0;
            else if (/^\d+$/.test(argument) && Number(argument) >= 1 && Number(argument) <= attachments.length) attachments.splice(Number(argument) - 1, 1);
            else throw new Error("用法: /detach N|all（N 为附件序号）");
          } else err(dumps(attachments.map((item, i) => ({ index: i + 1, ...attachmentMetadata(item) }))));
        } catch (error) { err(`! 无法更新附件: ${errorText(error)}`); }
        continue;
      }
      if (command === "/help") {
        err(en ? CHAT_HELP_EN : CHAT_HELP);
        for (const item of commandItems(cli, root)) err(`/${item.id}  ${item.description ?? ""}`);
        continue;
      }
      if (command === "/models" || command === "/model" || command === "/effort") {
        try {
          const [status, next] = await chatSwitch(cli, host, command, argument, store, s);
          err(status);
          if (next !== null && prepared) prepared.provider = next;
        } catch (error) { err(`! 无法切换模型: ${errorText(error)}`); }
        continue;
      }
      if (command === "/status") {
        err(dumps({ id: s ? s.id : null, root, mode: a.mode, permission_mode: prepared?.flags.permissionMode || s?.permission_mode || a.permission_mode || "build", status: s ? s.status : "new", steps: s ? s.steps ?? 0 : 0 }));
        continue;
      }
      if (command === "/mode") { await applyMode(cli, store, s, prepared, argument.trim()); continue; }
      if (command === "/dwf") { reportDynamicRuns(cli, store, s, argument); continue; }
      if (command === "/compact") { const refreshed = await reportCompaction(cli, store, s, argument); if (refreshed) s = refreshed; continue; }
      if (command.startsWith("/") && !literal) {
        let reply: string | null;
        try { reply = await dispatchSlash(cli, text, { session: s, root }); } catch (error) { err(`! ${errorText(error)}`); continue; }
        if (reply !== null && reply !== undefined) { err(String(reply)); continue; }
      }
      const retry = !literal && text === "/retry";
      if (retry && attachments.length) { err("! 附件尚未发送：请输入任务/回答，或 /detach all 后重试"); continue; }
      if (retry && (!s || awaiting)) { err("! 请先输入任务或回答当前问题"); continue; }
      if (!retry && pyLen(text) > 5000) { err("! 输入需为 1..5000 字符"); continue; }
      prepared ??= prepareAgent(cli, host, s ?? { root });
      const items = literal ? [] : commandItems(cli, root);
      try {
        if (awaiting) {
          s = await answerSession(await store.load(String(s!.id)), store, text, { attachments, preserveWhitespace: literal });
          err(`== 已回答，状态 ${s.status}`);
        } else if (!s) {
          const [content, invocation] = expandCommand(items, text);
          s = await store.new(String(content), root, { attachments });
          await lease.hold(String(s.id));
          await applyTarget(cli, store, s);
          if (a.provider_id || a.model || a.reasoning_effort) { s.model_selection = selectionRecord(a.provider_id, a.model, a.reasoning_effort); await store.save(s); }
          if (invocation) { s.command_invocations = [invocation]; await store.save(s); }
          err(`chat ${s.id}`);
        } else if (!retry) {
          const base = literal ? text : text.trim();
          const [content, invocation] = items.length ? expandCommand(items, base) : [base, null];
          s = await appendUserTurn(await store.load(String(s.id)), store, text, { attachments, preserveWhitespace: literal, persist: false });
          if (invocation) {
            (s.messages as Row[]).at(-1)!.content = withAttachments(String(content), attachments);
            const log = (s.command_invocations ??= []) as Row[];
            log.push(invocation);
            if (log.length > 50) log.splice(0, log.length - 50);
          }
          await store.save(s);
        }
      } catch (error) {
        const name = pyExceptionName(error);
        if (name === "LookupError" || name === "ValueError" || error instanceof Error) { err(`! 无法提交输入: ${errorText(error)}`); continue; }
        throw error;
      }
      attachments.length = 0;
      if (a.permission_mode !== null) persistPermissionMode(s, a.permission_mode);
      s.skill_catalog = a.skill_catalog;
      await store.save(s);
      const sid = String(s.id);
      terminal.setContext?.({ sessionId: sid, model: prepared.provider.model ?? a.model ?? "", mode: a.tui_mode ?? prepared.flags.permissionMode });
      await lease.drop();
      try { s = await runAgent(cli, host, io, await store.load(sid), prepared, terminal.event ? null : eventRenderer(cli.language)); }
      finally { await lease.hold(sid); }
      err(en ? `== ${s.status} (${s.steps} steps) · enter a follow-up, /retry to continue, /exit to leave` : `== ${s.status}（共 ${s.steps} 步） · 继续输入追问，/retry 继续，/exit 退出`);
    }
    return s ? await store.load(String(s.id)) : null;
  } catch (error) {
    if (pyExceptionName(error) === "BlockingIOError") cli.error("session is in use by another process");
    throw error;
  } finally {
    await lease.drop().catch(() => {});
  }
}

export async function chatCommand(cli: Cli): Promise<number> {
  const a = cli.args;
  const fullscreen = a.tui && fullscreenAvailable() ? new FullscreenChatTerminal({ language: cli.language }) : null;
  if (a.tui && !fullscreen) err(cli.zh("当前输入或输出不是交互终端，使用行式聊天。", "Input or output is not an interactive terminal; using line chat."));
  const terminal = fullscreen ?? new Terminal();
  const restoreOutput = fullscreen ? routeCliOutput(fullscreen) : () => {};
  let result: Session | null = null;
  try {
    fullscreen?.watch();
    const { host, io } = await agentHost(cli, terminal);
    const store = host.store;
    if (a.select) {
      if (a.id || a.continue_chat) cli.error("--select cannot be combined with ID or --continue");
      const options = await listSessions(store, { root: a.root, search: a.search });
      options.forEach((item, i) => err(`${i + 1}. ${dumps(item.title)} · ${item.id} · ${item.root}`));
      if (!options.length) cli.error("no matching session");
      const choice = (await io.terminal.prompt("会话序号（空行取消） › "))?.trim();
      if (!choice) return 0;
      if (!/^\d+$/.test(choice) || Number(choice) < 1 || Number(choice) > options.length) cli.error("invalid session selection");
      a.id = options[Number(choice) - 1]!.id; a.root = null;
    }
    if (a.id && (a.continue_chat || a.root !== null)) cli.error("chat ID cannot be combined with --continue or --root");
    checkBudgets(cli, true);
    checkDisallow(cli, host, "invalid session or tool deny list");
    let s: Session | null = null;
    try { s = a.id ? await store.load(a.id) : null; } catch { cli.error("invalid session or tool deny list"); }
    if (a.continue_chat) {
      s = await latestChat(store, realish(a.root ?? process.cwd()));
      if (!s) cli.error("no live session in this workspace; use chat to start one");
    }
    result = await chatLoop(cli, host, io, s);
  } finally { terminal.close(); restoreOutput(); }
  if (result) printSummary(result, false);
  return 0;
}
