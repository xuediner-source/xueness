import { findTreeSession, focusTreePane, initialPaneTree, splitTreePane, validPaneId, validTreeBinding, type PaneSide, type PaneTree, type TreeBinding } from './paneTree';
export const MAX_PANE_GROUPS = 32;
export type PaneGroup = { readonly groupId: string; readonly tree: PaneTree; readonly updatedAt: number };
export type PaneGroups = { readonly v: 2; readonly groups: readonly PaneGroup[]; readonly activeGroupId: string | null };
export type PanePlacement = { readonly groupId: string; readonly paneId: string };
export const initialPaneGroups = (): PaneGroups => ({ v: 2, groups: [], activeGroupId: null });
export const validGroupTime = (time: number): boolean => Number.isSafeInteger(time) && time >= 0;
export function resolveSessionPlacement(state: PaneGroups, binding: TreeBinding): PanePlacement | null {
  // Prefer the active group if legacy state has the same session in several groups.
  const ordered = [...state.groups].sort((a, b) => Number(b.groupId === state.activeGroupId) - Number(a.groupId === state.activeGroupId));
  for (const group of ordered) {
    const paneId = findTreeSession(group.tree, binding);
    if (paneId) return { groupId: group.groupId, paneId };
  }
  return null;
}
export function updatePaneGroup(state: PaneGroups, groupId: string, tree: PaneTree, now: number): PaneGroups {
  const group = state.groups.find(item => item.groupId === groupId);
  if (!group || group.tree === tree || !validGroupTime(now)) return state;
  return { ...state, groups: state.groups.map(item => item === group ? { ...item, tree, updatedAt: Math.max(now, item.updatedAt) } : item) };
}
export function focusGroupPane(state: PaneGroups, placement: PanePlacement, now: number): PaneGroups {
  const group = state.groups.find(item => item.groupId === placement.groupId);
  if (!group || !Object.hasOwn(group.tree.bindings, placement.paneId) || !validGroupTime(now)) return state;
  const changed = updatePaneGroup(state, group.groupId, focusTreePane(group.tree, placement.paneId), now);
  return changed.activeGroupId === group.groupId ? changed : { ...changed, activeGroupId: group.groupId };
}
export function addPaneGroup(state: PaneGroups, groupId: string, binding: TreeBinding, now: number): PaneGroups {
  if (!validTreeBinding(binding) || !validGroupTime(now)) return state;
  const existing = resolveSessionPlacement(state, binding);
  if (existing) return focusGroupPane(state, existing, now);
  if (!validPaneId(groupId) || state.groups.some(group => group.groupId === groupId) || state.groups.length >= MAX_PANE_GROUPS) return state;
  return { ...state, groups: [...state.groups, { groupId, tree: initialPaneTree(binding), updatedAt: now }], activeGroupId: groupId };
}
export function removePaneGroup(state: PaneGroups, groupId: string): PaneGroups {
  if (!state.groups.some(group => group.groupId === groupId)) return state;
  const groups = state.groups.filter(group => group.groupId !== groupId);
  return { ...state, groups, activeGroupId: state.activeGroupId === groupId ? groups[groups.length - 1]?.groupId ?? null : state.activeGroupId };
}
/** Resolve existing ownership before capacity checks. Never move a draft between groups. */
export function openGroupSession(state: PaneGroups, groupId: string, anchor: string, side: PaneSide, binding: TreeBinding, paneId: string, splitId: string, now: number): PaneGroups {
  if (!validTreeBinding(binding) || !validGroupTime(now)) return state;
  const existing = resolveSessionPlacement(state, binding);
  if (existing) return focusGroupPane(state, existing, now);
  const group = state.groups.find(item => item.groupId === groupId);
  if (!group) return state;
  const tree = splitTreePane(group.tree, anchor, side, binding, paneId, splitId);
  if (tree === group.tree) return state;
  return { ...updatePaneGroup(state, groupId, tree, now), activeGroupId: groupId };
}
