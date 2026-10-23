import { isPathWithinAllowedRoot } from '../../xuenessWorkspaces';

export type SidebarProjectLabel = { path: string; label: string };
export type SidebarProjectSection = { id: string; label: string; roots: string[] };

/** Match canonical workspace paths with the same Windows case/slash rules used by the workspace picker. */
export function sameSidebarProjectPath(left: string, right: string): boolean {
  return left === right || (isPathWithinAllowedRoot(left, right) && isPathWithinAllowedRoot(right, left));
}

export function normalizeSidebarProjectRoots(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const roots: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const path = item.trim();
    if (!path || path.length > 4096 || !isPathWithinAllowedRoot(path, path)) continue;
    if (!roots.some(existing => sameSidebarProjectPath(existing, path))) roots.push(path);
  }
  return roots;
}

export function normalizeHiddenProjectRoots(value: unknown): string[] {
  return normalizeSidebarProjectRoots(value);
}

export function toggleHiddenProjectRoot(value: unknown, path: string): string[] {
  const roots = normalizeHiddenProjectRoots(value);
  if (!isPathWithinAllowedRoot(path, path)) return roots;
  return roots.some(existing => sameSidebarProjectPath(existing, path))
    ? roots.filter(existing => !sameSidebarProjectPath(existing, path))
    : [...roots, path];
}

export function togglePinnedProjectRoot(value: unknown, path: string): string[] {
  const roots = normalizeSidebarProjectRoots(value);
  if (!isPathWithinAllowedRoot(path, path)) return roots;
  return roots.some(existing => sameSidebarProjectPath(existing, path))
    ? roots.filter(existing => !sameSidebarProjectPath(existing, path))
    : [...roots, path];
}

export function isSidebarProjectPinned(value: unknown, path: string): boolean {
  return normalizeSidebarProjectRoots(value).some(existing => sameSidebarProjectPath(existing, path));
}

export function normalizeSidebarProjectLabels(value: unknown): SidebarProjectLabel[] {
  if (!Array.isArray(value)) return [];
  const labels: SidebarProjectLabel[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (typeof row.path !== 'string' || typeof row.label !== 'string') continue;
    const path = row.path.trim();
    const label = row.label.trim().slice(0, 80);
    if (!path || !label || path.length > 4096 || !isPathWithinAllowedRoot(path, path)) continue;
    const existing = labels.findIndex(entry => sameSidebarProjectPath(entry.path, path));
    if (existing >= 0) labels.splice(existing, 1);
    labels.push({ path, label });
  }
  return labels;
}

export function setSidebarProjectLabel(value: unknown, path: string, label: string): SidebarProjectLabel[] {
  const labels = normalizeSidebarProjectLabels(value).filter(entry => !sameSidebarProjectPath(entry.path, path));
  const clean = label.trim().slice(0, 80);
  return clean && isPathWithinAllowedRoot(path, path) ? [...labels, { path, label: clean }] : labels;
}

export function sidebarProjectLabel(value: unknown, path: string): string | undefined {
  return normalizeSidebarProjectLabels(value).find(entry => sameSidebarProjectPath(entry.path, path))?.label;
}

export function normalizeSidebarProjectSections(value: unknown): SidebarProjectSection[] {
  if (!Array.isArray(value)) return [];
  const sections: SidebarProjectSection[] = [];
  const assigned: string[] = [];
  for (const item of value.slice(0, 100)) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== 'string' || typeof row.label !== 'string') continue;
    const id = row.id.trim().slice(0, 100);
    const label = row.label.trim().slice(0, 80);
    if (!/^[\w-]+$/u.test(id) || !label || sections.some(section => section.id === id)) continue;
    const roots = normalizeSidebarProjectRoots(row.roots).filter(path => !assigned.some(root => sameSidebarProjectPath(root, path)));
    assigned.push(...roots);
    sections.push({ id, label, roots });
  }
  return sections;
}

export function sidebarProjectSectionId(value: unknown, path: string): string | undefined {
  return normalizeSidebarProjectSections(value).find(section => section.roots.some(root => sameSidebarProjectPath(root, path)))?.id;
}

/** Assign one project to at most one persisted section; an empty target clears the assignment. */
export function moveSidebarProjectToSection(value: unknown, path: string, targetSectionId: string | null): SidebarProjectSection[] {
  const sections = normalizeSidebarProjectSections(value).map(section => ({
    ...section,
    roots: section.roots.filter(root => !sameSidebarProjectPath(root, path)),
  }));
  if (!targetSectionId) return sections;
  const target = sections.find(section => section.id === targetSectionId);
  if (!target || !isPathWithinAllowedRoot(path, path)) return sections;
  target.roots.push(path);
  return sections;
}

export function createSidebarProjectSection(value: unknown, path: string, label: string, id: string): SidebarProjectSection[] {
  const sections = normalizeSidebarProjectSections(value);
  const cleanLabel = label.trim().slice(0, 80);
  if (!cleanLabel || !/^[\w-]+$/u.test(id) || sections.length >= 100 || sections.some(section => section.id === id)) return sections;
  const moved = moveSidebarProjectToSection(sections, path, null);
  moved.push({ id, label: cleanLabel, roots: isPathWithinAllowedRoot(path, path) ? [path] : [] });
  return moved;
}
