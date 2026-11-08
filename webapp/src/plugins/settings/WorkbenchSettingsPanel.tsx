/**
 * The settings view as the workbench mounts it: section navigation, the
 * account card, and the content of the selected section. A section owned by
 * a plugin that is not effective shows "unavailable" with a link to plugin
 * management. Moved unchanged out of XuenessWorkbenchContainer.
 */
import React, { lazy, Suspense } from "react";
import { t as tr, type useLocale } from "../../i18n";
import type { XuenessPlugin } from "../../xuenessApi";
import { createCapabilityItem, type CapabilityKind } from "../../xuenessCapabilities";
import type { WorkbenchSession } from "../../xuenessWorkbench";
import type { WorkbenchPanel } from "../../xuenessPluginRegistry";
import type { CapabilitySectionProps } from "../../XuenessCapabilitiesPanel";
import { FeatureUnavailable, XuenessPluginManager, XuenessPluginSettingsPanel } from "../../XuenessPluginManager";
import { RegionBoundary } from "../../ui/primitives";
import { ToolExecutionSettings } from "../tools/ToolExecutionSettings";
import type { ComposerCatalogState } from "../sessions/useComposerCatalog";
import type { WorkbenchSettings } from "./useWorkbenchSettings";
import { CapabilitiesPanel, DesktopUpdates, ModelManager, ModelMonitorPanel, RemoteConnections, SubscriptionsPanel, WorkbuddySettingsPanel,
  XuenessAutomationsPanel, XuenessDiagnosticsPanel, XuenessMarketplace, XuenessMcpTools, XuenessUsageSettings } from "./workbenchSettingsViews";

const DesktopNotificationSettings = lazy(() => import('../desktop/DesktopNotificationSettings').then(module => ({ default: module.DesktopNotificationSettings })));
const SessionExperimentSettings = lazy(() => import('../sessions/SessionExperimentSettings').then(module => ({ default: module.SessionExperimentSettings })));
const SettingsSections = lazy(() => import("./SettingsSections").then(module => ({ default: module.SettingsSections })));
const DesktopAbout = lazy(() => import("../desktop/DesktopAbout").then(module => ({ default: module.DesktopAbout })));
const XuenessSettingsView = lazy(() => import("./XuenessSettingsView").then(module => ({ default: module.XuenessSettingsView })));
const NetworkSettings = lazy(() => import("../network/NetworkSettings").then(module => ({ default: module.NetworkSettings })));
const PluginProfilePicker = lazy(() => import("../extensions/PluginProfilePicker")
  .then(module => ({ default: module.PluginProfilePicker })));
const XuenessMemorySettings = lazy(() => import("../memory/MemorySettings").then(module => ({ default: module.XuenessMemorySettings })));
const BrowserSettings = lazy(() => import("../browser/BrowserSettings").then(module => ({ default: module.BrowserSettings })));
const XuenessSubagentSettings = lazy(() => import("../subagents/SubagentSettings").then(module => ({ default: module.XuenessSubagentSettings })));
const XuenessWorkspaceSettings = lazy(() => import('./XuenessWorkspaceSettings').then(module => ({ default: module.XuenessWorkspaceSettings })));

type WorkbenchSettingsPanelProps = {
  settings: WorkbenchSettings;
  isPluginEffective: (id: string) => boolean;
  capabilityKinds: CapabilityKind[];
  capSections: CapabilitySectionProps[];
  loadCapSlot: (kind: CapabilityKind) => Promise<void>;
  pluginCatalog: XuenessPlugin[];
  pluginCatalogLoading: boolean;
  pluginCatalogError: string;
  refreshPluginCatalog: () => Promise<void>;
  togglePlugin: (id: string, enabled: boolean) => Promise<void>;
  locale: ReturnType<typeof useLocale>;
  busy: boolean;
  session: WorkbenchSession | null;
  activeId: string | null;
  activeIdRef: React.MutableRefObject<string | null>;
  composer: ComposerCatalogState;
  providerFocusId: string | undefined;
  setPanel: (panel: WorkbenchPanel) => void;
  startNewTask: () => void;
  setRemoteDialogOpen: (open: boolean) => void;
};

export function WorkbenchSettingsPanel(props: WorkbenchSettingsPanelProps) {
  const { settings, pluginCatalog, session, composer, setPanel } = props;
  const { settingsSections, settingsSection, setSettingsSection, settingsDirty, settingsSaving, settingsLoading, settingsError, handleSaveSettings, handleLoadAllSettings } = settings;
  const { draftRoot, composerCatalog } = composer;
  // The settings sidebar card reuses data the workbench already loads; no extra request.
  const settingsRoot = session?.root ?? draftRoot ?? composerCatalog.root ?? undefined;
  const settingsPluginVersion = pluginCatalog.find(plugin => plugin.id === "settings")?.version;
  const settingsAccount = {
    name: settingsRoot
      ? composerCatalog.roots.find(item => item.path === settingsRoot)?.name
        ?? settingsRoot.split(/[/\\]+/u).filter(Boolean).pop()
        ?? settingsRoot
      : tr("未选择工作区"),
    path: settingsRoot,
    subtitle: settingsRoot ? undefined : tr("选择项目目录后显示在这里"),
    badges: [
      composerCatalog.git?.branch ? { label: composerCatalog.git.branch, title: tr("当前 Git 分支") } : null,
      settingsPluginVersion ? { label: `v${settingsPluginVersion}`, title: tr("配置设置插件版本") } : null,
    ].filter((badge): badge is { label: string; title: string } => badge !== null),
  };
  return <XuenessSettingsView sections={settingsSections} activeSection={settingsSection} onSelect={setSettingsSection}
      dirty={settingsDirty} saving={settingsSaving} loading={settingsLoading} error={settingsError} account={settingsAccount}
      onBack={() => setPanel("chat")} onRetry={() => settingsDirty ? handleSaveSettings() : handleLoadAllSettings()}>
      <RegionBoundary resetKey={settingsSection} onReload={() => window.location.reload()} onRecover={() => setPanel("plugins")}><Suspense fallback={<p role="status" className="xn-view-loading">{tr("正在加载界面…")}</p>}>{settingsContent(props)}</Suspense></RegionBoundary>
    </XuenessSettingsView>;
}

/** The selected section's content, rendered directly inside the section's suspense boundary. */
function settingsContent({ settings, isPluginEffective, capabilityKinds, capSections, loadCapSlot, pluginCatalog, pluginCatalogLoading, pluginCatalogError, refreshPluginCatalog,
  togglePlugin, locale, busy, session, activeId, activeIdRef, composer, providerFocusId, setPanel, startNewTask, setRemoteDialogOpen }: WorkbenchSettingsPanelProps) {
  const { settingsValues, capabilities, settingsSections, settingsSection, setSettingsSection, settingsSaving, handleToggleCapability, handleUpdateSetting } = settings;
  const { draftRoot, composerCatalog, setDraftRoot, setIsolatedWorkspace, updateChoices, refreshComposerCatalog, selectProviderForCurrentRun } = composer;
  const inlineSettings = ["general", "appearance", "shortcuts", "agent"].includes(settingsSection);
  if (settingsSection === "about") return <DesktopAbout enabled={isPluginEffective("desktop")} onboardingEnabled={isPluginEffective("onboarding")} />;
  if (settingsSection === "network") return <NetworkSettings enabled={isPluginEffective('network')} disabled={busy || settingsSaving || pluginCatalogLoading} />;
  if (settingsSection === 'updates') return <DesktopUpdates enabled={isPluginEffective('updates') && isPluginEffective('desktop')} />;
  if (settingsSection === "browser") return <BrowserSettings enabled={isPluginEffective("browser")} disabled={busy || settingsSaving || pluginCatalogLoading}
    onEnabledChange={async enabled => {
      await togglePlugin("browser", enabled);
      if (!activeIdRef.current) updateChoices({ browser: enabled });
      await handleUpdateSetting("browserControlEnabled", enabled);
    }} />;
  const pluginId = ({providers:"providers",subscriptions:'subscriptions',workbuddy:'workbuddy','model-monitor':'model_monitor',browser:"browser",memory:"memory",subagents:"subagents",mcp:"mcp",skills:"skills",commands:"commands",hooks:"hooks",usage:"usage"} as Record<string,string>)[settingsSection];
  if (pluginId && !isPluginEffective(pluginId)) return <FeatureUnavailable feature={settingsSections.find(section => section.id === settingsSection)?.label ?? settingsSection} onManage={() => setSettingsSection("modules")} />;
  if (inlineSettings) return <SettingsSections embedded sections={[]} activeSection={settingsSection}
    values={{...settingsValues, language: settingsValues.language ?? locale}} capabilities={capabilities}
    sessionScopedCommands={isPluginEffective("sessions") && isPluginEffective("settings")}
    terminalEffective={isPluginEffective("terminal")} browserEffective={isPluginEffective("browser")}
    onToggleCapability={handleToggleCapability} onUpdateSetting={handleUpdateSetting} saving={settingsSaving}
    pluginSettings={settingsSection === "general" ? <>
      {isPluginEffective("sessions") && <SessionExperimentSettings values={settingsValues} disabled={settingsSaving} onUpdate={handleUpdateSetting} />}
      {isPluginEffective("tools") && <ToolExecutionSettings values={settingsValues} disabled={settingsSaving} onUpdate={handleUpdateSetting} />}
      {isPluginEffective("desktop") && <DesktopNotificationSettings values={settingsValues} disabled={settingsSaving} onUpdate={handleUpdateSetting} />}
    </> : undefined} />;
  if (settingsSection === "workspace") return <><Suspense fallback={null}><XuenessWorkspaceSettings currentRoot={session?.root ?? draftRoot ?? composerCatalog.root}
    onDefaultChanged={() => { if (!activeId) { setDraftRoot(undefined); setIsolatedWorkspace(false); updateChoices({remote:undefined}); } void refreshComposerCatalog(); }} /></Suspense><SettingsSections embedded sections={[]} activeSection="workspace-display" values={settingsValues} capabilities={capabilities} onUpdateSetting={handleUpdateSetting} saving={settingsSaving} /></>;
  if (settingsSection === "providers") return <>
    <PluginProfilePicker enabled={isPluginEffective("extensions")} onCatalogChanged={() => void refreshPluginCatalog()} />
    <ModelManager focusProviderId={providerFocusId} runtimeMonitorEnabled={isPluginEffective("providers") && isPluginEffective("diagnostics")} onSelect={selectProviderForCurrentRun} />
  </>;
  if (settingsSection === "mcp") return <><CapabilitiesPanel sections={capSections.filter(section => section.kind === "mcp")} /><XuenessMcpTools /></>;
  if (settingsSection === "plugins") return <XuenessPluginSettingsPanel
    plugins={pluginCatalog} loading={pluginCatalogLoading} error={pluginCatalogError}
    onRefresh={refreshPluginCatalog} onToggle={togglePlugin}
    onBrowse={isPluginEffective("extensions") ? () => setSettingsSection("marketplace") : undefined}
    resourceContent={isPluginEffective("extensions") ? <CapabilitiesPanel sections={capSections.filter(section => section.kind === "plugins")}
      onImportPlugin={async ({id,fields}) => { const result = await createCapabilityItem("plugins", {id,...fields,createOnly:true}); if(result.ok) await loadCapSlot("plugins"); return result; }}
      onRefreshPlugins={() => void loadCapSlot("plugins")} onBrowsePlugins={() => setSettingsSection("marketplace")} /> : undefined} />;
  if (settingsSection === "subagents") return <XuenessSubagentSettings
    providersEnabled={isPluginEffective("providers")}
    cancelOneEnabled={settingsValues.subagentCancelOneEnabled === true}
    settingsSaving={settingsSaving}
    onCancelOneEnabledChange={value => void handleUpdateSetting("subagentCancelOneEnabled", value)}
  />;
  if (capabilityKinds.includes(settingsSection as CapabilityKind)) return <CapabilitiesPanel scopeLabel={settingsSection === 'skills' ? tr('内置与用户技能') : undefined} sections={capSections.filter(section => section.kind === settingsSection)} />;
  if (settingsSection === "modules") return <XuenessPluginManager plugins={pluginCatalog} loading={pluginCatalogLoading} error={pluginCatalogError} onRefresh={refreshPluginCatalog} onToggle={togglePlugin} />;
  if (settingsSection === 'subscriptions') return <SubscriptionsPanel embedded onChanged={() => void refreshComposerCatalog()} onSelectModel={id => { updateChoices({ provider: 'real', provider_id: id, model: undefined, reasoning_effort: undefined }); void refreshComposerCatalog(); setPanel('chat'); }} />;
  if (settingsSection === 'workbuddy') return <WorkbuddySettingsPanel />;
  if (settingsSection === 'model-monitor') return <ModelMonitorPanel embedded />;
  if (settingsSection === "marketplace") return <XuenessMarketplace onInstalled={() => void refreshPluginCatalog()} onManagePlugins={() => setSettingsSection('plugins')} />;
  if (settingsSection === "memory") return <XuenessMemorySettings enabled={settingsValues.memoryEnabled !== false} onEnabledChange={value => void handleUpdateSetting("memoryEnabled", value)} />;
  if (settingsSection === "usage") return <XuenessUsageSettings />;
  if (settingsSection === "automations") return <XuenessAutomationsPanel offPeakEnabled={isPluginEffective("automation")} />;
  if (settingsSection === "diagnostics") return <XuenessDiagnosticsPanel />;
  if (settingsSection === "remote") return <RemoteConnections onUse={() => { startNewTask(); setRemoteDialogOpen(true); }} />;
  return null;
}
