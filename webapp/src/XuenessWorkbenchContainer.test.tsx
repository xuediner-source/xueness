import test from "node:test";
import assert from "node:assert/strict";
import { composerModelRecoveryFor, evaluateWorkbenchGlobalKey, shouldIgnoreSessionResponse, createCleanSessionTransientState, shouldPreservePersistedDefaultDraftScope, shouldHydrateEmptyPrimaryDraftScope } from "./XuenessWorkbenchContainer";
import { persistDraft, readPersistedDraft, restoredDraft, type ComposerDraftState } from "./plugins/sessions/XuenessWorkbenchView";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

function composerDraft(text: string): ComposerDraftState {
  return { text, goal: false, attachments: [], selectedCapabilities: [],
    selectedContext: { files: [], sessions: [], skills: [], plugins: [] },
    submissionError: "", attachmentError: "", revision: 1 };
}

function primaryHydrationInput(overrides: Partial<Parameters<typeof shouldHydrateEmptyPrimaryDraftScope>[0]> = {}) {
  return {
    activeId: null,
    draftRoot: undefined,
    remote: false,
    catalogRoot: "/default-workspace",
    commandRoot: "/default-workspace",
    draftStore: new Map<string, ComposerDraftState>(),
    persistedDrafts: [],
    ...overrides,
  };
}

function makeContext(overrides: Partial<Parameters<typeof evaluateWorkbenchGlobalKey>[1]> = {}) {
  return {
    bindings: {},
    isPluginEffective: (id: string) => true,
    panel: "chat",
    busy: false,
    platform: "win32",
    ...overrides,
  };
}

test("evaluateWorkbenchGlobalKey dispatches Windows/Linux shortcuts via Ctrl and blocks Meta", () => {
  const ctx = makeContext({ platform: "win32" });

  assert.deepEqual(evaluateWorkbenchGlobalKey({ key: "n", ctrlKey: true }, ctx), { type: "new-session" });
  assert.deepEqual(evaluateWorkbenchGlobalKey({ key: "k", ctrlKey: true }, ctx), { type: "command-palette" });
  assert.deepEqual(evaluateWorkbenchGlobalKey({ key: ",", ctrlKey: true }, ctx), { type: "open-settings" });
  assert.deepEqual(evaluateWorkbenchGlobalKey({ key: "b", ctrlKey: true }, ctx), { type: "toggle-sidebar" });
  assert.deepEqual(evaluateWorkbenchGlobalKey({ key: "r", altKey: true, shiftKey: true }, ctx), { type: "refresh-session" });

  // On win32, Meta is NOT the Mod key
  assert.equal(evaluateWorkbenchGlobalKey({ key: "n", metaKey: true }, ctx), null);
  assert.equal(evaluateWorkbenchGlobalKey({ key: "k", metaKey: true }, ctx), null);
  assert.equal(evaluateWorkbenchGlobalKey({ key: "b", metaKey: true }, ctx), null);
});

test("evaluateWorkbenchGlobalKey dispatches macOS shortcuts via Meta (⌘) and blocks Ctrl", () => {
  const ctx = makeContext({ platform: "darwin" });

  assert.deepEqual(evaluateWorkbenchGlobalKey({ key: "n", metaKey: true }, ctx), { type: "new-session" });
  assert.deepEqual(evaluateWorkbenchGlobalKey({ key: "k", metaKey: true }, ctx), { type: "command-palette" });
  assert.deepEqual(evaluateWorkbenchGlobalKey({ key: ",", metaKey: true }, ctx), { type: "open-settings" });
  assert.deepEqual(evaluateWorkbenchGlobalKey({ key: "b", metaKey: true }, ctx), { type: "toggle-sidebar" });
  assert.deepEqual(evaluateWorkbenchGlobalKey({ key: "r", altKey: true, shiftKey: true }, ctx), { type: "refresh-session" });

  // On darwin, Ctrl is NOT the Mod key
  assert.equal(evaluateWorkbenchGlobalKey({ key: "n", ctrlKey: true }, ctx), null);
  assert.equal(evaluateWorkbenchGlobalKey({ key: "k", ctrlKey: true }, ctx), null);
  assert.equal(evaluateWorkbenchGlobalKey({ key: "b", ctrlKey: true }, ctx), null);
});

test("evaluateWorkbenchGlobalKey blocks all actions during IME composing states", () => {
  const ctxWin = makeContext({ platform: "win32" });
  const ctxMac = makeContext({ platform: "darwin" });

  // isComposing flag
  assert.equal(evaluateWorkbenchGlobalKey({ key: "n", ctrlKey: true, isComposing: true }, ctxWin), null);
  assert.equal(evaluateWorkbenchGlobalKey({ key: "n", metaKey: true, isComposing: true }, ctxMac), null);

  // keyCode 229
  assert.equal(evaluateWorkbenchGlobalKey({ key: "k", ctrlKey: true, keyCode: 229 }, ctxWin), null);
  assert.equal(evaluateWorkbenchGlobalKey({ key: "k", metaKey: true, keyCode: 229 }, ctxMac), null);

  // Process / Dead keys
  assert.equal(evaluateWorkbenchGlobalKey({ key: "Process", ctrlKey: true }, ctxWin), null);
  assert.equal(evaluateWorkbenchGlobalKey({ key: "Dead", metaKey: true }, ctxMac), null);

  // nativeEvent isComposing / keyCode
  assert.equal(evaluateWorkbenchGlobalKey({ key: "b", ctrlKey: true, nativeEvent: { isComposing: true } }, ctxWin), null);
  assert.equal(evaluateWorkbenchGlobalKey({ key: "b", metaKey: true, nativeEvent: { keyCode: 229 } }, ctxMac), null);

  // compositionActive
  assert.equal(evaluateWorkbenchGlobalKey({ key: "n", ctrlKey: true, compositionActive: true }, ctxWin), null);

  // defaultPrevented or repeat
  assert.equal(evaluateWorkbenchGlobalKey({ key: "n", ctrlKey: true, defaultPrevented: true }, ctxWin), null);
  assert.equal(evaluateWorkbenchGlobalKey({ key: "n", ctrlKey: true, repeat: true }, ctxWin), null);
});

test("evaluateWorkbenchGlobalKey avoids conflicts with terminal, input, and editor targets", () => {
  const terminalHost = {
    className: "xn-terminal-host",
    closest: (sel: string) => sel.includes("terminal") || sel.includes("xterm") ? terminalHost : null,
  };
  const inputEl = {
    tagName: "INPUT",
    closest: (sel: string) => sel.includes("input") ? inputEl : null,
  };
  const editorEl = {
    className: "xn-zc-editor",
    closest: (sel: string) => sel.includes("editor") ? editorEl : null,
  };

  const winCtx = makeContext({ platform: "win32" });
  const macCtx = makeContext({ platform: "darwin" });

  // Windows terminal: Ctrl+B (tmux), Ctrl+K (readline), Ctrl+N (history) must NOT be stolen
  assert.equal(evaluateWorkbenchGlobalKey({ key: "b", ctrlKey: true, target: terminalHost }, winCtx), null);
  assert.equal(evaluateWorkbenchGlobalKey({ key: "k", ctrlKey: true, target: terminalHost }, winCtx), null);
  assert.equal(evaluateWorkbenchGlobalKey({ key: "n", ctrlKey: true, target: terminalHost }, winCtx), null);

  // macOS terminal: ⌘B and ⌘K use metaKey, which does not send control codes to shell
  assert.deepEqual(evaluateWorkbenchGlobalKey({ key: "b", metaKey: true, target: terminalHost }, macCtx), { type: "toggle-sidebar" });
  assert.deepEqual(evaluateWorkbenchGlobalKey({ key: "k", metaKey: true, target: terminalHost }, macCtx), { type: "command-palette" });

  // Input & Editor: normal typing or editing shortcuts must not trigger
  assert.equal(evaluateWorkbenchGlobalKey({ key: "n", target: inputEl }, winCtx), null);
  assert.equal(evaluateWorkbenchGlobalKey({ key: "N", shiftKey: true, target: editorEl }, macCtx), null);

  // Global Mod+K and Mod+N from input still work when not editing
  assert.deepEqual(evaluateWorkbenchGlobalKey({ key: "k", ctrlKey: true, target: inputEl }, winCtx), { type: "command-palette" });
  assert.deepEqual(evaluateWorkbenchGlobalKey({ key: "k", metaKey: true, target: inputEl }, macCtx), { type: "command-palette" });
});

test("evaluateWorkbenchGlobalKey enforces plugin effectiveness and panel/busy state constraints", () => {
  // sessions plugin disabled
  const noSessionsCtx = makeContext({
    platform: "win32",
    isPluginEffective: (id: string) => id !== "sessions",
  });
  assert.equal(evaluateWorkbenchGlobalKey({ key: "n", ctrlKey: true }, noSessionsCtx), null);
  assert.equal(evaluateWorkbenchGlobalKey({ key: "k", ctrlKey: true }, noSessionsCtx), null);
  assert.deepEqual(evaluateWorkbenchGlobalKey({ key: ",", ctrlKey: true }, noSessionsCtx), { type: "open-settings" });

  // settings plugin disabled
  const noSettingsCtx = makeContext({
    platform: "win32",
    isPluginEffective: (id: string) => id !== "settings",
  });
  assert.equal(evaluateWorkbenchGlobalKey({ key: ",", ctrlKey: true }, noSettingsCtx), null);

  // sidebar toggle disabled when panel === 'settings'
  const inSettingsCtx = makeContext({ platform: "win32", panel: "settings" });
  assert.equal(evaluateWorkbenchGlobalKey({ key: "b", ctrlKey: true }, inSettingsCtx), null);

  // refresh disabled when busy === true
  const busyCtx = makeContext({ platform: "win32", busy: true });
  assert.equal(evaluateWorkbenchGlobalKey({ key: "r", altKey: true, shiftKey: true }, busyCtx), null);
});

test("evaluateWorkbenchGlobalKey honors custom shortcut bindings", () => {
  const customCtx = makeContext({
    platform: "win32",
    bindings: { "new-session": "Mod+Shift+N" },
  });

  // Old binding should no longer match
  assert.equal(evaluateWorkbenchGlobalKey({ key: "n", ctrlKey: true }, customCtx), null);

  // Custom binding matches
  assert.deepEqual(evaluateWorkbenchGlobalKey({ key: "n", ctrlKey: true, shiftKey: true }, customCtx), { type: "new-session" });
  assert.equal(evaluateWorkbenchGlobalKey({ key: "Enter", ctrlKey: true, shiftKey: true }, customCtx), null, "composer bindings stay scoped to the input");
});

test("shouldIgnoreSessionResponse guards against unmount, aborted signals, and session mismatch races", () => {
  const activeSession = "session-123";
  const controller = new AbortController();

  // Active matching session, mounted, not aborted -> accept response
  assert.equal(shouldIgnoreSessionResponse(activeSession, activeSession, true, controller.signal), false);

  // Mismatched session (user switched sessions before fetch returned) -> ignore
  assert.equal(shouldIgnoreSessionResponse("old-session-001", activeSession, true, controller.signal), true);

  // Unmounted component -> ignore
  assert.equal(shouldIgnoreSessionResponse(activeSession, activeSession, false, controller.signal), true);

  // Aborted signal -> ignore
  controller.abort();
  assert.equal(shouldIgnoreSessionResponse(activeSession, activeSession, true, controller.signal), true);
});

test("createCleanSessionTransientState resets files, preview, changes, and git panel states", () => {
  const clean = createCleanSessionTransientState();
  assert.deepEqual(clean.files, []);
  assert.equal(clean.filesTruncated, false);
  assert.equal(clean.selectedPath, null);
  assert.equal(clean.preview, null);
  assert.equal(clean.previewError, "");
  assert.equal(clean.changeSet, null);
  assert.equal(clean.changesError, "");
  assert.equal(clean.gitStatus, null);
  assert.equal(clean.gitStatusError, "");
  assert.equal(clean.gitDiff, null);
  assert.equal(clean.gitDiffError, "");
  assert.equal(clean.gitLog, null);
  assert.equal(clean.gitLogError, "");
  assert.deepEqual(clean.gitCheckpoints, []);
  assert.equal(clean.gitCheckpointError, "");
  assert.equal(clean.runError, "");
});

test("composer model recovery retries catalog discovery and configures only when no model is available", () => {
  const calls: string[] = [];
  const onRetry = () => calls.push("refresh-catalog");
  const onConfigure = () => calls.push("open-model-settings");
  const input = { loading: false, error: "", modelReady: false, allowReal: true,
    hasConfiguredModel: false, onRetry, onConfigure };

  assert.deepEqual(composerModelRecoveryFor({ ...input, loading: true }), { kind: "loading" });
  assert.deepEqual(composerModelRecoveryFor({ ...input, error: "catalog unavailable" }), { kind: "error", onRetry });
  const failed = composerModelRecoveryFor({ ...input, error: "catalog unavailable" });
  if (failed?.kind === "error") failed.onRetry();
  assert.deepEqual(calls, ["refresh-catalog"]);

  assert.deepEqual(composerModelRecoveryFor(input), { kind: "missing", onConfigure });
  const missing = composerModelRecoveryFor(input);
  if (missing?.kind === "missing") missing.onConfigure();
  assert.deepEqual(calls, ["refresh-catalog", "open-model-settings"]);

  assert.equal(composerModelRecoveryFor({ ...input, modelReady: true }), undefined);
  assert.deepEqual(composerModelRecoveryFor({ ...input, allowReal: false, hasConfiguredModel: true }), { kind: "blocked" });
});

test("startup root hydration checks persisted default and resolved-root drafts before lazy composer hydration", () => {
  for (const workspace of ["default", "/default-workspace"]) {
    const storage = memoryStorage();
    persistDraft(workspace, "new-task", { ...composerDraft(`saved in ${workspace}`), recoverableDrafts: [] }, storage);
    const persisted = readPersistedDraft(workspace, "new-task", storage);
    assert.ok(persisted);
    const draftStore = new Map<string, ComposerDraftState>();

    assert.equal(shouldHydrateEmptyPrimaryDraftScope(primaryHydrationInput({
      draftStore,
      persistedDrafts: [restoredDraft(persisted)],
    })), false, `${workspace} content must prevent startup rebinding`);
    assert.equal(draftStore.size, 0, "the check must not rely on the lazy composer having populated memory");
    assert.equal(readPersistedDraft(workspace, "new-task", storage)?.text, `saved in ${workspace}`);
  }
  assert.equal(shouldHydrateEmptyPrimaryDraftScope(primaryHydrationInput()), true,
    "an actually empty default/root scope can still hydrate in place");
});

test("startup root hydration preserves persisted attachment and uncertain-send recovery state", () => {
  const storage = memoryStorage();
  const recoverable = { ...composerDraft("sent before reload"), hadAttachments: true };
  const current = { ...composerDraft(""), hadAttachments: true, deliveryUnconfirmed: true,
    recoverableDrafts: [recoverable], pendingSubmission: { id: "pending-send", draft: recoverable } };
  persistDraft("default", "new-task", current, storage);
  const record = readPersistedDraft("default", "new-task", storage);
  assert.ok(record);
  const restored = restoredDraft(record);
  assert.equal(restored.hadAttachments, true);
  assert.equal(restored.deliveryUnconfirmed, true);
  assert.equal(restored.recoverableDrafts?.length, 2, "both the saved recovery and pending send remain recoverable");

  const draftStore = new Map<string, ComposerDraftState>();
  assert.equal(shouldHydrateEmptyPrimaryDraftScope(primaryHydrationInput({ draftStore, persistedDrafts: [restored] })), false);
  assert.equal(draftStore.size, 0);
  assert.ok(readPersistedDraft("default", "new-task", storage)?.pendingSubmission,
    "the hydration check must not rewrite or clear the pending persisted submission");
});

test("startup keeps a persisted default draft scope selected without rewriting attachment or recovery records", () => {
  const storage = memoryStorage();
  const attachment = { id: "a".repeat(32), token: "a".repeat(32), name: "notes.txt", size: 10,
    origin: "file" as const, mimeType: "text/plain" };
  const withAttachment = { ...composerDraft("draft with an attachment"), hadAttachments: true,
    attachments: [{ name: attachment.name, mimeType: attachment.mimeType, data: "", ref: attachment }],
    attachmentOwner: { root: "/original-workspace", draftId: "default-draft" } };
  persistDraft("default", "new-task", withAttachment, storage);
  const key = "xueness:composer-drafts:v1:default";
  const originalRecord = storage.getItem(key);
  const persistedAttachmentDraft = readPersistedDraft("default", "new-task", storage);
  assert.ok(persistedAttachmentDraft);
  assert.equal(shouldPreservePersistedDefaultDraftScope(persistedAttachmentDraft), true,
    "an attachment belongs to the default draft's original scope until the user selects a workspace");
  assert.equal(storage.getItem(key), originalRecord, "initial scope selection leaves the serialized attachment reference untouched");

  const pendingDraft = { ...composerDraft(""), deliveryUnconfirmed: true,
    pendingSubmission: { id: "pending-send", draft: composerDraft("possibly sent before restart") },
    recoverableDrafts: [{ ...composerDraft("older recoverable text"), hadAttachments: true }] };
  persistDraft("default", "new-task", pendingDraft, storage);
  const originalRecoveryRecord = storage.getItem(key);
  const persistedRecoveryDraft = readPersistedDraft("default", "new-task", storage);
  assert.ok(persistedRecoveryDraft);
  assert.equal(shouldPreservePersistedDefaultDraftScope(persistedRecoveryDraft), true,
    "an empty editor still selects the saved scope when a send or recoverable attachment needs attention");
  assert.equal(storage.getItem(key), originalRecoveryRecord, "pending and recovered metadata remain byte-for-byte available");

  persistDraft("default", "new-task", composerDraft(""), storage);
  assert.equal(shouldPreservePersistedDefaultDraftScope(readPersistedDraft("default", "new-task", storage)), false,
    "an actually empty saved scope must not pin the composer to the default root");
  assert.equal(shouldPreservePersistedDefaultDraftScope(null), false);
});

