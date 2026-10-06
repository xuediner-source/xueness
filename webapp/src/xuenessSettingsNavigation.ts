import { t as tr } from './i18n';
import type { XuenessSettingsSection } from './plugins/settings/XuenessSettingsView';

type SettingsGroupId = 'basics' | 'agentCapabilities' | 'dataAndStats' | 'extensions';

type SectionDefinition = readonly [
  id: string,
  label: string,
  description: string,
  group: SettingsGroupId,
  requiredPlugin?: string,
];

const GROUP_LABELS: Record<SettingsGroupId, string> = {
  basics: '基础设置',
  agentCapabilities: 'Agent 能力',
  dataAndStats: '数据与统计',
  extensions: '扩展与维护',
};

// Keep the upstream SettingsPage order for the thirteen primary destinations.
// Xueness-only destinations stay reachable in the final expandable group.
const definitions: readonly SectionDefinition[] = [
  ['general', '常规', '语言、对话显示与日常操作。', 'basics', 'settings'],
  ['appearance', '外观', '主题、字体与文件内容显示。', 'basics', 'settings'],
  ['providers', '模型设置', '管理模型连接、附件能力和思考强度。', 'basics', 'providers'],
  ['browser', '浏览器控制', '配置新任务的浏览器工具。', 'basics', 'browser'],
  ['network', '网络搜索', '搜索服务、搜索模型 API 与真实 DNS 诊断。', 'basics', 'network'],
  ['shortcuts', '键盘快捷键', '自定义工作台快捷键。', 'basics', 'settings'],
  ['memory', '记忆', '查看和编辑项目记忆。', 'agentCapabilities', 'memory'],
  ['subagents', '子智能体', '配置子代理的提示词与模型。', 'agentCapabilities', 'subagents'],
  ['plugins', '插件', '管理功能模块及依赖。', 'agentCapabilities'],
  ['mcp', 'MCP 服务器', '管理服务器、授权、资源和连接诊断。', 'agentCapabilities', 'mcp'],
  ['skills', '技能', '安装和编辑可供任务引用的技能。', 'agentCapabilities', 'skills'],
  ['commands', '命令', '管理自定义斜杠命令。', 'agentCapabilities', 'commands'],
  ['hooks', '钩子', '管理工具调用前后的钩子。', 'agentCapabilities', 'hooks'],
  ['usage', '使用统计', '查看实际会话、步骤和模型用量。', 'dataAndStats', 'usage'],
  ['workspace', '工作区', '选择项目目录，管理默认目录和最近工作区。', 'extensions', 'files'],
  ['modules', '功能模块', '启用或停用 Xueness 内置功能模块。', 'extensions'],
  ['agent', 'Agent 访问', '控制 MCP、子代理和 Hooks 的运行权限。', 'extensions', 'settings'],
  ['marketplace', '扩展市场', '查看并安装可信扩展资源。', 'extensions', 'extensions'],
  ['remote', 'SSH 工作区', '管理远程工作区连接。', 'extensions', 'remote'],
  ['automations', '自动化', '管理定时任务与审批。', 'extensions', 'automation'],
  ['about', '关于 Xueness', '查看应用版本和本机数据位置。', 'extensions', 'desktop'],
  ['updates', '应用更新', '检查、下载和安装客户端稳定版。', 'extensions', 'updates'],
  ['diagnostics', '诊断与维护', '导出脱敏诊断和清理旧日志。', 'extensions', 'diagnostics'],
];

export function settingsNavigation(effectiveIds: ReadonlySet<string>, installedIds: ReadonlySet<string> = effectiveIds): XuenessSettingsSection[] {
  return definitions
    .filter(([, , , group, requiredPlugin]) => !requiredPlugin || (group === 'extensions' ? effectiveIds : installedIds).has(requiredPlugin))
    .map(([id, label, description, group]) => ({
      id,
      label: tr(label),
      description: tr(description),
      group: tr(GROUP_LABELS[group]),
    }));
}
