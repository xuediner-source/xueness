import React, { lazy, Suspense, useCallback } from "react";
import type { CapabilityItem, CapabilityKind } from "../../xuenessCapabilities";
import type { WorkbenchPanel } from "../../xuenessPluginRegistry";
import type { SessionSummary } from "../../xuenessWorkbench";
import type { WorkspaceSelection } from "../sessions/useWorkspaceSelection";
import type { useSessionListActions } from "../sessions/useSessionListActions";
import type { usePrimaryFork } from "../sessions/primaryForkCommand";
import type { useCommandPaletteState } from "../sessions/commandPaletteState";
import {
  ForkSessionDialog, XuenessCapabilityDialog, XuenessCloneDialog, XuenessRenameDialog, XuenessWorkspacePickerDialog,
} from "../settings/workbenchSettingsViews";

const CommandPalette = lazy(() => import("./CommandPalette").then(module => ({ default: module.CommandPalette })));

export function WorkbenchCommandPalette({
  palette, sessions, busy, isPluginEffective, startNewTask, setPanel, handleRefreshAll, selectSession, setConversationFindRequest,
}: {
  palette: ReturnType<typeof useCommandPaletteState>;
  sessions: SessionSummary[];
  busy: boolean;
  isPluginEffective: (id: string) => boolean;
  startNewTask: () => void;
  setPanel: (panel: WorkbenchPanel) => void;
  handleRefreshAll: () => Promise<void>;
  selectSession: (id: string) => void;
  setConversationFindRequest: (req: { sessionId: string; id: string; query: string } | null) => void;
}) {
  const { setCommandOpen } = palette;
  const runPaletteCommand = useCallback((id: string) => {
    setCommandOpen(false);
    if (id === "new-task") startNewTask();
    else if (id === "open-settings" && isPluginEffective("settings")) setPanel("settings");
    else if (id === "refresh") void handleRefreshAll();
  }, [setCommandOpen, startNewTask, handleRefreshAll, isPluginEffective, setPanel]);
  if (!palette.commandPaletteEnabled) return null;
  return (
    <Suspense fallback={null}>
      <CommandPalette
        dialogRef={palette.commandDialogRef}
        inputRef={palette.commandRef}
        returnFocusTo={palette.commandOpenerRef.current}
        sessions={sessions}
        busy={busy}
        sessionsEnabled={isPluginEffective("sessions")}
        settingsEnabled={isPluginEffective("settings")}
        onClose={() => setCommandOpen(false)}
        onRunCommand={runPaletteCommand}
        onSelectSession={(id, query) => {
          selectSession(id);
          setConversationFindRequest(query ? { sessionId: id, id: crypto.randomUUID(), query } : null);
        }}
      />
    </Suspense>
  );
}

type WorkbenchDialogsProps = {
  workspace: WorkspaceSelection;
  chooseWorkspace: (root: string) => void;
  draftRoot: string | undefined;
  catalogRoot: string | null | undefined;
  isPluginEffective: (id: string) => boolean;
  listActions: ReturnType<typeof useSessionListActions>;
  capDialog: { mode: "create" | "edit"; kind: CapabilityKind; initial: CapabilityItem | null } | null;
  setCapDialog: (next: null) => void;
  capDialogBusy: boolean;
  capDialogError: string;
  handleCapSubmit: (payload: { id: string; fields: Record<string, unknown> }) => Promise<void>;
  permissionDialog: React.ReactNode;
  fork: ReturnType<typeof usePrimaryFork>;
};

export function WorkbenchDialogs({
  workspace, chooseWorkspace, draftRoot, catalogRoot, isPluginEffective, listActions,
  capDialog, setCapDialog, capDialogBusy, capDialogError, handleCapSubmit, permissionDialog, fork,
}: WorkbenchDialogsProps) {
  return (
    <>
      {workspace.workspacePicking && (
        <Suspense fallback={null}>
          <XuenessWorkspacePickerDialog
            open
            currentRoot={draftRoot ?? catalogRoot ?? undefined}
            returnFocusTo={workspace.workspacePickerOpener.current}
            mode={workspace.workspacePickerMode}
            onChoose={chooseWorkspace}
            onCancel={() => workspace.setWorkspacePicking(false)}
          />
        </Suspense>
      )}
      {workspace.cloneOpen && isPluginEffective("git") && (
        <Suspense fallback={null}>
          <XuenessCloneDialog
            open
            defaultParent={(draftRoot ?? catalogRoot) ?? null}
            returnFocusTo={workspace.cloneOpener.current}
            onCancel={() => workspace.setCloneOpen(false)}
            onCloned={root => {
              workspace.setCloneOpen(false);
              void workspace.refreshRecentProjects();
              chooseWorkspace(root);
            }}
          />
        </Suspense>
      )}
      {listActions.renameRequest !== null && (
        <Suspense fallback={null}>
          <XuenessRenameDialog
            open
            initialValue={listActions.renameRequest.initialValue}
            returnFocusTo={listActions.renameOpenerRef.current}
            onCancel={() => listActions.setRenameRequest(null)}
            onConfirm={value => {
              const request = listActions.renameRequest;
              listActions.setRenameRequest(null);
              if (request) void listActions.renameById(request.id, value);
            }}
          />
        </Suspense>
      )}
      {capDialog !== null && (
        <Suspense fallback={null}>
          <XuenessCapabilityDialog
            open
            mode={capDialog.mode}
            kind={capDialog.kind}
            initial={capDialog.initial ?? null}
            busy={capDialogBusy}
            error={capDialogError || undefined}
            onCancel={() => setCapDialog(null)}
            onSubmit={payload => void handleCapSubmit(payload)}
          />
        </Suspense>
      )}
      {permissionDialog}
      {fork.forkSource !== null && (
        <Suspense fallback={null}>
          <ForkSessionDialog
            open
            sourceId={fork.forkSource.id}
            sourceTitle={fork.forkSource.title}
            initialTurn={fork.forkSource.turn}
            createFork={fork.createPrimaryFork}
            onCancel={() => fork.setForkSource(null)}
            onFork={fork.completeFork}
          />
        </Suspense>
      )}
    </>
  );
}
