import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { t as tr, tf } from "./i18n";
import {
  CAPABILITY_KINDS,
  CAPABILITY_LABELS,
  loadCapabilitySection,
  toggleCapabilityItem,
  createCapabilityItem,
  updateCapabilityFields,
  deleteCapabilityItem,
  type CapabilityItem,
  type CapabilityKind,
} from "./xuenessCapabilities";
import { listResources, type XuenessPlugin } from "./xuenessApi";
import type { CapabilitySectionProps } from "./XuenessCapabilitiesPanel";

/** Panels are selected from this static registry only. Plugin catalog data is
 * descriptive and cannot inject code or create arbitrary UI routes. */
export type PluginPanel =
  | "chat"
  | "files"
  | "changes"
  | "git"
  | "directory"
  | "providers"
  | "subscriptions"
  | "workbuddy"
  | "model-monitor"
  | "context-lens"
  | "usage"
  | "memory"
  | "capabilities"
  | "settings"
  | "workflows"
  | "terminal"
  | "browser"
  | "automations"
  | "marketplace"
  | "diagnostics"
  | "remote"
  | "subagents";

export const XUENESS_PLUGIN_REGISTRY = {
  sessions: { name: "会话", description: "会话列表、工作区、用途与时间线视图、活性摘要、归档恢复与永久删除、侧栏、四会话分屏与持久会话组、独立输入、Agent 对话、有界子代理摘要、投影订阅与续传、命令回执与历史分叉、事实工作分段与活跃时长", panels: ["chat"] },
  files: { name: "文件", description: "工作区文件、改动和目录浏览", panels: ["files", "changes", "directory"] },
  git: { name: "Git", description: "工作区状态、差异和提交记录", panels: ["git"] },
  providers: { name: "供应商", description: "模型配置、模型发现、本地轻量模式与接口兼容诊断", panels: ["providers"] },
  subscriptions: { name: "订阅中心", description: "选择安装后通过账号授权、CLI 登录或订阅凭证接入，在会话中使用模型并查询上游真实额度。", panels: ["subscriptions"] },
  workbuddy: { name: "WorkBuddy 号池", description: "查看本机 WorkBuddy 账号状态并管理认证文件。", panels: ["workbuddy"] },
  native_ops: { name: "原生操作工具", description: "批量读取、文件修订与文档文本工具，按需发现并通过现有权限审批执行。", panels: [] },
  batch_calls: { name: "批量调用", description: "鼓励同一步发起独立工具调用，并在上下文压缩后恢复批量调用约定。", panels: [] },
  os_cua: { name: "OS Computer Use", description: "受审批约束的 OS 级计算机使用：平台适配端口上的有界屏幕截图、窗口列表与单步输入，带证据日志；无适配器平台明确不可用。", panels: [] },
  model_monitor: { name: "返回模型监测", description: "随会话记录请求型号与上游返回型号，标记一致、不同及未报告。不会自动发起额外模型请求。", panels: ["model-monitor"] },
  context_lens: { name: "上下文透镜", description: "基于 dsh-context 的上下文组成、逐请求趋势、内容浏览、文件命令活动与代理关系", panels: ["context-lens"] },
  usage: { name: "用量", description: "会话和步骤用量统计", panels: ["usage"] },
  memory: { name: "记忆", description: "记忆文件轨道状态", panels: ["memory"] },
  settings: { name: "设置", description: "工作台和运行设置", panels: ["settings"] },
  workflows: { name: "工作流", description: "工作流和后台任务", panels: ["workflows"] },
  terminal: { name: "终端", description: "工作区本地与连接作用域远程交互式终端", panels: ["terminal"] },
  automation: { name: "自动化", description: "本地计划与审批队列", panels: ["automations"] },
  extensions: { name: "扩展市场", description: "从 GitHub 按需下载官方插件，管理资源清单与插件组合", panels: ["marketplace"] },
  network: { name: "网络工具", description: "受限公网读取、搜索服务配置与按需诊断", panels: [] },
  diagnostics: { name: "诊断与维护", description: "导出脱敏状态并清理旧日志", panels: ["diagnostics"] },
  browser: { name: "浏览器自动化", description: "受审批约束的本地与远程截图式浏览器标签", panels: ["browser"] },
  remote: { name: "远程连接", description: "连接已配置的 SSH 主机，作用域问题回答、撤回恢复、当前轮输入与历史媒体预览", panels: ["remote"] },
  bots: { name: "Bot 工具", description: "由插件目录声明的 Bot 能力", panels: [] },
  onboarding: { name: "引导", description: "工作区初始化与首次启动系统权限引导", panels: [] },
  desktop: { name: "桌面端", description: "Windows/macOS 桌面宿主、原生目录选择、系统通知与系统权限状态", panels: [] },
  updates: { name: "更新", description: "应用版本检查与更新能力", panels: [] },
  office: { name: "Office 预览", description: "文档、表格和演示文稿只读预览", panels: [] },
  commands: { name: "命令", description: "斜杠命令资源", panels: ["capabilities"] },
  skills: { name: "技能", description: "技能资源", panels: ["capabilities"] },
  hooks: { name: "Hooks", description: "工具调用前后钩子", panels: ["capabilities"] },
  mcp: { name: "MCP", description: "外部 MCP 服务配置", panels: ["capabilities"] },
  subagents: { name: "子代理", description: "子代理资源与运行态", panels: ["capabilities", "subagents"] },
  shell: { name: "Shell 工具", description: "执行命令工具", panels: [] },
  planning: { name: "规划工具", description: "待办、提问和交付完整性检查", panels: [] },
  tools: { name: "工具执行策略", description: "对其他插件工具调用的实验性执行策略（干跑预览、每轮工具调用预算）", panels: [] },
  deepseek_harness: { name: "DeepSeek Harness", description: "DeepSeek 风格供应商的确定性 KV-cache 前缀稳定与 reasoning 双协议桥", panels: [] },
} as const satisfies Record<string, { name: string; description: string; panels: readonly PluginPanel[] }>;

export type XuenessPluginId = keyof typeof XUENESS_PLUGIN_REGISTRY;
export const FRONTEND_PLUGIN_IDS = Object.keys(XUENESS_PLUGIN_REGISTRY) as XuenessPluginId[];

export const PLUGIN_PANEL_LABELS: Record<PluginPanel, string> = {
  chat: "会话",
  files: "文件",
  changes: "改动",
  git: "Git",
  directory: "目录",
  providers: "供应商",
  subscriptions: "订阅中心",
  workbuddy: "WorkBuddy 号池",
  "model-monitor": "返回模型监测",
  "context-lens": "上下文透镜",
  usage: "用量",
  memory: "记忆",
  capabilities: "能力",
  settings: "设置",
  workflows: "工作流与后台任务",
  terminal: "终端",
  browser: "浏览器",
  automations: "自动化",
  marketplace: "扩展市场",
  diagnostics: "诊断与维护",
  remote: "SSH 工作区",
  subagents: "子代理",
};

export const CAPABILITY_PLUGIN_BY_KIND: Partial<Record<CapabilityKind, XuenessPluginId>> = {
  commands: "commands",
  skills: "skills",
  hooks: "hooks",
  mcp: "mcp",
  subagents: "subagents",
  plugins: "extensions",
};

/** Resolve the static frontend routes permitted by the server's catalog. The
 * backend owns dependency resolution (`effective`); unknown IDs and a missing
 * catalog fail closed. */
export function derivePluginAvailability(plugins: XuenessPlugin[], catalogReady: boolean) {
  const effectiveIds = new Set(catalogReady
    ? plugins.filter((plugin) => plugin.effective && plugin.id in XUENESS_PLUGIN_REGISTRY).map((plugin) => plugin.id)
    : []);
  const panels = catalogReady
    ? Array.from(new Set(Object.entries(XUENESS_PLUGIN_REGISTRY)
        .filter(([id]) => effectiveIds.has(id))
        .flatMap(([, definition]) => definition.panels))) as PluginPanel[]
    : [];
  const capabilityKinds = (Object.entries(CAPABILITY_PLUGIN_BY_KIND) as [CapabilityKind, XuenessPluginId | undefined][])
    .filter(([kind, id]) => id !== undefined && effectiveIds.has(id))
    .map(([kind]) => kind);
  return { panels, capabilityKinds, effectiveIds };
}

/** Workbench views: the registry's plugin panels plus the always-reachable plugin manager. */
export type WorkbenchPanel = PluginPanel | "plugins";

export const workbenchPanelLabels = (): Record<WorkbenchPanel, string> => ({
  ...Object.fromEntries(Object.entries(PLUGIN_PANEL_LABELS).map(([id, label]) => [id, tr(label)])) as Record<PluginPanel, string>,
  plugins: tr("插件管理"),
});

type CapSlot = {
  items: CapabilityItem[];
  loading: boolean;
  error: string;
  userScopeAvailable: boolean;
  userScopeReason: string;
};

type CapabilitySectionInput = {
  isPluginEffective: (id: string) => boolean;
  capabilityKinds: CapabilityKind[];
  /** Which sections are on screen: the capabilities panel, or one settings section. */
  panel: string;
  settingsSection: string;
  /** Kinds with their own section UI (skills); the others use the default list. */
  renderers?: Partial<Record<CapabilityKind, (props: CapabilitySectionProps) => React.JSX.Element>>;
};

/**
 * Shared capabilities panel wiring: one slot per resource kind, loaded on panel
 * open, plus the create / edit / delete dialog. Each kind only loads or writes
 * while the plugin that owns it (`CAPABILITY_PLUGIN_BY_KIND`) is effective. A
 * toggle failure surfaces on that kind's section; the switch never lies about
 * a write that did not land.
 */
export function useCapabilitySections({ isPluginEffective, capabilityKinds, panel, settingsSection, renderers = {} }: CapabilitySectionInput) {
  const emptyCapSlot: CapSlot = {
    items: [],
    loading: false,
    error: "",
    userScopeAvailable: true,
    userScopeReason: "",
  };
  const [capSlots, setCapSlots] = useState<Record<CapabilityKind, CapSlot>>(
    () => Object.fromEntries(CAPABILITY_KINDS.map((k) => [k, { ...emptyCapSlot }])) as Record<CapabilityKind, CapSlot>,
  );
  const [capBusyId, setCapBusyId] = useState<string | null>(null);

  const loadCapSlot = useCallback(async (kind: CapabilityKind) => {
    const pluginId = CAPABILITY_PLUGIN_BY_KIND[kind];
    if (!pluginId || !isPluginEffective(pluginId)) return;
    setCapSlots((prev) => ({ ...prev, [kind]: { ...prev[kind], loading: true, error: "" } }));
    const res = await loadCapabilitySection(kind);
    if (!isPluginEffective(pluginId)) return;
    setCapSlots((prev) => ({
      ...prev,
      [kind]: res.ok
        ? {
            items: res.value.items,
            loading: false,
            error: "",
            userScopeAvailable: res.value.userScopeAvailable,
            userScopeReason: res.value.userScopeReason,
          }
        : { ...prev[kind], loading: false, error: res.error },
    }));
  }, [isPluginEffective]);

  useEffect(() => {
    const kinds = panel === "capabilities" ? capabilityKinds :
      panel === "settings" ? capabilityKinds.filter(kind => kind === settingsSection) : [];
    for (const kind of kinds) void loadCapSlot(kind);
  }, [panel, settingsSection, capabilityKinds.join(","), loadCapSlot]);

  const handleToggleCapabilityItem = useCallback(
    async (kind: CapabilityKind, item: CapabilityItem, next: boolean) => {
      const pluginId = CAPABILITY_PLUGIN_BY_KIND[kind];
      if (!pluginId || !isPluginEffective(pluginId)) return;
      setCapBusyId(item.id);
      const res = await toggleCapabilityItem(kind, item.id, next);
      setCapBusyId(null);
      if (!res.ok) {
        setCapSlots((prev) => ({ ...prev, [kind]: { ...prev[kind], error: res.error } }));
        return;
      }
      await loadCapSlot(kind);
    },
    [isPluginEffective, loadCapSlot],
  );

  // -- capability create / edit / delete --------------------------------------
  const [capDialog, setCapDialog] = useState<
    { mode: "create" | "edit"; kind: CapabilityKind; initial: CapabilityItem | null } | null
  >(null);
  const [capDialogError, setCapDialogError] = useState("");
  const [capDialogBusy, setCapDialogBusy] = useState(false);

  useEffect(() => {
    if (!capDialog) return;
    const pluginId = CAPABILITY_PLUGIN_BY_KIND[capDialog.kind];
    if (!pluginId || !isPluginEffective(pluginId)) setCapDialog(null);
  }, [capDialog, isPluginEffective]);

  const openCapCreate = useCallback((kind: CapabilityKind) => {
    const pluginId = CAPABILITY_PLUGIN_BY_KIND[kind];
    if (!pluginId || !isPluginEffective(pluginId)) return;
    setCapDialogError("");
    setCapDialog({ mode: "create", kind, initial: null });
  }, [isPluginEffective]);

  const openCapEdit = useCallback((kind: CapabilityKind, item: CapabilityItem) => {
    const pluginId = CAPABILITY_PLUGIN_BY_KIND[kind];
    if (!pluginId || !isPluginEffective(pluginId)) return;
    setCapDialogError("");
    // The list summary deliberately omits skill/command bodies. Fetch the
    // current record before opening an editor so saving never blanks a body.
    void listResources(kind).then(result => {
      if (!isPluginEffective(pluginId)) return;
      const raw = result.items.find(row => row.id === item.id);
      if (!raw) throw new Error("Resource no longer exists");
      setCapDialog({ mode: "edit", kind, initial: { ...item, extra: { ...item.extra, ...raw } } });
    }).catch(error => setCapSlots(prev => ({ ...prev, [kind]: { ...prev[kind], error: String(error) } })));
  }, [isPluginEffective]);

  const handleCapDelete = useCallback(
    async (kind: CapabilityKind, item: CapabilityItem) => {
      const pluginId = CAPABILITY_PLUGIN_BY_KIND[kind];
      if (!pluginId || !isPluginEffective(pluginId)) return;
      if (!window.confirm(tf("删除{0}「{1}」？配置文件会从资源目录移除。", [tr(CAPABILITY_LABELS[kind]), item.id]))) return;
      setCapBusyId(item.id);
      const res = await deleteCapabilityItem(kind, item.id);
      setCapBusyId(null);
      if (!res.ok) {
        setCapSlots((prev) => ({ ...prev, [kind]: { ...prev[kind], error: res.error } }));
        return;
      }
      await loadCapSlot(kind);
    },
    [isPluginEffective, loadCapSlot],
  );

  const handleCapSubmit = useCallback(
    async (payload: { id: string; fields: Record<string, unknown> }) => {
      if (!capDialog) return;
      const pluginId = CAPABILITY_PLUGIN_BY_KIND[capDialog.kind];
      if (!pluginId || !isPluginEffective(pluginId)) return;
      setCapDialogBusy(true);
      setCapDialogError("");
      const res =
        capDialog.mode === "create"
          ? await createCapabilityItem(capDialog.kind, { id: payload.id, ...payload.fields, createOnly: true })
          : await updateCapabilityFields(capDialog.kind, capDialog.initial?.id ?? payload.id, payload.fields);
      setCapDialogBusy(false);
      if (!res.ok) {
        setCapDialogError(res.error);
        return;
      }
      setCapDialog(null);
      await loadCapSlot(capDialog.kind);
    },
    [capDialog, isPluginEffective, loadCapSlot],
  );

  const capSections: CapabilitySectionProps[] = CAPABILITY_KINDS.filter((kind) =>
    capabilityKinds.includes(kind),
  ).map((kind) => ({
    kind,
    label: tr(CAPABILITY_LABELS[kind]),
    items: capSlots[kind].items,
    loading: capSlots[kind].loading,
    error: capSlots[kind].error || undefined,
    userScopeAvailable: capSlots[kind].userScopeAvailable,
    userScopeReason: capSlots[kind].userScopeReason || undefined,
    busyId: capBusyId,
    onToggle: (k, item, next) => void handleToggleCapabilityItem(k, item, next),
    onCreate: openCapCreate,
    onEdit: openCapEdit,
    onDelete: (k, item) => void handleCapDelete(k, item),
    ...(renderers[kind] ? { render: renderers[kind] } : {}),
  }));

  return { capSections, loadCapSlot, capDialog, setCapDialog, capDialogError, capDialogBusy, handleCapSubmit };
}
