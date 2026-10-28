import { usePaneControlShortcuts } from './paneShortcutActions';
import React, { useEffect, useRef, useState } from 'react';
import { t as tr } from '../../i18n';
import type { RunChoices } from '../../xuenessBridge';
import { ConversationPane } from './secondaryConversationPane';
import type { PaneComposerProps } from './secondaryPaneComposer';
import { usePaneWorkbench } from './usePaneWorkbench';
import { paneScopeKey, PRIMARY_PANE_ID, clampPaneRatio, setTreeSplitRatio, type PaneScope, type PaneSide, type TreeBinding } from './paneTree';
import { resolveSessionPlacement, type PaneGroups } from './paneGroups';
import { paneBindingKey, paneScopeIdentity, type PaneIdentity } from './paneIdentity';
import { paneRestoreAllowsWrites } from './paneRestore';
import { paneTreeGeometry, type PaneSplitGeometry } from './paneGeometry';
import { PANE_SESSION_DRAG_MIME } from './paneLayout';
import { paneDropSide, readTreePaneDrop } from './paneDrop';
import { useScopedSessionCommands } from './scopedCommands';
import { PaneGroupSwitcher } from './PaneGroupSwitcher';
import type { RemoteSessionAdapter } from '../remote/remoteSessionAdapter';
import './pane-workbench.css';

const SIDES: readonly PaneSide[] = ['left', 'right', 'up', 'down'];
const LABELS: Record<PaneSide, string> = { left: '向左分屏', right: '向右分屏', up: '向上分屏', down: '向下分屏' };

export const paneLeafReactKey = (groupId: string | undefined, paneId: string): string => paneId === PRIMARY_PANE_ID ? PRIMARY_PANE_ID : JSON.stringify([groupId, paneId]);

/** A sidebar's bare ID is usable only with one explicit local namespace. */
export function sidebarPaneBinding(state: PaneGroups, sessions: readonly { id: string; root?: string }[], id: string): TreeBinding | null {
  const matches = sessions.filter(item => item.id === id);
  if (matches.length !== 1 || typeof matches[0].root !== 'string') return null;
  return state.groups.flatMap(item => Object.values(item.tree.bindings)).find(binding =>
    binding.sessionId === id && !binding.scope.remoteConnectionId && binding.scope.workspaceRoot === matches[0].root) ?? null;
}
export function pendingPrimarySelection(requested: string | null | undefined, actual: string | null, explicitSelection: boolean): boolean {
  return !explicitSelection && requested !== undefined && requested !== actual;
}

export type PaneSelectionHandler = (sessionId: string) => boolean;
type PaneSessionRow = { id: string; root?: string; title?: string; task?: string };
export type SessionPaneWorkbenchProps = {
  enabled: boolean; primaryBinding: TreeBinding; children: React.ReactNode;
  renderHeader?: (splitControls: React.ReactNode, groupSwitcher: React.ReactNode) => React.ReactNode;
  auxiliaryView?: React.ReactNode;
  initialRunOptions: Readonly<RunChoices>; filesEffective: boolean; settingsEffective: boolean;
  effectivePluginIds: ReadonlySet<string>; sendShortcut: 'enter' | 'mod-enter'; shortcutBindings: Record<string, string>;
  sessions: readonly PaneSessionRow[];
  /** Index records verified against the same owner returned by resolveRemoteAdapter. */
  remoteSessions?: readonly PaneSessionRow[];
  resolveRemoteSafetyStopAdapter?: (scope: PaneScope) => RemoteSessionAdapter | null | undefined;
  resolveRemoteAdapter?: (scope: PaneScope) => RemoteSessionAdapter | null | undefined;
  onFocusedIdentity?: (identity: PaneIdentity | null) => void;
  onSelectPrimary: (sessionId: string | null) => void;
  registerSelection: (handler: PaneSelectionHandler | null) => void;
  consumeSelectionIntent: () => boolean;
  registerCreation: (handler: ((sessionId: string) => void) | null) => void;
  onCreateSession?: PaneComposerProps['onCreateSession'];
  onConfigureModels?: PaneComposerProps['onConfigureModels'];
  hydrateEmptyPrimaryDraftScope?: boolean;
};

function SplitDivider({ split, bounds, onResize, onPreview }: {
  split: PaneSplitGeometry; bounds: React.RefObject<HTMLDivElement | null>; onResize: (ratio: number) => void; onPreview: (ratio: number | null) => void;
}) {
  const drag = useRef<{ id: number; ratio: number } | null>(null);
  const row = split.direction === 'row';
  const style: React.CSSProperties = row
    ? { left: `${(split.x + split.width * split.ratio) * 100}%`, top: `${split.y * 100}%`, height: `${split.height * 100}%` }
    : { top: `${(split.y + split.height * split.ratio) * 100}%`, left: `${split.x * 100}%`, width: `${split.width * 100}%` };
  const move = (event: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== event.pointerId) return;
    const rect = bounds.current?.getBoundingClientRect();
    if (!rect || !(row ? rect.width : rect.height)) return;
    const position = row ? (event.clientX - rect.left) / rect.width : (event.clientY - rect.top) / rect.height;
    onPreview(clampPaneRatio((position - (row ? split.x : split.y)) / (row ? split.width : split.height)));
  };
  const cancel = (event: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== event.pointerId) return;
    drag.current = null; onPreview(null);
  };
  return <div role="separator" tabIndex={0} className="xn-workbench-divider" data-direction={split.direction} style={style}
    aria-label={tr('调整分屏尺寸')} aria-orientation={row ? 'vertical' : 'horizontal'} aria-valuemin={25} aria-valuemax={75} aria-valuenow={Math.round(split.ratio * 100)}
    onPointerDown={event => { if (event.button !== 0) return; event.preventDefault();
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { return; }
      drag.current = { id: event.pointerId, ratio: split.ratio }; }}
    onPointerMove={move} onPointerUp={event => { if (drag.current?.id !== event.pointerId) return; onResize(split.ratio); onPreview(null); drag.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
    onPointerCancel={cancel} onLostPointerCapture={cancel}
    onKeyDown={event => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const value = event.key === 'Home' ? .25 : event.key === 'End' ? .75
        : event.key === (row ? 'ArrowLeft' : 'ArrowUp') ? split.ratio - .05
          : event.key === (row ? 'ArrowRight' : 'ArrowDown') ? split.ratio + .05 : null;
      if (value !== null) { event.preventDefault(); onResize(clampPaneRatio(value)); }
    }} />;
}

/** Flat, keyed leaf siblings preserve composer/scroll ownership across tree edits. */
export function SessionPaneWorkbench(props: SessionPaneWorkbenchProps) {
  const controller = usePaneWorkbench({ enabled: props.enabled, primaryBinding: props.primaryBinding, initialRunOptions: props.initialRunOptions });
  const current = useRef({ props, controller }); current.current = { props, controller };
  const bounds = useRef<HTMLDivElement>(null);
  const requestedPrimary = useRef<string | null | undefined>(undefined);
  const selectionInitialized = useRef(false);
  const lastPrimaryBinding = useRef<string | null>(null);
  const [resizePreview, setResizePreview] = useState<{ groupId: string; splitId: string; ratio: number } | null>(null);
  const [drop, setDrop] = useState<{ paneId: string; side: PaneSide } | null>(null);
  const group = controller.activeGroup;
  const tree = group?.tree;
  const previewTree = tree && resizePreview?.groupId === group?.groupId ? setTreeSplitRatio(tree, resizePreview.splitId, resizePreview.ratio) : tree;
  const geometry = previewTree ? paneTreeGeometry(previewTree.root) : { leaves: [{ paneId: PRIMARY_PANE_ID, x: 0, y: 0, width: 1, height: 1 }], splits: [] };
  const focused = tree?.focus ?? PRIMARY_PANE_ID;
  const candidateFocusedIdentity = props.enabled ? controller.identity(focused) : null;
  const focusedIdentity = candidateFocusedIdentity?.paneId === PRIMARY_PANE_ID &&
    (candidateFocusedIdentity.sessionId !== props.primaryBinding.sessionId || paneScopeIdentity(candidateFocusedIdentity.scope) !== paneScopeIdentity(props.primaryBinding.scope))
    ? null : candidateFocusedIdentity;
  const focusedIdentityKey = focusedIdentity ? paneBindingKey(focusedIdentity) : '';
  useEffect(() => { props.onFocusedIdentity?.(focusedIdentity); }, [focusedIdentityKey, props.onFocusedIdentity]);
  usePaneControlShortcuts({ enabled: props.enabled && !props.auxiliaryView && props.settingsEffective, root: bounds, focusedPaneId: focused, bindings: props.shortcutBindings });
  const adapterForScope = (scope: PaneScope) => {
    const adapter = scope.remoteConnectionId ? props.resolveRemoteAdapter?.(scope) : undefined;
    return adapter?.isCurrent() ? adapter : undefined;
  };
  const sessionsForScope = (scope: PaneScope): readonly PaneSessionRow[] => scope.remoteConnectionId
    ? adapterForScope(scope) ? props.remoteSessions ?? [] : [] : props.sessions;
  const focus = (paneId: string, moveFocus = false) => {
    controller.focus(paneId);
    if (moveFocus) bounds.current?.querySelector<HTMLElement>(`[data-pane-id="${paneId}"]`)?.focus();
  };
  const selectRequiredPrimary = (binding: TreeBinding | null) => {
    if (binding && !binding.scope.remoteConnectionId && binding.sessionId !== props.primaryBinding.sessionId) { requestedPrimary.current = binding.sessionId; props.onSelectPrimary(binding.sessionId); }
  };
  const primaryPromotion = controller.promotionCallback(PRIMARY_PANE_ID);
  const remotePrimary = !!(controller.requiredPrimaryBinding ?? props.primaryBinding).scope.remoteConnectionId;
  useEffect(() => {
    if (!props.enabled || remotePrimary) { props.registerCreation(null); return; }
    props.registerCreation(primaryPromotion);
    return () => props.registerCreation(null);
  }, [props.enabled, props.registerCreation, primaryPromotion, remotePrimary]);
  const bindingKey = JSON.stringify(props.primaryBinding);
  useEffect(() => {
    if (!props.enabled || !group) return;
    const { props: latest, controller: model } = current.current;
    if (!selectionInitialized.current) {
      selectionInitialized.current = true;
      lastPrimaryBinding.current = bindingKey;
      const required = latest.consumeSelectionIntent() ? model.ensureGroup(latest.primaryBinding) : model.requiredPrimaryBinding;
      if (required && !required.scope.remoteConnectionId && required.sessionId !== latest.primaryBinding.sessionId) {
        requestedPrimary.current = required.sessionId; latest.onSelectPrimary(required.sessionId);
      } else if (required && latest.hydrateEmptyPrimaryDraftScope) {
        model.syncPrimary(latest.primaryBinding, false, true);
      }
      return;
    }
    const explicitSelection = latest.consumeSelectionIntent();
    if (pendingPrimarySelection(requestedPrimary.current, latest.primaryBinding.sessionId, explicitSelection)) return;
    if (requestedPrimary.current !== undefined && !explicitSelection) {
      requestedPrimary.current = undefined; lastPrimaryBinding.current = bindingKey;
      return;
    }
    requestedPrimary.current = undefined;
    if (lastPrimaryBinding.current === bindingKey) return;
    lastPrimaryBinding.current = bindingKey;
    const binding = model.syncPrimary(latest.primaryBinding, explicitSelection, latest.hydrateEmptyPrimaryDraftScope);
    if (binding && !binding.scope.remoteConnectionId && binding.sessionId !== latest.primaryBinding.sessionId) {
      requestedPrimary.current = binding.sessionId; latest.onSelectPrimary(binding.sessionId);
    }
  }, [bindingKey, props.enabled, props.hydrateEmptyPrimaryDraftScope, group?.groupId]);
  useEffect(() => {
    if (!props.enabled) return;
    props.registerSelection(id => {
      const { props: latest, controller: model } = current.current;
      if (!latest.enabled) return false;
      requestedPrimary.current = undefined;
      // Never identify a pane by bare session ID across workspace/remote namespaces.
      const known = sidebarPaneBinding(model.state, latest.sessions, id);
      if (!known || !resolveSessionPlacement(model.state, known)) return false;
      const primary = model.ensureGroup(known);
      if (primary && !primary.scope.remoteConnectionId && primary.sessionId !== latest.primaryBinding.sessionId) { requestedPrimary.current = primary.sessionId; latest.onSelectPrimary(primary.sessionId); }
      return true;
    });
    return () => props.registerSelection(null);
  }, [props.enabled, props.registerSelection]);
  useScopedSessionCommands({ sessionsEffective: props.enabled, settingsEffective: props.settingsEffective,
    bindings: props.shortcutBindings, paneWide: controller.wide,
    sessionIds: sessionsForScope(tree?.bindings[focused]?.scope ?? props.primaryBinding.scope)
      .filter(item => tree?.bindings[focused]?.scope.remoteConnectionId || !item.root || item.root === tree?.bindings[focused]?.scope.workspaceRoot).map(item => item.id),
    activeSessionId: tree?.bindings[focused]?.sessionId ?? null,
    onSelectSession: (id, paneId) => {
      const scope = tree?.bindings[paneId ?? focused]?.scope ?? props.primaryBinding.scope;
      const binding: TreeBinding = { sessionId: id, scope };
      if (scope.remoteConnectionId) {
        if (adapterForScope(scope)) controller.replaceBinding(paneId ?? focused, binding);
        return;
      }
      if (paneId && paneId !== PRIMARY_PANE_ID) selectRequiredPrimary(controller.replaceBinding(paneId, binding));
      else selectRequiredPrimary(controller.ensureGroup(binding));
    }, paneWorkbench: { scopeKey: tree ? paneScopeKey(tree.bindings[focused].scope) : '', paneIds: geometry.leaves.map(item => item.paneId), focusedPaneId: focused,
      onSplit: (side, paneId) => { controller.focus(paneId); controller.split(side); }, onFocus: id => focus(id, true), onClose: id => controller.close(id) } });
  if (!props.enabled) return props.primaryBinding.scope.remoteConnectionId
    ? <p role="status">{tr('远程分屏需要独立连接，当前未连接。')}</p> : props.children;
  const title = (paneId: string) => {
    const binding = tree?.bindings[paneId] ?? props.primaryBinding;
    const session = sessionsForScope(binding.scope).find(item => item.id === binding.sessionId);
    return session?.title || session?.task || (binding.sessionId ?? tr('新会话'));
  };
  const splitControls = <details className="xn-session-header__splits" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) event.currentTarget.open = false; }}
      onKeyDown={event => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); } }}>
      <summary>{tr('分屏')} <span aria-hidden="true">⌄</span></summary><div>{SIDES.map(side => <button type="button" key={side} title={tr(LABELS[side])} aria-label={tr(LABELS[side])}
        disabled={!controller.wide || geometry.leaves.length >= 4} onClick={event => { event.currentTarget.closest('details')!.open = false; controller.focus(focused); controller.split(side); }}>{tr(LABELS[side])}</button>)}</div></details>;
  const groupSwitcher = <PaneGroupSwitcher value={group?.groupId} groups={controller.state.groups.map((item, index) => ({ id: item.groupId,
    title: sessionsForScope(item.tree.bindings.primary.scope).find(session => session.id === item.tree.bindings.primary.sessionId)?.title || `${tr('分屏组')} ${index + 1}`,
    panes: paneTreeGeometry(item.tree.root).leaves.length }))}
    onSelect={id => selectRequiredPrimary(controller.activateGroup(id))} onClose={id => selectRequiredPrimary(controller.closeGroup(id))} />;
  return <div className="xn-pane-workbench" aria-label={tr('会话工作区')} data-testid="xn-pane-workbench">
    {props.renderHeader?.(splitControls, groupSwitcher) ?? <header className="xn-pane-workbench__fallback-header"><span>{title(PRIMARY_PANE_ID)}</span>{groupSwitcher}{splitControls}</header>}
    {['invalid', 'pendingLegacy', 'unavailable'].includes(controller.storageStatus) && <p role="status" className="xn-pane-workbench__notice">{tr(controller.storageStatus === 'unavailable' ? '分屏布局未能保存' : '原有分屏记录已保留，当前布局仅在此窗口有效。')}</p>}
    {!props.auxiliaryView && !controller.wide && geometry.leaves.length > 1 && <div className="xn-pane-workbench__tabs" role="toolbar" aria-label={tr('显示此分屏')}>
      {geometry.leaves.map(leaf => <button type="button" key={leaf.paneId} aria-pressed={focused === leaf.paneId} onClick={() => focus(leaf.paneId)}>{title(leaf.paneId)}</button>)}
    </div>}
    {props.auxiliaryView && <div className="xn-pane-workbench__view xn-secondary-view__body">{props.auxiliaryView}</div>}
    <div className="xn-pane-workbench__canvas" ref={bounds} hidden={!!props.auxiliaryView}>
      {geometry.leaves.map(leaf => {
        const primary = leaf.paneId === PRIMARY_PANE_ID;
        const identity = controller.identity(leaf.paneId);
        const binding = tree?.bindings[leaf.paneId] ?? props.primaryBinding;
        const remote = !!binding.scope.remoteConnectionId;
        const connectedAdapter = adapterForScope(binding.scope);
        const safetyAdapter = remote ? props.resolveRemoteSafetyStopAdapter?.(binding.scope) : undefined;
        const remoteAdapter = connectedAdapter ?? (safetyAdapter?.isSafetyStopAvailable() ? safetyAdapter : undefined);
        const remoteSessions = remote ? sessionsForScope(binding.scope) : [];
        const visible = controller.wide || focused === leaf.paneId;
        const restore = controller.restoreStatus(leaf.paneId);
        const primaryScopeMismatch = primary && tree && paneScopeIdentity(tree.bindings.primary.scope) !== paneScopeIdentity(props.primaryBinding.scope);
        const style: React.CSSProperties = controller.wide ? { left: `${leaf.x * 100}%`, top: `${leaf.y * 100}%`, width: `${leaf.width * 100}%`, height: `${leaf.height * 100}%` } : { inset: 0 };
        return <section key={paneLeafReactKey(group?.groupId, leaf.paneId)} className="xn-workbench-leaf" style={style}
          hidden={!visible} tabIndex={-1} data-pane-id={leaf.paneId} data-pane-session-id={tree?.bindings[leaf.paneId]?.sessionId ?? undefined} data-pane-focused={focused === leaf.paneId ? 'true' : 'false'}
          data-drop-side={drop?.paneId === leaf.paneId ? drop.side : undefined} aria-label={primary ? tr('主会话') : title(leaf.paneId)}
          onFocusCapture={() => focus(leaf.paneId)} onPointerDownCapture={() => focus(leaf.paneId)}
          onDragOver={event => {
            if (!controller.wide || !Array.from(event.dataTransfer.types).includes(PANE_SESSION_DRAG_MIME)) return;
            event.preventDefault(); event.dataTransfer.dropEffect = 'copy';
            const rect = event.currentTarget.getBoundingClientRect();
            setDrop({paneId:leaf.paneId,side:paneDropSide((event.clientX-rect.left)/rect.width,(event.clientY-rect.top)/rect.height)});
          }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDrop(null); }}
          onDrop={event => {
            event.preventDefault(); if (!controller.wide) { setDrop(null); return; } const binding = readTreePaneDrop(event.dataTransfer); const rect = event.currentTarget.getBoundingClientRect();
            const side = paneDropSide((event.clientX-rect.left)/rect.width,(event.clientY-rect.top)/rect.height); setDrop(null);
            if (binding) selectRequiredPrimary(controller.openSession(binding, side, leaf.paneId));
          }}>
          {geometry.leaves.length > 1 && <div className="xn-workbench-leaf__toolbar">
            <span title={title(leaf.paneId)}>{title(leaf.paneId)}</span>
            {remote && <select aria-label={tr('选择远程会话')} value={binding.sessionId ?? ''} disabled={!connectedAdapter || !identity}
              onChange={event => {
                const sessionId = event.currentTarget.value;
                if (remoteAdapter?.isCurrent() && remoteSessions.some(item => item.id === sessionId)) {
                  controller.replaceBinding(leaf.paneId, { scope: binding.scope, sessionId });
                }
              }}>
              <option value="" disabled>{tr('选择远程会话')}</option>
              {binding.sessionId && !remoteSessions.some(item => item.id === binding.sessionId) && <option value={binding.sessionId}>{binding.sessionId}</option>}
              {remoteSessions.map(item => <option key={item.id} value={item.id}>{item.title || item.task || item.id}</option>)}
            </select>}
            {remoteAdapter?.indexTruncated && <span role="status">{tr('仅显示最近 1000 个远程会话，已保存的分屏会话仍会保留。')}</span>}
            {SIDES.map(side => <button type="button" key={side} title={tr(LABELS[side])} aria-label={tr(LABELS[side])}
              disabled={!controller.wide || geometry.leaves.length >= 4} onClick={() => { controller.focus(leaf.paneId); controller.split(side); }}>{ {left:'←',right:'→',up:'↑',down:'↓'}[side] }</button>)}
            {!primary && <button type="button" aria-label={tr('关闭分屏')} onClick={() => controller.close(leaf.paneId)}>×</button>}
          </div>}
          <div className="xn-workbench-leaf__content">
            {!primary && restore?.kind === 'unknown' && restore.reason !== 'remote-route-required' && <p role="status">{tr('会话连接尚未确认')} <button type="button" onClick={() => controller.retryRestore(leaf.paneId)}>{tr('重试连接')}</button></p>}
            {!primary && restore?.kind === 'absent' && <p role="status">{tr('此会话已不可用，分屏草稿仍保留。')}</p>}
            {primary && !remote ? (primaryScopeMismatch || (restore?.kind === 'unknown' && restore.reason === 'scope-mismatch') ? <p role="status">{tr('会话连接尚未确认')}</p> : props.children)
            : remote && !remoteAdapter ? <p role="status">{tr('远程分屏需要独立连接，当前未连接。')}</p> : identity && <ConversationPane identity={identity}
            choices={controller.runOptions(leaf.paneId)} onChoicesChange={choices => controller.updateRunOptions(leaf.paneId, choices)}
            enabled={props.enabled && !props.auxiliaryView && visible && (remote ? !!connectedAdapter : paneRestoreAllowsWrites(identity.sessionId, restore))}
            remoteAdapter={remoteAdapter} safetyStopEnabled={props.enabled && visible && props.effectivePluginIds.has('sessions') && props.effectivePluginIds.has('remote')} filesEffective={props.filesEffective} effectivePluginIds={props.effectivePluginIds}
            draftAlias={tree?.bindings[leaf.paneId]?.draftAlias} sendShortcut={props.sendShortcut} shortcutBindings={props.shortcutBindings}
            onForkSession={id => { const current = controller.identity(leaf.paneId, identity.groupId); if (current?.bindingRevision === identity.bindingRevision && current.sessionId === identity.sessionId) controller.replaceBinding(leaf.paneId, { scope: identity.scope, sessionId: id }, identity.groupId); }}
            onCreateSession={props.onCreateSession} onConfigureModels={props.onConfigureModels} onSessionPromoted={controller.promotionCallback(leaf.paneId)} />}</div>
        </section>;
      })}
      {controller.wide && geometry.splits.map(split => <SplitDivider key={split.splitId} split={split} bounds={bounds} onResize={ratio => controller.resize(split.splitId, ratio)}
        onPreview={ratio => setResizePreview(ratio === null || !group ? null : {groupId:group.groupId,splitId:split.splitId,ratio})} />)}
    </div>
  </div>;
}
