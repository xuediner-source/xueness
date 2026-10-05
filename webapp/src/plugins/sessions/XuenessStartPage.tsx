/**
 * 空会话起始页（sessions 插件功能）。
 *
 * Qoder 式的起始布局：左侧三个大动作块（打开项目 / 克隆仓库 / 通过 SSH 连接），
 * 右侧「最近项目」卡片置顶、「最近会话」为第二个分组。动作块与项目数据都由容器
 * 按插件生效状态提供——克隆属于 git 插件、SSH 属于 remote 插件，插件未生效时容器
 * 根本不会把该动作传进来，因此本组件不发起任何请求，只做展示与回调。
 */
import React from "react";
import { ChevronRight } from "lucide-react";
import { t as tr } from "../../i18n";
import {
  commandPaletteStatusLabel,
  formatPaletteUpdatedAt,
} from "./CommandPalette";
import type { SessionSummary } from "../../xuenessWorkbench";
import "../../styles/start-page.css";

/** 起始页快捷动作：图标与回调都由容器提供，只接已有能力。 */
export type StartPageAction = {
  id: string;
  label: string;
  description?: string;
  Icon: React.ComponentType<{ size?: number | string; className?: string }>;
  onSelect(trigger: HTMLElement): void;
};

/** 最近项目：已登记工作区的一条记录（与 settings 的 recentDirectories 同形）。 */
export type StartPageProject = {
  path: string;
  label?: string;
  lastUsed?: string | number;
};

/**
 * 最近会话：按 updatedAt 降序（缺失视为最旧且保持稳定顺序），最多 limit 条。
 * 纯函数，便于 SSR 测试断言条数与顺序。
 */
export function recentSessionSummaries(
  sessions: SessionSummary[] | null | undefined,
  limit = 5,
): SessionSummary[] {
  if (!sessions || sessions.length === 0) return [];
  const keyed = sessions.map((session, index) => ({
    session,
    index,
    updated: Date.parse(session.updatedAt ?? ""),
  }));
  keyed.sort((left, right) => {
    const leftValid = Number.isFinite(left.updated);
    const rightValid = Number.isFinite(right.updated);
    if (leftValid && rightValid && left.updated !== right.updated) return right.updated - left.updated;
    if (leftValid !== rightValid) return leftValid ? -1 : 1;
    return left.index - right.index;
  });
  return keyed.slice(0, Math.max(0, limit)).map(({ session }) => session);
}

/**
 * 最近项目：按最后使用时间降序；没有可用时间戳时保持登记顺序并排在最后，
 * 最多 limit 条（默认 5）。同一目录重复出现只保留最先出现的那条。
 */
export function recentStartPageProjects(
  projects: readonly StartPageProject[] | null | undefined,
  limit = 5,
): StartPageProject[] {
  if (!projects || projects.length === 0) return [];
  const seen = new Set<string>();
  const keyed: { project: StartPageProject; index: number; used: number }[] = [];
  projects.forEach((project, index) => {
    const path = typeof project?.path === "string" ? project.path.trim() : "";
    if (!path || seen.has(path)) return;
    seen.add(path);
    const stamp = typeof project.lastUsed === "number" ? project.lastUsed : Date.parse(String(project.lastUsed ?? ""));
    keyed.push({ project: { ...project, path }, index, used: Number.isFinite(stamp) ? stamp : Number.NEGATIVE_INFINITY });
  });
  keyed.sort((left, right) => {
    if (left.used !== right.used) return right.used - left.used;
    return left.index - right.index;
  });
  return keyed.slice(0, Math.max(0, limit)).map(({ project }) => project);
}

/** 项目名：优先用登记时的标签，否则取路径最后一段。 */
export function startPageProjectName(project: StartPageProject): string {
  const label = (project.label ?? "").trim();
  if (label) return label;
  const segments = project.path.replace(/\\/g, "/").split("/").filter(Boolean);
  return segments[segments.length - 1] ?? project.path;
}

/** 缩写路径：只保留末尾 keep 段，前面的层级用 …/ 表示，完整路径放 title。 */
export function abbreviatedWorkspacePath(path: string, keep = 2): string {
  const normalized = (path ?? "").trim().replace(/\\/g, "/");
  if (!normalized) return "";
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length <= keep) return normalized;
  const leading = normalized.startsWith("/") ? "/" : "";
  return `${leading}…/${segments.slice(-keep).join("/")}`;
}

export type XuenessStartPageProps = {
  actions: StartPageAction[];
  /** 已登记工作区；容器只在 settings+sessions 生效时取到，未提供时不渲染该卡片。 */
  projects?: readonly StartPageProject[] | null;
  sessions: SessionSummary[];
  locale?: "zh" | "en";
  onSelectSession(id: string): void;
  onSelectProject?(path: string): void;
};

export function XuenessStartPage({
  actions,
  projects,
  sessions,
  locale = "zh",
  onSelectSession,
  onSelectProject,
}: XuenessStartPageProps): React.JSX.Element | null {
  const recent = recentSessionSummaries(sessions, 5);
  const recentProjects = projects === undefined || projects === null ? null : recentStartPageProjects(projects, 5);
  if (actions.length === 0 && recent.length === 0 && recentProjects === null) return null;
  return (
    <div className="xn-start-page" data-testid="xn-start-page">
      {actions.length > 0 && (
        <div className="xn-start-page__actions" role="group" aria-label={tr("快捷开始")}>
          {actions.map((action) => (
            <button
              type="button"
              key={action.id}
              className="xn-start-page__action"
              data-testid={`start-action-${action.id}`}
              onClick={(event) => action.onSelect(event.currentTarget)}
            >
              <span className="xn-start-page__action-icon" aria-hidden="true">
                <action.Icon size={18} />
              </span>
              <span className="xn-start-page__action-copy">
                <strong>{action.label}</strong>
                {action.description && <small>{action.description}</small>}
              </span>
              <ChevronRight size={14} className="xn-start-page__action-chevron" aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
      <div className="xn-start-page__side">
        {recentProjects !== null && (
          <section
            className="xn-start-page__recent"
            aria-labelledby="xn-start-page-projects-title"
            data-testid="xn-start-page-projects"
          >
            <h2 id="xn-start-page-projects-title">{tr("最近项目")}</h2>
            {recentProjects.length === 0 ? (
              <p className="xn-start-page__recent-empty">{tr("暂无最近项目")}</p>
            ) : (
              <ul className="xn-start-page__recent-list">
                {recentProjects.map((project) => (
                  <li key={project.path}>
                    <button
                      type="button"
                      className="xn-start-page__recent-item"
                      data-testid={`start-project-${project.path}`}
                      title={project.path}
                      onClick={() => onSelectProject?.(project.path)}
                    >
                      <span className="xn-start-page__recent-title">{startPageProjectName(project)}</span>
                      <span className="xn-start-page__recent-meta">
                        <span className="xn-start-page__project-path">{abbreviatedWorkspacePath(project.path)}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
        <section className="xn-start-page__recent" aria-labelledby="xn-start-page-recent-title" data-testid="xn-start-page-recent">
          <h2 id="xn-start-page-recent-title">{tr("最近会话")}</h2>
          {recent.length === 0 ? (
            <p className="xn-start-page__recent-empty">{tr("暂无最近会话")}</p>
          ) : (
            <ul className="xn-start-page__recent-list">
              {recent.map((session) => {
                const label = session.title || session.task || tr("未命名任务");
                const updatedAt = formatPaletteUpdatedAt(session.updatedAt, locale);
                return (
                  <li key={session.id}>
                    <button
                      type="button"
                      className="xn-start-page__recent-item"
                      data-testid={`start-recent-${session.id}`}
                      title={label}
                      onClick={() => onSelectSession(session.id)}
                    >
                      <span className="xn-start-page__recent-title">{label}</span>
                      <span className="xn-start-page__recent-meta">
                        <span>{commandPaletteStatusLabel(session.status)}</span>
                        {updatedAt && <time dateTime={session.updatedAt}>{updatedAt}</time>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
