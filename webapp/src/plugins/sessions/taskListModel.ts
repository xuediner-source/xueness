import { t as tr } from '../../i18n';
import type { SessionSummary } from '../../xuenessWorkbench';
import type { SessionSidebarSidecar } from './sessionsIndex';
import {
  isSidebarProjectPinned,
  normalizeHiddenProjectRoots,
  normalizeSidebarProjectLabels,
  normalizeSidebarProjectRoots,
  normalizeSidebarProjectSections,
  sameSidebarProjectPath,
  sidebarProjectLabel,
  sidebarProjectSectionId,
  type SidebarProjectSection,
} from './projectSidebar';

export type TaskGroup = { id: string; label: string; taskIds: string[] };
export type SidebarProjectRoot = { path: string; name: string };
export type TaskProjectBucket = { id: string; label: string; items: SessionSummary[]; project: true; pinned?: boolean; sectionId?: string; customLabel?: boolean };
export type SidebarBucket = { id: string; label: string; items: SessionSummary[]; project: boolean; kind?: string };
export type SidebarView = 'groups'|'projects'|'workspace'|'purpose'|'timeline';
export type SidebarPreferences = {
  view?: SidebarView;
  sort?: 'recent'|'oldest'|'name';
  groups?: TaskGroup[];
  collapsed?: string[];
  hiddenProjectRoots?: string[];
  pinnedProjectRoots?: string[];
  projectLabels?: { path: string; label: string }[];
  projectSections?: SidebarProjectSection[];
};
export const TASK_GROUP_DRAG_MIME = 'application/x-xueness-session';

type SessionWithSidebarSidecar = SessionSummary & SessionSidebarSidecar & { sidecar?: SessionSidebarSidecar };

export function sessionSidebarFields(session: SessionSummary): SessionWithSidebarSidecar {
  const row = session as SessionWithSidebarSidecar;
  const nested = row.sidecar ?? {};
  return {
    ...row,
    workspace: row.workspace ?? nested.workspace ?? row.root,
    workspaceId: row.workspaceId ?? nested.workspaceId,
    workspacePath: row.workspacePath ?? nested.workspacePath,
    workspaceName: row.workspaceName ?? nested.workspaceName,
    purpose: row.purpose ?? nested.purpose,
    pendingInteraction: row.pendingInteraction ?? nested.pendingInteraction,
    unread: row.unread ?? nested.unread ?? (row.unreadAt != null || nested.unreadAt != null),
    unreadAt: row.unreadAt ?? nested.unreadAt,
    changeSummary: row.changeSummary ?? nested.changeSummary,
    remote: row.remote ?? nested.remote,
  };
}

function sidebarPathLabel(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || tr('任务');
}

/** Builds workspace buckets from sessions-index metadata while preserving the
 * existing project grouping semantics for rows without metadata. */
export function mergeWorkspaceBuckets(sessions: SessionSummary[]): SidebarBucket[] {
  const buckets = new Map<string, SidebarBucket>();
  for (const session of sessions) {
    const row = sessionSidebarFields(session);
    const key = row.workspacePath ?? row.workspace ?? row.root ?? row.workspaceId ?? '';
    const label = String(row.workspaceName ?? (key ? sidebarPathLabel(key) : tr('未指定工作区')));
    const bucket: SidebarBucket = buckets.get(key) ?? { id: key, label, items: [], project: true };
    bucket.items.push(session);
    buckets.set(key, bucket);
  }
  return [...buckets.values()];
}

/** Purpose sections mirror ZCode's purpose groups; rows with no purpose remain
 * visible under a stable fallback section rather than disappearing. */
export function mergePurposeBuckets(sessions: SessionSummary[]): SidebarBucket[] {
  const buckets = new Map<string, SidebarBucket>();
  for (const session of sessions) {
    const purpose = String(sessionSidebarFields(session).purpose ?? '').trim();
    const key = purpose || '__purpose_unspecified__';
    const label = purpose === 'project' ? tr('项目') : purpose === 'conversation' ? tr('对话') : purpose || tr('未指定用途');
    const bucket: SidebarBucket = buckets.get(key) ?? { id: key, label, items: [], project: false };
    bucket.items.push(session);
    buckets.set(key, bucket);
  }
  return [...buckets.values()];
}

export function mergeProjectBuckets(
  sessions: SessionSummary[],
  projectRoots: SidebarProjectRoot[] = [],
  hiddenProjectRoots: unknown = [],
  projectLabels: unknown = [],
  pinnedProjectRoots: unknown = [],
  projectSections: unknown = [],
): TaskProjectBucket[] {
  const buckets: TaskProjectBucket[] = [];
  const hidden = normalizeHiddenProjectRoots(hiddenProjectRoots);
  const hiddenPath = (path: string) => hidden.some(item => sameSidebarProjectPath(item, path));
  const findBucket = (path: string) => buckets.find(bucket => sameSidebarProjectPath(bucket.id, path));
  const labels = normalizeSidebarProjectLabels(projectLabels);
  const pinned = normalizeSidebarProjectRoots(pinnedProjectRoots);
  const sections = normalizeSidebarProjectSections(projectSections);
  const labelForPath = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() || tr('任务');
  for (const root of projectRoots) {
    if (!root || typeof root.path !== 'string' || !root.path) continue;
    if (hiddenPath(root.path) || findBucket(root.path)) continue;
    const customLabel = sidebarProjectLabel(labels, root.path);
    buckets.push({
        id: root.path,
        label: customLabel || root.name.trim() || labelForPath(root.path),
        items: [],
        project: true,
        pinned: isSidebarProjectPinned(pinned, root.path),
        sectionId: sidebarProjectSectionId(sections, root.path),
        customLabel: customLabel !== undefined,
      });
  }
  for (const session of sessions) {
    const id = session.root ?? '';
    if (hiddenPath(id)) continue;
    let bucket = findBucket(id);
    if (!bucket) {
      const customLabel = sidebarProjectLabel(labels, id);
      bucket = { id, label: customLabel || labelForPath(id), items: [], project: true,
        pinned: isSidebarProjectPinned(pinned, id), sectionId: sidebarProjectSectionId(sections, id), customLabel: customLabel !== undefined };
      buckets.push(bucket);
    }
    bucket.items.push(session);
  }
  return buckets.map((bucket, index) => ({ bucket, index }))
    .sort((left, right) => Number(Boolean(right.bucket.pinned)) - Number(Boolean(left.bucket.pinned)) || left.index - right.index)
    .map(entry => entry.bucket);
}

export type ProjectArchivePlan = { sessionIds: string[]; skippedActiveCount: number };
const PROJECT_SESSION_ACTIVE_STATUSES = new Set(['running', 'stopping', 'queued', 'pausing', 'starting']);

export function projectArchivePlan(sessions: readonly SessionSummary[], root: string): ProjectArchivePlan {
  const projectSessions = sessions.filter(session => typeof session.root === 'string' && sameSidebarProjectPath(session.root, root));
  const sessionIds: string[] = [];
  let skippedActiveCount = 0;
  for (const session of projectSessions) {
    const streaming = (session as SessionSummary & { streaming?: { status?: string } }).streaming?.status === 'streaming';
    if (PROJECT_SESSION_ACTIVE_STATUSES.has(session.status) || streaming) skippedActiveCount++;
    else sessionIds.push(session.id);
  }
  return { sessionIds, skippedActiveCount };
}
