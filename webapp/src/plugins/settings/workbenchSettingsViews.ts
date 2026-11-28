/**
 * Plugin views that appear both as a settings section and as a workbench
 * panel (or the sidebar footer). Each is declared once so a view loaded in
 * one place renders without a second suspense in the other. Views only load
 * when a permitted section or panel mounts them.
 */
import { lazy } from "react";
import { optionalComponent } from "../extensions/optionalFrontend";

export const CapabilitiesPanel = lazy(() => import('../../XuenessCapabilitiesPanel').then(module => ({ default: module.CapabilitiesPanel })));
export const DesktopUpdates = lazy(() => import("../updates/DesktopUpdates").then(module => ({ default: module.DesktopUpdates })));
export const ModelManager = lazy(() => import("../providers").then(module => ({ default: module.ModelManager })));
// Marketplace plugins: their interface comes from the package the user downloaded (see optionalFrontend.ts).
export const MagpiePanel = optionalComponent<{ embedded?: boolean; onModelsChanged?: () => void; onSelectModel?: (profileId: string) => void }>('magpie', 'MagpiePanel');
export const ModelMonitorPanel = optionalComponent<{ embedded?: boolean }>('model_monitor', 'ModelMonitorPanel');
export type TavernSessionRef = { plugin: 'tavern'; id: string };
export const TavernPanel = optionalComponent<{ onStart(text: string): void; onStartSession?(text: string, ref: TavernSessionRef): Promise<boolean>; onOpenSession?(id: string): void; onOpenPanel?(): void }>('tavern', 'TavernPanel');
export const RemoteConnections = lazy(() => import("../remote").then(module => ({ default: module.RemoteConnections })));
export const XuenessMarketplace = lazy(() => import("../extensions").then(module => ({ default: module.XuenessMarketplace })));
export const XuenessAutomationsPanel = lazy(() => import("../automation").then(module => ({ default: module.XuenessAutomationsPanel })));
export const XuenessMcpTools = lazy(() => import("../mcp").then(module => ({ default: module.XuenessMcpTools })));
export const XuenessDiagnosticsPanel = lazy(() => import("../diagnostics").then(module => ({ default: module.XuenessDiagnosticsPanel })));
export const SwarmPanel = lazy(() => import("../swarm/SwarmPanel").then(module => ({ default: module.SwarmPanel })));
export const XuenessUsageSettings = lazy(() => import("../usage/XuenessUsageSettings").then(module => ({ default: module.XuenessUsageSettings })));
export const XuenessPluginManager = lazy(() => import("../../XuenessPluginManager").then(module => ({ default: module.XuenessPluginManager })));
export const XuenessPluginSettingsPanel = lazy(() => import("../../XuenessPluginManager").then(module => ({ default: module.XuenessPluginSettingsPanel })));
export const FileBrowser = lazy(() => import("../files/FileBrowser").then(module => ({ default: module.FileBrowser })));
export const DiffView = lazy(() => import("../files/DiffView").then(module => ({ default: module.DiffView })));
export const DirectoryBrowser = lazy(() => import("../files/DirectoryBrowser").then(module => ({ default: module.DirectoryBrowser })));
export const MemoryOcean = lazy(() => import("../memory/MemoryOcean").then(module => ({ default: module.MemoryOcean })));
export const DesktopPermissionOnboarding = lazy(() => import("../onboarding/DesktopPermissionOnboarding").then(module => ({ default: module.DesktopPermissionOnboarding })));
export const WorkflowPanel = lazy(() => import("../workflows").then(module => ({ default: module.WorkflowPanel })));
export const TerminalPanel = lazy(() => import("../terminal").then(module => ({ default: module.TerminalPanel })));
export const XuenessGitView = lazy(() => import("../git/XuenessGitView").then(module => ({ default: module.XuenessGitView })));
export const ContextLensPanel = lazy(() => import("../context_lens/ContextLensPanel").then(module => ({ default: module.ContextLensPanel })));
export const BrowserPanel = lazy(() => import("../browser/BrowserPanel").then(module => ({ default: module.BrowserPanel })));
export const SkillsSection = lazy(() => import("../skills/SkillsSection").then(module => ({ default: module.SkillsSection })));
export const SessionPaneWorkbench = lazy(() => import("../sessions/SessionPaneWorkbench").then(module => ({ default: module.SessionPaneWorkbench })));
export const ForkSessionDialog = lazy(() => import("../sessions/ForkSessionDialog").then(module => ({ default: module.ForkSessionDialog })));
export const XuenessRenameDialog = lazy(() => import("../sessions/XuenessRenameDialog").then(module => ({ default: module.XuenessRenameDialog })));
export const XuenessCloneDialog = lazy(() => import("../git/XuenessCloneDialog").then(module => ({ default: module.XuenessCloneDialog })));
export const XuenessWorkspacePickerDialog = lazy(() => import("./XuenessWorkspacePickerDialog").then(module => ({ default: module.XuenessWorkspacePickerDialog })));
export const XuenessCapabilityDialog = lazy(() => import("../../XuenessCapabilityDialog").then(module => ({ default: module.XuenessCapabilityDialog })));
export const WorkbenchSettingsPanel = lazy(() => import("./WorkbenchSettingsPanel").then(module => ({ default: module.WorkbenchSettingsPanel })));
export const SubagentSidePane = lazy(() => import("../subagents/SubagentSidePane").then(module => ({ default: module.SubagentSidePane })));
