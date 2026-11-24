import { t as tr, tf } from '../../i18n';
import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { type ComposerAttachment } from "./composerAttachmentRef";
import { getComposerAttachmentUploadStore } from './composerAttachmentUploadStore';
import { attachmentOwnerMatches } from './composerAttachmentDraft';
import { matchesComposerSearch } from './ComposerCapabilityMenu';
import { subscribeComposerDrafts, notifyComposerDrafts } from './composerRecovery';
import { editorHasAtomicNodes, editorStateForPlainText, editorStateMatching, editorStateSignature, navigationLength, navigationText } from './composerEditorState';
import { ComposerMaterialManifest } from './ComposerMaterialManifest';
import { composerMaterialsForDraft } from './composerMaterialSummary';
import { CurrentTurnInput, type FollowupMode, type InputDelivery } from './CurrentTurnInput';
import { displayBinding } from '../../xuenessShortcutDisplay';
import { ComposerProps, ComposerDraftState, emptyComposerDraft } from './composerTypes';
import { readPersistedDraft, restoredDraft, persistDraft } from './composerDraftStore';
import { ComposerMention, contextComposerSuggestions, isFileDragEvent } from './composerInputHelpers';
import { createComposerDraftActions } from './composerDraftActions';
import { useComposerPlusMenu } from './composerPlusMenuState';
import { useComposerUploadSync } from './composerUploadSync';
import { resolveComposerEditorSurface } from './composerEditorSurface';
import { useComposerWindowStop, useComposerInputAutoHeight } from './composerWindowEffects';
import { createComposerAttachmentActions } from './composerAttachmentActions';
import { createComposerSendHandler } from './composerSendHandler';
import { createComposerEditingActions } from './composerEditingActions';
import { createComposerKeyDownHandler } from './composerKeyDownHandler';
import { ComposerSuggestionList } from './ComposerSuggestionList';
import { ComposerContextChips } from './ComposerContextChips';
import { ComposerStatusMessages } from './ComposerStatusMessages';
import { ComposerInputSurface } from './ComposerInputSurface';
import { ComposerPlusMenu } from './ComposerPlusMenu';
import { ComposerSubmitActions } from './ComposerSubmitActions';


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
  const { toggleCapability, setText, setGoal, toggleContext, addContext } = createComposerDraftActions({ capabilities, updateCurrentDraft, richComposer });
  const [legacyAttachmentBusy, setLegacyAttachmentBusy] = useState(false);
  const legacyAttachmentBusyRef = useRef(false);
  const {
    plusOpen, setPlusOpen, addSearch, setAddSearch, plusRef, plusButtonRef, menuRef, attachInputRef,
    closePlusMenu, openAttachmentPicker, handlePlusMenuKeyDown,
  } = useComposerPlusMenu();
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
  useComposerUploadSync({ richComposer, uploadStore, draftsRef, draft, uploadOwner, resolvedWorkspaceKey, uploadEnabled, ownerMismatch, attachmentGeneration });
  const { disposeRef, removeAttachment, removeUpload, addAttachmentFiles, handlePasteEvent, handleDropEvent } = createComposerAttachmentActions({
    draftsRef, scopedDraftKey, uploadOwner, uploadStore, uploadEnabled, ownerMismatch, attachments, attachmentRoot,
    attachmentRemoteOwner, attachmentTransport, attachmentsEnabled, attachmentGeneration, richComposer, disabled, running,
    legacyAttachmentBusyRef, setLegacyAttachmentBusy, setAttachmentError, setIsDraggingOver, updateAttachments,
    updateCurrentDraft, updateDraftFor,
  });
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
  const editorSurface = resolveComposerEditorSurface({ surfaceRef, tokenEditor, localEditSignature, pendingCaret, scopedDraftKey });
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

  useComposerWindowStop({ running, onStop, stopping, editorDomRef, localInputRef, plusOpen, suggestions, platform, shortcutBindings });
  useComposerInputAutoHeight(localInputRef, text, variant);

  const { readSelectionOffset, commitStructured, acceptSuggestion, degradeToTextarea } = createComposerEditingActions({
    tokenEditor, editorDomRef, localInputRef, cursorOffset, text, draftsRef, scopedDraftKey, localEditSignature,
    pendingCaret, updateCurrentDraft, setCursorOffset, richComposer, startActions, setGoal, setText, addContext,
    selectedMention, setSuggestDismissed, setActiveSuggestion,
  });

  const handleSend = createComposerSendHandler({
    isSendDisabled, draftsRef, scopedDraftKey, onSend, setSubmissionError, defaultValue, uploadStore, uploadOwner,
    legacyAttachmentBusyRef, unavailableAttachments, attachmentRoot, attachmentSessionId, attachmentRemoteOwner,
    richComposer, resolvedWorkspaceKey, draftKey, historyIndexRef, running, queueWhenRunning, effectiveFollowupMode,
    updateDraftFor, disposeRef,
  });

  const handleKeyDown = createComposerKeyDownHandler({
    compositionActiveRef, tokenEditor, readSelectionOffset, commitStructured, shortcutBindings, platform, suggestions,
    localInputRef, editorDomRef, setText, text, handleSend, running, queueWhenRunning, effectiveFollowupMode,
    sendShortcut, onStop, stopping, setSuggestDismissed, plusOpen, closePlusMenu, historyIndexRef, savedDraftTextRef,
    currentSuggestion, acceptSuggestion, setActiveSuggestion, resolvedWorkspaceKey, degradeToTextarea,
  });

  return (
    <div className={`xn-composer-region xn-composer-region--${variant}`}>
      <form
      aria-label={tr("消息编写器")}
      className={`xn-composer xn-composer--${variant}${topContent ? " xn-composer--with-top-content" : ""}`}
      data-rich-composer={richComposer ? "true" : "false"} data-running={running ? "true" : undefined}
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
        <ComposerSuggestionList suggestions={suggestions} suggestionListId={suggestionListId} currentSuggestion={currentSuggestion}
          acceptSuggestion={acceptSuggestion} setActiveSuggestion={setActiveSuggestion} />
      )}
      {(goal || attachments.length > 0 || uploadItems.length > 0 || selectedContextCount > 0) && (
        <ComposerContextChips selectedCapabilities={selectedCapabilities} capabilities={capabilities}
          updateCurrentDraft={updateCurrentDraft} goal={goal} setGoal={setGoal} selectedContext={selectedContext}
          selectedMention={selectedMention} toggleContext={toggleContext} richComposer={richComposer}
          uploadItems={uploadItems} uploadEnabled={uploadEnabled} uploadOwner={uploadOwner} removeUpload={removeUpload}
          uploadStore={uploadStore} ownerMismatch={ownerMismatch} attachments={attachments} attachmentRoot={attachmentRoot}
          attachmentSessionId={attachmentSessionId} removeAttachment={removeAttachment} />
      )}
      <ComposerMaterialManifest materials={materialRows} />
      <ComposerStatusMessages ownerMismatch={ownerMismatch} legacyAttachmentBusy={legacyAttachmentBusy}
        attachmentError={attachmentError} draft={draft} uploadStore={uploadStore} uploadOwner={uploadOwner}
        updateCurrentDraft={updateCurrentDraft} selectedCapabilities={selectedCapabilities} sendDisabled={sendDisabled}
        hasSendableContent={hasSendableContent} goal={goal} modelRecovery={modelRecovery}
        sendDisabledReason={sendDisabledReason} startActions={startActions} submissionError={submissionError}
        availableMentions={availableMentions} capabilities={capabilities} attachmentRoot={attachmentRoot}
        attachmentSessionId={attachmentSessionId} attachmentRemoteOwner={attachmentRemoteOwner}
        localInputRef={localInputRef} setAttachmentError={setAttachmentError} draftsRef={draftsRef}
        scopedDraftKey={scopedDraftKey} disposeRef={disposeRef} />
      <ComposerInputSurface tokenEditor={tokenEditor} editorSurface={editorSurface} disabled={disabled} minimal={minimal}
        suggestionListId={suggestionListId} suggestions={suggestions} currentSuggestion={currentSuggestion}
        inputRef={inputRef} editorDomRef={editorDomRef} commitStructured={commitStructured}
        degradeToTextarea={degradeToTextarea} handleKeyDown={handleKeyDown} handlePasteEvent={handlePasteEvent}
        handleDropEvent={handleDropEvent} compositionActiveRef={compositionActiveRef} setCursorOffset={setCursorOffset}
        attachRef={attachRef} structuredDraft={structuredDraft} text={text} setText={setText}
        historyIndexRef={historyIndexRef} setSuggestDismissed={setSuggestDismissed}
        setActiveSuggestion={setActiveSuggestion} setSubmissionError={setSubmissionError} placeholder={placeholder}
        autoFocus={autoFocus} />
      <div className="xn-composer__row">
        <div className="xn-composer__tools">
          <ComposerPlusMenu plusRef={plusRef} plusButtonRef={plusButtonRef} menuRef={menuRef} plusMenuId={plusMenuId}
            plusOpen={plusOpen} setPlusOpen={setPlusOpen} disabled={disabled} attachmentsEnabled={attachmentsEnabled}
            legacyAttachmentBusy={legacyAttachmentBusy} openAttachmentPicker={openAttachmentPicker}
            handlePlusMenuKeyDown={handlePlusMenuKeyDown} closePlusMenu={closePlusMenu} addSearch={addSearch}
            setAddSearch={setAddSearch} canOfferGoal={canOfferGoal} canOfferWorkflow={canOfferWorkflow} goal={goal}
            startActions={startActions} setGoal={setGoal} localInputRef={localInputRef}
            visibleCapabilities={visibleCapabilities} selectedCapabilities={selectedCapabilities}
            toggleCapability={toggleCapability} visibleMentions={visibleMentions} selectedContext={selectedContext}
            toggleContext={toggleContext} availableMentions={availableMentions} />
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
        <ComposerSubmitActions showQueueControl={showQueueControl} isSendDisabled={isSendDisabled}
          pointerDeliveryRef={pointerDeliveryRef} effectiveFollowupMode={effectiveFollowupMode} platform={platform}
          queueBusy={queueBusy} showStopControl={showStopControl} stopping={stopping} onStop={onStop} running={running}
          draft={draft} />
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
