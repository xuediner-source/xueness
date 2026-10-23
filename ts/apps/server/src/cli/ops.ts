/**
 * Operator commands (Python settings/usage/memory/git/planning/providers/
 * diagnostics/updates/onboarding `operator_cli`): each prints its owner's
 * reply as indented JSON, or `ERROR …` on stderr with exit 1.
 */
import { homedir } from "node:os";
import { dirname } from "node:path";
import { isDict, pyJsonLoads } from "@xueness/contracts";
import { OpenAICompatible } from "@xueness/providers";
import { doctor } from "@xueness/plugin-diagnostics";
import { dispatchClone } from "@xueness/plugin-git";
import { configurationError, discoverModels, loadDefault, ProfileStore, resolveSavedProvider } from "@xueness/plugin-providers";
import { SECTION_IDS } from "@xueness/plugin-settings";
import { apply, check } from "@xueness/plugin-updates";
import type { Parser } from "./argparse.ts";
import { type Cli, dumps, err, errorText, out, pyPath, type Reply } from "./host.ts";
import { hiddenPrompt, visiblePrompt } from "./input.ts";

type Sub = ReturnType<Parser["subparsers"]>;
type Row = Record<string, any>;
const GIT_SUBCOMMANDS = ["turn-checkpoints", "rewind", "clone"], GIT_VERBS = ["status", "diff", "log"];
const enc = encodeURIComponent;
const message = (error: unknown): string => error instanceof Error ? error.message : errorText(error);

function jsonObject(raw: string): Row {
  let parsed: unknown;
  try { parsed = pyJsonLoads(raw, { rejectNonFinite: true }); } catch { throw new Error("expected a JSON object with finite numbers"); }
  if (!isDict(parsed)) throw new Error("expected a JSON object");
  return parsed;
}

export function register(sub: Sub): void {
  sub.add("settings", "show stored settings (all sections or one)").add("section", { nargs: "?", default: null, choices: SECTION_IDS });
  const set = sub.add("settings-set", "set one key in a settings section (value parsed as JSON, fallback string)");
  set.add("section", { choices: SECTION_IDS }).add("key").add("value");
  sub.add("usage", "usage summary from local journals").add("--range", { dest: "range_param", default: "7d", choices: ["7d", "30d", "all"] });
  sub.add("memory-tracks", "memory track metadata (needs XUENESS_MEMORY_ROOT in the environment)");
  const git = sub.add("git", "git status/diff/log, turn checkpoints, rewind and clone");
  git.add("target", { help: "session id to inspect, or one of: " + GIT_SUBCOMMANDS.join(", ") });
  git.add("rest", { nargs: "*", metavar: "[verb|url dest]", help: "status, diff or log for a session; the remote and destination for clone" });
  git.add("--session", { help: "session id for a subcommand" }).add("--checkpoint", { help: "turn checkpoint id to rewind to" });
  git.add("--latest", { action: "store_true", help: "rewind to the newest turn checkpoint" });
  git.add("--root", { help: "refuse unless the session workspace, or a clone destination's parent, resolves here" });
  git.add("--confirmed", { action: "store_true", help: "acknowledge that the operation writes to this machine" });
  const goal = sub.add("goal", "show, set, replace or clear a session goal");
  goal.add("--session", { required: true, help: "session id" });
  goal.add("action", { nargs: "?", default: "show", choices: ["show", "set", "replace", "clear", "pause", "resume", "budget"], help: "show, set, replace, clear, pause, resume or replace the budget" });
  goal.add("text", { nargs: "*", help: "goal text for set/replace" });
  goal.add('--budget', { type: jsonObject, default: null, help: 'complete goal budget JSON: maxRounds, maxWallSeconds, maxTokens; {} removes limits' });
  const providers = sub.add("providers", "manage saved model profiles; keys are never printed").subparsers("action", true);
  providers.add("list");
  const save = providers.add("save");
  save.add("id").add("--name").add("--base-url", { required: true }).add("--model", { required: true });
  save.add("--protocol", { choices: ["openai", "anthropic"], default: null, help: "messages protocol; defaults to the existing profile or OpenAI-compatible" });
  save.add("--capabilities", { default: null, metavar: "LIST", help: "optional comma-separated model input capabilities: image,pdf,video" });
  save.add("--reasoning-levels", { default: null, metavar: "LIST", help: "optional comma-separated OpenAI reasoning levels: none,minimal,low,medium,high,xhigh" });
  save.add("--runtime-profile", { choices: ["standard", "lightweight"], default: null, help: "runtime resource profile; lightweight is intended for local/small models" });
  save.add("--context-window", { type: "int", default: null, help: "model context window in tokens (2048..262144)" });
  save.add("--max-output-tokens", { type: "int", default: null, help: "maximum generated tokens (128..32768, at most half the context window)" });
  save.add("--tool-calling", { choices: ["native", "json"], default: null, help: "native API tools or lightweight JSON tool protocol" });
  save.add("--lightweight-options", { type: jsonObject, default: null, metavar: "JSON", help: "complete lightweight settings object; replaces prior values, use '{}' to clear" });
  save.add("--no-stream-usage", { action: "store_true", help: "omit stream_options.include_usage for compatibility" });
  save.add("--key-env", { help: "environment variable holding the API key; omit to keep existing key" });
  providers.add("discover", "explicitly list model IDs exposed by a saved OpenAI-compatible profile").add("id");
  const doctorCommand = sub.add("doctor", "read-only health report: plugins, storage, model configuration");
  doctorCommand.add("--root", { default: null, help: "workspace directory to probe (default: current directory)" });
  doctorCommand.add("--ping", { action: "store_true", help: "explicitly send one bounded model-discovery request to the configured provider (the default report sends no request)" });
  doctorCommand.add("--json", { action: "store_true", help: "machine-readable output on stdout" });
  const update = sub.add("update", "check or explicitly apply a source update from configured origin").subparsers("update_action", true);
  update.add("check", "compare the current branch with its configured origin");
  update.add("apply", "fast-forward a clean checkout after explicit authorization").add("--allow-update", { action: "store_true", help: "authorize fetching and fast-forwarding this source checkout" });
  const wizard = sub.add("onboarding", "configure the first local model profile");
  for (const flag of ["--id", "--name", "--base-url", "--model"]) wizard.add(flag, { default: null });
  wizard.add("--protocol", { choices: ["openai", "anthropic"], default: null });
  wizard.add("--capabilities", { default: null, help: "optional comma-separated image,pdf,video input capabilities" });
  wizard.add("--api-key-env", { default: null, help: "read the key from this environment variable instead of a hidden prompt" });
}

export async function execute(cli: Cli): Promise<number | null> {
  const a = cli.args;
  switch (a.cmd) {
    case "settings": return cli.report(await cli.api("GET", "/api/settings" + (a.section ? "/" + a.section : "")));
    case "settings-set": {
      let value: unknown;
      try { value = pyJsonLoads(String(a.value)); } catch { value = a.value; }
      return cli.report(await cli.api("POST", "/api/settings/" + a.section, { values: { [a.key]: value } }));
    }
    case "usage": return cli.report(await cli.api("GET", "/api/usage", {}, { range: [a.range_param] }));
    case "memory-tracks": return cli.report(await cli.api("GET", "/api/memory/tracks"));
    case "git": return gitCommand(cli);
    case "goal": return goalCommand(cli);
    case "providers": return providersCommand(cli);
    case "doctor": return doctorReport(cli);
    case "update":
      try {
        if (a.update_action !== "check" && !a.allow_update) throw new Error("apply requires --allow-update");
        out(dumps(a.update_action === "check" ? await check(cli.projectRoot) : await apply(cli.projectRoot), 2));
        return 0;
      } catch (error) { err(dumps({ error: message(error) })); return 1; }
    case "onboarding": return onboarding(cli);
    default: return null;
  }
}

async function gitCommand(cli: Cli): Promise<number> {
  const a = cli.args, rest: string[] = a.rest ?? [];
  if (a.target === "clone") {
    if (rest.length !== 2) { err("ERROR: git clone requires <url> <dest>"); return 1; }
    const [url, dest] = rest as [string, string];
    const data: Row = { url, dest, confirmed: a.confirmed };
    if (a.root != null) data.root = pyPath(a.root);
    const expanded = dest === "~" || dest.startsWith("~/") ? homedir() + dest.slice(1) : dest;
    return cli.report(await dispatchClone({ allowedRoots: () => [dirname(expanded)] }, "POST", data) as Reply);
  }
  if (GIT_SUBCOMMANDS.includes(a.target)) {
    if (!a.session) { err("ERROR: --session is required"); return 1; }
    const base = `/api/sessions/${enc(a.session)}/git/turn-checkpoints`;
    if (a.target === "turn-checkpoints") return cli.report(await cli.api("GET", base));
    if (Boolean(a.checkpoint) === Boolean(a.latest)) { err("ERROR: exactly one of --checkpoint or --latest is required"); return 1; }
    const data: Row = { confirmed: a.confirmed, checkpoint: a.checkpoint || null, latest: a.latest };
    if (a.root != null) data.root = pyPath(a.root);
    return cli.report(await cli.api("POST", base + "/rewind", data));
  }
  if (rest.length !== 1 || !GIT_VERBS.includes(rest[0]!)) { err("ERROR: expected one of " + GIT_VERBS.join(", ")); return 1; }
  return cli.report(await cli.api("GET", `/api/sessions/${enc(a.target)}/git/${rest[0]}`));
}

async function goalCommand(cli: Cli): Promise<number> {
  const a = cli.args;
  let method = "GET", data: Row = {};
  if (a.action === "set" || a.action === "replace") {
    const text = (a.text as string[]).join(" ").trim();
    if (!text) { err(`ERROR: goal ${a.action} requires non-empty text`); return 1; }
    method = "POST"; data = { text, replace: a.action === "replace" };
  } else if (a.action === "clear") method = "DELETE";
  else if (a.action === "pause" || a.action === "resume") { method = "POST"; data = { action: a.action }; }
  else if (a.action === 'budget') {
    if (a.budget === null) { err('ERROR: goal budget requires --budget JSON'); return 1; }
    method = 'POST'; data = { action: 'budget' };
  }
  if (a.budget !== null) {
    if (!['set', 'replace', 'budget'].includes(a.action)) { err('ERROR: --budget requires set, replace or budget'); return 1; }
    data.budget = a.budget;
  }
  return cli.report(await cli.api(method, `/api/sessions/${enc(String(a.session))}/goal`, data));
}

async function providersCommand(cli: Cli): Promise<number> {
  const a = cli.args;
  let reply: Reply;
  if (a.action === "list") reply = await cli.api("GET", "/api/providers");
  else if (a.action === "save") {
    const list = (value: string): string[] => value.split(",").map((item) => item.trim()).filter(Boolean);
    const data: Row = { id: a.id, name: a.name || a.id, baseUrl: a.base_url, model: a.model };
    if (a.protocol) data.protocol = a.protocol;
    if (a.capabilities != null) data.capabilities = list(a.capabilities);
    if (a.reasoning_levels != null) data.reasoningLevels = list(a.reasoning_levels);
    if (a.runtime_profile != null) data.runtimeProfile = a.runtime_profile;
    if (a.context_window != null) data.contextWindow = a.context_window;
    if (a.max_output_tokens != null) data.maxOutputTokens = a.max_output_tokens;
    if (a.tool_calling != null) data.toolCalling = a.tool_calling;
    if (a.lightweight_options != null) data.lightweightOptions = a.lightweight_options;
    if (a.no_stream_usage) data.compatibility = { streamUsage: false };
    if (a.key_env) {
      if (!process.env[a.key_env]) throw new Error("key environment variable is empty");
      data.apiKey = process.env[a.key_env];
    }
    reply = await cli.api("POST", "/api/providers", data);
  } else reply = await cli.api("POST", "/api/providers/discover", { id: a.id });
  if (reply[0] !== 200) throw new Error(String(reply[1]?.error));
  out(dumps(reply[1], 2));
  return 0;
}

const LABELS = {
  zh: { title: "Xueness doctor（只读体检）", version: "版本", plugins: "插件", effective: "生效", blocked: "未生效", storage: "存储", writable: "可写", not_writable: "不可写", missing: "不存在", symlink: "符号链接", model: "模型", profiles: "个 profile", resolvable: "解析通过", unresolvable: "解析失败", env: "环境变量配置", no_default: "未设默认", ping_ok: "ping 通过", ping_fail: "ping 失败", overall: "整体", pass: "通过", fail: "存在问题" },
  en: { title: "Xueness doctor (read-only)", version: "version", plugins: "plugins", effective: "effective", blocked: "not effective", storage: "storage", writable: "writable", not_writable: "not writable", missing: "missing", symlink: "symlink", model: "model", profiles: "profiles", resolvable: "resolves", unresolvable: "does not resolve", env: "environment configuration", no_default: "no default", ping_ok: "ping ok", ping_fail: "ping failed", overall: "overall", pass: "pass", fail: "problems found" },
};

/** `doctor.report`: plugins, storage probes and the model target, plus an optional bounded ping. */
async function doctorReport(cli: Cli): Promise<number> {
  const a = cli.args, store = new ProfileStore(cli.state);
  let plugins: Row;
  const [status, payload] = await cli.api("GET", "/api/plugins");
  if (status >= 400 || !Array.isArray(payload?.plugins)) plugins = { installed: 0, effective: 0, blocked: [], configurationError: "plugin catalog is unavailable" };
  else {
    const items = payload.plugins as Row[];
    plugins = { installed: items.length, effective: items.filter((item) => item.effective).length,
      blocked: items.filter((item) => !item.effective).map((item) => ({ id: item.id, enabled: item.enabled, blockedBy: [...(item.blockedBy ?? [])] })),
      configurationError: items.find((item) => item.configurationError)?.configurationError ?? null };
  }
  let profiles: Row[] = [];
  try { profiles = store.listAll(); } catch { profiles = []; }
  const envConfigured = Boolean(process.env.XUENESS_API_BASE) && Boolean(process.env.XUENESS_MODEL);
  const model: Row = { profiles: profiles.map((item) => ({ id: item.id ?? null, model: item.model ?? null, protocol: item.protocol ?? "openai", hasKey: Boolean(item.hasKey) })), default: null, envConfigured, ping: null };
  let provider: unknown = null;
  try {
    const selection = loadDefault(store);
    model.default = Object.keys(selection).length ? selection : null;
    if (Object.keys(selection).length || (!profiles.length && envConfigured)) provider = resolveSavedProvider(store);
    else if (profiles.length) provider = resolveSavedProvider(store, { providerId: String(profiles[0]!.id) });
    else throw new Error("XUENESS_MODEL and XUENESS_API_KEY must be set");
    Object.assign(model, { resolvable: true, error: null });
  } catch (error) { provider = null; Object.assign(model, { resolvable: false, error: configurationError(error) }); }
  if (a.ping) model.ping = !cli.enabled("providers") ? { ok: false, error: "providers plugin is disabled" }
    : provider === null ? { ok: false, error: model.error }
      : !(provider instanceof OpenAICompatible) ? { ok: false, error: "model discovery is not supported for this protocol" }
        : await discoverModels(provider, 5).then((models) => ({ ok: true, models: Array.isArray(models) ? models.length : null }), () => ({ ok: false, error: "provider model discovery failed (details suppressed)" }));
  let document: Row;
  try { document = await doctor({ stateDir: cli.state, ...(a.root != null ? { workspace: String(a.root) } : {}) }); }
  catch (error) { err("ERROR: " + message(error)); return 1; }
  const storage = document.storage as Row, pingOk = model.ping === null || model.ping.ok === true;
  Object.assign(document, { plugins, model, ok: Boolean(storage.stateDir.writable && storage.workspace.writable && model.resolvable && pingOk && !plugins.configurationError) });
  out(a.json ? dumps(document, 2) : formatReport(document, cli.language));
  return document.ok ? 0 : 1;
}

function formatReport(document: Row, language: string): string {
  const label = language === "en" ? LABELS.en : LABELS.zh;
  const v = document.version, plugins = document.plugins, storage = document.storage, model = document.model;
  const stateLabel = (probe: Row): string => probe.symlink ? label.symlink : !probe.exists ? label.missing : probe.writable ? label.writable : label.not_writable;
  const lines = [label.title, `${label.version}: xueness ${v.xueness}（Python ${v.python}, ${v.system}/${v.machine}）`, `${label.plugins}: ${plugins.installed}，${label.effective} ${plugins.effective}`];
  for (const row of plugins.blocked) lines.push(`  ${label.blocked}: ${row.id}（${!row.enabled ? "enabled=False" : "blockedBy=" + row.blockedBy.join(",")}）`);
  if (plugins.configurationError) lines.push("  configurationError: " + plugins.configurationError);
  lines.push(`${label.storage}: ${storage.stateDir.path} ${stateLabel(storage.stateDir)}；${storage.workspace.path} ${stateLabel(storage.workspace)}`);
  const d = model.default, defaultText = d ? `${d.providerId || label.no_default} / ${d.model || ""}` : label.no_default;
  lines.push(`${label.model}: ${model.profiles.length} ${label.profiles}；${defaultText}；${model.resolvable ? label.resolvable : `${label.unresolvable}: ${model.error || ""}`}`);
  if (!model.profiles.length && model.envConfigured) lines.push("  " + label.env);
  if (model.ping != null) lines.push("  " + (model.ping.ok ? label.ping_ok : `${label.ping_fail} (${model.ping.error || ""})`));
  lines.push(`${label.overall}: ${document.ok ? label.pass : label.fail}`);
  return lines.join("\n");
}

/** `onboarding.execute_cli`: prompts for missing profile fields and a hidden key, then saves the profile. */
async function onboarding(cli: Cli): Promise<number> {
  const a = cli.args, en = cli.language === "en";
  const value = async (provided: string | null, prompt: string, fallback?: string | null): Promise<string> => {
    if (provided != null) return provided.trim();
    return (await visiblePrompt(fallback ? `${prompt} [${fallback}]: ` : `${prompt}: `)).trim() || (fallback || "");
  };
  try {
    const tty = process.stdin.isTTY === true;
    if (!tty && !a.api_key_env) throw new Error("a hidden key prompt needs a terminal; use --api-key-env for noninteractive setup");
    if (!tty && ["id", "name", "protocol", "base_url", "model"].some((name) => a[name] == null)) throw new Error("interactive configuration needs a terminal; supply all profile flags");
    const id = await value(a.id, en ? "Profile id" : "配置 ID", "default");
    const existing: Row = new ProfileStore(cli.state).listAll().find((item) => item.id === id) ?? {};
    const protocol = await value(a.protocol, en ? "Protocol (openai/anthropic)" : "协议 (openai/anthropic)", existing.protocol ?? "openai");
    const defaultUrl = existing.baseUrl || (protocol === "anthropic" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1");
    const data: Row = { id, name: await value(a.name, en ? "Display name" : "显示名称", existing.name ?? "Default provider"), protocol,
      baseUrl: await value(a.base_url, en ? "API base URL" : "API 地址", defaultUrl), model: await value(a.model, en ? "Model name" : "模型名称", existing.model) };
    if (a.capabilities != null) data.capabilities = String(a.capabilities).split(",").map((item) => item.trim()).filter(Boolean);
    let key = a.api_key_env ? process.env[a.api_key_env] ?? "" : "";
    if (a.api_key_env && !key) throw new Error("the selected API key environment variable is empty");
    if (!key) key = await hiddenPrompt(en ? "API key (input hidden; Enter keeps an existing key): " : "API 密钥（输入不回显；回车保留现有密钥）：");
    if (key) data.apiKey = key;
    const [status, result] = await cli.api("POST", "/api/providers", data);
    if (status >= 400) throw new Error(result?.error ?? "provider profile could not be saved");
    err(en ? "Provider profile saved; the key is never displayed." : "模型配置已保存；密钥不会显示。");
    out(dumps(result, 2));
    return 0;
  } catch (error) {
    err("ERROR: " + (message(error) || (en ? "Setup cancelled" : "设置已取消")));
    return 1;
  }
}
