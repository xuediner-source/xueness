import { t as tr } from '../../i18n';
import { attachmentsFromRefs, parseStoredAttachmentRefs, persistedAttachmentFields } from "./composerAttachmentRef";
import { parseComposerAttachmentOwner, type ComposerAttachmentOwner } from './composerAttachmentDraft';
import { editorStateHasContent, editorStateMatching, type ComposerEditorState } from './composerEditorState';
import { getWorkbenchStorage } from '../desktop/desktopStorage';
import { MAX_PROMPT_HISTORY } from './composerInputHelpers';
import { ComposerDraftState, emptyComposerDraft } from './composerTypes';


export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}


export function getBrowserStorage(): StorageLike | null {
  return getWorkbenchStorage();
}


export const PROMPT_HISTORY_STORAGE_KEY_PREFIX = "xueness:chat-prompt-history:";


export function readPromptHistoryEntries(
  workspaceKey: string,
  storage: StorageLike | null = getBrowserStorage(),
): string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(`${PROMPT_HISTORY_STORAGE_KEY_PREFIX}${encodeURIComponent(workspaceKey)}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .slice(-MAX_PROMPT_HISTORY);
  } catch {
    return [];
  }
}


export function persistPromptHistoryEntries(
  workspaceKey: string,
  entries: readonly string[],
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage) return;
  try {
    const normalized = entries
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .slice(-MAX_PROMPT_HISTORY);
    storage.setItem(`${PROMPT_HISTORY_STORAGE_KEY_PREFIX}${encodeURIComponent(workspaceKey)}`, JSON.stringify(normalized));
  } catch {}
}


export const COMPOSER_DRAFT_STORAGE_KEY_PREFIX = "xueness:composer-drafts:v1:";


export type PersistedComposerDraft = {
  draftId?: string;
  attachmentOwner?: ComposerAttachmentOwner;
  text: string;
  goal?: boolean;
  selectedCapabilities?: string[];
  selectedContext?: {
    files: string[];
    sessions: string[];
    skills: string[];
    plugins: string[];
  };
  updatedAt?: number;
  recoverableDrafts?: PersistedComposerDraft[];
  hadAttachments?: boolean;
  attachmentRefs?: ReturnType<typeof parseStoredAttachmentRefs>;
  editorState?: ComposerEditorState;
  deliveryUnconfirmed?: boolean;
  pendingSubmission?: PersistedComposerDraft;
};


function persistedEditorState(text: string, stored: unknown): ComposerEditorState | undefined {
  return editorStateMatching(text, stored) ?? undefined;
}


export function restoredDraft(value: PersistedComposerDraft): ComposerDraftState {
  const recovered = value.recoverableDrafts?.map(item => restoredDraft({ ...item, recoverableDrafts: undefined, pendingSubmission: undefined })) ?? [];
  if (value.pendingSubmission) recovered.push(restoredDraft({ ...value.pendingSubmission, deliveryUnconfirmed: true,
    recoverableDrafts: undefined, pendingSubmission: undefined }));
  const attachmentRefs = parseStoredAttachmentRefs(value.attachmentRefs);
  return { ...emptyComposerDraft(value.text), draftId: value.draftId || crypto.randomUUID(),
    attachmentOwner: parseComposerAttachmentOwner(value.attachmentOwner), goal: value.goal === true,
    selectedCapabilities: value.selectedCapabilities ?? [],
    selectedContext: value.selectedContext ?? { files: [], sessions: [], skills: [], plugins: [] },
    attachments: attachmentsFromRefs(attachmentRefs),
    editorState: persistedEditorState(value.text, value.editorState),
    attachmentError: value.hadAttachments ? tr('重新打开后请重新添加附件。') : '',
    hadAttachments: value.hadAttachments === true, deliveryUnconfirmed: value.deliveryUnconfirmed === true,
    recoverableDrafts: recovered };
}


function readStoredDraft(value: unknown, includeRecovery = true): PersistedComposerDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('text' in value) || typeof value.text !== 'string') return null;
  const input = value as PersistedComposerDraft;
  const strings = (items: unknown): string[] => Array.isArray(items) ? items.filter((item): item is string => typeof item === 'string') : [];
  return { draftId: typeof input.draftId === 'string' ? input.draftId : undefined,
    attachmentOwner: parseComposerAttachmentOwner(input.attachmentOwner), text: input.text, goal: input.goal === true, selectedCapabilities: strings(input.selectedCapabilities),
    selectedContext: { files: strings(input.selectedContext?.files), sessions: strings(input.selectedContext?.sessions),
      skills: strings(input.selectedContext?.skills), plugins: strings(input.selectedContext?.plugins) },
    ...(input.hadAttachments === true ? { hadAttachments: true } : {}),
    ...(parseStoredAttachmentRefs(input.attachmentRefs).length
      ? { attachmentRefs: parseStoredAttachmentRefs(input.attachmentRefs) } : {}),
    ...(persistedEditorState(input.text, input.editorState) ? { editorState: persistedEditorState(input.text, input.editorState) } : {}),
    ...(input.deliveryUnconfirmed === true ? { deliveryUnconfirmed: true } : {}),
    ...(includeRecovery && input.pendingSubmission ? { pendingSubmission: readStoredDraft(input.pendingSubmission, false) ?? undefined } : {}),
    ...(includeRecovery && Array.isArray(input.recoverableDrafts) ? { recoverableDrafts: input.recoverableDrafts
      .map(item => readStoredDraft(item, false)).filter((item): item is PersistedComposerDraft => item !== null) } : {}) };
}


export function readPersistedDraft(
  workspaceKey: string,
  scope: string,
  storage: StorageLike | null = getBrowserStorage(),
): PersistedComposerDraft | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(`${COMPOSER_DRAFT_STORAGE_KEY_PREFIX}${encodeURIComponent(workspaceKey)}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.scopes) return null;
    const scopeData = parsed.scopes[scope];
    return readStoredDraft(scopeData);
  } catch {
    return null;
  }
}


export function persistDraft(
  workspaceKey: string,
  scope: string,
  draft: Pick<ComposerDraftState, "text" | "goal" | "selectedCapabilities" | "selectedContext" | "recoverableDrafts"> & Partial<Pick<ComposerDraftState, 'attachments' | 'pendingSubmission' | 'deliveryUnconfirmed' | 'hadAttachments' | 'editorState' | 'draftId' | 'attachmentOwner'>>,
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage) return;
  try {
    const storageKey = `${COMPOSER_DRAFT_STORAGE_KEY_PREFIX}${encodeURIComponent(workspaceKey)}`;
    const raw = storage.getItem(storageKey);
    let file = { version: 1, scopes: {} as Record<string, PersistedComposerDraft> };
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && parsed.scopes) file = parsed;
      } catch {}
    }
    const hasContent = Boolean(
      draft.text.trim() || editorStateHasContent(draft.editorState) ||
      draft.recoverableDrafts?.length || draft.attachments?.length || draft.pendingSubmission || draft.hadAttachments ||
      draft.goal ||
      draft.selectedCapabilities?.length ||
      draft.selectedContext.files.length ||
      draft.selectedContext.sessions.length ||
      draft.selectedContext.skills.length ||
      draft.selectedContext.plugins.length,
    );
    if (!hasContent) {
      delete file.scopes[scope];
    } else {
      const snapshot = (item: typeof draft): PersistedComposerDraft => {
        const editorState = persistedEditorState(item.text, item.editorState);
        return { draftId: item.draftId, attachmentOwner: item.attachmentOwner, text: item.text, goal: item.goal,
          selectedCapabilities: item.selectedCapabilities, selectedContext: item.selectedContext,
          ...persistedAttachmentFields(item.attachments, item.hadAttachments),
          ...(item.hadAttachments ? { hadAttachments: true } : {}),
          ...(editorState ? { editorState } : {}),
          deliveryUnconfirmed: item.deliveryUnconfirmed === true };
      };
      const editorState = persistedEditorState(draft.text, draft.editorState);
      file.scopes[scope] = {
        draftId: draft.draftId, attachmentOwner: draft.attachmentOwner,
        text: draft.text,
        goal: draft.goal,
        selectedCapabilities: draft.selectedCapabilities,
        selectedContext: draft.selectedContext,
        ...persistedAttachmentFields(draft.attachments, draft.hadAttachments),
        ...(draft.hadAttachments ? { hadAttachments: true } : {}),
        ...(editorState ? { editorState } : {}),
        deliveryUnconfirmed: draft.deliveryUnconfirmed === true,
        recoverableDrafts: draft.recoverableDrafts?.map(snapshot),
        pendingSubmission: draft.pendingSubmission ? snapshot(draft.pendingSubmission.draft) : undefined,
        updatedAt: Date.now(),
      };
    }
    if (Object.keys(file.scopes).length === 0) {
      if (storage.removeItem) storage.removeItem(storageKey);
      else storage.setItem(storageKey, "");
    } else {
      storage.setItem(storageKey, JSON.stringify(file));
    }
  } catch {}
}


export function clearPersistedDraft(
  workspaceKey: string,
  scope: string,
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage) return;
  try {
    const storageKey = `${COMPOSER_DRAFT_STORAGE_KEY_PREFIX}${encodeURIComponent(workspaceKey)}`;
    const raw = storage.getItem(storageKey);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.scopes || !parsed.scopes[scope]) return;
    delete parsed.scopes[scope];
    if (Object.keys(parsed.scopes).length === 0) {
      if (storage.removeItem) storage.removeItem(storageKey);
      else storage.setItem(storageKey, "");
    } else {
      storage.setItem(storageKey, JSON.stringify(parsed));
    }
  } catch {}
}


/** Clear only the submitted session's draft, and only if nobody edited it since submission. */
export function clearSubmittedComposerDraft(
  drafts: Map<string, ComposerDraftState>,
  draftKey: string,
  submittedRevision: number,
): Map<string, ComposerDraftState> {
  const current = drafts.get(draftKey);
  if (!current || current.revision !== submittedRevision) return drafts;
  const next = new Map(drafts);
  next.set(draftKey, { ...emptyComposerDraft(), recoverableDrafts: current.recoverableDrafts, pendingSubmission: current.pendingSubmission, revision: current.revision + 1 });
  return next;
}


/** A rejected submission may restore its snapshot only while the cleared draft is still untouched. */
export function restoreSubmittedComposerDraft(
  drafts: Map<string, ComposerDraftState>, draftKey: string, clearedRevision: number,
  submittedDraft: ComposerDraftState, error = "",
): Map<string, ComposerDraftState> {
  const current = drafts.get(draftKey);
  if (!current || current.revision !== clearedRevision) return drafts;
  const next = new Map(drafts);
  next.set(draftKey, { ...submittedDraft, revision: current.revision + 1, submissionError: error });
  return next;
}
