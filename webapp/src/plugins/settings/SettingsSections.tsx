import React, { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { t as tr } from "../../i18n";
import { XuenessTerminalShellSelect } from "../terminal/XuenessTerminalPreferences";
import type { SettingsMap } from "../../xuenessWorkspace";
import type { AgentCapabilities } from "../../xuenessSettings";
import { Badge, Button, EmptyState, Field, Panel, Spinner, Stat } from "../../ui/primitives";
import { Select } from "../../ui/Select";
import { XuenessShortcutsPanel } from "./XuenessShortcutsPanel";
import { SettingsGroup, SettingsRow } from "./SettingsPrimitives";
import { CODE_PREVIEW_THEME_OPTIONS, CodePreview, isCodePreviewTheme, type CodePreviewTheme } from "../../ui/CodePreview";

// ============================================================================
// 5. SettingsSections
// ============================================================================

export type SettingsSectionsProps = {
  sections: { id: string; label: string }[];
  activeSection: string;
  onSelectSection?: (id: string) => void;
  values: SettingsMap;
  capabilities: AgentCapabilities;
  onToggleCapability?: (key: keyof AgentCapabilities, value: boolean) => void | Promise<unknown>;
  onUpdateSetting?: (key: string, value: unknown) => void | Promise<unknown>;
  onSave?: () => void | Promise<unknown>;
  saveError?: string;
  dirty?: boolean;
  embedded?: boolean;
  saving?: boolean;
};

function SettingsToggle({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}): React.ReactElement {
  return (
    <input
      type="checkbox"
      role="switch"
      className="xn-settings-switch"
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange(event.currentTarget.checked)}
    />
  );
}

function SettingsSelect({
  label,
  value,
  disabled,
  onChange,
  children,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="xn-settings-select-wrap">
      <Select aria-label={label} value={value} disabled={disabled} onChange={(event) => onChange(event.currentTarget.value)}>
        {children}
      </Select>
    </div>
  );
}

function SettingsFontSizeInput({
  label,
  value,
  min,
  max,
  disabled,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  onCommit: (value: number) => void | Promise<unknown>;
}): React.ReactElement {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const parsed = draft.trim() === "" ? Number.NaN : Number(draft);
    const next = Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : value;
    setDraft(String(next));
    if (next !== value) void onCommit(next);
  };
  return (
    <div className="xn-settings-font-size">
      <input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        value={draft}
        aria-label={label}
        disabled={disabled}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          else if (event.key === "Escape") {
            event.preventDefault();
            setDraft(String(value));
          }
        }}
      />
      <span aria-hidden="true">px</span>
    </div>
  );
}

const CAPABILITY_SETTINGS: {
  key: keyof AgentCapabilities;
  label: string;
  description: string;
}[] = [
  { key: "allowMcp", label: "允许 MCP", description: "允许 Agent 启动已配置的 MCP 工具。" },
  { key: "allowSubagents", label: "允许子代理", description: "允许 Agent 启动嵌套子代理任务。" },
  { key: "allowHooks", label: "允许 Hooks", description: "允许运行已配置的工具调用钩子。" },
];

export function SettingsSections({
  activeSection,
  values,
  capabilities,
  onToggleCapability,
  onUpdateSetting,
  saving = false,
  embedded = false,
}: SettingsSectionsProps): React.ReactElement {
  const update = (key: string, value: unknown) => onUpdateSetting?.(key, value);
  const select = (label: string, value: string, options: React.ReactNode, onChange: (next: string) => void, forceDisabled = false) => (
    <SettingsSelect label={tr(label)} value={value} disabled={!onUpdateSetting || saving || forceDisabled} onChange={onChange}>
      {options}
    </SettingsSelect>
  );
  const toggle = (key: string, label: string, fallback = true) => (
    <SettingsToggle
      label={tr(label)}
      checked={values[key] === undefined ? fallback : values[key] === true}
      disabled={!onUpdateSetting || saving}
      onChange={(next) => { void update(key, next); }}
    />
  );
  const rawCodeSettings = values.codePreviewSettings && typeof values.codePreviewSettings === "object" && !Array.isArray(values.codePreviewSettings)
    ? values.codePreviewSettings as Record<string, unknown>
    : {};
  const codePreviewSettings = {
    lightTheme: isCodePreviewTheme(rawCodeSettings.lightTheme) ? rawCodeSettings.lightTheme : "github-light" as CodePreviewTheme,
    darkTheme: isCodePreviewTheme(rawCodeSettings.darkTheme) ? rawCodeSettings.darkTheme : "github-dark" as CodePreviewTheme,
    showLineNumbers: rawCodeSettings.showLineNumbers !== false,
    wrapLongLines: rawCodeSettings.wrapLongLines === true,
    fontSizePx: Number.isFinite(Number(rawCodeSettings.fontSizePx))
      ? Math.min(20, Math.max(12, Number(rawCodeSettings.fontSizePx)))
      : 12,
  };
  const updateCodePreviewSettings = (patch: Partial<typeof codePreviewSettings>) =>
    update("codePreviewSettings", { ...codePreviewSettings, ...patch });
  const themeMode = String(values.theme ?? "system");
  const [systemPrefersDark, setSystemPrefersDark] = useState(false);
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) return;
    const apply = () => setSystemPrefersDark(media.matches);
    apply();
    media.addEventListener?.("change", apply);
    return () => media.removeEventListener?.("change", apply);
  }, []);
  const activePreviewMode = themeMode === "dark" ? "dark" : themeMode === "light" ? "light" : systemPrefersDark ? "dark" : "light";

  let controls: React.ReactNode = null;
  if (activeSection === "general") {
    const locale = String(values.language ?? "zh");
    const configuredArchiveDays = Number(values.taskAutoArchiveOlderThanDays ?? 7);
    const archiveDays = [3, 7, 14, 30].includes(configuredArchiveDays) ? configuredArchiveDays : 7;
    controls = <>
      <div className="xn-settings-general-locale" data-testid="settings-current-locale">
        {locale === "en" ? "English (US)" : tr("中文简体")}
      </div>
      <SettingsGroup>
        <SettingsRow
          label={tr("界面语言")}
          description={tr("选择应用 UI 的显示语言。")}
          control={select("界面语言", String(values.language ?? "zh"), <><option value="zh">中文</option><option value="en">English</option></>, (next) => { void update("language", next); })}
        />
      </SettingsGroup>
      <SettingsGroup title={tr("对话行为")} description={tr("控制消息到达时的显示方式。")}>
        <SettingsRow label={tr("新消息自动滚动")} description={tr("收到新消息时保持对话在最新位置。")} control={toggle("autoScroll", "新消息自动滚动")} />
        <SettingsRow label={tr("显示推理内容")} description={tr("展示模型通过流式接口返回的推理文本；模型未返回时不会显示。")} control={toggle("messageStreamShowReasoning", "显示推理内容", true)} />
        <SettingsRow label={tr("显示任务待办")} description={tr("在对话中显示模型创建的待办事项。")} control={toggle("showTodos", "显示任务待办")} />
        <SettingsRow label={tr("默认收起工具详情")} description={tr("工具调用保留在时间线中，展开后查看详情。")} control={toggle("collapseTools", "默认收起工具详情")} />
      </SettingsGroup>
      <SettingsGroup title={tr("自动归档旧任务")} description={tr("仅归档已完成、已查看且长期未更新的任务；归档可在历史记录中恢复。")}>
        <SettingsRow
          label={tr("启用自动归档")}
          description={tr("未查看、置顶、正在运行或有待处理操作的任务会保留。")}
          control={toggle("taskAutoArchiveEnabled", "启用自动归档", false)}
        />
        <SettingsRow
          label={tr("归档保留时长")}
          description={tr("从最近一次查看开始计时，超过所选时长后才会归档。")}
          control={select(
            "归档保留时长",
            String(archiveDays),
            <><option value="3">3 {tr("天")}</option><option value="7">7 {tr("天")}</option><option value="14">14 {tr("天")}</option><option value="30">30 {tr("天")}</option></>,
            (next) => { const days = Number(next); if ([3, 7, 14, 30].includes(days)) void update("taskAutoArchiveOlderThanDays", days); },
            values.taskAutoArchiveEnabled !== true,
          )}
        />
      </SettingsGroup>
      <SettingsGroup title={tr("工具分组")} description={tr("将相邻的同类工具调用合并显示。") }>
        <SettingsRow label={tr("分组探索工具")} description={tr("聚合连续的读取与搜索调用。")} control={toggle("toolGroupingExploreEnabled", "分组探索工具")} />
        <SettingsRow label={tr("分组终端命令")} description={tr("聚合连续的终端命令。")} control={toggle("toolGroupingTerminalEnabled", "分组终端命令")} />
        <SettingsRow label={tr("分组文件更改")} description={tr("聚合连续的文件写入和编辑调用。")} control={toggle("toolGroupingChangesEnabled", "分组文件更改", false)} />
      </SettingsGroup>
      <SettingsGroup title={tr("终端设置")} description={tr("选择新终端使用的 Shell，并调整终端文字。") }>
        <SettingsRow label={tr("默认 Shell")} description={tr("只影响之后打开的终端；现有终端保持当前 Shell。")} control={<XuenessTerminalShellSelect value={typeof values.defaultShell === "string" ? values.defaultShell : undefined} disabled={!onUpdateSetting || saving} onChange={next => { void update("defaultShell", next); }} />} />
        <SettingsRow label={tr("终端字体")} description={tr("缺少所选字体时使用系统等宽字体。")} control={select("终端字体", String(values.terminalFontFamily ?? "system"), <><option value="system">{tr("系统等宽")}</option><option value="Menlo">Menlo</option><option value="SFMono-Regular">SF Mono</option><option value="monospace">monospace</option></>, next => { void update("terminalFontFamily", next); })} />
        <SettingsRow label={tr("终端字号")} description={tr("调整交互式终端中的文字大小。")} control={<SettingsFontSizeInput label={tr("终端字号")} value={Number(values.terminalFontSize ?? 13)} disabled={!onUpdateSetting || saving} min={10} max={24} onCommit={next => update("terminalFontSize", next)} />} />
      </SettingsGroup>
    </>;
  } else if (activeSection === "agent") {
    controls = <SettingsGroup>
      {CAPABILITY_SETTINGS.map(({ key, label, description }) => (
        <div key={key} data-testid={`capability-${key}`} data-enabled={capabilities[key] ? "true" : "false"}>
          <SettingsRow
            label={tr(label)}
            description={tr(description)}
            control={<SettingsToggle label={tr(label)} checked={capabilities[key]} disabled={!onToggleCapability || saving} onChange={(next) => { void onToggleCapability?.(key, next); }} />}
          />
        </div>
      ))}
    </SettingsGroup>;
  } else if (activeSection === "appearance") {
    controls = <>
      <SettingsGroup title={tr("界面设置")} description={tr("设置应用主题和界面文字大小。") }>
        <SettingsRow
          label={tr("界面主题")}
          description={tr("选择浅色、深色或跟随系统主题。")}
          control={select("界面主题", String(values.theme ?? "system"), <>
            <option value="system"><span className="xn-settings-theme-option"><Monitor size={16} aria-hidden="true" />{tr("跟随系统")}</span></option>
            <option value="dark"><span className="xn-settings-theme-option"><Moon size={16} aria-hidden="true" />{tr("深色")}</span></option>
            <option value="light"><span className="xn-settings-theme-option"><Sun size={16} aria-hidden="true" />{tr("浅色")}</span></option>
          </>, (next) => { void update("theme", next); })}
        />
        <SettingsRow
          label={tr("界面字号")}
          description={tr("调整应用界面的文字大小，图标和布局尺寸不受影响。")}
          control={<SettingsFontSizeInput label={tr("界面字号")} value={Number(values.fontSize ?? 14)} disabled={!onUpdateSetting || saving} min={12} max={20} onCommit={(next) => update("fontSize", next)} />}
        />
      </SettingsGroup>

      <SettingsGroup title={tr("代码设置")} description={tr("设置代码内容的主题、字号和显示方式，不受界面字号影响。") }>
        <SettingsRow
          label={tr("浅色代码主题")}
          description={tr("浅色界面下代码内容使用的高亮主题。")}
          control={select("浅色代码主题", codePreviewSettings.lightTheme, <>{CODE_PREVIEW_THEME_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</>, (next) => {
            if (isCodePreviewTheme(next)) void updateCodePreviewSettings({ lightTheme: next });
          })}
        />
        <SettingsRow
          label={tr("深色代码主题")}
          description={tr("深色界面下代码内容使用的高亮主题。")}
          control={select("深色代码主题", codePreviewSettings.darkTheme, <>{CODE_PREVIEW_THEME_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</>, (next) => {
            if (isCodePreviewTheme(next)) void updateCodePreviewSettings({ darkTheme: next });
          })}
        />
        <SettingsRow
          label={tr("显示行号")}
          description={tr("在代码内容和差异视图中显示行号。")}
          control={<SettingsToggle label={tr("显示行号")} checked={codePreviewSettings.showLineNumbers} disabled={!onUpdateSetting || saving} onChange={(next) => { void updateCodePreviewSettings({ showLineNumbers: next }); }} />}
        />
        <SettingsRow
          label={tr("长行自动换行")}
          description={tr("代码内容过长时自动换行。")}
          control={<SettingsToggle label={tr("长行自动换行")} checked={codePreviewSettings.wrapLongLines} disabled={!onUpdateSetting || saving} onChange={(next) => { void updateCodePreviewSettings({ wrapLongLines: next }); }} />}
        />
        <SettingsRow
          label={tr("代码字号")}
          description={tr("调整代码块、文件预览和差异视图的默认字号。")}
          control={<SettingsFontSizeInput label={tr("代码字号")} value={codePreviewSettings.fontSizePx} disabled={!onUpdateSetting || saving} min={12} max={20} onCommit={(next) => updateCodePreviewSettings({ fontSizePx: next })} />}
        />
      </SettingsGroup>

      <section className="xn-settings-card-group xn-settings-code-previews">
        <header className="xn-settings-card-group__header">
          <h2>{tr("代码预览")}</h2>
          <p>{tr("同时预览浅色与深色代码主题，当前界面使用的主题会标记为“当前生效”。")}</p>
        </header>
        <div className="xn-settings-code-previews__grid">
          {CODE_PREVIEW_THEME_OPTIONS.find((option) => option.value === codePreviewSettings.lightTheme) && (
            <CodePreview
              mode="light"
              theme={codePreviewSettings.lightTheme}
              themeName={CODE_PREVIEW_THEME_OPTIONS.find((option) => option.value === codePreviewSettings.lightTheme)!.label}
              active={activePreviewMode === "light"}
              showLineNumbers={codePreviewSettings.showLineNumbers}
              wrapLongLines={codePreviewSettings.wrapLongLines}
              fontSizePx={codePreviewSettings.fontSizePx}
            />
          )}
          <CodePreview
            mode="dark"
            theme={codePreviewSettings.darkTheme}
            themeName={CODE_PREVIEW_THEME_OPTIONS.find((option) => option.value === codePreviewSettings.darkTheme)?.label ?? codePreviewSettings.darkTheme}
            active={activePreviewMode === "dark"}
            showLineNumbers={codePreviewSettings.showLineNumbers}
            wrapLongLines={codePreviewSettings.wrapLongLines}
            fontSizePx={codePreviewSettings.fontSizePx}
          />
        </div>
      </section>


    </>;
  } else if (activeSection === "workspace-display") {
    controls = <SettingsGroup title={tr("工作区显示")} description={tr("调整文件预览中 Tab 字符的显示宽度。") }>
        <SettingsRow
          label={tr("缩进宽度")}
          description={tr("文件内容中 Tab 字符的显示宽度。")}
          control={select("缩进宽度", String(Number(values.tabSize ?? 2)), <>{[2, 4, 8].map((size) => <option key={size} value={size}>{size}</option>)}</>, (next) => { void update("tabSize", Number(next)); })}
        />
      </SettingsGroup>;
  } else if (activeSection === "shortcuts") {
    const bindings = values.bindings && typeof values.bindings === "object" && !Array.isArray(values.bindings)
      ? Object.fromEntries(Object.entries(values.bindings).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : {};
    controls = <>
      <XuenessShortcutsPanel bindings={bindings} disabled={!onUpdateSetting || saving} onChange={(next) => update("bindings", next)} />
      <SettingsGroup title={tr("发送行为")} description={tr("选择发送消息时使用的 Enter 组合。") }>
        <SettingsRow
          label={tr("发送消息快捷键")}
          description={tr("选择 Enter 或 Mod+Enter 发送。Shift+Enter 始终用于换行。")}
          control={select("发送消息快捷键", values.sendShortcut === "mod-enter" ? "mod-enter" : "enter", <><option value="enter">Enter</option><option value="mod-enter">Mod+Enter</option></>, (next) => { void update("sendShortcut", next); })}
        />
      </SettingsGroup>
      <div className="xn-settings-shortcut-hints" aria-label={tr("固定快捷键")}>
        <div><span>{tr("输入换行")}</span><kbd>Shift+Enter</kbd></div>
        <div><span>{tr("关闭菜单或停止运行")}</span><kbd>Escape</kbd></div>
      </div>
    </>;
  } else if (activeSection === "browser") {
    controls = <>
      <SettingsGroup title={tr("浏览器工具")}>
        <SettingsRow
          label={tr("新任务启用浏览器")}
          description={tr("为新对话启用浏览器工具；工具执行仍遵循所选权限模式。")}
          control={toggle("browserControlEnabled", "新任务启用浏览器", false)}
        />
      </SettingsGroup>
      <div className="xn-settings-readonly">
        <h2>{tr("浏览器运行环境")}</h2>
        <p>{tr("使用服务器上的 Node、Playwright 和 Chromium，配置独立于你当前浏览器的标签页。")}</p>
        <p>{tr("可执行程序通过 XUENESS_BROWSER_EXECUTABLE 指定；没有安装依赖时，实际运行会显示错误。")}</p>
      </div>
    </>;
  }

  const content = (
    <div className="xn-settings-controls" data-testid={`settings-section-content-${activeSection}`}>
      {controls}
    </div>
  );
  return embedded ? content : <div className="xn-settings-controls">{content}</div>;
}
