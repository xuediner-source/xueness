/**
 * Header of the primary pane: the session's title bar with fork, session
 * info, pin / rename / archive and plugin menu actions, or a titled fallback
 * when no session is open. Moved unchanged out of XuenessWorkbenchContainer.
 */
import React from "react";
import { GitBranch, PanelRight, Share2 } from "lucide-react";
import { t as tr } from "../../i18n";
import type { WorkbenchSession } from "../../xuenessWorkbench";
import type { WorkbenchPanel } from "../../xuenessPluginRegistry";
import { WorkbenchHeader } from "./WorkbenchHeader";
import type { SessionListActions } from "./useSessionListActions";

type WorkbenchSessionHeaderProps = {
  splitControls?: React.ReactNode;
  groupSwitcher?: React.ReactNode;
  session: WorkbenchSession | null;
  activeId: string | null;
  panel: WorkbenchPanel;
  panelLabel: string;
  viewSwitcher: React.ReactNode;
  agentsAvailable: boolean;
  lightweightLayout: boolean;
  busy: boolean;
  activeSessionRunning: boolean;
  isPluginEffective: (id: string) => boolean;
  setPanel: (panel: WorkbenchPanel) => void;
  beginFork: (turn?: number) => void;
  contextSidepaneOpen: boolean;
  setContextSidepaneOpen: (update: (open: boolean) => boolean) => void;
  setDeliveryEditorRequest: (update: (previous: { id: string; version: number } | null) => { id: string; version: number }) => void;
  setShareDialogOpen: (open: boolean) => void;
  listActions: SessionListActions;
};

export function WorkbenchSessionHeader({ splitControls, groupSwitcher, session, activeId, panel, panelLabel, viewSwitcher, agentsAvailable, lightweightLayout, busy,
  activeSessionRunning, isPluginEffective, setPanel, beginFork, contextSidepaneOpen, setContextSidepaneOpen, setDeliveryEditorRequest, setShareDialogOpen, listActions }: WorkbenchSessionHeaderProps) {
  const { togglePin, handleRefreshAll, requestRename, deleteById } = listActions;
  return session ? (<WorkbenchHeader
              session={session} navigation={viewSwitcher} groupSwitcher={groupSwitcher}
              onOpenAgents={agentsAvailable && !lightweightLayout ? () => setPanel("subagents") : undefined}
              actions={<>
                {splitControls}{!lightweightLayout && <><button type="button" className="xn-conv-header__action xn-conv-header__fork" aria-label={tr("分叉会话")} title={tr("分叉会话")} disabled={busy || session.status === "running" || session.streaming?.status === "streaming"} onClick={() => beginFork()}><GitBranch size={14} aria-hidden="true" /><span>{tr("分叉会话")}</span></button></>}
                <button type="button" className="xn-conv-header__action" aria-label={tr("会话信息")} title={tr("会话信息")}
                  aria-pressed={contextSidepaneOpen} onClick={() => { setContextSidepaneOpen(value => !value); }}><PanelRight size={16} aria-hidden="true" /></button>
              </>}
            pinned={session.pinned === true} onTogglePin={() => activeId && void togglePin(activeId, session.pinned !== true)}
            onRefresh={() => void handleRefreshAll()}
            onRename={() => activeId && requestRename(activeId)}
            onDelete={() => activeId && void deleteById(activeId)}
            menuItems={<>
              {isPluginEffective('planning') && <button type="button" className="xn-conv-header__action"
                disabled={busy || activeSessionRunning}
                onClick={() => setDeliveryEditorRequest(previous => ({id: session.id, version: (previous?.version ?? 0) + 1}))}>
                {tr('编辑交付清单')}</button>}
              {isPluginEffective('sessions') && <button type="button" className="xn-conv-header__action"
                disabled={busy || activeSessionRunning}
                onClick={() => setShareDialogOpen(true)}>
                <Share2 size={14} aria-hidden="true" /><span>{tr('分享会话')}</span></button>}
            </>}
          />) : <WorkbenchHeader fallbackTitle={panel === 'chat' ? tr('新会话') : panelLabel} navigation={viewSwitcher} groupSwitcher={groupSwitcher} actions={splitControls} />;
}
