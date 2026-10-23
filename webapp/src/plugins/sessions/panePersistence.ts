import { MAX_PANE_DEPTH, MAX_PANE_LEAVES, PRIMARY_PANE_ID, clampPaneRatio, initialPaneTree, paneSessionKey, splitTreePane, validPaneId, validTreeBinding, type PaneNode, type PaneTree, type TreeBinding } from './paneTree';
import { MAX_PANE_GROUPS, validGroupTime, type PaneGroup, type PaneGroups } from './paneGroups';
export const PANE_GROUP_STORAGE_KEY = 'xueness.sessions.pane-layout.v2';
export const MAX_PANE_PAYLOAD = 131072;
export type PaneDecodeResult = { readonly kind: 'ok'; readonly state: PaneGroups; readonly migrated: boolean }
  | { readonly kind: 'empty' }
  | { readonly kind: 'invalid'; readonly raw: string; readonly reason: string }
  | { readonly kind: 'pendingLegacy'; readonly raw: string; readonly legacy: LegacyPaneLayout };
export type LegacyPaneLayout = { readonly v: 1; readonly split: 'row' | 'column' | null; readonly focus: 'primary' | 'secondary'; readonly ratio: number; readonly secondary: { readonly sessionId: string; readonly workspaceRoot: string } | null };
export type LegacyMigrationContext = { readonly primaryBinding: TreeBinding; readonly groupId: string; readonly updatedAt: number };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function cleanBinding(value: unknown): TreeBinding | null {
  if (!record(value) || !record(value.scope)) return null;
  const scope = value.scope;
  const candidate = { scope: { workspaceRoot: scope.workspaceRoot, ...(scope.workspaceIdentity === undefined ? {} : { workspaceIdentity: scope.workspaceIdentity }), ...(scope.remoteConnectionId === undefined ? {} : { remoteConnectionId: scope.remoteConnectionId }) }, sessionId: value.sessionId,
    ...(value.draftAlias === undefined ? {} : { draftAlias: record(value.draftAlias) ? { workspaceKey: value.draftAlias.workspaceKey, draftKey: value.draftAlias.draftKey } : null }) } as TreeBinding;
  return validTreeBinding(candidate) ? candidate : null;
}
function cleanTree(value: unknown): PaneTree | null {
  if (!record(value) || !record(value.bindings) || typeof value.focus !== 'string') return null;
  const ids = new Set<string>(), leaves: string[] = [];
  const node = (raw: unknown, depth: number): PaneNode | null => {
    if (!record(raw) || depth > MAX_PANE_DEPTH) return null;
    const id = raw.type === 'leaf' ? raw.paneId : raw.splitId;
    if (!validPaneId(id) || ids.has(id)) return null;
    ids.add(id);
    if (ids.size > MAX_PANE_LEAVES * 2 - 1) return null;
    if (raw.type === 'leaf') { leaves.push(id); return { type: 'leaf', paneId: id }; }
    if (raw.type !== 'split' || !['row', 'column'].includes(String(raw.direction)) || typeof raw.ratio !== 'number' || !Number.isFinite(raw.ratio)) return null;
    const first = node(raw.first, depth + 1), second = node(raw.second, depth + 1);
    return first && second ? { type: 'split', splitId: id, direction: raw.direction as 'row' | 'column', ratio: clampPaneRatio(raw.ratio), first, second } : null;
  };
  const root = node(value.root, 0);
  if (!root || leaves.length > MAX_PANE_LEAVES || !leaves.includes(PRIMARY_PANE_ID) || !leaves.includes(value.focus) || Object.keys(value.bindings).length !== leaves.length) return null;
  const bindings: Record<string, TreeBinding> = {}, sessions = new Set<string>();
  for (const id of leaves) {
    if (!Object.hasOwn(value.bindings, id)) return null;
    const binding = cleanBinding(value.bindings[id]);
    if (!binding) return null;
    if (binding.sessionId !== null) {
      const key = paneSessionKey(binding.scope, binding.sessionId);
      if (sessions.has(key)) return null;
      sessions.add(key);
    }
    bindings[id] = binding;
  }
  return { root, bindings, focus: value.focus };
}
function cleanV2(value: unknown): PaneGroups | null {
  if (!record(value) || value.v !== 2 || !Array.isArray(value.groups) || value.groups.length > MAX_PANE_GROUPS) return null;
  const groups: PaneGroup[] = [], ids = new Set<string>();
  for (const raw of value.groups) {
    if (!record(raw) || !validPaneId(raw.groupId) || ids.has(raw.groupId) || typeof raw.updatedAt !== 'number' || !validGroupTime(raw.updatedAt)) return null;
    const tree = cleanTree(raw.tree); if (!tree) return null;
    groups.push({ groupId: raw.groupId, tree, updatedAt: raw.updatedAt }); ids.add(raw.groupId);
  }
  if (value.activeGroupId !== null && (typeof value.activeGroupId !== 'string' || !ids.has(value.activeGroupId))) return null;
  return { v: 2, groups, activeGroupId: value.activeGroupId as string | null };
}
function cleanLegacy(value: Record<string, unknown>): LegacyPaneLayout | null {
  if (value.v !== 1 || ![null, 'row', 'column'].includes(value.split as null) || !['primary', 'secondary'].includes(String(value.focus)) || typeof value.ratio !== 'number' || !Number.isFinite(value.ratio)) return null;
  let secondary: LegacyPaneLayout['secondary'] = null;
  if (value.secondary !== null) {
    if (!record(value.secondary)) return null;
    const candidate = cleanBinding({ scope: { workspaceRoot: value.secondary.workspaceRoot }, sessionId: value.secondary.sessionId });
    if (!candidate || candidate.sessionId === null) return null;
    secondary = { workspaceRoot: candidate.scope.workspaceRoot, sessionId: candidate.sessionId };
  }
  if (!value.split && (secondary || value.focus === 'secondary')) return null;
  return { v: 1, split: value.split as LegacyPaneLayout['split'], focus: value.focus as LegacyPaneLayout['focus'], ratio: clampPaneRatio(value.ratio), secondary };
}
/** Invalid/deferred outcomes carry original bytes: callers must not overwrite storage. */
export function decodePaneGroups(raw: string | null, context?: LegacyMigrationContext): PaneDecodeResult {
  if (raw === null) return { kind: 'empty' };
  const invalid = (reason: string): PaneDecodeResult => ({ kind: 'invalid', raw, reason });
  if (!raw || raw.length > MAX_PANE_PAYLOAD) return invalid('payload-size');
  let parsed: unknown; try { parsed = JSON.parse(raw); } catch { return invalid('json'); }
  if (!record(parsed)) return invalid('schema');
  if (parsed.v === 2) { const state = cleanV2(parsed); return state ? { kind: 'ok', state, migrated: false } : invalid('schema'); }
  const legacy = cleanLegacy(parsed);
  if (!legacy) return invalid('schema-version');
  const primary = context && cleanBinding(context.primaryBinding);
  // The old record never contained its primary selection or an empty secondary's scope.
  if (!context || !primary || primary.sessionId === null || !validPaneId(context.groupId) || !validGroupTime(context.updatedAt) || (legacy.split && !legacy.secondary)) return { kind: 'pendingLegacy', raw, legacy };
  const primaryWithAlias: TreeBinding = { ...primary, draftAlias: primary.draftAlias ?? { workspaceKey: primary.scope.workspaceRoot, draftKey: `session:${primary.sessionId}` } };
  let tree = initialPaneTree(primaryWithAlias);
  if (legacy.split && legacy.secondary) {
    const { workspaceRoot, sessionId } = legacy.secondary;
    const secondary: TreeBinding = { scope: { workspaceRoot }, sessionId, draftAlias: { workspaceKey: workspaceRoot, draftKey: `pane-secondary:${sessionId}` } };
    // Duplicate legacy views have separate draft owners; defer rather than erase either.
    if (paneSessionKey(primary.scope, primary.sessionId) === paneSessionKey(secondary.scope, sessionId)) return { kind: 'pendingLegacy', raw, legacy };
    tree = splitTreePane(tree, PRIMARY_PANE_ID, legacy.split === 'row' ? 'right' : 'down', secondary, 'secondary', 'legacy-split');
    tree = { ...tree, root: tree.root.type === 'split' ? { ...tree.root, ratio: legacy.ratio } : tree.root, focus: legacy.focus };
  }
  return { kind: 'ok', migrated: true, state: { v: 2, groups: [{ groupId: context.groupId, tree, updatedAt: context.updatedAt }], activeGroupId: context.groupId } };
}
/** Reject invalid state rather than silently persisting an empty replacement. Runtime fields are omitted. */
export function encodePaneGroups(state: PaneGroups): string {
  const clean = cleanV2(state);
  if (!clean) throw new TypeError('Invalid pane groups');
  const raw = JSON.stringify(clean);
  if (raw.length > MAX_PANE_PAYLOAD) throw new RangeError('Pane groups exceed persistence limit');
  return raw;
}
