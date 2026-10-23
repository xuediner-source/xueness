import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { RunChoices } from '../../xuenessBridge';
import { addPaneGroup, focusGroupPane, initialPaneGroups, openGroupSession, removePaneGroup, resolveSessionPlacement, updatePaneGroup, type PaneGroups } from './paneGroups';
import { bindCreatedPaneSession, closeTreePane, paneLeafIds, replaceTreeBinding, setTreeSplitRatio, validTreeBinding, type PaneSide, type PaneTree, type TreeBinding } from './paneTree';
import { decodePaneGroups, encodePaneGroups, PANE_GROUP_STORAGE_KEY } from './panePersistence';
import { getWorkbenchStorage } from '../desktop/desktopStorage';
import { PANE_LAYOUT_STORAGE_KEY, paneLayoutViewportIsWide } from './paneLayout';
import { paneTreeGeometry } from './paneGeometry';
import { paneBindingKey, paneScopeIdentity, type PaneIdentity } from './paneIdentity';
import { copyPaneRunOptions, updatePaneRunOptions } from './paneRunOptions';
import { probePaneSession, type PaneRestoreResult, type PaneSessionProbe } from './paneRestore';

export type PaneStorageStatus = 'idle' | 'ready' | 'invalid' | 'pendingLegacy' | 'unavailable';
export type PaneWorkbenchStorage = Pick<Storage, 'getItem' | 'setItem'>;
export type PaneWorkbenchSnapshot = { readonly state: PaneGroups; readonly storageStatus: PaneStorageStatus; readonly revision: number };
export type PaneWorkbenchOptions = {
  readonly enabled: boolean;
  readonly primaryBinding: TreeBinding;
  readonly initialRunOptions?: RunChoices;
  readonly probeSession?: PaneSessionProbe;
};
type Runtime = { binding: TreeBinding; revision: number; choices: RunChoices };
const defaultChoices: RunChoices = { provider: 'real', mode: 'build', permission_mode: 'build', browser: false };
const ownerKey = (groupId: string, paneId: string) => JSON.stringify([groupId, paneId]);
const sameBinding = (a: TreeBinding, b: TreeBinding) => a.sessionId === b.sessionId
  && paneScopeIdentity(a.scope) === paneScopeIdentity(b.scope)
  && a.draftAlias?.workspaceKey === b.draftAlias?.workspaceKey && a.draftAlias?.draftKey === b.draftAlias?.draftKey;

/** Plugin-owned imperative core: effects are admitted only by start(), never construction/render. */
export class PaneWorkbenchController {
  private snapshot: PaneWorkbenchSnapshot = { state: initialPaneGroups(), storageStatus: 'idle', revision: 0 };
  private listeners = new Set<() => void>();
  private options: PaneWorkbenchOptions;
  private running = false;
  private storage: PaneWorkbenchStorage | null = null;
  private writable = false;
  private sequence = 0;
  private generation = 0;
  private runtime = new Map<string, Runtime>();
  private restores = new Map<string, PaneRestoreResult>();
  private requests = new Map<string, AbortController>();
  private promotions = new WeakMap<TreeBinding, Map<string, (sessionId: string) => void>>();
  constructor(options: PaneWorkbenchOptions, private readonly now: () => number = Date.now,
    private readonly createId: (kind: string) => string = kind => `${kind}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${++this.sequence}`}`) { this.options = options; }
  configure(options: PaneWorkbenchOptions): void { this.options = options; }
  getSnapshot = (): PaneWorkbenchSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private allowed = () => this.running && this.options.enabled;
  private publish(state = this.snapshot.state, status = this.snapshot.storageStatus): void {
    this.snapshot = { state, storageStatus: status, revision: this.snapshot.revision + 1 };
    this.listeners.forEach(listener => listener());
  }
  private reconcileRuntime(state: PaneGroups, preserve?: string): void {
    const live = new Set<string>();
    for (const group of state.groups) for (const paneId of paneLeafIds(group.tree.root)) {
      const key = ownerKey(group.groupId, paneId), binding = group.tree.bindings[paneId];
      live.add(key);
      const old = this.runtime.get(key);
      if (!old || old.binding !== binding) this.runtime.set(key, {
        binding, revision: old && sameBinding(old.binding, binding) ? old.revision : ++this.sequence,
        choices: old && (key === preserve || sameBinding(old.binding, binding)) ? old.choices : copyPaneRunOptions(this.options.initialRunOptions ?? defaultChoices),
      });
    }
    for (const key of this.runtime.keys()) if (!live.has(key)) this.runtime.delete(key);
    // Canceled/rebound ownership cannot receive late restore results.
    const liveKeys = this.currentBindingKeys();
    for (const [key, request] of this.requests) if (!liveKeys.has(key)) { request.abort(); this.requests.delete(key); }
    for (const key of this.restores.keys()) if (!liveKeys.has(key)) this.restores.delete(key);
  }
  private currentBindingKeys(): Set<string> {
    const keys = new Set<string>();
    for (const group of this.snapshot.state.groups) for (const paneId of paneLeafIds(group.tree.root)) {
      const identity = this.identity(paneId, group.groupId); if (identity) keys.add(paneBindingKey(identity));
    }
    return keys;
  }
  private commit(state: PaneGroups, preserve?: string): TreeBinding | null {
    if (!this.allowed()) return null;
    if (state !== this.snapshot.state) {
      // Set the tree before reconciliation so identities point to the new ownership.
      this.snapshot = { ...this.snapshot, state };
      this.reconcileRuntime(state, preserve);
      let status = this.snapshot.storageStatus;
      if (this.writable && this.storage) try { this.storage.setItem(PANE_GROUP_STORAGE_KEY, encodePaneGroups(state)); status = 'ready'; }
      catch { status = 'unavailable'; }
      this.publish(state, status);
    }
    return this.requiredPrimaryBinding();
  }
  start(storage: PaneWorkbenchStorage | null): void {
    if (!this.options.enabled) return;
    this.running = true; this.storage = storage; this.reload();
  }
  stop(): void {
    this.running = false; this.generation++; this.promotions = new WeakMap();
    this.requests.forEach(request => request.abort()); this.requests.clear();
    this.storage = null; this.writable = false;
  }
  reload = (): void => {
    if (!this.allowed()) return;
    this.generation++; this.promotions = new WeakMap(); this.requests.forEach(request => request.abort()); this.requests.clear(); this.restores.clear();
    let raw: string | null = null, legacy = false;
    try {
      if (!this.storage) throw new Error('storage unavailable');
      raw = this.storage.getItem(PANE_GROUP_STORAGE_KEY);
      if (raw === null) { raw = this.storage.getItem(PANE_LAYOUT_STORAGE_KEY); legacy = raw !== null; }
    } catch {
      this.writable = false; this.publish(this.snapshot.state, 'unavailable');
      if (!this.snapshot.state.groups.length) this.ensureGroup(this.options.primaryBinding);
      return;
    }
    const result = decodePaneGroups(raw, { primaryBinding: this.options.primaryBinding, groupId: this.createId('group'), updatedAt: this.now() });
    this.writable = result.kind === 'ok' || result.kind === 'empty';
    if (result.kind === 'ok') {
      // A v1 record under the v2 key must be preserved byte-for-byte too.
      this.writable = !result.migrated || legacy;
      this.snapshot = { ...this.snapshot, state: result.state };
      this.reconcileRuntime(result.state); this.publish(result.state, this.writable ? 'ready' : 'pendingLegacy');
      if (result.migrated && this.writable && this.storage) {
        try { this.storage.setItem(PANE_GROUP_STORAGE_KEY, encodePaneGroups(result.state)); }
        catch { this.publish(result.state, 'unavailable'); }
      }
    } else if (result.kind === 'empty') {
      this.snapshot = { ...this.snapshot, state: initialPaneGroups() }; this.reconcileRuntime(this.snapshot.state);
      this.publish(this.snapshot.state, 'ready'); this.ensureGroup(this.options.primaryBinding);
    } else {
      // Corruption/deferred migration is surfaced, never replaced with an empty layout.
      this.publish(this.snapshot.state, result.kind);
      if (!this.snapshot.state.groups.length) this.ensureGroup(this.options.primaryBinding);
    }
  };
  requiredPrimaryBinding = (): TreeBinding | null => this.activeGroup()?.tree.bindings.primary ?? null;
  activeGroup = () => this.snapshot.state.groups.find(group => group.groupId === this.snapshot.state.activeGroupId) ?? null;
  private group = (groupId?: string) => this.snapshot.state.groups.find(group => group.groupId === (groupId ?? this.snapshot.state.activeGroupId));
  private edit(paneId: string, transform: (tree: PaneTree) => PaneTree, groupId?: string): TreeBinding | null {
    if (!this.allowed()) return null;
    const group = this.group(groupId);
    if (!group || !Object.hasOwn(group.tree.bindings, paneId)) return null;
    return this.commit(updatePaneGroup(this.snapshot.state, group.groupId, transform(group.tree), this.now()));
  }
  ensureGroup = (binding: TreeBinding): TreeBinding | null => {
    if (!this.allowed() || !validTreeBinding(binding)) return null;
    const state = this.snapshot.state, existing = resolveSessionPlacement(state, binding);
    // A repeated draft selection is still its current owner, not a new empty group.
    if (binding.sessionId === null && this.activeGroup() && sameBinding(this.activeGroup()!.tree.bindings.primary, binding)) return this.requiredPrimaryBinding();
    return this.commit(existing ? focusGroupPane(state, existing, this.now()) : addPaneGroup(state, this.createId('group'), binding, this.now()));
  };
  selectPrimary = this.ensureGroup;
  /** Automatic detail hydration must not turn a restored secondary focus into a selection. */
  syncPrimary = (binding: TreeBinding, explicitSelection = false, hydrateEmptyDraftScope = false): TreeBinding | null => {
    const required = this.requiredPrimaryBinding();
    if (!explicitSelection && required && sameBinding(required, binding)) return required;
    // The first composer catalog resolves the default workspace after the pane
    // workbench may already have persisted an unscoped empty draft. Rebind that
    // provisional leaf in place so startup does not create a second empty group.
    if (!explicitSelection && hydrateEmptyDraftScope && required?.sessionId === null && binding.sessionId === null
      && required.scope.workspaceRoot === '' && !!binding.scope.workspaceRoot
      && !required.draftAlias
      && !required.scope.remoteConnectionId && !binding.scope.remoteConnectionId
      && !required.scope.workspaceIdentity && !binding.scope.workspaceIdentity) {
      const group = this.activeGroup();
      if (group?.tree.bindings.primary === required) {
        const hydrated = required.draftAlias ? { ...binding, draftAlias: required.draftAlias } : binding;
        return this.edit('primary', tree => replaceTreeBinding(tree, 'primary', hydrated), group.groupId);
      }
    }
    return this.ensureGroup(binding);
  };
  activateGroup = (groupId: string): TreeBinding | null => {
    const group = this.group(groupId);
    return !this.allowed() || !group ? null : this.commit(focusGroupPane(this.snapshot.state, { groupId, paneId: group.tree.focus }, this.now()));
  };
  closeGroup = (groupId: string): TreeBinding | null => this.commit(removePaneGroup(this.snapshot.state, groupId));
  openSession = (binding: TreeBinding, side: PaneSide = 'right', anchor?: string): TreeBinding | null => {
    if (!this.allowed()) return null;
    const group = this.activeGroup();
    if (!group) return this.ensureGroup(binding);
    return this.commit(openGroupSession(this.snapshot.state, group.groupId, anchor ?? group.tree.focus, side, binding, this.createId('pane'), this.createId('split'), this.now()));
  };
  split = (side: PaneSide, binding?: TreeBinding): TreeBinding | null => {
    const group = this.activeGroup(), focused = group?.tree.bindings[group.tree.focus];
    return focused ? this.openSession(binding ?? { scope: focused.scope, sessionId: null }, side) : null;
  };
  close = (paneId: string, groupId?: string): TreeBinding | null => this.edit(paneId, tree => closeTreePane(tree, paneId), groupId);
  focus = (paneId: string, groupId?: string): TreeBinding | null => {
    const group = this.group(groupId);
    return group ? this.commit(focusGroupPane(this.snapshot.state, { groupId: group.groupId, paneId }, this.now())) : null;
  };
  resize = (splitId: string, ratio: number, groupId?: string): TreeBinding | null => {
    const group = this.group(groupId);
    return group ? this.edit('primary', tree => setTreeSplitRatio(tree, splitId, ratio), group.groupId) : null;
  };
  replaceBinding = (paneId: string, binding: TreeBinding, groupId?: string): TreeBinding | null => {
    if (!this.allowed() || !validTreeBinding(binding)) return null;
    const existing = resolveSessionPlacement(this.snapshot.state, binding);
    if (existing) return this.commit(focusGroupPane(this.snapshot.state, existing, this.now()));
    return this.edit(paneId, tree => replaceTreeBinding(tree, paneId, binding), groupId);
  };
  identity = (paneId: string, groupId?: string): PaneIdentity | null => {
    const group = this.group(groupId); if (!group) return null;
    const entry = this.runtime.get(ownerKey(group.groupId, paneId));
    return entry ? { groupId: group.groupId, paneId, bindingRevision: entry.revision, scope: entry.binding.scope, sessionId: entry.binding.sessionId } : null;
  };
  runOptions = (paneId: string, groupId?: string): RunChoices => {
    const group = this.group(groupId), entry = group && this.runtime.get(ownerKey(group.groupId, paneId));
    return copyPaneRunOptions(entry?.choices ?? this.options.initialRunOptions ?? defaultChoices);
  };
  updateRunOptions = (paneId: string, patch: Partial<RunChoices>, groupId?: string): void => {
    if (!this.allowed()) return;
    const group = this.group(groupId), entry = group && this.runtime.get(ownerKey(group.groupId, paneId));
    if (entry) { entry.choices = updatePaneRunOptions(entry.choices, patch); this.publish(); }
  };
  promotionCallback = (paneId: string, groupId?: string): ((sessionId: string) => void) => {
    const group = this.group(groupId), expected = group?.tree.bindings[paneId];
    if (!group || !expected) return () => undefined;
    let callbacks = this.promotions.get(expected);
    if (!callbacks) { callbacks = new Map(); this.promotions.set(expected, callbacks); }
    const key = ownerKey(group.groupId, paneId), prior = callbacks.get(key);
    if (prior) return prior;
    const generation = this.generation;
    const callback = (sessionId: string) => {
      if (!this.allowed() || generation !== this.generation) return;
      const current = this.group(group.groupId); if (!current) return;
      const binding = { ...expected, sessionId };
      const existing = resolveSessionPlacement(this.snapshot.state, binding);
      if (existing && (existing.groupId !== group.groupId || existing.paneId !== paneId)) return;
      const tree = bindCreatedPaneSession(current.tree, paneId, expected, sessionId);
      this.commit(updatePaneGroup(this.snapshot.state, current.groupId, tree, this.now()), key);
    };
    callbacks.set(key, callback); return callback;
  };
  restoreStatus = (paneId: string, groupId?: string): PaneRestoreResult | null => {
    const identity = this.identity(paneId, groupId);
    return identity ? this.restores.get(paneBindingKey(identity)) ?? null : null;
  };
  retryRestore = (paneId?: string, groupId?: string): void => {
    if (!this.allowed()) return;
    if (paneId) {
      const identity = this.identity(paneId, groupId);
      if (identity) this.restores.delete(paneBindingKey(identity));
    } else this.restores.clear();
    this.publish(); this.restore();
  };
  /** No sessions-index input: a capped index cannot establish absence. */
  restore = (): void => {
    if (!this.allowed()) return;
    const groups = [...this.snapshot.state.groups].sort((a, b) => Number(b.groupId === this.snapshot.state.activeGroupId) - Number(a.groupId === this.snapshot.state.activeGroupId));
    for (const group of groups) for (const paneId of paneLeafIds(group.tree.root)) {
      if (this.requests.size >= 4) return;
      const identity = this.identity(paneId, group.groupId), binding = group.tree.bindings[paneId];
      if (!identity || binding.sessionId === null) continue;
      const key = paneBindingKey(identity);
      if (this.restores.has(key) || this.requests.has(key)) continue;
      const controller = new AbortController(), generation = this.generation;
      this.requests.set(key, controller);
      const probe = this.options.probeSession ?? probePaneSession;
      Promise.resolve().then(() => {
        if (!this.allowed() || controller.signal.aborted) return { kind: 'unknown', reason: 'aborted' } as PaneRestoreResult;
        return probe(binding, controller.signal);
      }).catch(() => ({ kind: 'unknown', reason: 'network' } as PaneRestoreResult)).then(result => {
        if (this.requests.get(key) === controller) this.requests.delete(key);
        const current = this.identity(paneId, group.groupId);
        if (!this.allowed() || controller.signal.aborted || generation !== this.generation || !current || paneBindingKey(current) !== key) return;
        this.restores.set(key, result); this.publish(); this.restore();
      });
    }
  };
}

export function usePaneWorkbench(options: PaneWorkbenchOptions) {
  const ref = useRef<PaneWorkbenchController | null>(null);
  if (!ref.current) ref.current = new PaneWorkbenchController(options);
  const controller = ref.current;
  controller.configure(options);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const width = useRef(0);
  const viewport = useRef({ value: false, listeners: new Set<() => void>() });
  const wide = useSyncExternalStore(listener => { viewport.current.listeners.add(listener); return () => viewport.current.listeners.delete(listener); },
    () => viewport.current.value, () => false);
  useEffect(() => {
    if (!options.enabled) { controller.stop(); return; }
    let storage: PaneWorkbenchStorage | null = null;
    storage = getWorkbenchStorage();
    controller.start(storage);
    const resize = () => {
      width.current = window.innerWidth;
      const value = paneLayoutViewportIsWide(width.current);
      if (value !== viewport.current.value) { viewport.current.value = value; viewport.current.listeners.forEach(listener => listener()); }
    };
    const changed = (event: StorageEvent) => {
      if (event.storageArea && event.storageArea !== storage) return;
      if (event.key === null || event.key === PANE_GROUP_STORAGE_KEY || event.key === PANE_LAYOUT_STORAGE_KEY) controller.reload();
    };
    resize(); window.addEventListener('resize', resize); window.addEventListener('storage', changed);
    return () => { controller.stop(); window.removeEventListener('resize', resize); window.removeEventListener('storage', changed); };
  }, [controller, options.enabled]);
  useEffect(() => { if (options.enabled) controller.restore(); }, [controller, options.enabled, snapshot.state]);
  const primaryKey = JSON.stringify(options.primaryBinding);
  useEffect(() => {
    if (options.enabled && controller.getSnapshot().storageStatus === 'pendingLegacy' && options.primaryBinding.sessionId !== null) controller.reload();
  }, [controller, options.enabled, primaryKey]);
  const state = options.enabled ? snapshot.state : initialPaneGroups();
  const activeGroup = options.enabled ? controller.activeGroup() : null;
  return { state, activeGroup, requiredPrimaryBinding: activeGroup?.tree.bindings.primary ?? null,
    geometry: activeGroup ? paneTreeGeometry(activeGroup.tree.root) : { leaves: [], splits: [] },
    wide: options.enabled && wide, storageStatus: snapshot.storageStatus,
    ensureGroup: controller.ensureGroup, selectPrimary: controller.selectPrimary, syncPrimary: controller.syncPrimary, openSession: controller.openSession,
    split: controller.split, close: controller.close, focus: controller.focus, resize: controller.resize,
    activateGroup: controller.activateGroup, closeGroup: controller.closeGroup, replaceBinding: controller.replaceBinding,
    identity: controller.identity, runOptions: controller.runOptions, updateRunOptions: controller.updateRunOptions,
    promotionCallback: controller.promotionCallback, restoreStatus: controller.restoreStatus, retryRestore: controller.retryRestore,
  };
}
