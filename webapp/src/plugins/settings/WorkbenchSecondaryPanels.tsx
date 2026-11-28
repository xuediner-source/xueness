import React, { Suspense, useEffect, useRef, useState } from "react";
import { t as tr, tf } from "../../i18n";
import { get, type MemoryTrack, type XuenessPlugin } from "../../xuenessApi";
import type { WorkbenchPanel } from "../../xuenessPluginRegistry";
import type { CapabilityKind } from "../../xuenessCapabilities";
import type { CapabilitySectionProps } from "../../XuenessCapabilitiesPanel";
import type { WorkbenchSession } from "../../xuenessWorkbench";
import type { RuntimeProfile } from "../../xuenessComposer";
import { initGitRepository, stageGitPaths, unstageGitPaths, commitGitChanges, switchGitBranch, stashGitChanges, createGitCheckpoint, restoreGitCheckpoint } from "../../xuenessGit";
import { usePanelResource } from "../shared";
import type { useGitPanel } from "../git/useGitPanel";
import type { useWorkbenchFiles } from "../files/useWorkbenchFiles";
import type { useDefaultModelSelection } from "../providers/useDefaultModelSelection";
import type { useComposerCatalog } from "../sessions/useComposerCatalog";
import type { WorkbenchSettings } from "./useWorkbenchSettings";
import type { resolvePaneSidePanelBinding } from "../sessions/paneSidePanelBinding";
import {
  BrowserPanel, CapabilitiesPanel, ContextLensPanel, DiffView, DirectoryBrowser, FileBrowser,
  MagpiePanel, MemoryOcean, ModelManager, ModelMonitorPanel, RemoteConnections, SubagentSidePane,
  SwarmPanel, TavernPanel, TerminalPanel, WorkbenchSettingsPanel, WorkflowPanel,
  XuenessAutomationsPanel, XuenessDiagnosticsPanel, XuenessGitView, XuenessMarketplace, XuenessMcpTools,
  XuenessPluginManager, XuenessUsageSettings,
} from "./workbenchSettingsViews";

export function usePanelHistory(activeId: string | null, setActiveId: (id: string | null) => void, busy: boolean) {
  const [panel, setPanel] = useState<WorkbenchPanel>("chat");
  const history = useRef<{ panel: WorkbenchPanel; activeId: string | null }[]>([{ panel: "chat", activeId: null }]);
  const historyCursor = useRef(0);
  const historyTarget = useRef<string | null>(null);
  const [historyPosition, setHistoryPosition] = useState({ cursor: 0, length: 1 });
  useEffect(() => {
    const key = `${panel}:${activeId ?? ""}`;
    if (historyTarget.current === key) { historyTarget.current = null; return; }
    const current = history.current[historyCursor.current];
    if (current.panel === panel && current.activeId === activeId) return;
    history.current = [...history.current.slice(0, historyCursor.current + 1), { panel, activeId }];
    historyCursor.current = history.current.length - 1;
    setHistoryPosition({ cursor: historyCursor.current, length: history.current.length });
  }, [panel, activeId]);
  const navigateHistory = (direction: number) => {
    const cursor = historyCursor.current + direction;
    const target = history.current[cursor];
    if (!target || busy) return;
    historyCursor.current = cursor;
    historyTarget.current = `${target.panel}:${target.activeId ?? ""}`;
    setPanel(target.panel); setActiveId(target.activeId);
    setHistoryPosition({ cursor, length: history.current.length });
  };
  return { panel, setPanel, historyPosition, navigateHistory };
}

type SecondaryPanelsInput = {
  panel: WorkbenchPanel;
  setPanel: (panel: WorkbenchPanel) => void;
  activeId: string | null;
  activeIdRef: React.MutableRefObject<string | null>;
  session: WorkbenchSession | null;
  busy: boolean;
  locale: "zh" | "en";
  isPluginEffective: (id: string) => boolean;
  settings: WorkbenchSettings;
  capabilityKinds: CapabilityKind[];
  capSections: CapabilitySectionProps[];
  loadCapSlot: (kind: CapabilityKind) => Promise<void>;
  pluginCatalog: XuenessPlugin[];
  pluginCatalogLoading: boolean;
  pluginCatalogError: string;
  refreshPluginCatalog: () => Promise<void>;
  togglePlugin: (id: string, enabled: boolean) => Promise<void>;
  composer: ReturnType<typeof useComposerCatalog>;
  defaultModel: ReturnType<typeof useDefaultModelSelection>;
  filesPanel: ReturnType<typeof useWorkbenchFiles>;
  gitPanel: ReturnType<typeof useGitPanel>;
  memoryTracks: ReturnType<typeof usePanelResource<MemoryTrack[]>>;
  scopedSidePanel: ReturnType<typeof resolvePaneSidePanelBinding>;
  activeRuntimeProfile: RuntimeProfile | undefined;
  lightweightLayout: boolean;
  startNewTask: () => void;
  appendTextToComposer: (targetSessionId: string | null, text: string, workspaceRoot?: string) => void;
  setRemoteDialogOpen: (open: boolean) => void;
  selectSession: (id: string) => void;
  handleCreate: (text: string, input?: never, onAccepted?: never, tavernRef?: { plugin: "tavern"; id: string }) => Promise<boolean>;
  handleStop: () => Promise<void>;
};

/** Mount secondary plugin panels on demand; each lazy chunk loads only when its panel opens. */
export function buildSecondaryPanels({
  panel, setPanel, activeId, activeIdRef, session, busy, locale, isPluginEffective, settings, capabilityKinds, capSections,
  loadCapSlot, pluginCatalog, pluginCatalogLoading, pluginCatalogError, refreshPluginCatalog, togglePlugin, composer, defaultModel,
  filesPanel, gitPanel, memoryTracks, scopedSidePanel, activeRuntimeProfile, lightweightLayout, startNewTask, appendTextToComposer,
  setRemoteDialogOpen, selectSession, handleCreate, handleStop,
}: SecondaryPanelsInput): Record<Exclude<WorkbenchPanel, "chat">, React.ReactNode> {
  const { settingsValues, settingsSection } = settings;
  const { refreshComposerCatalog, updateChoices } = composer;
  const { gitStatus, gitStatusError, gitDiff, gitDiffError, gitLog, gitLogError, gitCheckpoints, gitCheckpointError, gitLoading, gitActionBusy, loadGitPanel, runGitAction } = gitPanel;
  void panel;
  void settingsSection;

  return {
    remote: <RemoteConnections onUse={() => { startNewTask(); setRemoteDialogOpen(true); }} />,
    subagents: (
      <Suspense fallback={<div className="p-4 text-xs text-[var(--fg-muted)]">{tr("正在加载…")}</div>}>
        <SubagentSidePane
          sessionId={activeId}
          isOpen={true}
          onClose={() => setPanel("chat")}
          activeRuntimeProfile={activeRuntimeProfile}
          subagentsEnabled={isPluginEffective("subagents")}
          cancelOneEnabled={settingsValues.subagentCancelOneEnabled === true}
          lightweight={lightweightLayout}
          mode="panel"
          onStopSession={handleStop}
          onRequestResumeChild={taskId => {
            if (!activeId || !isPluginEffective("sessions") || !isPluginEffective("subagents")) return;
            appendTextToComposer(activeId, tf("请恢复已保留的子任务 {0}，沿用它的历史与只读权限，继续处理并收集结果。", [taskId]));
            setPanel("chat");
          }}
        />
      </Suspense>
    ),
    plugins: <XuenessPluginManager plugins={pluginCatalog} loading={pluginCatalogLoading} error={pluginCatalogError} onRefresh={refreshPluginCatalog} onToggle={togglePlugin} />,
    workflows: <WorkflowPanel sessionId={activeId} subagentsEnabled={isPluginEffective("subagents")} />,
    terminal: <TerminalPanel {...scopedSidePanel} fontSize={Number(settingsValues.terminalFontSize ?? 13)} fontFamily={String(settingsValues.terminalFontFamily ?? "system")} />,
    browser: <BrowserPanel {...scopedSidePanel} />,
    automations: <XuenessAutomationsPanel offPeakEnabled={isPluginEffective("automation")} />,
    marketplace: <XuenessMarketplace onInstalled={() => void refreshPluginCatalog()} onManagePlugins={() => setPanel("plugins")} />,
    magpie: <MagpiePanel onModelsChanged={() => void refreshComposerCatalog()} onSelectModel={id => { composer.selectProviderForCurrentRun(id); setPanel("chat"); }} />,
    "model-monitor": <ModelMonitorPanel />,
    diagnostics: <XuenessDiagnosticsPanel />,
    files: (
      <FileBrowser
        files={filesPanel.files}
        truncated={filesPanel.filesTruncated}
        selectedPath={filesPanel.selectedPath}
        preview={filesPanel.preview}
        previewError={filesPanel.previewError}
        officePreviewEnabled={isPluginEffective("office")}
        onSelect={filesPanel.handleSelectFile}
      />
    ),
    changes: <DiffView changeSet={filesPanel.changeSet} error={filesPanel.changesError} />,
    git: (
      <XuenessGitView
        status={gitStatus}
        statusError={gitStatusError || undefined}
        statusLoading={gitLoading}
        diff={gitDiff}
        diffError={gitDiffError || undefined}
        diffLoading={gitLoading}
        log={gitLog}
        logError={gitLogError || undefined}
        logLoading={gitLoading}
        checkpoints={gitCheckpoints}
        actionError={gitCheckpointError}
        actionBusy={gitActionBusy}
        onRefresh={() => void loadGitPanel()}
        onInit={() => void runGitAction(() => initGitRepository(activeId!))}
        onStage={paths => void runGitAction(() => stageGitPaths(activeId!, paths))}
        onUnstage={paths => void runGitAction(() => unstageGitPaths(activeId!, paths))}
        onCommit={message => void runGitAction(() => commitGitChanges(activeId!, message))}
        onBranch={(name, create) => void runGitAction(() => switchGitBranch(activeId!, name, create))}
        onStash={() => void runGitAction(() => stashGitChanges(activeId!))}
        onCheckpoint={message => void runGitAction(() => createGitCheckpoint(activeId!, message))}
        onRestore={checkpointId => void runGitAction(() => restoreGitCheckpoint(activeId!, checkpointId))}
      />
    ),
    directory: <DirectoryBrowser currentPath={filesPanel.dirListing?.path ?? null} entries={filesPanel.dirListing?.entries ?? []}
      error={filesPanel.dirError} truncated={filesPanel.dirListing?.truncated ?? false} loading={filesPanel.dirLoading}
      onNavigate={filesPanel.browseDirectory} onOpenFile={filesPanel.handleSelectFile} onCreateDir={filesPanel.handleCreateDir} />,
    providers: (
      <ModelManager focusProviderId={defaultModel.providerFocusId} runtimeMonitorEnabled={isPluginEffective("providers") && isPluginEffective("diagnostics")} onSelect={id => { composer.selectProviderForCurrentRun(id); setPanel("chat"); }}
        onRefreshExternal={isPluginEffective("magpie") ? async () => { const s = await get<{ state?: string }>("/api/magpie/status").catch(() => null); if (s?.state === "running") await get("/api/magpie/models").catch(() => null); } : undefined}
        onManageSource={isPluginEffective("magpie") ? source => { if (source === "magpie") setPanel("magpie"); } : undefined} />
    ),
    "context-lens": <ContextLensPanel enabled={isPluginEffective("context_lens")} settingsEnabled={isPluginEffective("settings")} sessionId={activeId} onOpenSession={selectSession} onSelectSession={id => { selectSession(id); setPanel("context-lens"); }} />,
    usage: <XuenessUsageSettings />,
    memory: <MemoryOcean workspaceRoot={typeof session?.root === "string" ? session.root : undefined} tracks={memoryTracks} />,
    swarm: <SwarmPanel enabled={isPluginEffective("swarm")} sessionId={activeId} />,
    // Roleplay chats start from here tagged with their Tavern playthrough; the conversation itself is an ordinary session.
    tavern: <TavernPanel onStart={text => { startNewTask(); appendTextToComposer(null, text); }} onStartSession={(text, ref) => { setPanel("chat"); return handleCreate(text, undefined, undefined, ref); }} onOpenSession={id => { selectSession(id); setPanel("chat"); }} />,
    capabilities: <><CapabilitiesPanel sections={capSections} />{isPluginEffective("mcp") && <XuenessMcpTools />}</>,
    settings: <WorkbenchSettingsPanel settings={settings} isPluginEffective={isPluginEffective} capabilityKinds={capabilityKinds} capSections={capSections}
      loadCapSlot={loadCapSlot} pluginCatalog={pluginCatalog} pluginCatalogLoading={pluginCatalogLoading} pluginCatalogError={pluginCatalogError}
      refreshPluginCatalog={refreshPluginCatalog} togglePlugin={togglePlugin} locale={locale} busy={busy} session={session} activeId={activeId} activeIdRef={activeIdRef}
      composer={composer} providerFocusId={defaultModel.providerFocusId} setPanel={setPanel} startNewTask={startNewTask} appendTextToComposer={appendTextToComposer} setRemoteDialogOpen={setRemoteDialogOpen} />,
  };
}
