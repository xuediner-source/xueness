/**
 * In-chat commands beside the turn loop (`sessions/cli.py` CHAT_HELP,
 * `_report_dynamic_runs`, `_report_compaction`, `model_switch.chat_switch`,
 * and `plugin_runtime.dispatch_slash` for plugin-owned names).
 */
import { CompactError, compactNow, currentModelSelection, parseModelTarget, recordModelSwitch } from "@xueness/plugin-sessions";
import { declaredReasoningLevels, ProfileStore } from "@xueness/plugin-providers";
import { chat as dynamicRunsChat, handleExpertSlash } from "@xueness/plugin-workflows";
import type { AgentProvider } from "@xueness/agent";
import type { Session, SessionStore } from "@xueness/sessions";
import { loadCatalogManifests } from "../manifests.ts";
import type { ApplicationApi } from "../application-api.ts";
import { dumps, err, errorText, type Cli } from "./host.ts";
import { catalogSlash } from "./catalog.ts";
import { clearGoal, publicGoal, stageGoal, transitionGoal, updateGoalBudget } from '@xueness/plugin-planning';
import { pyJsonLoads } from '@xueness/contracts';

type Row = Record<string, any>;

export const CHAT_HELP = "/goal show|set TEXT|replace TEXT|pause|resume|clear|budget JSON\n                    管理会话目标与累计预算\n/help               显示帮助与自定义命令\n/status             当前会话、工作区、模式与状态\n/mode plan|build|edit|yolo|guarded\n                    切换模式（plan 为内核上限，禁止写入和执行；edit 自动编辑；yolo 放行本地变更但仍询问远程执行）\n/retry              继续当前运行，不添加用户消息\n/paste              多行输入，单独一行 /end 提交，/cancel 取消\n/attach PATH        暂存工作区 UTF-8 文本文件快照，随下一条输入发送\n/paste-image        显式捕获剪贴板 PNG，随下一条输入发送（不会自动读取剪贴板）\n/attachments        查看待发送附件\n/detach N|all       移除第 N 个或所有待发送附件\n/models             列出已保存的模型配置与当前选择\n/model <ID> [MODEL] 切换供应商/模型；亦支持 /model provider/model，env 使用环境配置\n/model save-default 把当前模型与推理档位存为默认\n/effort list|<档位> 查看或切换推理档位，save-default 存为默认\n/dwf [list|cancel [runId]|resume <runId>]\n                    本会话启动的动态工作流运行\n/compact [说明]     立即按预算压缩上下文（不调用模型，原始日志保留）\n/expert [status|resume|stop|任务]\n                    专家工作流：调研→计划→实现→审查\n/skills [list|inspect <名称>]\n                    列出或查看目录型技能（SKILL.md）\n/commands [list|inspect <名称>]\n                    列出或查看文件型与存储的自定义命令\n/init [说明]        调研工作区并生成或更新 AGENTS.md（commands 插件的内建提示命令）\n/exit 或 /quit      保存会话并退出\n运行中 Ctrl+C 请求停止；停止后 /retry 继续，或输入新方向。\n输入提示处 Ctrl+C 退出；写入/编辑/执行默认逐次询问。";
export const CHAT_HELP_EN = "/goal show|set TEXT|replace TEXT|pause|resume|clear|budget JSON\n                    Manage session goals and cumulative budgets\n/help               Show help and custom commands\n/status             Show session, workspace, mode and status\n/mode plan|build|edit|yolo|guarded\n                    Change mode (plan is the kernel ceiling and denies writes and execution; edit auto-edits files; yolo allows local changes but still asks before remote execution)\n/retry              Continue the current run without adding a user message\n/paste              Enter multiline input; /end submits and /cancel discards\n/attach PATH        Queue a workspace UTF-8 text file for the next input\n/paste-image        Explicitly capture a clipboard PNG for the next input\n/attachments        List queued attachments\n/detach N|all       Remove one or all queued attachments\n/models             List saved model profiles and the current choice\n/model <ID> [MODEL] Switch provider/model; /model provider/model and env also work\n/model save-default Store the current model and reasoning level as the default\n/effort list|<level> Show or change the reasoning level; save-default stores it\n/dwf [list|cancel [runId]|resume <runId>]\n                    Dynamic workflow runs started by this session\n/compact [notes]    Compact the context to budget now (no model call; journal kept)\n/expert [status|resume|stop|task]\n                    Expert workflow: research → plan → implement → review\n/skills [list|inspect <name>]\n                    List or inspect directory skills (SKILL.md)\n/commands [list|inspect <name>]\n                    List or inspect file and stored custom commands\n/init [notes]       Study the workspace and create or update AGENTS.md (built-in commands prompt)\n/exit or /quit      Save the session and exit\nCtrl+C requests a stop while running; use /retry or enter a new direction afterward.";

/** POSIX `shlex.split`. */
export function shlexSplit(text: string): string[] {
  const words: string[] = [];
  let word = "", active = false, quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote === "'") { if (c === "'") quote = null; else word += c; continue; }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && i + 1 < text.length && '"\\$`\n'.includes(text[i + 1]!)) word += text[++i];
      else word += c;
      continue;
    }
    if (/\s/.test(c)) { if (active) { words.push(word); word = ""; active = false; } continue; }
    active = true;
    if (c === "'" || c === '"') quote = c;
    else if (c === "\\") { if (i + 1 < text.length) word += text[++i]; else throw new Error("No escaped character"); }
    else word += c;
  }
  if (quote) throw new Error("No closing quotation");
  if (active) words.push(word);
  return words;
}

/** Manifest `commands` names: the owners of in-chat slash names and the commands loader's reserved set. */
export function manifestCommands(cli: Cli): Map<string, string> {
  const owners = new Map<string, string>();
  for (const [id, manifest] of loadCatalogManifests(cli.projectRoot)) for (const name of Array.isArray(manifest.commands) ? manifest.commands : []) if (!owners.has(name)) owners.set(name, id);
  return owners;
}

/** `dispatch_slash`: the plugin owning `/name` answers, or null when nobody claims it. */
export async function dispatchSlash(cli: Cli, text: string, ctx: { session: Row | null; root: string }): Promise<string | null> {
  const space = text.indexOf(" ");
  const name = text.slice(1, space < 0 ? undefined : space), argument = space < 0 ? "" : text.slice(space + 1);
  if (!name || name.startsWith("/")) return null;
  const owner = manifestCommands(cli).get(name);
  if (!owner) return null;
  if (!cli.enabled(owner)) return "plugin disabled or dependency unavailable: " + owner;
  if (name === 'goal') {
    if (!ctx.session) return cli.zh('还没有会话目标；先创建会话。', 'Create a session before setting its goal.');
    const input = argument.trim(), split = input.indexOf(' '), action = (split < 0 ? input : input.slice(0, split)) || 'show', value = split < 0 ? '' : input.slice(split + 1).trim();
    const enabled = (id: string) => cli.enabled(id);
    if (action === 'set' || action === 'replace') stageGoal(ctx.session, value, { enabled, replace: action === 'replace', source: 'cli' });
    else if (action === 'pause' || action === 'resume') transitionGoal(ctx.session, action, enabled, 'cli');
    else if (action === 'clear') clearGoal(ctx.session, enabled, 'cli');
    else if (action === 'budget') updateGoalBudget(ctx.session, pyJsonLoads(value), enabled, 'cli');
    else if (action !== 'show') return 'usage: /goal show|set TEXT|replace TEXT|pause|resume|clear|budget JSON';
    if (action !== 'show') await (await cli.store()).save(ctx.session as Session);
    return dumps({ goal: publicGoal(ctx.session) }, 2);
  }
  if (name === "skills" || name === "commands" || name === "mcp") return catalogSlash(cli, name, argument.trim(), ctx);
  if (name === "expert") return handleExpertSlash(argument.trim(), { state_dir: cli.state, session: ctx.session, root: ctx.root }) as unknown as string | null;
  return null;
}

/** `/dwf`: the workflows plugin decides; the chat prints its rows. */
export function reportDynamicRuns(cli: Cli, store: SessionStore, session: Row | null, argument: string): void {
  if (!cli.enabled("workflows")) { err("! " + cli.zh("插件已禁用或依赖不可用: workflows", "workflows plugin is not enabled")); return; }
  let result: Row;
  try { result = dynamicRunsChat(cli.state, store, session ?? {}, argument); }
  catch (error) {
    const payload = typeof (error as Row).payload === "function" ? (error as Row).payload() : null;
    const refusal = payload?.refusal ?? { reason: "invalid", detail: errorText(error) };
    err(`! ${refusal.reason}: ${refusal.detail}`); return;
  }
  const runs = result.runs as Row[] | undefined;
  if (runs === undefined || runs === null) {
    const run = result.run ?? {};
    const label = result.action === "cancel" ? cli.zh("已取消", "Cancelled") : cli.zh("已恢复", "Resumed");
    err(`${label} ${run.name ?? ""} · ${run.status ?? ""}`.replace(/[ ·]+$/, ""));
    return;
  }
  if (!runs.length) { err(cli.zh("（该会话没有动态工作流运行）", "(no dynamic workflow runs)")); return; }
  for (const run of runs) {
    const refusal = run.resumeRefusal ?? {};
    let line = `- ${String(run.id).slice(0, 8)} ${run.name ?? ""} · ${run.status} · ${run.startedAt} → ${run.updatedAt} · ${run.resumable ? "✓" : "✗"}`;
    if (!run.resumable && refusal.reason) line += ` (${refusal.reason})`;
    err(line);
  }
  const summary = cli.zh(`共 ${runs.length} 个运行 · 进行中 ${result.inFlight ?? 0} · 可恢复 ${result.resumable ?? 0}`, `${runs.length} runs · ${result.inFlight ?? 0} in flight · ${result.resumable ?? 0} resumable`);
  err(summary + " · /dwf cancel [runId] · /dwf resume <runId>");
}

/** `/compact`: deterministic compaction now; the refreshed session or null. */
export async function reportCompaction(cli: Cli, store: SessionStore, session: Row | null, argument: string): Promise<Session | null> {
  if (!session) { err("! " + cli.zh("还没有可压缩的会话", "no session to compact yet")); return null; }
  let report: Row;
  try { report = await compactNow(store, String(session.id), argument, { enabled: (id) => cli.enabled(id), source: "chat" }); }
  catch (error) {
    if (error instanceof CompactError) { err(`! ${error.reason}: ${error.detail}`); return store.load(String(session.id)); }
    throw error;
  }
  if (!report.compacted) err("== " + cli.zh("上下文已在预算内，无需压缩", "nothing to compact: the window is already inside its budget"));
  else {
    const b = report.before, a = report.after;
    err(cli.zh(`已压缩：消息 ${b.messages} → ${a.messages} 条，${b.chars} → ${a.chars} 字符，预算 ${report.budget}，归档 ${report.dropped} 条、遮蔽 ${report.masked} 条（原始日志与全部用户发言保留）`,
      `Compacted: ${b.messages} → ${a.messages} messages, ${b.chars} → ${a.chars} chars, budget ${report.budget}, dropped ${report.dropped}, masked ${report.masked}`));
  }
  return store.load(String(session.id));
}

function levelsText(cli: Cli, providerId: string | null, model: string | null, current: string | null): string {
  const levels = declaredReasoningLevels(new ProfileStore(cli.state), providerId, model);
  const head = `当前: ${providerId || "env"} ${model || ""}`;
  return head + "\n" + (levels.length ? "可选档位: " + levels.map((level) => level === current ? `[${level}]` : level).join(" ") : "该模型未声明推理档位");
}

/** `model_switch.chat_switch`: the status line and, when the model changed, the next provider. */
export async function chatSwitch(cli: Cli, host: ApplicationApi, command: string, argument: string, store: SessionStore, session: Row | null): Promise<[string, AgentProvider | null]> {
  const a = cli.args;
  const tokens = argument ? shlexSplit(argument) : [];
  let providerId: string | null = a.provider_id ?? null, model: string | null = a.model ?? null, effort: string | null = a.reasoning_effort ?? null;
  const usage = command === "/effort" ? "/effort list|<level>|save-default" : "/model list|<provider/model>|ID [MODEL]|save-default；env 使用环境配置";
  if (tokens[0] === "save-default" && tokens.length === 1) {
    if (!cli.enabled("providers")) throw new Error("需要启用 providers 插件才能保存默认模型");
    const [status, payload] = await cli.api("POST", "/api/providers/default", { providerId, model, reasoningEffort: effort });
    if (status >= 400) throw new Error(payload?.error ?? "cannot save the default model");
    const saved = payload?.default ?? payload ?? {};
    return [`已设为默认: ${saved.providerId || "env"} ${saved.model || ""} ${saved.reasoningEffort || ""}`, null];
  }
  if (command === "/effort") {
    if (!tokens.length || tokens[0] === "list") return [levelsText(cli, providerId, model, effort), null];
    if (tokens.length !== 1) throw new Error("用法: " + usage);
    effort = tokens[0]!;
  } else {
    if (!tokens.length || tokens[0] === "list") {
      const [, payload] = await cli.api("GET", "/api/providers");
      const current = [providerId, model, effort].filter(Boolean).join(" ");
      return [dumps({ current: current || null, profiles: payload }), null];
    }
    if (tokens.length === 1) [providerId, model] = parseModelTarget(tokens[0]!);
    else if (tokens.length === 2) { [providerId] = parseModelTarget(tokens[0]!); model = tokens[1] || null; }
    else throw new Error("用法: " + usage);
    effort = null;
  }
  const provider = host.agent.resolveProvider({ providerId, model, reasoningEffort: effort, runtimeProfile: a.runtime_profile ?? null }, String(session?.id ?? ""));
  a.provider_id = providerId; a.model = model; a.reasoning_effort = effort;
  if (session) {
    const selected: Row = { provider_id: providerId || null, model: model || null };
    if (effort) selected.reasoning_effort = effort;
    recordModelSwitch(session, currentModelSelection(session), selected, "cli", "next_run");
    session.model_selection = selected;
    session.runtime_profile = a.runtime_profile || provider.runtimeProfile || "standard";
    await store.save(session as Session);
  }
  const target = [providerId || "env", model, effort].filter(Boolean).join(" ");
  return [`${command === "/effort" ? "推理档位已切换" : "模型已切换"}: ${target}`, provider];
}
