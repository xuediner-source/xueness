import type { CapabilityKind } from "./xuenessCapabilities";
import type { XuenessPlugin } from "./xuenessApi";

/** Panels are selected from this static registry only. Plugin catalog data is
 * descriptive and cannot inject code or create arbitrary UI routes. */
export type PluginPanel =
  | "chat"
  | "files"
  | "changes"
  | "git"
  | "directory"
  | "providers"
  | "usage"
  | "memory"
  | "capabilities"
  | "settings"
  | "workflows"
  | "terminal"
  | "automations"
  | "marketplace"
  | "diagnostics"
  | "remote";

export const XUENESS_PLUGIN_REGISTRY = {
  sessions: { name: "会话", description: "会话列表、Agent 对话与历史分叉", panels: ["chat"] },
  files: { name: "文件", description: "工作区文件、改动和目录浏览", panels: ["files", "changes", "directory"] },
  git: { name: "Git", description: "工作区状态、差异和提交记录", panels: ["git"] },
  providers: { name: "供应商", description: "模型配置、模型发现与本地轻量模式", panels: ["providers"] },
  usage: { name: "用量", description: "会话和步骤用量统计", panels: ["usage"] },
  memory: { name: "记忆", description: "记忆文件轨道状态", panels: ["memory"] },
  settings: { name: "设置", description: "工作台和运行设置", panels: ["settings"] },
  workflows: { name: "工作流", description: "工作流和后台任务", panels: ["workflows"] },
  terminal: { name: "终端", description: "工作区交互式终端", panels: ["terminal"] },
  automation: { name: "自动化", description: "本地计划与审批队列", panels: ["automations"] },
  extensions: { name: "扩展市场", description: "查看并安装可信资源清单", panels: ["marketplace"] },
  network: { name: "网络工具", description: "受限网络搜索与读取工具", panels: [] },
  diagnostics: { name: "诊断与维护", description: "导出脱敏状态并清理旧日志", panels: ["diagnostics"] },
  browser: { name: "浏览器自动化", description: "受审批约束的 Playwright 浏览器操作工具", panels: [] },
  remote: { name: "远程连接", description: "连接已配置的 SSH 主机", panels: ["remote"] },
  bots: { name: "Bot 工具", description: "由插件目录声明的 Bot 能力", panels: [] },
  onboarding: { name: "引导", description: "工作区初始化与新手引导能力", panels: [] },
  desktop: { name: "桌面端", description: "Windows/macOS 桌面宿主与原生目录选择", panels: [] },
  updates: { name: "更新", description: "应用版本检查与更新能力", panels: [] },
  office: { name: "Office 预览", description: "文档、表格和演示文稿只读预览", panels: [] },
  commands: { name: "命令", description: "斜杠命令资源", panels: ["capabilities"] },
  skills: { name: "技能", description: "技能资源", panels: ["capabilities"] },
  hooks: { name: "Hooks", description: "工具调用前后钩子", panels: ["capabilities"] },
  mcp: { name: "MCP", description: "外部 MCP 服务配置", panels: ["capabilities"] },
  subagents: { name: "子代理", description: "子代理资源", panels: ["capabilities"] },
  shell: { name: "Shell 工具", description: "执行命令工具", panels: [] },
  planning: { name: "规划工具", description: "待办和提问工具", panels: [] },
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
  usage: "用量",
  memory: "记忆",
  capabilities: "能力",
  settings: "设置",
  workflows: "工作流与后台任务",
  terminal: "终端",
  automations: "自动化",
  marketplace: "扩展市场",
  diagnostics: "诊断与维护",
  remote: "SSH 工作区",
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
