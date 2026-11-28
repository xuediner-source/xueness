/**
 * The start page body of the primary pane (greeting, start actions and docked
 * new-task composer). Split from `WorkbenchConversation` so active-session
 * timeline code loads lazily on demand.
 */
import React, { lazy, Suspense } from "react";
import { CircleHelp, Monitor } from "lucide-react";
import { t as tr, tf, type useLocale } from "../../i18n";
import type { RunChoices } from "../../xuenessBridge";
import type { ComposerCatalog, ComposerModel } from "../../xuenessComposer";
import type { SessionSummary } from "../../xuenessWorkbench";
import type { WorkbenchPanel } from "../../xuenessPluginRegistry";
import type { RecentWorkspaceDirectory } from "../../xuenessWorkspaces";
import { IconXuenessMark } from "../../ui/icons";
import { optionalComponent } from "../extensions/optionalFrontend";
import type { RemoteSessionAdapter } from "../remote/remoteSessionAdapter";
import { CommandReceiptRecovery } from "./CommandReceiptRecovery";
import { ConversationTimelineViewport } from "./ConversationTimelineViewport";
import { heroGreeting } from "./WorkbenchHeader";
import { XuenessStartPage, type StartPageAction } from "./XuenessStartPage";
import { Composer } from "./XuenessWorkbenchView";
import type { ComposerProps } from "./composerTypes";
import type { WorkbenchSessionData } from "./useWorkbenchSessionData";

const StarterIdeas = lazy(() => import("./StarterIdeas").then(module => ({ default: module.StarterIdeas })));
const StartPageRemoteDialog = lazy(() => import("./StartPageRemoteDialog"));
const ModelMonitorHome = optionalComponent<{
  sessionId?: string;
  providerId?: string;
  requestedModel?: string;
  providerName?: string;
  running?: boolean;
  onOpenHistory: () => void;
}>("model_monitor", "ModelMonitorHome");

/** Composer props both primary composers (conversation and start page) share. */
export type WorkbenchComposerShared = Pick<
  ComposerProps,
  | "draftStore"
  | "richComposer"
  | "attachmentRoot"
  | "inputRef"
  | "platform"
  | "sendShortcut"
  | "shortcutBindings"
  | "sendDisabledReason"
  | "running"
  | "controls"
  | "startActions"
  | "capabilities"
  | "mentions"
  | "commands"
  | "files"
>;

export type WorkbenchStartViewProps = {
  isPluginEffective: (id: string) => boolean;
  lightweightLayout: boolean;
  claudexAppearance: boolean;
  locale: ReturnType<typeof useLocale>;
  viewSwitcher: React.ReactNode;
  workspaceContext: React.ReactNode;
  composerCatalog: ComposerCatalog;
  draftRoot: string | undefined;
  choices: RunChoices;
  selectedComposerModel: ComposerModel | undefined;
  startPageActions: StartPageAction[];
  recentProjects: RecentWorkspaceDirectory[] | null;
  liveSessions: SessionSummary[];
  selectSession: (id: string) => void;
  chooseWorkspace: (root: string, isolated?: boolean, forceNew?: boolean) => void;
  remoteDialogOpen: boolean;
  setRemoteDialogOpen: (open: boolean) => void;
  setRemoteAdapter: (adapter: RemoteSessionAdapter | null) => void;
  updateChoices: (patch: Partial<RunChoices>) => void;
  setPanel: (panel: WorkbenchPanel) => void;
  busy: boolean;
  runError: string;
  creatingSession: boolean;
  activeId: string | null;
  stoppingSessions: Set<string>;
  handleStop: () => Promise<void>;
  sessionCommands: WorkbenchSessionData["sessionCommands"];
  handleRefreshAll: () => Promise<void>;
  composer: WorkbenchComposerShared;
  workspaceKey: string;
  commandRoot: string;
  starterWorkspaceKey: string;
  composerModelReady: boolean;
  composerCatalogLoading: boolean;
  composerCatalogError: string;
  refreshComposerCatalog: () => Promise<void>;
  onSend: NonNullable<ComposerProps["onSend"]>;
  appendTextToComposer: (targetSessionId: string | null, text: string, workspaceRoot?: string) => void;
};

/** Body of `.xn-empty-state-shell`: the start page with the docked new-task composer. */
export function WorkbenchStartView({
  isPluginEffective, lightweightLayout, claudexAppearance, locale, viewSwitcher, workspaceContext, composerCatalog, draftRoot,
  choices, selectedComposerModel, startPageActions, recentProjects, liveSessions, selectSession, chooseWorkspace, remoteDialogOpen, setRemoteDialogOpen,
  setRemoteAdapter, updateChoices, setPanel, busy, runError, creatingSession, activeId, stoppingSessions, handleStop, sessionCommands, handleRefreshAll,
  composer, workspaceKey, commandRoot, starterWorkspaceKey, composerModelReady, composerCatalogLoading, composerCatalogError, refreshComposerCatalog, onSend,
  appendTextToComposer,
}: WorkbenchStartViewProps) {
  return (
    <ConversationTimelineViewport
      autoScroll={false}
      rowsVersion={[]}
      centerEmptyStateWithDock
      emptyState={
        <div className="xn-empty-state-content">
          {!lightweightLayout && (
            <div className="xn-hero__bar">
              <details className="xn-workbench-menu">
                <summary aria-label={tr("工作台")}><CircleHelp size={16} /></summary>
                <div>{viewSwitcher}</div>
              </details>
            </div>
          )}
          <div className="xn-hero__intro">
            <div className="xn-hero__brand" aria-hidden="true"><IconXuenessMark size={34} className="xn-hero__brand-mark" /></div>
            <h1 className="xn-hero__greeting">
              {claudexAppearance
                ? tf("我们应该在 {0} 中做些什么？", [composerCatalog.roots.find(item => item.path === (draftRoot ?? composerCatalog.root))?.name ?? (draftRoot ?? composerCatalog.root)?.split(/[/\\]/u).filter(Boolean).pop() ?? "Xueness"])
                : heroGreeting(new Date())}
            </h1>
            <p className="xn-hero__hint">{tr("描述你想完成的事，Xueness 会在你的工作区里执行。")}</p>
          </div>
          {!lightweightLayout && (
            <XuenessStartPage
              actions={startPageActions}
              projects={recentProjects}
              sessions={liveSessions}
              locale={locale}
              onSelectSession={selectSession}
              onSelectProject={root => chooseWorkspace(root)}
              remoteDialog={
                remoteDialogOpen && isPluginEffective("remote") ? (
                  <Suspense fallback={null}>
                    <StartPageRemoteDialog
                      open={remoteDialogOpen}
                      allowRemote={isPluginEffective("remote")}
                      onClose={() => setRemoteDialogOpen(false)}
                      onSelectRemote={(id, adapter) => {
                        chooseWorkspace(composerCatalog.isolatedRoot, true);
                        setRemoteAdapter(adapter);
                        updateChoices({ remote: id });
                        setRemoteDialogOpen(false);
                      }}
                      currentRemoteId={choices.remote}
                      connections={composerCatalog.remoteConnections}
                      onManageRemote={() => {
                        setRemoteDialogOpen(false);
                        setPanel("remote");
                      }}
                    />
                  </Suspense>
                ) : null
              }
            />
          )}
        </div>
      }
      bottomDock={
        <div className="xn-hero__composer">
          {isPluginEffective("model_monitor") && (
            <Suspense fallback={null}>
              <ModelMonitorHome
                key="new-chat"
                providerId={choices.provider_id}
                requestedModel={choices.model ?? selectedComposerModel?.model}
                providerName={selectedComposerModel?.supplierName ?? selectedComposerModel?.name}
                onOpenHistory={() => setPanel("model-monitor")}
              />
            </Suspense>
          )}
          {claudexAppearance && (
            <div className="xn-hero__workspace">
              {workspaceContext}
              <span className="xn-composer-workspace__host"><Monitor size={15} aria-hidden="true" />{choices.remote ? tr("SSH 工作区") : tr("此计算机")}</span>
            </div>
          )}
          {runError && <p role="alert" className="xn-run-error">{runError}</p>}
          <CommandReceiptRecovery commands={sessionCommands} enabled={isPluginEffective("sessions")} onRefresh={handleRefreshAll} onOpenSession={selectSession} />
          <Composer
            {...composer}
            draftKey="new-task"
            workspaceKey={workspaceKey}
            variant="docked"
            topContent={claudexAppearance ? undefined : workspaceContext}
            onSend={onSend}
            disabled={busy || !commandRoot || !isPluginEffective("sessions")}
            sendDisabled={creatingSession || !composerModelReady || composerCatalogLoading}
            stopping={activeId ? stoppingSessions.has(activeId) : false}
            onStop={activeId ? handleStop : undefined}
            placeholder={tr("向 Xueness 提问，使用 @ 添加上下文，使用 / 选择命令或能力")}
          />
          {!composerCatalogLoading && !composerModelReady && (composerCatalogError || (composerCatalog.models.some(model => model.configured) && !composerCatalog.allowReal)) && (
            <div className="xn-composer-model-setup" role="status">
              <span>{tr(composerCatalogError ? "模型列表加载失败，请重试。" : composerCatalog.models.some(model => model.configured) && !composerCatalog.allowReal ? "服务端已关闭模型请求。" : "配置一个模型即可开始对话。")}</span>
              <button type="button" onClick={() => composerCatalogError ? void refreshComposerCatalog() : setPanel(isPluginEffective("providers") ? "providers" : "plugins")}>
                {tr(composerCatalogError ? "重试" : "配置模型")}
              </button>
            </div>
          )}
          {isPluginEffective("sessions") && (
            <Suspense fallback={null}>
              <StarterIdeas disabled={busy || creatingSession} onSelect={prompt => appendTextToComposer(null, prompt, starterWorkspaceKey)} />
            </Suspense>
          )}
        </div>
      }
    />
  );
}
