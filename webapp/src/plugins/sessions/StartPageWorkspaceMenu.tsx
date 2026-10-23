/**
 * Empty-state workspace picker. Loaded on demand so the start-page shell
 * does not carry the remote/local catalog menu in the startup graph.
 */
import React from "react";
import { t as tr } from "../../i18n";
import { Cloud, Folder, FolderOpen, House, Search, X } from "lucide-react";
import { abbreviatedWorkspacePath, startPageProjectName } from "./XuenessStartPage";

export type StartPageWorkspace = {
  path: string;
  label: string;
  kind?: "local" | "remote";
  remoteId?: string;
  connected?: boolean;
  connectionState?: string;
};

/** Keep the empty-state picker searchable while bounding the rendered catalog. */
export function filterStartPageWorkspaces(
  workspaces: readonly StartPageWorkspace[] | null | undefined,
  query = "",
  limit = 5,
): StartPageWorkspace[] {
  const needle = query.trim().toLocaleLowerCase();
  const seen = new Set<string>();
  return (workspaces ?? []).filter((item) => {
    const path = typeof item?.path === "string" ? item.path.trim() : "";
    const label = typeof item?.label === "string" ? item.label.trim() : "";
    if (!path || !label) return false;
    if (item.kind === "remote" && item.connected === false) return false;
    const key = `${item.kind ?? "local"}:${item.remoteId ?? ""}:${path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return !needle || `${label} ${path} ${item.remoteId ?? ""}`.toLocaleLowerCase().includes(needle);
  }).slice(0, Math.max(0, limit));
}

export type StartPageWorkspaceMenuProps = {
  workspaces: readonly StartPageWorkspace[];
  currentPath?: string | null;
  onSelectWorkspace(path: string, remoteId?: string): void;
  onOpenFolder?(): void;
  onConnectRemote?(): void;
  onDetachProject?(): void;
  allowOpenFolder?: boolean;
  allowRemote?: boolean;
};

/** ChatEmptyState-like workspace picker, owned by the sessions plugin. */
export function StartPageWorkspaceMenu({
  workspaces,
  currentPath,
  onSelectWorkspace,
  onOpenFolder,
  onConnectRemote,
  onDetachProject,
  allowOpenFolder = true,
  allowRemote = false,
}: StartPageWorkspaceMenuProps): React.JSX.Element {
  const [query, setQuery] = React.useState("");
  const visible = filterStartPageWorkspaces(workspaces, query);
  const current = workspaces.find(item => item.path === currentPath);
  const CurrentIcon = current?.kind === "remote" ? Cloud : House;
  const currentLabel = current?.label ?? (currentPath ? startPageProjectName({ path: currentPath }) : tr("选择工作区"));
  return (
    <details className="xn-start-page__workspace" data-testid="xn-start-page-workspace-menu">
      <summary data-shortcut-action="open-workspace" aria-label={tr("选择工作区")}>
        <CurrentIcon size={15} aria-hidden="true" />
        <span>{currentLabel}</span>
      </summary>
      <div className="xn-start-page__workspace-popover">
        <label className="xn-start-page__workspace-search">
          <Search size={14} aria-hidden="true" />
          <input type="search" value={query} placeholder={tr("搜索工作区")} aria-label={tr("搜索工作区")}
            onChange={event => setQuery(event.currentTarget.value)} data-testid="xn-start-page-workspace-search" />
        </label>
        <div className="xn-start-page__workspace-list" role="listbox" aria-label={tr("工作区列表")}>
          {visible.map(item => {
            const Icon = item.kind === "remote" ? Cloud : Folder;
            return <button type="button" role="option" aria-selected={item.path === currentPath}
              key={`${item.kind ?? "local"}:${item.remoteId ?? ""}:${item.path}`}
              data-testid={`start-workspace-${item.remoteId ?? item.path}`}
              onClick={() => onSelectWorkspace(item.path, item.remoteId)}>
              <Icon size={14} aria-hidden="true" /><span>{item.label}</span><small>{abbreviatedWorkspacePath(item.path)}</small>
            </button>;
          })}
          {visible.length === 0 && <p className="xn-start-page__workspace-empty">{tr("没有匹配的工作区")}</p>}
        </div>
        <div className="xn-start-page__workspace-actions">
          {allowOpenFolder && onOpenFolder && <button type="button" onClick={onOpenFolder}><FolderOpen size={14} aria-hidden="true" />{tr("打开文件夹")}</button>}
          {allowRemote && onConnectRemote && <button type="button" onClick={onConnectRemote}><Cloud size={14} aria-hidden="true" />{tr("连接或重连 SSH")}</button>}
          {onDetachProject && current && current.kind !== "remote" && <button type="button" onClick={onDetachProject}><X size={14} aria-hidden="true" />{tr("脱离项目")}</button>}
        </div>
      </div>
    </details>
  );
}

export default StartPageWorkspaceMenu;
