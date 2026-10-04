import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, Folder, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { createResource, deleteResource, listResources, listProviders, patchResource } from "../../xuenessApi";
import type { ProviderSummary, ResourceItem } from "../../xuenessApi";
import { Select } from "../../ui/Select";
import { useLocale, type Locale } from "../../i18n";
import "../../styles/operations.css";
import "../../styles/subagent-settings.css";

export const SUBAGENT_COLORS = ["yellow", "red", "orange", "green", "cyan", "blue", "purple", "pink"] as const;
export type SubagentColor = (typeof SUBAGENT_COLORS)[number];

/** These are actual Xueness tool-registry names, so the saved whitelist is executable. */
export const SUBAGENT_TOOL_OPTIONS = [
  "read", "list", "glob", "grep", "read_session_context", "write", "edit", "exec",
  "todo_read", "todo_write", "ask_user", "workflow_create", "workflow_amend",
  "workflow_run", "workflow_status", "background_exec", "background_status",
  "background_cancel", "background_logs", "workflow_answer_actor", "web_fetch",
  "web_search", "browser_navigate", "browser_inspect", "browser_click", "browser_fill",
  "browser_screenshot", "remote_exec",
] as const;

export type SubagentResource = ResourceItem & {
  name?: string;
  description?: string;
  systemPrompt?: string;
  enabled?: boolean;
  color?: string;
  providerId?: string;
  model?: string;
  reasoningEffort?: string;
  tools?: unknown;
};

export type SubagentDraft = {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  color: SubagentColor;
  providerId: string;
  model: string;
  reasoningEffort: string;
  toolsMode: "all" | "custom";
  tools: string[];
  preservedTools: string[];
  enabled: boolean;
};

const COPY = {
  title: ["子智能体", "Subagents"],
  description: ["为不同类型的委托任务配置提示词、模型和工具范围。", "Configure prompts, models, and tool access for delegated tasks."],
  refresh: ["刷新子智能体", "Refresh subagents"],
  search: ["搜索子智能体", "Search subagents"],
  globalScope: ["全局", "Global"],
  noMatches: ["没有匹配的子智能体", "No matching subagents"],
  add: ["新建", "New"],
  empty: ["还没有子智能体", "No subagents yet"],
  emptyHint: ["创建一个子智能体，让主任务可以把专门的工作委托给它。", "Create a subagent for the main task to delegate focused work to."],
  loading: ["正在加载子智能体…", "Loading subagents…"],
  name: ["名称", "Name"],
  id: ["ID", "ID"],
  descriptionField: ["描述", "Description"],
  color: ["颜色", "Color"],
  model: ["模型配置", "Model profile"],
  inheritModel: ["继承当前任务模型", "Inherit current task model"],
  modelOverride: ["模型 ID 覆盖（可选）", "Model ID override (optional)"],
  modelInheritHint: ["留空时使用当前任务的模型。选择配置后，留空使用该配置的模型。", "Leave blank to use the current task model. With a profile selected, blank uses that profile’s model."],
  providersDisabled: ["供应商插件已停用；已保存的配置会保留，启用供应商插件后可重新选择。", "The providers plugin is disabled. Saved selections are preserved; enable it to choose a profile."],
  reasoning: ["推理等级", "Reasoning effort"],
  defaultReasoning: ["模型默认", "Model default"],
  tools: ["工具", "Tools"],
  allTools: ["继承全部工具", "Inherit all tools"],
  customTools: ["自定义工具白名单", "Custom tool allowlist"],
  toolsHint: ["子智能体仍受只读运行权限限制；选择工具不会提升权限。", "Subagents keep the read-only runtime boundary; selecting a tool does not grant new permissions."],
  prompt: ["系统提示词", "System prompt"],
  promptPlaceholder: ["描述这个子智能体的职责、工作方式和输出格式。", "Describe this subagent’s role, approach, and output format."],
  enabled: ["启用", "Enabled"],
  enabledAria: ["启用子智能体", "Enable subagent"],
  save: ["保存", "Save"],
  cancel: ["取消", "Cancel"],
  delete: ["删除", "Delete"],
  saveNew: ["创建子智能体", "Create subagent"],
  edit: ["编辑子智能体", "Edit subagent"],
  all: ["全部工具", "All tools"],
  toolCount: ["{0} 个工具", "{0} tools"],
  missingName: ["请输入名称。", "Enter a name."],
  missingDescription: ["请输入子智能体描述。", "Enter a subagent description."],
  missingPrompt: ["请输入子智能体提示词。", "Enter a subagent prompt."],
  missingId: ["请输入有效 ID（字母、数字、点、下划线或连字符）。", "Enter a valid ID using letters, numbers, dots, underscores, or hyphens."],
  deleteConfirm: ["删除此子智能体？此操作无法从设置中撤销。", "Delete this subagent? This cannot be undone from settings."],
  profileUnavailable: ["模型配置不可用", "Model profile unavailable"],
  missingProfileKey: ["未配置密钥", "API key missing"],
  colorNames: ["黄色", "红色", "橙色", "绿色", "青色", "蓝色", "紫色", "粉色"],
  toolLabelsZh: ["读取文件", "列出文件", "路径匹配", "内容搜索", "读取历史", "写入文件", "编辑文件", "执行命令", "读取待办", "更新待办", "询问用户", "创建工作流", "修改工作流", "运行工作流", "查看工作流", "后台执行", "查看后台任务", "取消后台任务", "查看后台日志", "回复工作流", "网页读取", "网页搜索", "浏览器导航", "检查页面", "点击页面", "填写页面", "页面截图", "远程命令"],
} as const;

function copy(locale: Locale, key: keyof typeof COPY): string {
  return COPY[key][locale === "en" ? 1 : 0];
}

export function makeSubagentPayload(draft: SubagentDraft): Record<string, unknown> {
  const tools = draft.toolsMode === "all"
    ? ["*"]
    : [...new Set([...draft.tools, ...draft.preservedTools].filter(Boolean))];
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    systemPrompt: draft.systemPrompt.trim(),
    color: draft.color,
    providerId: draft.providerId.trim(),
    model: draft.model.trim(),
    reasoningEffort: draft.reasoningEffort,
    tools,
    enabled: draft.enabled,
  };
}

export function slugifySubagentId(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

function emptyDraft(): SubagentDraft {
  return { id: "", name: "", description: "", systemPrompt: "", color: "yellow", providerId: "", model: "", reasoningEffort: "", toolsMode: "all", tools: [], preservedTools: [], enabled: true };
}

export function draftFromResource(item: SubagentResource): SubagentDraft {
  const toolsConfigured = item.tools !== undefined && item.tools !== null;
  const rawTools = Array.isArray(item.tools) ? item.tools.filter((value): value is string => typeof value === "string") : [];
  const inheritAll = !toolsConfigured || rawTools.some(value => value.trim() === "*");
  const knownTools = new Set<string>(SUBAGENT_TOOL_OPTIONS);
  return {
    id: item.id,
    name: typeof item.name === "string" ? item.name : item.id,
    description: typeof item.description === "string" ? item.description : "",
    systemPrompt: typeof item.systemPrompt === "string" ? item.systemPrompt : "",
    color: SUBAGENT_COLORS.includes(item.color as SubagentColor) ? item.color as SubagentColor : "yellow",
    providerId: typeof item.providerId === "string" ? item.providerId : "",
    model: typeof item.model === "string" ? item.model : "",
    reasoningEffort: typeof item.reasoningEffort === "string" ? item.reasoningEffort : "",
    toolsMode: inheritAll ? "all" : "custom",
    tools: inheritAll ? [] : rawTools.filter(value => knownTools.has(value)),
    preservedTools: inheritAll ? [] : rawTools.filter(value => !knownTools.has(value)),
    enabled: item.enabled !== false,
  };
}

const REASONING_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const COLOR_DOT: Record<SubagentColor, string> = {
  yellow: "#f4c95d", red: "#e66b74", orange: "#ef9851", green: "#58b889",
  cyan: "#53b9c8", blue: "#6399e8", purple: "#a17be0", pink: "#df79ad",
};

function knownReasoningLevels(model: string): string[] {
  const normalized = model.trim().toLowerCase();
  if (["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"].some(prefix => normalized === prefix || normalized.startsWith(prefix + "-"))) {
    return ["low", "medium", "high", "xhigh", "max"];
  }
  if (["o3", "o4"].some(prefix => normalized === prefix || normalized.startsWith(prefix + "-"))) {
    return ["low", "medium", "high"];
  }
  return [];
}

type SubagentResourceList = Awaited<ReturnType<typeof listResources>>;
type ProviderList = Awaited<ReturnType<typeof listProviders>>;
type Settled<T> = PromiseSettledResult<T>;

/** A latest-request loader whose provider read is omitted when that plugin is unavailable. */
export function createSubagentSettingsLoader(
  readResources: () => Promise<SubagentResourceList> = () => listResources("subagents"),
  readProviders: () => Promise<ProviderList> = listProviders,
) {
  let generation = 0;
  return {
    invalidate() { generation += 1; },
    async load(providersEnabled: boolean): Promise<{
      resourcesResult: Settled<SubagentResourceList>;
      providersResult: Settled<ProviderList | null>;
    } | null> {
      const request = ++generation;
      const providerRead = providersEnabled ? readProviders() : Promise.resolve(null);
      const [resourcesResult, providersResult] = await Promise.allSettled([
        readResources(), providerRead,
      ] as const);
      if (request !== generation) return null;
      return { resourcesResult, providersResult };
    },
  };
}

export function XuenessSubagentSettings({ providersEnabled }: { providersEnabled: boolean }): React.JSX.Element {
  const locale = useLocale();
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const [items, setItems] = useState<SubagentResource[]>([]);
  const [query, setQuery] = useState("");
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [profileError, setProfileError] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<SubagentDraft | null>(null);
  const [idTouched, setIdTouched] = useState(false);
  const loader = useRef<ReturnType<typeof createSubagentSettingsLoader> | null>(null);
  if (!loader.current) loader.current = createSubagentSettingsLoader();
  const mounted = useRef(false);
  const providersEnabledRef = useRef(providersEnabled);
  providersEnabledRef.current = providersEnabled;

  const refresh = useCallback(async () => {
    if (!mounted.current || !loader.current) return;
    setLoading(true);
    setError("");
    const enabledForRequest = providersEnabledRef.current;
    const result = await loader.current.load(enabledForRequest);
    if (!result || !mounted.current) return;
    const { resourcesResult, providersResult } = result;
    if (resourcesResult.status === "fulfilled") {
      const rows = resourcesResult.value.items.filter((item): item is SubagentResource =>
        typeof item.id === "string" && item.id.trim().length > 0,
      ).sort((a, b) => a.id.localeCompare(b.id));
      setItems(rows);
    } else {
      setError(resourcesResult.reason instanceof Error ? resourcesResult.reason.message : String(resourcesResult.reason));
    }
    if (!enabledForRequest) {
      setProviders([]);
      setProfileError("");
    } else if (providersResult.status === "fulfilled" && providersResult.value) {
      setProviders(providersResult.value.providers);
      setProfileError("");
    } else {
      setProviders([]);
      const reason = providersResult.status === "rejected" ? providersResult.reason : copy(localeRef.current, "profileUnavailable");
      setProfileError(reason instanceof Error ? reason.message : String(reason));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      loader.current?.invalidate();
    };
  }, []);

  useEffect(() => {
    if (!providersEnabled) {
      setProviders([]);
      setProfileError("");
    }
    void refresh();
    return () => { loader.current?.invalidate(); };
  }, [refresh, providersEnabled]);

  const effectiveProviders = providersEnabled ? providers : [];

  const startCreate = () => {
    setEditingId(null);
    setDraft(emptyDraft());
    setIdTouched(false);
    setError("");
  };
  const startEdit = (item: SubagentResource) => {
    setEditingId(item.id);
    setDraft(draftFromResource(item));
    setIdTouched(true);
    setError("");
  };
  const cancel = () => { setDraft(null); setEditingId(null); setError(""); };
  const selectedProvider = effectiveProviders.find(provider => provider.id === draft?.providerId);
  const reasoningLevels = selectedProvider
    ? selectedProvider.protocol === "anthropic"
      ? []
      : selectedProvider.reasoningLevels ?? knownReasoningLevels(draft?.model || selectedProvider.model)
    : knownReasoningLevels(draft?.model || "");
  const modelSupportsReasoning = reasoningLevels.length > 0;

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft || busy) return;
    const id = draft.id.trim();
    if (!draft.name.trim()) { setError(copy(locale, "missingName")); return; }
    if (!draft.description.trim()) { setError(copy(locale, "missingDescription")); return; }
    if (!draft.systemPrompt.trim()) { setError(copy(locale, "missingPrompt")); return; }
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(id) || id === "." || id.includes("..")) { setError(copy(locale, "missingId")); return; }
    setBusy(true); setError("");
    try {
      const payload = makeSubagentPayload(draft);
      if (editingId) await patchResource("subagents", editingId, payload);
      else await createResource("subagents", { id, ...payload, createOnly: true });
      if (!mounted.current) return;
      await refresh();
      if (!mounted.current) return;
      setDraft(null); setEditingId(null);
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally { if (mounted.current) setBusy(false); }
  };

  const toggleEnabled = async (item: SubagentResource, enabled: boolean) => {
    setBusy(true); setError("");
    try { await patchResource("subagents", item.id, { enabled }); if (mounted.current) await refresh(); }
    catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (mounted.current) setBusy(false); }
  };

  const remove = async (item: SubagentResource) => {
    if (!window.confirm(copy(locale, "deleteConfirm"))) return;
    setBusy(true); setError("");
    try { await deleteResource("subagents", item.id); if (!mounted.current) return; if (editingId === item.id) cancel(); await refresh(); }
    catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (mounted.current) setBusy(false); }
  };

  const setDraftField = <K extends keyof SubagentDraft>(key: K, value: SubagentDraft[K]) => {
    setDraft(current => current ? { ...current, [key]: value } : current);
  };
  const visibleItems = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return items.filter(item => [item.id, item.name, item.description].some(value => String(value ?? "").toLocaleLowerCase().includes(term)));
  }, [items, query]);

  return <div className="xn-subagent-settings xn-operations" data-testid="subagent-settings">
    {error && <div role="alert">{error}</div>}
    {providersEnabled && profileError && <div className="xn-subagent-settings__profile-error" role="status">{copy(locale, "profileUnavailable")}: {profileError}</div>}
    {!providersEnabled && <div className="xn-subagent-settings__profile-error" role="status">{copy(locale, "providersDisabled")}</div>}

    {draft ? <form className="xn-subagent-settings__form" onSubmit={save}>
      <header><div><h3>{editingId ? copy(locale, "edit") : copy(locale, "saveNew")}</h3>{editingId && <p>{editingId}</p>}</div></header>
      <div className={`xn-subagent-settings__top-grid${editingId ? " xn-subagent-settings__top-grid--edit" : ""}`}>
        {!editingId && <label className="xn-subagent-settings__field"><span>{copy(locale, "id")}</span><input required value={draft.id} onChange={event => { setIdTouched(true); setDraftField("id", event.target.value); }} /></label>}
        <label className="xn-subagent-settings__field"><span>{copy(locale, "name")}</span><input required autoFocus={!editingId} value={draft.name} onChange={event => { const name = event.target.value; setDraft(current => current ? { ...current, name, id: !editingId && !idTouched ? slugifySubagentId(name) : current.id } : current); }} /></label>
        <div className="xn-subagent-settings__field"><span>{copy(locale, "color")}</span><div className="xn-subagent-settings__colors" role="radiogroup" aria-label={copy(locale, "color")}>{SUBAGENT_COLORS.map((color, index) => <button type="button" key={color} role="radio" aria-checked={draft.color === color} aria-label={locale === "en" ? color : COPY.colorNames[index]} title={locale === "en" ? color : COPY.colorNames[index]} style={{ "--xn-subagent-color": COLOR_DOT[color] } as React.CSSProperties} onClick={() => setDraftField("color", color)}><i /></button>)}</div></div>
      </div>

      <label className="xn-subagent-settings__field"><span>{copy(locale, "descriptionField")}</span><input required value={draft.description} onChange={event => setDraftField("description", event.target.value)} /></label>

      <section className="xn-subagent-settings__section"><h4>{copy(locale, "model")}</h4><p>{copy(locale, "modelInheritHint")}</p>
        <div className="xn-subagent-settings__model-grid">
          <label className="xn-subagent-settings__field"><span>{copy(locale, "model")}</span><Select aria-label={copy(locale, "model")} value={draft.providerId} disabled={!providersEnabled || busy || effectiveProviders.length === 0} onChange={event => setDraft(current => current ? { ...current, providerId: event.target.value, model: "", reasoningEffort: "" } : current)}>
            <option value="">{copy(locale, "inheritModel")}</option>{draft.providerId && !effectiveProviders.some(provider => provider.id === draft.providerId) && <option value={draft.providerId} disabled>{draft.providerId} · {copy(locale, providersEnabled ? "profileUnavailable" : "providersDisabled")}</option>}{effectiveProviders.map(provider => <option key={provider.id} value={provider.id} disabled={!provider.hasKey}>{provider.name} · {provider.model}{provider.hasKey ? "" : ` · ${copy(locale, "missingProfileKey")}`}</option>)}
          </Select></label>
          <label className="xn-subagent-settings__field"><span>{copy(locale, "modelOverride")}</span><input value={draft.model} placeholder={selectedProvider?.model || copy(locale, "inheritModel")} onChange={event => setDraftField("model", event.target.value)} /></label>
          <label className="xn-subagent-settings__field"><span>{copy(locale, "reasoning")}</span><Select aria-label={copy(locale, "reasoning")} value={draft.reasoningEffort} disabled={busy || !modelSupportsReasoning} onChange={event => setDraftField("reasoningEffort", event.target.value)}>
            <option value="">{copy(locale, "defaultReasoning")}</option>{(reasoningLevels.length ? reasoningLevels : REASONING_LEVELS).map(level => <option key={level} value={level}>{level}</option>)}
          </Select></label>
        </div>
      </section>

      <section className="xn-subagent-settings__section"><h4>{copy(locale, "tools")}</h4>
        <label className="xn-subagent-settings__mode"><Select aria-label={copy(locale, "tools")} value={draft.toolsMode} disabled={busy} onChange={event => { const mode = event.target.value as "all" | "custom"; setDraft(current => current ? { ...current, toolsMode: mode, tools: mode === "custom" && current.tools.length === 0 ? [...SUBAGENT_TOOL_OPTIONS] : current.tools } : current); }}><option value="all">{copy(locale, "allTools")}</option><option value="custom">{copy(locale, "customTools")}</option></Select><small>{copy(locale, "toolsHint")}</small></label>
        {draft.toolsMode === "custom" && <div className="xn-subagent-settings__tool-grid" role="group" aria-label={copy(locale, "customTools")}>{SUBAGENT_TOOL_OPTIONS.map((tool, index) => <label key={tool}><input type="checkbox" checked={draft.tools.includes(tool)} disabled={busy} onChange={event => setDraft(current => current ? { ...current, tools: event.target.checked ? [...new Set([...current.tools, tool])] : current.tools.filter(value => value !== tool) } : current)} /><span>{locale === "en" ? tool : COPY.toolLabelsZh[index]}</span></label>)}</div>}
      </section>

      <label className="xn-subagent-settings__field"><span>{copy(locale, "prompt")}</span><textarea required rows={4} value={draft.systemPrompt} placeholder={copy(locale, "promptPlaceholder")} onChange={event => setDraftField("systemPrompt", event.target.value)} /></label>
      <label className="xn-subagent-settings__enabled"><span>{copy(locale, "enabled")}</span><input className="xn-settings-switch" type="checkbox" role="switch" aria-label={copy(locale, "enabledAria")} checked={draft.enabled} onChange={event => setDraftField("enabled", event.target.checked)} /></label>
      <footer className="xn-subagent-settings__actions">{editingId && <button type="button" className="xn-operation-danger" disabled={busy} onClick={() => { const item = items.find(value => value.id === editingId); if (item) void remove(item); }}><Trash2 size={15} />{copy(locale, "delete")}</button>}<span /> <button type="button" disabled={busy} onClick={cancel}>{copy(locale, "cancel")}</button><button type="submit" className="xn-operation-primary" disabled={busy}>{copy(locale, "save")}</button></footer>
    </form> : <>
      <div className="xn-subagent-settings__toolbar"><span className="xn-subagent-settings__scope"><Folder size={15} />{copy(locale, "globalScope")}</span><label><Search size={16} aria-hidden="true" /><input type="search" aria-label={copy(locale, "search")} placeholder={copy(locale, "search")} value={query} onChange={event => setQuery(event.target.value)} /></label></div>
      <div className="xn-subagent-settings__list-header"><div><strong>{visibleItems.length}</strong> {copy(locale, "title")}</div><div><button type="button" disabled={loading || busy} aria-label={copy(locale, "refresh")} title={copy(locale, "refresh")} onClick={() => void refresh()}><RefreshCw size={15} /></button><button type="button" className="xn-operation-primary" disabled={busy} onClick={startCreate}><Plus size={15} />{copy(locale, "add")}</button></div></div>
      {loading ? <div className="xn-subagent-settings__empty" role="status">{copy(locale, "loading")}</div> : visibleItems.length ? <div className="xn-subagent-settings__list">{visibleItems.map(item => {
        const itemDraft = draftFromResource(item);
        const provider = effectiveProviders.find(value => value.id === itemDraft.providerId);
        const modelLabel = itemDraft.providerId
          ? `${provider?.name || itemDraft.providerId} · ${itemDraft.model || provider?.model || ""}`
          : itemDraft.model || copy(locale, "inheritModel");
        const allTools = itemDraft.toolsMode === "all";
        const count = Array.isArray(item.tools) ? item.tools.filter(value => typeof value === "string" && value !== "*").length : 0;
        return <article key={item.id} className="xn-subagent-settings__row" data-testid={`subagent-${item.id}`}>
          <button type="button" className="xn-subagent-settings__identity" onClick={() => startEdit(item)} disabled={busy}>
            <span className="xn-subagent-settings__avatar" style={{ "--xn-subagent-color": COLOR_DOT[itemDraft.color] } as React.CSSProperties}><Bot size={17} /></span><span className="xn-subagent-settings__copy"><strong>{itemDraft.name || item.id}<small className="xn-subagent-settings__badge">{modelLabel}</small><small className="xn-subagent-settings__badge">{allTools ? copy(locale, "all") : copy(locale, "toolCount").replace("{0}", String(count))}</small></strong><span>{itemDraft.description || "—"}</span></span>
          </button>
          <div className="xn-subagent-settings__row-actions"><label><span>{copy(locale, "enabled")}</span><input className="xn-settings-switch" type="checkbox" role="switch" aria-label={`${copy(locale, "enabledAria")}: ${itemDraft.name}`} checked={itemDraft.enabled} disabled={busy} onChange={event => void toggleEnabled(item, event.target.checked)} /></label><button type="button" aria-label={`${copy(locale, "edit")} ${item.id}`} title={copy(locale, "edit")} disabled={busy} onClick={() => startEdit(item)}><span className="xn-subagent-settings__edit-icon">✎</span></button></div>
        </article>;
      })}</div> : <div className="xn-subagent-settings__empty"><Bot size={24} /><strong>{copy(locale, items.length ? "noMatches" : "empty")}</strong>{!items.length && <span>{copy(locale, "emptyHint")}</span>}</div>}
    </>}
  </div>;
}
