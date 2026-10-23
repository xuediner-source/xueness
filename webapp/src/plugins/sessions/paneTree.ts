/** Original, side-effect-free sessions.pane_layout model. Callers own IDs and effects. */
export const PRIMARY_PANE_ID = 'primary';
export const MAX_PANE_LEAVES = 4;
export const MAX_PANE_DEPTH = 3;
export type PaneScope = { readonly workspaceRoot: string; readonly workspaceIdentity?: string; readonly remoteConnectionId?: string };
export type PaneDraftAlias = { readonly workspaceKey: string; readonly draftKey: string };
export type TreeBinding = { readonly scope: PaneScope; readonly sessionId: string | null; readonly draftAlias?: PaneDraftAlias };
export type PaneNode = { readonly type: 'leaf'; readonly paneId: string } | {
  readonly type: 'split'; readonly splitId: string; readonly direction: 'row' | 'column'; readonly ratio: number;
  readonly first: PaneNode; readonly second: PaneNode;
};
export type PaneTree = { readonly root: PaneNode; readonly bindings: Readonly<Record<string, TreeBinding>>; readonly focus: string };
export type PaneSide = 'left' | 'right' | 'up' | 'down';
export const validPaneId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
export const validPaneText = (value: unknown, max = 512): value is string => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
export function validTreeBinding(value: TreeBinding): boolean {
  return !!value && !!value.scope && validPaneText(value.scope.workspaceRoot)
    && (value.scope.workspaceIdentity === undefined || (validPaneText(value.scope.workspaceIdentity) && !!value.scope.workspaceIdentity.trim()))
    && (value.scope.remoteConnectionId === undefined || validPaneId(value.scope.remoteConnectionId))
    && (value.sessionId === null || validPaneId(value.sessionId))
    && (value.draftAlias === undefined || (!!value.draftAlias && validPaneText(value.draftAlias.workspaceKey) && validPaneText(value.draftAlias.draftKey, 256) && !!value.draftAlias.draftKey));
}
export const paneScopeKey = (scope: PaneScope): string => scope.workspaceIdentity?.trim() || scope.workspaceRoot;
/** Tuple encoding avoids delimiter collisions; connection handles are routing metadata. */
export const paneSessionKey = (scope: PaneScope, sessionId: string): string => JSON.stringify([paneScopeKey(scope), sessionId]);
export const clampPaneRatio = (ratio: number): number => Number.isFinite(ratio) ? Math.max(.25, Math.min(.75, ratio)) : .5;
export function paneLeafIds(node: PaneNode): string[] { return node.type === 'leaf' ? [node.paneId] : [...paneLeafIds(node.first), ...paneLeafIds(node.second)]; }
export function paneNodeIds(node: PaneNode): string[] { return node.type === 'leaf' ? [node.paneId] : [node.splitId, ...paneNodeIds(node.first), ...paneNodeIds(node.second)]; }
export function initialPaneTree(binding: TreeBinding): PaneTree {
  if (!validTreeBinding(binding)) throw new TypeError('Invalid primary binding');
  return { root: { type: 'leaf', paneId: PRIMARY_PANE_ID }, bindings: { [PRIMARY_PANE_ID]: binding }, focus: PRIMARY_PANE_ID };
}
function mapNode(node: PaneNode, transform: (node: PaneNode) => PaneNode): PaneNode {
  const changed = transform(node);
  if (changed !== node || node.type === 'leaf') return changed;
  const first = mapNode(node.first, transform), second = mapNode(node.second, transform);
  return first === node.first && second === node.second ? node : { ...node, first, second };
}
export function focusTreePane(tree: PaneTree, paneId: string): PaneTree {
  return tree.focus === paneId || !paneLeafIds(tree.root).includes(paneId) ? tree : { ...tree, focus: paneId };
}
export function findTreeSession(tree: PaneTree, binding: TreeBinding): string | null {
  if (binding.sessionId === null) return null;
  const key = paneSessionKey(binding.scope, binding.sessionId);
  return paneLeafIds(tree.root).find(id => {
    const candidate = tree.bindings[id];
    return candidate?.sessionId != null && paneSessionKey(candidate.scope, candidate.sessionId) === key;
  }) ?? null;
}
export function splitTreePane(tree: PaneTree, anchor: string, side: PaneSide, binding: TreeBinding, paneId: string, splitId: string): PaneTree {
  if (!validTreeBinding(binding)) return tree;
  const existing = findTreeSession(tree, binding);
  if (existing) return focusTreePane(tree, existing);
  const ids = paneNodeIds(tree.root), leaves = paneLeafIds(tree.root);
  if (!['left', 'right', 'up', 'down'].includes(side) || !leaves.includes(anchor) || leaves.length >= MAX_PANE_LEAVES
    || !validPaneId(paneId) || !validPaneId(splitId) || paneId === splitId || ids.includes(paneId) || ids.includes(splitId)) return tree;
  const newLeaf: PaneNode = { type: 'leaf', paneId };
  const before = side === 'left' || side === 'up';
  const root = mapNode(tree.root, node => node.type === 'leaf' && node.paneId === anchor ? {
    type: 'split', splitId, direction: side === 'left' || side === 'right' ? 'row' : 'column', ratio: .5,
    first: before ? newLeaf : node, second: before ? node : newLeaf,
  } : node);
  return { root, bindings: { ...tree.bindings, [paneId]: binding }, focus: paneId };
}
export function closeTreePane(tree: PaneTree, paneId: string): PaneTree {
  if (paneId === PRIMARY_PANE_ID || !paneLeafIds(tree.root).includes(paneId)) return tree;
  const root = mapNode(tree.root, node => {
    if (node.type === 'leaf') return node;
    if (node.first.type === 'leaf' && node.first.paneId === paneId) return node.second;
    if (node.second.type === 'leaf' && node.second.paneId === paneId) return node.first;
    return node;
  });
  const bindings = { ...tree.bindings }; delete bindings[paneId];
  return { root, bindings, focus: tree.focus === paneId ? PRIMARY_PANE_ID : tree.focus };
}
export function replaceTreeBinding(tree: PaneTree, paneId: string, binding: TreeBinding): PaneTree {
  if (!paneLeafIds(tree.root).includes(paneId) || !validTreeBinding(binding)) return tree;
  const existing = findTreeSession(tree, binding);
  if (existing && existing !== paneId) return focusTreePane(tree, existing);
  // No draft-store move or re-key: an alias is retained only by the same owner.
  if (tree.bindings[paneId] === binding) return focusTreePane(tree, paneId);
  return { ...tree, bindings: { ...tree.bindings, [paneId]: binding }, focus: paneId };
}
/** Compare expected binding by reference to reject stale createSession completions. */
export function bindCreatedPaneSession(tree: PaneTree, paneId: string, expected: TreeBinding, sessionId: string): PaneTree {
  if (tree.bindings[paneId] !== expected || expected.sessionId !== null || !validPaneId(sessionId)) return tree;
  const binding = { ...expected, sessionId };
  if (findTreeSession(tree, binding)) return tree;
  return { ...tree, bindings: { ...tree.bindings, [paneId]: binding } };
}
export function setTreeSplitRatio(tree: PaneTree, splitId: string, ratio: number): PaneTree {
  const value = clampPaneRatio(ratio);
  const root = mapNode(tree.root, node => node.type === 'split' && node.splitId === splitId && node.ratio !== value ? { ...node, ratio: value } : node);
  return root === tree.root ? tree : { ...tree, root };
}
