import { t as tr, tf } from '../../i18n';
import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { IconArrowUp, IconLoader, IconPaperclip, IconX } from "../../ui/icons";
import type { ComposerCapability } from "../../xuenessComposer";
import { attachmentsFromRefs, editorAttachmentRefs, type AttachmentOrigin, type AttachmentRef, type ComposerAttachment } from "./composerAttachmentRef";
import { deferComposerAttachmentRelease } from './composerAttachmentCleanup';
import { getComposerAttachmentUploadStore } from './composerAttachmentUploadStore';
import { attachmentOwnerMatches, composerDraftIdentityIsOwned, composerReferenceIsOwned, hasUnscopedComposerAttachments, reconcileComposerUploads } from './composerAttachmentDraft';
import { ComposerCapabilityMenu, MAX_SELECTED_COMPOSER_CAPABILITIES, capabilityLabel, matchesComposerSearch } from './ComposerCapabilityMenu';
import { retainRejectedComposerDraft, recoverComposerDraft, composerDraftContent, subscribeComposerDrafts, notifyComposerDrafts } from './composerRecovery';
import { applyEditorSuggestion, contextAfterEditorEdit, deleteEditorAtom, editorHasAtomicNodes, editorStateForPlainText, editorStateMatching, editorStateSignature, insertEditorText, navigationLength, navigationText, parseComposerEditorState, renderEditorHtml, sendableText, type ComposerEditorState } from './composerEditorState';
import { ComposerStructuredEditor, readEditorCursor } from './ComposerStructuredEditor';
import { DeliveryUnconfirmedError } from './submissionTransport';
import { ComposerRecoveryPanel } from './ComposerRecoveryPanel';
import { ComposerMaterialManifest } from './ComposerMaterialManifest';
import { composerInputForDraft, composerMaterialsForDraft } from './composerMaterialSummary';
import { CurrentTurnInput, followupDelivery, followupPointerDelivery, type FollowupMode, type InputDelivery } from './CurrentTurnInput';
import { Search, Target, Workflow, Blocks } from 'lucide-react';
import { deferCompositionEnd, displayBinding, isModKeyPressed, isImeComposingEvent } from '../../xuenessShortcutDisplay';
import { matchesShortcut, resolveShortcutBinding } from "../../xuenessShortcutCommands";
import { ComposerProps, ComposerDraftState, emptyComposerDraft } from './composerTypes';
import { readPersistedDraft, restoredDraft, persistDraft, readPromptHistoryEntries, persistPromptHistoryEntries, clearSubmittedComposerDraft, restoreSubmittedComposerDraft } from './composerDraftStore';
import { composerAttachmentBytes, COMPOSER_ATTACHMENT_LIMITS, encodeComposerFile, ComposerMention, contextComposerSuggestions, ContextComposerSuggestion, appendPromptHistoryEntry, navigatePromptHistory, extractFilesFromClipboard, isFileDragEvent } from './composerInputHelpers';
import { isImeCompositionKey, composerEnterIntent } from './composerKeyboard';


// Chip shell stays in this module. Preview kind, button and dialog load on demand.
const attachmentPublishers = new WeakMap<object, () => void>();


const missingAttachmentDrafts = new Set<string>();


const ComposerAttachmentChips = React.lazy(() => import('./composerAttachmentPreview'));


export function Composer({
  sendShortcut = "enter",
  onSend,
  disabled = false,
  sendDisabled = false,
  sendDisabledReason,
  modelRecovery,
  running = false,
  queueWhenRunning = false,
  guideWhenRunning = false,
  followupMode,
  onFollowupModeChange,
  queueBusy = false,
  stopping = false,
  onStop,
  draftKey = "default",
  draftStore,
  workspaceKey,
  placeholder = tr("输入消息或指令..."),
  defaultValue = "",
  variant = "docked",
  autoFocus = false,
  inputRef,
  footer,
  topContent,
  controls,
  startActions,
  mentions = [],
  capabilities = [],
  commands = [],
  files = [],
  minimal = false,
  platform,
  shortcutBindings = {},
  richComposer = false,
  attachmentSessionId,
  attachmentRoot,
  attachmentsEnabled = true,
  attachmentGeneration = "default",
  attachmentTransport,
  attachmentRemoteOwner,
}: ComposerProps) {
  const localDraftsRef = useRef<Map<string, ComposerDraftState>>(new Map());
  const [localFollowupMode, setLocalFollowupMode] = useState<FollowupMode>('guide');
  const effectiveFollowupMode = guideWhenRunning ? followupMode ?? localFollowupMode : 'queue';
  const pointerDeliveryRef = useRef<InputDelivery | undefined>(undefined);
  const draftsRef = draftStore ?? localDraftsRef;
  const resolvedWorkspaceKey = workspaceKey ?? "default";
  const scopedDraftKey = `${resolvedWorkspaceKey}:${draftKey}`;
  const [draftRenderVersion, setDraftRenderVersion] = useState(0);
  useEffect(() => subscribeComposerDrafts(draftsRef, () => setDraftRenderVersion(version => version + 1)), [draftsRef]);
  const compositionActiveRef = useRef(false);
  const historyIndexRef = useRef<number | null>(null);
  const savedDraftTextRef = useRef<string>("");
  const [cursorOffset, setCursorOffset] = useState<number | null>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  useEffect(() => {
    historyIndexRef.current = null;
    savedDraftTextRef.current = "";
    setCursorOffset(null);
    setSuggestDismissed(false);
    setActiveSuggestion(0);
  }, [draftKey, resolvedWorkspaceKey]);

  if (!draftsRef.current.has(scopedDraftKey)) {
    const persisted = readPersistedDraft(resolvedWorkspaceKey, draftKey);
    if (persisted) {
      draftsRef.current.set(scopedDraftKey, restoredDraft(persisted));
    } else {
      draftsRef.current.set(scopedDraftKey, emptyComposerDraft(defaultValue));
    }
  }
  const draft = draftsRef.current.get(scopedDraftKey)!;
  if (!draft.draftId) draft.draftId = crypto.randomUUID();
  // State lives in a per-scope map so late handlers keep writing to the draft
  // they submitted, even after this component has switched to another session.
  void draftRenderVersion;
  const updateDraftFor = (
    scope: string,
    update: (current: ComposerDraftState) => ComposerDraftState,
    contentChanged = true,
  ): ComposerDraftState => {
    const current = draftsRef.current.get(scope) ?? emptyComposerDraft();
    const updated = update(current);
    if (updated === current) return current;
    const nextDraft = { ...updated, revision: current.revision + (contentChanged ? 1 : 0) };
    const nextDrafts = new Map(draftsRef.current);
    nextDrafts.set(scope, nextDraft);
    draftsRef.current = nextDrafts;
    const scopePrefix = `${resolvedWorkspaceKey}:`;
    persistDraft(resolvedWorkspaceKey, scope.startsWith(scopePrefix) ? scope.slice(scopePrefix.length) : draftKey, nextDraft);
    notifyComposerDrafts(draftsRef);
    return nextDraft;
  };
  const updateCurrentDraft = (update: (current: ComposerDraftState) => ComposerDraftState, contentChanged = true) =>
    updateDraftFor(scopedDraftKey, update, contentChanged);
  const { text, attachments, goal, selectedContext, submissionError, attachmentError } = draft;
  const selectedCapabilities = draft.selectedCapabilities ?? [];
  const toggleCapability = (item: ComposerCapability) => {
    if (item.available === false || !capabilities.some(entry => entry.id === item.id && entry.available !== false)) return;
    updateCurrentDraft(current => {
      const previous = current.selectedCapabilities ?? [];
      if (previous.includes(item.id)) {
        return { ...current, selectedCapabilities: previous.filter(id => id !== item.id) };
      }
      if (previous.length >= MAX_SELECTED_COMPOSER_CAPABILITIES) return current;
      return { ...current, selectedCapabilities: [...previous, item.id] };
    });
  };
  const setText = (value: string | ((previous: string) => string)) => updateCurrentDraft(current => {
    const nextText = typeof value === "function" ? value(current.text) : value;
    if (!richComposer) {
      if (nextText === current.text && !current.submissionError && !current.editorState) return current;
      return { ...current, text: nextText, editorState: undefined, submissionError: "" };
    }
    if (nextText === current.text && !current.submissionError && editorStateMatching(nextText, current.editorState)) return current;
    const editorState = editorStateForPlainText(nextText) ?? undefined;
    if (nextText === current.text && !current.submissionError && !editorState && !current.editorState) return current;
    return { ...current, text: nextText, editorState, submissionError: "" };
  });
  const setGoal = (value: boolean | ((previous: boolean) => boolean)) => updateCurrentDraft(current => {
    const nextGoal = typeof value === "function" ? value(current.goal) : value;
    return nextGoal === current.goal ? current : { ...current, goal: nextGoal };
  });
  const [legacyAttachmentBusy, setLegacyAttachmentBusy] = useState(false);
  const legacyAttachmentBusyRef = useRef(false);
  const [plusOpen, setPlusOpen] = useState(false);
  const [addSearch, setAddSearch] = useState('');
  const plusRef = useRef<HTMLDivElement | null>(null);
  const plusButtonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const attachInputRef = useRef<HTMLInputElement | null>(null);
  // Local handle for the helper buttons; external inputRef stays in sync.
  const localInputRef = useRef<HTMLTextAreaElement | null>(null);
  const editorDomRef = useRef<HTMLDivElement | null>(null);
  const localEditSignature = useRef("");
  const pendingCaret = useRef<number | null>(null);
  const surfaceRef = useRef({ scope: "", key: 0, signature: "", html: "", caret: 0 });
  const wasTokenMode = useRef(false);
  const attachRef = (el: HTMLTextAreaElement | null) => {
    localInputRef.current = el;
    if (typeof inputRef === "function") inputRef(el);
    else if (inputRef && typeof inputRef === "object") {
      (inputRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = el;
    }
  };
  const updateAttachments = (next: ComposerAttachment[]) => updateCurrentDraft(current =>
    current.attachments === next ? current : { ...current, attachments: next, hadAttachments: false });
  const setAttachmentError = (message: string) => updateCurrentDraft(current =>
    current.attachmentError === message ? current : { ...current, attachmentError: message }, false);
  const setSubmissionError = (message: string) => updateCurrentDraft(current =>
    current.submissionError === message ? current : { ...current, submissionError: message }, false);
  const uploadOwner = draft.attachmentOwner ?? { remote: attachmentRemoteOwner, root: attachmentRoot ?? '', sessionId: attachmentSessionId,
    draftId: draft.draftId ?? scopedDraftKey };
  const uploadStore = useMemo(() => getComposerAttachmentUploadStore({ root: uploadOwner.root,
    sessionId: uploadOwner.sessionId, draftKey: uploadOwner.draftId, remote: uploadOwner.remote }, attachmentTransport),
    [uploadOwner.root, uploadOwner.sessionId, uploadOwner.draftId, JSON.stringify(uploadOwner.remote), attachmentTransport]);
  const uploadEnabled = (!attachmentRemoteOwner || Boolean(attachmentTransport)) && richComposer && attachmentsEnabled && !disabled && Boolean(attachmentRoot);
  const uploadItems = uploadStore.getSnapshot();
  const ownerMismatch = Boolean((draft.attachments.length || draft.hadAttachments || uploadItems.length) && !attachmentOwnerMatches(draft.attachmentOwner, attachmentRoot, attachmentSessionId, attachmentRemoteOwner));
  const unavailableAttachments = attachments.length > 0 && (!attachmentsEnabled || (!richComposer && attachments.some(item => item.ref)));
  const attachmentBusy = legacyAttachmentBusy || uploadStore.hasUnready();
  useEffect(() => {
    if (!richComposer) return;
    uploadStore.setDisposalGuard(id => composerReferenceIsOwned(draftsRef.current.values(), id));
    // Initialize once. A retained manager may already contain completions from
    // an unmounted editor; never replace those with an older persisted snapshot.
    if (draft.hadAttachments && !uploadStore.hasUnready()) missingAttachmentDrafts.add(uploadOwner.draftId);
    const retainedUploads = uploadStore.getSnapshot().length > 0;
    if (!retainedUploads) uploadStore.syncReadyRefs(editorAttachmentRefs(draft.attachments));
    const publish = () => {
      for (const [key, value] of draftsRef.current) {
        const next = reconcileComposerUploads(value, uploadOwner.draftId,
          uploadStore.readyAttachments(), uploadStore.hasUnready() || missingAttachmentDrafts.has(uploadOwner.draftId));
        if (next === value) continue;
        draftsRef.current.set(key, next);
        const prefix = `${resolvedWorkspaceKey}:`;
        if (key.startsWith(prefix)) persistDraft(resolvedWorkspaceKey, key.slice(prefix.length), next);
      }
      notifyComposerDrafts(draftsRef);
    };
    // Keep persistence subscribed through remounts, until this manager is reused.
    const key = uploadStore as object;
    attachmentPublishers.get(key)?.();
    attachmentPublishers.set(key, uploadStore.subscribe(publish));
  }, [uploadStore, draftsRef, richComposer]);
  useEffect(() => {
    uploadStore.setContext({ enabled: uploadEnabled && !ownerMismatch, generation: attachmentGeneration });
  }, [uploadStore, uploadEnabled, ownerMismatch, attachmentGeneration]);
  const disposeRef = (ref: AttachmentRef | undefined, owner = uploadOwner) => {
    if (!ref) return;
    const refId = ref.id;
    // An id collision must never turn a restored remote reference into local cleanup.
    if (JSON.stringify(ref.remoteOwner ? { connectionId: ref.remoteOwner.connectionId, digest: ref.remoteOwner.digest, workspaceIdentity: ref.remoteOwner.workspaceIdentity } : null) !== JSON.stringify(owner.remote ?? null)) return;
    deferComposerAttachmentRelease(owner, refId, () => composerReferenceIsOwned(draftsRef.current.values(), refId), owner.remote && JSON.stringify(owner.remote) !== JSON.stringify(attachmentRemoteOwner) ? undefined : attachmentTransport);
  };
  const removeAttachment = (index: number) => {
    const removed = attachments[index];
    const item = uploadStore.getSnapshot().find(item => item.ref?.id === removed?.ref?.id);
    if (item) uploadStore.remove(item.id);
    updateAttachments(attachments.filter((_, itemIndex) => itemIndex !== index));
    disposeRef(removed?.ref);
  };
  const removeUpload = (id: string) => {
    const removed = uploadStore.getSnapshot().find(item => item.id === id);
    uploadStore.remove(id);
    disposeRef(removed?.ref);
  };
  const addAttachmentFiles = async (filesToAdd: FileList | File[], origin: AttachmentOrigin = "file") => {
    const incoming = Array.from(filesToAdd);
    if (!incoming.length || disabled || !attachmentsEnabled || running || ownerMismatch) return;
    const uploadOrigin = origin === 'workspace' ? 'file' : origin;
    if (richComposer) {
      if (!attachmentRoot) { setAttachmentError(tr('附件未能写入会话，草稿已保留。')); return; }
      updateCurrentDraft(current => ({ ...current, attachmentOwner: uploadOwner, attachmentError: '' }));
      uploadStore.setContext({ enabled: uploadEnabled, generation: attachmentGeneration });
      const result = uploadStore.enqueue(incoming, uploadOrigin);
      if (result.rejected.length) setAttachmentError(tr('最多 8 个附件；图片单个 20 MiB，总量 64 MiB；其他文件最多 4 个，PDF/视频单个 2 MiB、合计 4 MiB，文本 64 KiB。'));
      return;
    }
    // Plain composer compatibility. Transaction failures never enter this path.
    if (legacyAttachmentBusyRef.current) return;
    legacyAttachmentBusyRef.current = true; setLegacyAttachmentBusy(true);
    const scope = scopedDraftKey;
    try {
      const existing = (draftsRef.current.get(scope) ?? emptyComposerDraft()).attachments;
      const added: ComposerAttachment[] = [];
      let total = existing.reduce((sum, item) => sum + composerAttachmentBytes(item.data), 0);
      for (const file of incoming) {
        if (existing.length + added.length >= COMPOSER_ATTACHMENT_LIMITS.count || file.size > COMPOSER_ATTACHMENT_LIMITS.eachBytes || total + file.size > COMPOSER_ATTACHMENT_LIMITS.totalBytes) {
          setAttachmentError(tr('附件最多 4 个，单个不超过 2 MiB，总量不超过 4 MiB。')); continue;
        }
        const data = await encodeComposerFile(file);
        added.push({ name: file.name, mimeType: file.type || 'application/octet-stream', data }); total += file.size;
      }
      updateDraftFor(scope, current => ({ ...current, attachments: [...current.attachments, ...added], hadAttachments: false }));
    } catch { setAttachmentError(tr('读取附件失败，请重新选择。')); }
    finally { legacyAttachmentBusyRef.current = false; setLegacyAttachmentBusy(false); }
  };
  const toggleContext = (mention: ComposerMention) => {
    const field = mention.kind === "file" ? "files" : mention.kind === "session" ? "sessions" : mention.kind === "skill" ? "skills" : "plugins";
    updateCurrentDraft(current => {
      const values = current.selectedContext[field];
      const next = values.includes(mention.id)
        ? values.filter((id) => id !== mention.id)
        : [...values, mention.id];
      if (next === values) return current;
      return { ...current, selectedContext: { ...current.selectedContext, [field]: next } };
    });
  };
  const addContext = (mention: ComposerMention) => {
    const field = mention.kind === "file" ? "files" : mention.kind === "session" ? "sessions" : mention.kind === "skill" ? "skills" : "plugins";
    updateCurrentDraft(current => current.selectedContext[field].includes(mention.id)
      ? current
      : { ...current, selectedContext: { ...current.selectedContext, [field]: [...current.selectedContext[field], mention.id] } });
  };
  const closePlusMenu = (restoreFocus = false) => {
    setPlusOpen(false);
    setAddSearch('');
    if (restoreFocus) plusButtonRef.current?.focus();
  };
  const openAttachmentPicker = () => {
    closePlusMenu();
    attachInputRef.current?.click();
  };
  const handlePlusMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (isImeCompositionKey(event)) return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled), [role="menuitemcheckbox"]:not(:disabled)'));
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closePlusMenu(true);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      items[index < 0 ? (delta > 0 ? 0 : items.length - 1) : (index + delta + items.length) % items.length]?.focus();
    } else if (event.target instanceof HTMLInputElement) {
      // Searching the Add menu must never submit the enclosing message form.
      if (event.key === 'Enter') { event.preventDefault(); items[0]?.focus(); }
    } else if (event.key === "Home") {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      items[items.length - 1]?.focus();
    }
  };

  useEffect(() => {
    if (!plusOpen) return;
    const first = menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled), [role="menuitemcheckbox"]:not(:disabled)');
    first?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!plusRef.current?.contains(event.target as Node)) closePlusMenu();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [plusOpen]);

  const availableMentions: ComposerMention[] = [...mentions];
  for (const path of files) {
    if (!availableMentions.some((item) => item.kind === "file" && item.id === path)) {
      availableMentions.push({ id: path, label: path, kind: "file" });
    }
  }
  const selectedMention = (kind: ComposerMention["kind"], id: string): ComposerMention =>
    availableMentions.find((item) => item.kind === kind && item.id === id) ?? { id, label: id, kind };

  // Escape dismisses suggestions first, closes the plus menu next, then stops a running task.
  const [suggestDismissed, setSuggestDismissed] = useState(false);
  const suggestionListId = useId();
  const plusMenuId = useId();

  const matchedEditor = richComposer ? editorStateMatching(text, draft.editorState) : null;
  const plainEditor = richComposer ? editorStateForPlainText(text) : null;
  const tokenEditor = matchedEditor && editorHasAtomicNodes(matchedEditor) ? matchedEditor : null;
  const structuredDraft = Boolean(richComposer && (tokenEditor || plainEditor));
  let editorSurface = surfaceRef.current;
  if (!tokenEditor) {
    if (editorSurface.scope) {
      editorSurface = { scope: "", key: 0, signature: "", html: "", caret: 0 };
      surfaceRef.current = editorSurface;
    }
  } else {
    const signature = editorStateSignature(tokenEditor);
    const local = localEditSignature.current === signature;
    if (local) {
      localEditSignature.current = "";
      if (editorSurface.signature !== signature) {
        editorSurface = { ...editorSurface, signature };
        surfaceRef.current = editorSurface;
      }
    } else if (editorSurface.scope !== scopedDraftKey || editorSurface.signature !== signature) {
      const caret = pendingCaret.current ?? navigationLength(tokenEditor);
      pendingCaret.current = null;
      editorSurface = {
        scope: scopedDraftKey,
        key: editorSurface.scope === scopedDraftKey ? editorSurface.key + 1 : 0,
        signature,
        html: renderEditorHtml(tokenEditor),
        caret,
      };
      surfaceRef.current = editorSurface;
    }
  }
  const suggestionSource = tokenEditor ? navigationText(tokenEditor).replaceAll("\uFFFC", "\n") : text;
  const suggestionCursor = tokenEditor ? (cursorOffset ?? navigationLength(tokenEditor)) : (cursorOffset ?? text.length);
  const trimmed = text.trim();
  const selectedContextCount = Object.values(selectedContext).reduce((sum, values) => sum + values.length, selectedCapabilities.length);
  const visibleCapabilities = capabilities.filter(item => matchesComposerSearch(addSearch,
    item.id, item.label, item.labelEn, item.description, item.descriptionEn));
  const visibleMentions = availableMentions.filter(item => matchesComposerSearch(addSearch, item.id, item.label, item.description));
  const canOfferGoal = Boolean(startActions?.canGoal);
  const canOfferWorkflow = Boolean(startActions?.canWorkflow);
  const hasSendableContent = trimmed.length > 0 || attachments.length > 0 || selectedContextCount > 0;
  const materialRows = composerMaterialsForDraft(draft, richComposer, {
    mentions: availableMentions,
    capabilities,
    uploads: uploadItems,
    attachmentsEnabled,
    ownerMismatch,
  });
  const isSendDisabled = disabled || sendDisabled || queueBusy || Boolean(draft.pendingSubmission) || (running && !queueWhenRunning) || attachmentBusy || unavailableAttachments || ownerMismatch || Boolean(draft.hadAttachments) || !hasSendableContent;
  // 停止/发送互斥（对标 ZCode showStopControl = canStop && !hasDraftToSubmit）：
  // 运行中且草稿为空时，停止按钮独占发送槽位；有草稿时显示排队发送键。
  // queueWhenRunning=false 时发送键在运行中没有排队语义，停止键始终保留。
  const canStop = running && Boolean(onStop);
  const showStopControl = canStop && (!queueWhenRunning || !hasSendableContent);
  const showQueueControl = running && queueWhenRunning && hasSendableContent;
  const suggestions = !disabled && !suggestDismissed && historyIndexRef.current === null
    ? contextComposerSuggestions(suggestionSource, commands, availableMentions, {
      canGoal: canOfferGoal,
      canWorkflow: canOfferWorkflow,
      canCompact: Boolean(startActions?.canCompact),
    }, suggestionCursor)
    : [];
  const [activeSuggestion, setActiveSuggestion] = useState(0);
  const currentSuggestion = suggestions.length > 0 ? Math.min(activeSuggestion, suggestions.length - 1) : -1;
  const tokenSignature = tokenEditor ? editorStateSignature(tokenEditor) : "";
  useEffect(() => {
    const tokens = tokenSignature.length > 0;
    if (wasTokenMode.current && !tokens) localInputRef.current?.focus();
    wasTokenMode.current = tokens;
  }, [tokenSignature]);

  useEffect(() => {
    if (!running || !onStop || stopping) return;
    const onWindowKeyDown = (event: KeyboardEvent) => {
      // Custom stop bindings are composer-only. Escape outside the editor belongs
      // to the focused leaf, never the first running composer's document listener.
      if (event.key !== "Escape" || event.defaultPrevented || event.repeat || isImeCompositionKey(event)) return;
      const pane = (editorDomRef.current ?? localInputRef.current)?.closest<HTMLElement>('[data-pane-focused]');
      if (pane && (pane.hidden || pane.dataset.paneFocused !== 'true')) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest?.("textarea, input, select, [contenteditable='true']")) return;
      if (
        plusOpen ||
        suggestions.length > 0 ||
        document.querySelector('[role="dialog"], [role="menu"], [aria-modal="true"], .xn-composer-toolbar__mode[open], .xn-composer-toolbar__model[open]')
      ) return;
      event.preventDefault();
      onStop();
    };
    document.addEventListener("keydown", onWindowKeyDown);
    return () => document.removeEventListener("keydown", onWindowKeyDown);
  }, [onStop, platform, plusOpen, running, shortcutBindings, stopping, suggestions.length]);

  // Keep the input compact for short prompts and let it grow for longer ones.
  useEffect(() => {
    const input = localInputRef.current;
    if (!input) return;
    const maxHeight = 160;
    const measure = () => {
      input.style.height = "auto";
      const contentHeight = input.scrollHeight;
      input.style.height = `${Math.min(contentHeight, maxHeight)}px`;
      input.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    let width = input.clientWidth;
    const observer = new ResizeObserver(() => {
      const next = input.clientWidth;
      if (next !== width) { width = next; measure(); }
    });
    observer.observe(input);
    return () => observer.disconnect();
  }, [text, variant]);

  const readSelectionOffset = () => {
    if (tokenEditor && editorDomRef.current) return readEditorCursor(editorDomRef.current);
    return localInputRef.current?.selectionStart ?? cursorOffset ?? text.length;
  };
  const commitStructured = (state: ComposerEditorState, cursor: number, local: boolean) => {
    const previous = parseComposerEditorState(draftsRef.current.get(scopedDraftKey)?.editorState);
    if (local) localEditSignature.current = editorStateSignature(state);
    else pendingCaret.current = cursor;
    updateCurrentDraft(current => ({
      ...current,
      text: sendableText(state),
      editorState: state,
      selectedContext: contextAfterEditorEdit(current.selectedContext, previous, state),
      submissionError: "",
    }));
    setCursorOffset(cursor);
  };
  const acceptSuggestion = (suggestion: ContextComposerSuggestion) => {
    const cursor = readSelectionOffset();
    if (richComposer) {
      const base = editorStateMatching(text, draftsRef.current.get(scopedDraftKey)?.editorState) ?? editorStateForPlainText(text);
      const applied = base ? applyEditorSuggestion(base, cursor, suggestion) : null;
      if (applied) {
        if (suggestion.kind === "goal") {
          if (startActions?.onGoal) startActions.onGoal();
          else setGoal(current => !current);
        } else if (suggestion.kind === "workflow") startActions?.onWorkflow();
        else if (suggestion.kind !== "command") addContext(selectedMention(suggestion.kind, suggestion.token));
        commitStructured(applied.state, applied.cursor, false);
        setSuggestDismissed(false);
        setActiveSuggestion(0);
        if (!editorHasAtomicNodes(applied.state)) {
          setTimeout(() => {
            localInputRef.current?.focus();
            try { localInputRef.current?.setSelectionRange(applied.cursor, applied.cursor); } catch { /* The structured surface has no selection range. */ }
          }, 0);
        }
        return;
      }
    }
    let nextText = text;
    let nextCursor = cursor;

    const offset = cursor;
    const before = text.slice(0, offset);
    const after = text.slice(offset);

    if (suggestion.kind === "goal") {
      if (startActions?.onGoal) startActions.onGoal();
      else setGoal((current) => !current);
      const replaced = before.replace(/(?:^|\s)\/[A-Za-z0-9._-]*$/, (match) => match.match(/^\s*/)?.[0] ?? "");
      nextText = replaced + after;
      nextCursor = replaced.length;
    } else if (suggestion.kind === "workflow") {
      startActions?.onWorkflow();
      const replaced = before.replace(/(?:^|\s)\/[A-Za-z0-9._-]*$/, (match) => match.match(/^\s*/)?.[0] ?? "");
      nextText = replaced + after;
      nextCursor = replaced.length;
    } else if (suggestion.kind === "command") {
      const replaced = before.replace(/(?:^|\s)\/[A-Za-z0-9._-]*$/, (match) =>
        (match.match(/^\s*/)?.[0] ?? "") + "/" + suggestion.token + " ",
      );
      nextText = replaced + after;
      nextCursor = replaced.length;
    } else {
      addContext(selectedMention(suggestion.kind, suggestion.token));
      const expression = suggestion.kind === "skill"
        ? /(?:^|\s)\$([^\s@#$]*)$/
        : /(?:^|\s)@[^\s@#$]*$/;
      const replaced = before.replace(expression, (match) => match.match(/^\s*/)?.[0] ?? "");
      nextText = replaced + after;
      nextCursor = replaced.length;
    }

    setText(nextText);
    setCursorOffset(nextCursor);
    setSuggestDismissed(false);
    setActiveSuggestion(0);
    setTimeout(() => {
      localInputRef.current?.focus();
      try {
        localInputRef.current?.setSelectionRange(nextCursor, nextCursor);
      } catch {}
    }, 0);
  };

  const handleSend = async (requestedDelivery?: InputDelivery) => {
    if (isSendDisabled || draftsRef.current.get(scopedDraftKey)?.pendingSubmission || !onSend) return;
    setSubmissionError("");
    const submittedDraft = draftsRef.current.get(scopedDraftKey) ?? emptyComposerDraft(defaultValue);
    if (uploadStore.hasUnready() || legacyAttachmentBusyRef.current || submittedDraft.hadAttachments || unavailableAttachments ||
      (submittedDraft.attachments.length > 0 && !attachmentOwnerMatches(submittedDraft.attachmentOwner, attachmentRoot, attachmentSessionId, attachmentRemoteOwner))) return;
    const submittedRevision = submittedDraft.revision;
    const draft = composerInputForDraft(submittedDraft, richComposer);
    const ticket = crypto.randomUUID();
    const submittedText = submittedDraft.text.trim();
    if (submittedText) {
      const history = readPromptHistoryEntries(resolvedWorkspaceKey);
      persistPromptHistoryEntries(resolvedWorkspaceKey, appendPromptHistoryEntry(history, submittedText));
    }
    historyIndexRef.current = null;
    // Move the complete submission out of the editor before the async run can
    // promote/remount the composer. A rejection restores this frozen snapshot.
    draftsRef.current = clearSubmittedComposerDraft(draftsRef.current, scopedDraftKey, submittedRevision);
    const clearedRevision = draftsRef.current.get(scopedDraftKey)!.revision;
    draftsRef.current.set(scopedDraftKey, { ...draftsRef.current.get(scopedDraftKey)!,
      pendingSubmission: { id: ticket, draft: composerDraftContent(submittedDraft) } });
    persistDraft(resolvedWorkspaceKey, draftKey, draftsRef.current.get(scopedDraftKey)!);
    notifyComposerDrafts(draftsRef);
    let accepted = false;
    const release = () => {
      const current = draftsRef.current.get(scopedDraftKey);
      if (current?.pendingSubmission?.id !== ticket) return;
      const next = { ...current, pendingSubmission: undefined };
      draftsRef.current.set(scopedDraftKey, next);
      persistDraft(resolvedWorkspaceKey, draftKey, next);
      notifyComposerDrafts(draftsRef);
    };
    const acknowledge = () => { accepted = true; release(); };
    const restore = (error = "", deliveryUnconfirmed = false) => {
      if (accepted) return;
      // An unknown delivery stays saved beside the editor, so it cannot be
      // resent by a second Enter press before the user checks the conversation.
      const next = deliveryUnconfirmed ? draftsRef.current : restoreSubmittedComposerDraft(draftsRef.current, scopedDraftKey, clearedRevision, submittedDraft, error);
      if (next !== draftsRef.current) {
        draftsRef.current = next;
        persistDraft(resolvedWorkspaceKey, draftKey, next.get(scopedDraftKey)!);
        notifyComposerDrafts(draftsRef);
      } else {
        updateDraftFor(scopedDraftKey, current => retainRejectedComposerDraft(current, submittedDraft, error, deliveryUnconfirmed));
      }
    };
    try {
      const delivery = running && queueWhenRunning ? requestedDelivery ?? followupDelivery(effectiveFollowupMode) : undefined;
      const sent = await onSend(submittedDraft.text.trim(), draft, acknowledge, delivery);
      if (sent === false) restore();
      else {
        acknowledge();

      }
    } catch (error) {
      restore(error instanceof Error ? error.message : tr("发送失败，草稿已保留。"), error instanceof DeliveryUnconfirmedError);
    } finally {
      release();
      if (accepted) {
        for (const ref of editorAttachmentRefs(submittedDraft.attachments)) disposeRef(ref, submittedDraft.attachmentOwner ?? uploadOwner);
        if (submittedDraft.draftId && !composerDraftIdentityIsOwned(draftsRef.current.values(), submittedDraft.draftId)) {
          uploadStore.syncReadyRefs([]);
          attachmentPublishers.get(uploadStore)?.(); attachmentPublishers.delete(uploadStore);
          uploadStore.invalidate();
        }
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    const isComposing = compositionActiveRef.current || isImeCompositionKey(e);
    if (tokenEditor && !isComposing && (e.key === "Backspace" || e.key === "Delete")) {
      const edited = deleteEditorAtom(tokenEditor, readSelectionOffset(), e.key === "Backspace" ? "backspace" : "delete");
      if (edited) {
        e.preventDefault();
        commitStructured(edited.state, edited.cursor, false);
        return;
      }
    }
    if (e.defaultPrevented || e.repeat) return;
    const newlineBinding = resolveShortcutBinding("insert-newline", shortcutBindings);
    if (!isComposing && matchesShortcut(e, newlineBinding, platform) && suggestions.length === 0) {
      e.preventDefault();
      const cursor = readSelectionOffset();
      if (tokenEditor) {
        const inserted = insertEditorText(tokenEditor, cursor, "\n");
        if (inserted) commitStructured(inserted.state, inserted.cursor, false);
      } else {
        const end = localInputRef.current?.selectionEnd ?? cursor;
        setText(text.slice(0, cursor) + "\n" + text.slice(end));
        requestAnimationFrame(() => localInputRef.current?.setSelectionRange(cursor + 1, cursor + 1));
      }
      return;
    }
    const sendBinding = resolveShortcutBinding("send-message", shortcutBindings);
    const stopBinding = resolveShortcutBinding("stop-generation", shortcutBindings);
    if (!isComposing && matchesShortcut(e, sendBinding, platform) && suggestions.length === 0) {
      e.preventDefault();
      void handleSend();
      return;
    }
    if (!isComposing && running && onStop && !stopping && matchesShortcut(e, stopBinding, platform)) {
      e.preventDefault();
      onStop();
      return;
    }
    if (e.key === "Escape") {
      if (isComposing) return;
      e.preventDefault();
      if (suggestions.length > 0) {
        setSuggestDismissed(true);
        return;
      }
      if (plusOpen) {
        closePlusMenu(true);
        return;
      }
      if (historyIndexRef.current !== null) {
        setText(savedDraftTextRef.current);
        historyIndexRef.current = null;
        return;
      }
      if (running && onStop && !stopping) onStop();
    } else if (e.key === "Tab" && suggestions.length > 0 && currentSuggestion >= 0) {
      if (isComposing) return;
      e.preventDefault();
      acceptSuggestion(suggestions[currentSuggestion]);
    } else if (e.key === "ArrowDown") {
      if (isComposing) return;
      if (suggestions.length > 0) {
        e.preventDefault();
        setActiveSuggestion((currentSuggestion + 1) % suggestions.length);
      } else if (!e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && historyIndexRef.current !== null) {
        e.preventDefault();
        const entries = readPromptHistoryEntries(resolvedWorkspaceKey);
        const result = navigatePromptHistory(entries, historyIndexRef.current, "down");
        if (result.nextIndex === null) {
          setText(savedDraftTextRef.current);
          historyIndexRef.current = null;
        } else {
          historyIndexRef.current = result.nextIndex;
          setText(result.nextValue);
        }
      }
    } else if (e.key === "ArrowUp") {
      if (isComposing) return;
      if (suggestions.length > 0) {
        e.preventDefault();
        setActiveSuggestion((currentSuggestion - 1 + suggestions.length) % suggestions.length);
      } else if (!e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const entries = readPromptHistoryEntries(resolvedWorkspaceKey);
        if (historyIndexRef.current === null && text.length === 0 && !tokenEditor) {
          savedDraftTextRef.current = text;
          const result = navigatePromptHistory(entries, null, "up");
          if (result.shouldHandle) {
            e.preventDefault();
            historyIndexRef.current = result.nextIndex;
            setText(result.nextValue);
          }
        } else if (historyIndexRef.current !== null) {
          const result = navigatePromptHistory(entries, historyIndexRef.current, "up");
          if (result.shouldHandle) {
            e.preventDefault();
            historyIndexRef.current = result.nextIndex;
            setText(result.nextValue);
          }
        }
      }
    } else {
      if (running && queueWhenRunning && e.key === 'Enter' && isModKeyPressed(e, platform)
          && !e.shiftKey && !e.altKey && !isComposing) {
        e.preventDefault();
        void handleSend(followupDelivery(effectiveFollowupMode, true));
        return;
      }
      const intent = composerEnterIntent(
        { ...e, compositionActive: compositionActiveRef.current },
        sendShortcut,
        suggestions.length > 0 && currentSuggestion >= 0,
        platform,
      );
      if (intent === "accept-suggestion") {
        e.preventDefault();
        acceptSuggestion(suggestions[currentSuggestion]);
      } else if (intent === "send") {
        e.preventDefault();
        void handleSend();
      } else if (tokenEditor && e.key === "Enter" && !isComposing) {
        e.preventDefault();
        const cursor = readSelectionOffset();
        const inserted = insertEditorText(tokenEditor, cursor, "\n");
        if (inserted) commitStructured(inserted.state, inserted.cursor, false);
        else degradeToTextarea((editorDomRef.current?.textContent ?? text).replace(/\u200B/g, ""));
      }
    }
  };
  const degradeToTextarea = (fallback: string) => {
    localEditSignature.current = "";
    pendingCaret.current = null;
    updateCurrentDraft(current => ({ ...current, text: fallback, editorState: undefined, submissionError: "" }));
  };

  const handlePasteEvent = (event: React.ClipboardEvent) => {
    const pastedFiles = extractFilesFromClipboard(event.clipboardData);
    if (pastedFiles.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      void addAttachmentFiles(pastedFiles, "paste");
    }
  };

  const handleDropEvent = (event: React.DragEvent) => {
    setIsDraggingOver(false);
    const files = extractFilesFromClipboard(event.dataTransfer);
    if (files.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      void addAttachmentFiles(files, "drop");
    }
  };

  const attachmentChipShell = attachments.map((attachment, index) => (
    <span className="xn-composer__context-chip" key={(attachment.ref?.id ?? attachment.name) + ":" + index}
      data-testid="composer-attachment-chip" data-attachment-origin={attachment.ref?.origin}>
      <span>{attachment.name}</span>
      <button type="button" aria-label={tf("移除附件：{0}", [attachment.name])} onClick={() => removeAttachment(index)}>
        <IconX size={12} />
      </button>
    </span>
  ));
  const previewChips = Boolean(richComposer && attachmentRoot && attachments.length > 0);

  return (
    <div className={`xn-composer-region xn-composer-region--${variant}`}>
      <form
      aria-label={tr("消息编写器")}
      className={`xn-composer xn-composer--${variant}${topContent ? " xn-composer--with-top-content" : ""}`}
      data-rich-composer={richComposer ? "true" : "false"}
      data-editor={tokenEditor ? "tokens" : structuredDraft ? "text" : "textarea"}
      data-drag-over={isDraggingOver ? "true" : undefined}
      onSubmit={(e) => {
        e.preventDefault();
        const delivery = pointerDeliveryRef.current;
        pointerDeliveryRef.current = undefined;
        void handleSend(delivery);
      }}
      onPaste={handlePasteEvent}
      onDragOver={(event) => {
        if (isFileDragEvent(event.dataTransfer)) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }
      }}
      onDragEnter={(event) => {
        if (isFileDragEvent(event.dataTransfer)) {
          event.preventDefault();
          setIsDraggingOver(true);
        }
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node)) return;
        setIsDraggingOver(false);
      }}
      onDrop={handleDropEvent}
    >
      <input
        ref={attachInputRef}
        type="file"
        multiple
        hidden
        disabled={disabled || !attachmentsEnabled || legacyAttachmentBusy}
        aria-label={tr("添加附件")}
        data-testid="composer-attachment-input"
        onChange={(event) => {
          if (event.currentTarget.files) void addAttachmentFiles(event.currentTarget.files);
          event.currentTarget.value = "";
        }}
      />
      {topContent && <div className="xn-composer__top-content">{topContent}</div>}
      {suggestions.length > 0 && (
        <ul id={suggestionListId} role="listbox" className="xn-composer__suggest" aria-label={tr("输入建议")} data-testid="composer-suggestions">
          {suggestions.map((s, index) => (
            <li key={`${s.kind}-${s.token}`}>
              <button
                type="button"
                className={`xn-composer__suggest-item ${index === currentSuggestion ? "xn-composer__suggest-item--active" : ""}`}
                data-testid={`composer-suggestion-${s.kind}-${s.token}`}
                aria-selected={index === currentSuggestion ? "true" : undefined}
                id={`${suggestionListId}-option-${index}`}
                role="option"
                onClick={() => {
                  acceptSuggestion(s);
                  setActiveSuggestion(0);
                }}
              >
                <code>{(s.kind === "command" || s.kind === "goal" || s.kind === "workflow" ? "/" : s.kind === "skill" ? "$" : "@") + (s.label ?? s.token)}</code>
                {s.description && <span>{s.description}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {(goal || attachments.length > 0 || uploadItems.length > 0 || selectedContextCount > 0) && (
        <div className="xn-composer__chips" aria-label={tr("已添加的上下文")} data-testid="composer-selected-context" aria-live="polite" aria-relevant="additions removals">
          {selectedCapabilities.map(id => {
            const capability = capabilities.find(item => item.id === id);
            return <span className="xn-composer__context-chip" key={id} data-testid={`composer-capability-chip-${id}`}>
              <span>{capability ? capabilityLabel(capability) : id}</span>
              <button type="button" aria-label={tr("移除能力")} onClick={() => updateCurrentDraft(current => ({ ...current,
                selectedCapabilities: (current.selectedCapabilities ?? []).filter(value => value !== id) }))}><IconX size={12} /></button>
            </span>;
          })}
          {goal && (
            <span className="xn-composer__context-chip" data-testid="composer-goal-chip">
              {tr("目标")}
              <button type="button" aria-label={tr("移除目标标记")} onClick={() => setGoal(false)}><IconX size={12} /></button>
            </span>
          )}
          {(["files", "sessions", "skills", "plugins"] as const).flatMap((field) => {
            const kind = field === "files" ? "file" : field === "sessions" ? "session" : field === "skills" ? "skill" : "plugin";
            return selectedContext[field].map((id) => {
              const mention = selectedMention(kind, id);
              return (
                <span className="xn-composer__context-chip" key={kind + ":" + id} data-testid={"composer-context-" + kind}>
                  <span>{mention.label}</span>
                  <button type="button" aria-label={tf("移除上下文：{0}", [mention.label])} onClick={() => toggleContext(mention)}><IconX size={12} /></button>
                </span>
              );
            });
          })}
          {richComposer && uploadItems.length > 0 ? uploadItems.map(item => (
            <span className="xn-composer__context-chip" key={item.id} data-testid="composer-upload-chip" data-upload-state={item.state} title={item.error}>
              {item.state === 'ready' && item.ref ? <React.Suspense fallback={<span>{item.name}</span>}>
                <ComposerAttachmentChips attachments={attachmentsFromRefs([item.ref])} enabled={uploadEnabled}
                  root={uploadOwner.root} sessionId={uploadOwner.sessionId} onRemove={() => removeUpload(item.id)} />
              </React.Suspense> : <span>{item.name}</span>}
              <span role="status">{item.state === 'queued' ? tr('附件排队中') : item.state === 'uploading' ? `${tr('附件上传中')} ${Math.round(item.progress)}%` : item.state === 'failed' ? tr('附件上传失败') : tr('附件已就绪')}</span>
              {item.state === 'uploading' && <progress max={item.size || 1} value={item.uploadedBytes} aria-label={item.name} />}
              {item.state === 'failed' && <button type="button" disabled={!uploadEnabled || ownerMismatch} onClick={() => uploadStore.retry(item.id)}>{tr('重试附件')}</button>}
              {item.state !== 'ready' && <button type="button" aria-label={tf('移除附件：{0}', [item.name])} onClick={() => removeUpload(item.id)}>{item.state === 'uploading' || item.state === 'queued' ? tr('取消') : <IconX size={12} />}</button>}
            </span>
          )) : previewChips ? (
            <React.Suspense fallback={attachmentChipShell}>
              <ComposerAttachmentChips
                attachments={attachments}
                enabled={richComposer}
                root={attachmentRoot}
                sessionId={attachmentSessionId}
                onRemove={removeAttachment}
              />
            </React.Suspense>
          ) : attachmentChipShell}
        </div>
      )}
      <ComposerMaterialManifest materials={materialRows} />
      {ownerMismatch && <div className="xn-composer__error" role="alert">{tr("附件属于原草稿，请移除后重新添加。")}</div>}
      {legacyAttachmentBusy && <div className="xn-composer__status" role="status">{tr("正在读取附件...")}</div>}
      {attachmentError && <div className="xn-composer__error" role="alert">{attachmentError}</div>}
      {draft.hadAttachments && !uploadStore.hasUnready() && <button type="button" onClick={() => { missingAttachmentDrafts.delete(uploadOwner.draftId); updateCurrentDraft(current => ({ ...current, hadAttachments: false, attachmentError: '' })); }}>{tr('移除未恢复附件')}</button>}
      {selectedCapabilities.length > 0 && <div className="xn-composer__status" role="status" data-testid="composer-capability-hint">{tr('已添加能力。描述具体需求后发送，即可使用。')}</div>}
      {sendDisabled && (hasSendableContent || goal || modelRecovery) && <div className="xn-composer__status xn-composer__setup" role="status" aria-live="polite" data-testid="composer-send-unavailable">
        <span>{sendDisabledReason || tr('选择或配置模型后即可发送。')}</span>
        {modelRecovery?.kind === "loading" && <button type="button" data-testid="composer-model-recovery-loading" disabled aria-busy="true">{tr('正在加载…')}</button>}
        {modelRecovery?.kind === "error" && <button type="button" data-testid="composer-model-recovery-retry" onClick={modelRecovery.onRetry}>{tr('重试')}</button>}
        {modelRecovery?.kind === "missing" && <button type="button" data-testid="composer-model-recovery-configure" onClick={modelRecovery.onConfigure}>{tr('配置模型')}</button>}
        {!modelRecovery && startActions?.onModels && <button type="button" onClick={startActions.onModels}>{tr('配置模型')}</button>}
      </div>}
      {submissionError && <div className="xn-composer__error" role="alert">{submissionError}</div>}
      {draft.deliveryUnconfirmed && <div className="xn-composer__error" role="status">{tr('消息接收状态暂时无法确认，请先查看会话与队列再重试。')}</div>}
      {draft.pendingSubmission && <div className="xn-composer-recovery xn-composer-recovery--sending" data-testid="composer-sending" role="status">
        <span>{tr('正在发送…')}</span>
        <p className="xn-composer-recovery__preview">{draft.pendingSubmission.draft.text || tr('附件与上下文')}</p>
      </div>}
      <ComposerRecoveryPanel drafts={draft.recoverableDrafts ?? []}
        references={availableMentions}
        capabilities={capabilities}
        attachmentState={recovered => !recovered.attachmentOwner ? 'unknown-scope'
          : attachmentOwnerMatches(recovered.attachmentOwner, attachmentRoot, attachmentSessionId, attachmentRemoteOwner) ? 'available' : 'different-scope'}
        onRestore={index => { updateCurrentDraft(current => recoverComposerDraft(current, index)); localInputRef.current?.focus(); }}
        onDiscard={index => {
          const discarded = draftsRef.current.get(scopedDraftKey)?.recoverableDrafts?.[index];
          if (discarded && hasUnscopedComposerAttachments(discarded)) {
            setAttachmentError(tr('无法确认原附件的归属范围，已保留恢复草稿。'));
            return;
          }
          updateCurrentDraft(current => ({ ...current,
            recoverableDrafts: current.recoverableDrafts?.filter((_, position) => position !== index) }));
          if (!discarded) return;
          const owner = discarded.attachmentOwner;
          if (owner && !composerDraftIdentityIsOwned(draftsRef.current.values(), owner.draftId)) {
            const manager = getComposerAttachmentUploadStore({ root: owner.root, sessionId: owner.sessionId, draftKey: owner.draftId, remote: owner.remote });
            manager.setDisposalGuard(id => composerReferenceIsOwned(draftsRef.current.values(), id));
            for (const item of manager.getSnapshot()) manager.remove(item.id);
            attachmentPublishers.get(manager)?.();
            attachmentPublishers.delete(manager);
            manager.invalidate();
            for (const ref of editorAttachmentRefs(discarded.attachments)) disposeRef(ref, owner);
          }
        }} />
      {tokenEditor ? <ComposerStructuredEditor
        html={editorSurface.html}
        resetKey={editorSurface.key}
        caret={editorSurface.caret}
        disabled={disabled}
        label={tr("输入消息或指令...")}
        describedBy={minimal ? undefined : `${suggestionListId}-keyboard-help`}
        controls={suggestions.length ? suggestionListId : undefined}
        expanded={suggestions.length > 0}
        activeDescendant={currentSuggestion >= 0 ? `${suggestionListId}-option-${currentSuggestion}` : undefined}
        editorRef={element => {
          editorDomRef.current = element;
          if (typeof inputRef === "function") inputRef(element);
          else if (inputRef && typeof inputRef === "object") {
            (inputRef as React.MutableRefObject<HTMLElement | null>).current = element;
          }
        }}
        onLocalChange={(state, cursor) => commitStructured(state, cursor, true)}
        onDegrade={degradeToTextarea}
        onKeyDown={handleKeyDown}
        onPaste={handlePasteEvent}
        onDrop={handleDropEvent}
        onDragOver={event => {
          if (isFileDragEvent(event.dataTransfer)) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }
        }}
        onCompositionStart={() => { compositionActiveRef.current = true; }}
        onCompositionEnd={() => { deferCompositionEnd(() => { compositionActiveRef.current = false; }); }}
        onCursor={setCursorOffset}
      /> : <textarea
        ref={attachRef}
        className="xn-composer__input"
        data-editor={structuredDraft ? "text" : "textarea"}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setCursorOffset(e.target.selectionStart);
          historyIndexRef.current = null;
          setSuggestDismissed(false);
          setActiveSuggestion(0);
          setSubmissionError("");
        }}
        onSelect={(e) => setCursorOffset(e.currentTarget.selectionStart)}
        onClick={(e) => setCursorOffset(e.currentTarget.selectionStart)}
        onKeyUp={(e) => setCursorOffset(e.currentTarget.selectionStart)}
        onKeyDown={handleKeyDown}
        onCompositionStart={(event) => {
          compositionActiveRef.current = true;
          event.currentTarget.setAttribute("data-composing", "true");
        }}
        onCompositionEnd={(event) => {
          const el = event.currentTarget;
          deferCompositionEnd(() => {
            compositionActiveRef.current = false;
            el?.removeAttribute("data-composing");
          });
        }}
        onPaste={handlePasteEvent}
        onDragOver={(event) => {
          if (isFileDragEvent(event.dataTransfer)) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }
        }}
        onDrop={handleDropEvent}
        disabled={disabled}
        placeholder={placeholder}
        rows={2}
        autoFocus={autoFocus}
        aria-autocomplete="list"
        aria-label={tr("输入消息或指令...")}
        aria-controls={suggestions.length ? suggestionListId : undefined}
        aria-expanded={suggestions.length > 0}
        aria-activedescendant={currentSuggestion >= 0 ? `${suggestionListId}-option-${currentSuggestion}` : undefined}
        aria-describedby={minimal ? undefined : `${suggestionListId}-keyboard-help`}
      />}
      <div className="xn-composer__row">
        <div className="xn-composer__tools">
          {<div className="xn-composer__actions" role="group" aria-label={tr("输入辅助")}>
            <div className="xn-composer__plus-wrap" ref={plusRef}>
              {/* 附件一级入口（ZCode attachmentAction 式）：直接调现有附件逻辑，
                  「+」菜单保留给 mentions/命令，减少一次点击。 */}
              <button
                type="button"
                className="xn-composer__chip"
                aria-label={tr("添加附件")}
                title={tr("添加附件")}
                data-testid="composer-attachment"
                disabled={disabled || !attachmentsEnabled || legacyAttachmentBusy}
                onClick={openAttachmentPicker}
              >
                <IconPaperclip size={16} />
              </button>
              <button
                ref={plusButtonRef}
                type="button"
                className="xn-composer__chip xn-composer__plus"
                aria-label={tr("添加上下文或能力")}
                aria-haspopup="menu"
                aria-expanded={plusOpen}
                aria-controls={plusOpen ? plusMenuId : undefined}
                data-testid="composer-plus"
                disabled={disabled}
                onClick={() => setPlusOpen((open) => !open)}
                onKeyDown={(event) => {
                  if (isImeComposingEvent(event)) return;
                  if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setPlusOpen(true);
                  }
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </button>
              {plusOpen && (
                <div
                  ref={menuRef}
                  id={plusMenuId}
                  className="xn-composer__plus-menu"
                  role="menu"
                  aria-label={tr("添加上下文或能力")}
                  onKeyDown={handlePlusMenuKeyDown}
                  onBlur={(event) => {
                    // Native mouse/touch focus loss can report null before click.
                    // Outside pointerdown and a real Tab focus destination dismiss it.
                    if (event.relatedTarget && !plusRef.current?.contains(event.relatedTarget as Node)) closePlusMenu();
                  }}
                >
                  <div className="xn-composer-add-search"><Search size={15} aria-hidden="true" /><input
                    type="search" value={addSearch} data-testid="composer-add-search"
                    aria-label={tr('搜索能力或上下文')} placeholder={tr('搜索能力或上下文')}
                    onChange={event => setAddSearch(event.target.value)} /></div>
                  <div className="xn-composer__plus-heading">{tr("添加")}</div>
                  <button type="button" role="menuitem" disabled={!attachmentsEnabled || legacyAttachmentBusy} onClick={openAttachmentPicker}>
                    <IconPaperclip size={16} />{tr("附件")}
                  </button>
                  {canOfferGoal && (
                    <button
                      type="button"
                      role="menuitem"
                      aria-pressed={goal}
                      onClick={() => {
                        if (startActions?.onGoal) startActions.onGoal();
                        else setGoal((current) => !current);
                        closePlusMenu();
                        localInputRef.current?.focus();
                      }}
                    ><Target size={16} aria-hidden="true" />{goal ? tr("移除目标标记") : tr("添加为目标")}</button>
                  )}
                  {canOfferWorkflow && startActions && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        startActions.onWorkflow();
                        closePlusMenu();
                        localInputRef.current?.focus();
                      }}
                    ><Workflow size={16} aria-hidden="true" />{tr("创建工作流")}</button>
                  )}
                  {startActions && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        startActions.onPlugins();
                        closePlusMenu();
                      }}
                    ><Blocks size={16} aria-hidden="true" />{tr("管理插件")}</button>
                  )}
                  <ComposerCapabilityMenu items={visibleCapabilities} selected={selectedCapabilities} onToggle={item => {
                    toggleCapability(item); closePlusMenu(); localInputRef.current?.focus();
                  }} />
                  {(["plugin", "file", "session", "skill"] as const).map((kind) => {
                    const items = visibleMentions.filter((mention) => mention.kind === kind).slice(0, addSearch.trim() ? 50 : 8);
                    if (items.length === 0) return null;
                    const field = kind === "file" ? "files" : kind === "session" ? "sessions" : kind === "skill" ? "skills" : "plugins";
                    const heading = kind === "plugin" ? tr("插件") : kind === "file" ? tr("文件") : kind === "session" ? tr("任务") : tr("技能");
                    return (
                      <div className="xn-composer__plus-group" role="group" aria-label={heading} key={kind}>
                        <div className="xn-composer__plus-heading">{heading}</div>
                        {items.map((mention) => (
                          <button
                            type="button"
                            role="menuitemcheckbox"
                            aria-checked={selectedContext[field].includes(mention.id)}
                            key={mention.id}
                            title={mention.description}
                            onClick={() => {
                              toggleContext(mention);
                              closePlusMenu();
                              localInputRef.current?.focus();
                            }}
                          >{mention.label}</button>
                        ))}
                      </div>
                    );
                  })}
                  {addSearch.trim() && !visibleCapabilities.length && !visibleMentions.length && <div className="xn-composer__plus-empty" role="status">{tr('没有匹配的能力或上下文')}</div>}
                  {availableMentions.length === 0 && !startActions && (
                    <div className="xn-composer__plus-empty">{tr("暂无可添加的上下文")}</div>
                  )}
                  <div className="xn-composer__plus-help">{tr("@ 文件、插件或会话 · $ 技能 · / 命令")}</div>
                </div>
              )}
            </div>
          </div>}
          {(controls || footer) && <div className="xn-composer__settings" role="group" aria-label={tr("运行选项")}>{controls ?? footer}</div>}
          {running && queueWhenRunning && guideWhenRunning && <CurrentTurnInput mode={effectiveFollowupMode}
            disabled={disabled || queueBusy || Boolean(draft.pendingSubmission)}
            onChange={mode => { setLocalFollowupMode(mode); onFollowupModeChange?.(mode); }} />}
          {!minimal && <span id={`${suggestionListId}-keyboard-help`} className="xn-composer__keyboard-help">
            {queueWhenRunning && running
              ? guideWhenRunning ? `${effectiveFollowupMode === 'guide' ? tr('引导当前轮') : tr('加入队列')} · ${displayBinding('Mod+Enter', platform)} ${effectiveFollowupMode === 'guide' ? tr('加入队列') : tr('立即发送')}`
                : sendShortcut === "mod-enter" ? tf("{0} 排队 · Enter 换行", [displayBinding("Mod+Enter")]) : tr("Enter 排队 · Shift+Enter 换行")
              : sendShortcut === "mod-enter" ? tf("{0} 发送 · Enter 换行", [displayBinding("Mod+Enter")]) : tr("Enter 发送 · Shift+Enter 换行")}
          </span>}
        </div>
        <div className="xn-composer__submit-actions">
          {showQueueControl && <button type="submit" disabled={isSendDisabled}
            onClick={event => { pointerDeliveryRef.current = followupPointerDelivery(effectiveFollowupMode, event, platform); }}
            className="xn-composer__send xn-composer__queue" aria-label={tr(queueBusy ? "正在排队…" : effectiveFollowupMode === 'guide' ? '引导当前轮' : "加入队列")}
            title={tr(queueBusy ? "正在排队…" : effectiveFollowupMode === 'guide' ? '引导当前轮' : "加入队列")} data-testid="composer-queue">
            {queueBusy ? <IconLoader size={16} /> : <IconArrowUp size={16} />}
          </button>}
          {showStopControl ? (
            <button
              type="button"
              disabled={stopping}
              className="xn-composer__send xn-composer__stop"
              aria-label={stopping ? tr("正在停止") : tr("停止")}
              aria-keyshortcuts="Escape"
              title={stopping ? tr("正在停止") : tr("停止当前任务 (Esc)")}
              data-testid="composer-stop"
              onClick={onStop}
            >
              {stopping ? <IconLoader size={16} /> : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <rect x="7" y="7" width="10" height="10" rx="2" />
                </svg>
              )}
            </button>
          ) : !running && (
            <button
              type="submit"
              disabled={isSendDisabled}
              className="xn-composer__send"
              aria-label={tr(draft.pendingSubmission ? "正在发送…" : "发送")}
              title={tr(draft.pendingSubmission ? "正在发送…" : "发送")}
            >
              {draft.pendingSubmission ? <IconLoader size={16} /> : <IconArrowUp size={16} />}
            </button>
          )}
        </div>
      </div>
      </form>
    </div>
  );
}

export * from './TaskList';

export * from './diffPreview';

export * from './disclosureState';

export * from './ApprovalPreview';

export * from './Approvals';

export * from './composerInputHelpers';

export * from './composerDraftStore';

export * from './composerTypes';

export * from './composerKeyboard';

export * from './WorkbenchHeader';
