/**
 * Composer draft rules the workbench applies outside the composer itself:
 * model-recovery actions, which startup draft scope to keep, and the two
 * programmatic draft writers (append a quote/prompt, move withdrawn text back).
 * Moved unchanged out of XuenessWorkbenchContainer.
 */
import type React from "react";
import { useCallback } from "react";
import { t as tr } from "../../i18n";
import type { WorkbenchSession } from "../../xuenessWorkbench";
import { replacementComposerDraftIdentity } from './composerAttachmentDraft';
import { composerDraftContent, hasComposerDraftContent, notifyComposerDrafts } from './composerRecovery';
import { editorStateForPlainText, retargetEditorText } from './composerEditorState';
import { persistDraft, restoredDraft, type PersistedComposerDraft } from "./composerDraftStore";
import { type ComposerDraftState } from "./composerTypes";
import { type ComposerModelRecovery } from "./composerInputHelpers";

type ComposerModelRecoveryInput = {
  loading: boolean;
  error: string;
  modelReady: boolean;
  allowReal: boolean;
  hasConfiguredModel: boolean;
  onRetry: () => void;
  onConfigure: () => void;
};

/** Keep recovery actions explicit: catalog failures retry discovery; absent models open setup. */
export function composerModelRecoveryFor(input: ComposerModelRecoveryInput): ComposerModelRecovery | undefined {
  if (input.loading) return { kind: "loading" };
  if (input.error) return { kind: "error", onRetry: input.onRetry };
  if (input.modelReady) return undefined;
  if (!input.allowReal && input.hasConfiguredModel) return { kind: "blocked" };
  return { kind: "missing", onConfigure: input.onConfigure };
}

type PrimaryDraftHydrationInput = {
  activeId: string | null;
  draftRoot: string | undefined;
  remote: boolean;
  catalogRoot: string | null | undefined;
  commandRoot: string;
  draftStore: ReadonlyMap<string, ComposerDraftState>;
  persistedDrafts: readonly (ComposerDraftState | null)[];
};

function hasDraftStateToPreserve(draft: Partial<ComposerDraftState> | null | undefined): boolean {
  return Boolean(draft && (hasComposerDraftContent(draft) || draft.pendingSubmission || draft.deliveryUnconfirmed
    || draft.recoverableDrafts?.length || draft.submissionError || draft.attachmentError));
}

/** Keep the first composer on default:new-task until that saved draft is restored. */
export function shouldPreservePersistedDefaultDraftScope(persisted: PersistedComposerDraft | null): boolean {
  return Boolean(persisted && hasDraftStateToPreserve(restoredDraft(persisted)));
}

/** Only rebind the startup draft pane after both in-memory and persisted scopes are known empty. */
export function shouldHydrateEmptyPrimaryDraftScope(input: PrimaryDraftHydrationInput): boolean {
  if (input.activeId !== null || input.draftRoot !== undefined || input.remote || !input.catalogRoot) return false;
  const draftKeys = new Set(['default:new-task', `${input.commandRoot || 'default'}:new-task`]);
  for (const key of draftKeys) {
    if (hasDraftStateToPreserve(input.draftStore.get(key))) return false;
  }
  return !input.persistedDrafts.some(hasDraftStateToPreserve);
}

type ComposerDraftWriterInput = {
  draftStore: React.MutableRefObject<Map<string, ComposerDraftState>>;
  sessionSnapshotRef: React.MutableRefObject<WorkbenchSession | null>;
  activeIdRef: React.MutableRefObject<string | null>;
  heroInputRef: React.MutableRefObject<HTMLElement | null>;
  draftRoot: string | undefined;
  catalogRoot: string | null;
  commandRoot: string;
};

/** Programmatic writes into a session's (or the new task's) saved composer draft. */
export function useComposerDraftWriters({ draftStore: composerDraftStore, sessionSnapshotRef, activeIdRef, heroInputRef, draftRoot, catalogRoot, commandRoot }: ComposerDraftWriterInput) {
  const appendTextToComposer = useCallback((targetSessionId: string | null, text: string, workspaceRoot?: string) => {
    const root = workspaceRoot ?? (sessionSnapshotRef.current?.id === targetSessionId
      ? sessionSnapshotRef.current.root ?? draftRoot ?? catalogRoot
      : draftRoot ?? catalogRoot);
    const workspaceKey = root || 'default';
    const draftKey = targetSessionId ? `session:${targetSessionId}` : 'new-task';
    const scopedKey = `${workspaceKey}:${draftKey}`;
    const current = composerDraftStore.current.get(scopedKey) ?? {
      text: '', attachments: [], goal: false,
      selectedContext: { files: [], sessions: [], skills: [], plugins: [] },
      selectedCapabilities: [], submissionError: '', attachmentError: '', revision: 0,
    };
    const nextText = current.text.trimEnd() ? `${current.text.trimEnd()}\n\n${text}` : text;
    const next: ComposerDraftState = {
      ...current,
      text: nextText,
      editorState: retargetEditorText(current.editorState, nextText) ?? undefined,
      submissionError: '',
      revision: current.revision + 1,
    };
    composerDraftStore.current.set(scopedKey, next);
    persistDraft(workspaceKey, draftKey, next);
    notifyComposerDrafts(composerDraftStore);
    if (activeIdRef.current === targetSessionId) {
      window.requestAnimationFrame(() => {
        const input = heroInputRef.current;
        if (!input) return;
        input.focus();
        if (input instanceof HTMLTextAreaElement) input.setSelectionRange(input.value.length, input.value.length);
      });
    }
  }, [draftRoot, catalogRoot]);

  const moveTextIntoComposer = useCallback((targetSessionId: string, text: string, hasContext = false, workspaceKey = commandRoot || 'default') => {
    const draftKey = `session:${targetSessionId}`;
    const scopedKey = `${workspaceKey}:${draftKey}`;
    const current = composerDraftStore.current.get(scopedKey) ?? {
      text: '', attachments: [], goal: false,
      selectedContext: { files: [], sessions: [], skills: [], plugins: [] },
      selectedCapabilities: [], submissionError: '', attachmentError: '', revision: 0,
    };
    const recoverableDrafts = [...(current.recoverableDrafts ?? [])];
    const currentContent = composerDraftContent(current);
    if (hasComposerDraftContent(currentContent)) recoverableDrafts.push(currentContent);
    const next: ComposerDraftState = {
      ...current, ...replacementComposerDraftIdentity(hasContext), text, editorState: editorStateForPlainText(text) ?? undefined, attachments: [], goal: false, selectedCapabilities: [],
      selectedContext: { files: [], sessions: [], skills: [], plugins: [] },
      submissionError: '', attachmentError: hasContext ? tr('原附件或上下文不会恢复，请重新添加。') : '',
      recoverableDrafts,
      revision: current.revision + 1,
    };
    composerDraftStore.current.set(scopedKey, next);
    persistDraft(workspaceKey, draftKey, next);
    notifyComposerDrafts(composerDraftStore);
  }, [commandRoot]);

  return { appendTextToComposer, moveTextIntoComposer };
}
