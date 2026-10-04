/**
 * 空会话起始页（sessions 插件功能）。
 *
 * Qoder 式的起始布局：左侧是现有能力的快捷动作块（打开工作区、新建会话、
 * 从模板或技能开始——动作本身由容器按插件生效状态提供），右侧是「最近会话」
 * 卡片，最多 5 条，点一下打开。组件只做展示与选择回调，不发起请求。
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

export type XuenessStartPageProps = {
  actions: StartPageAction[];
  sessions: SessionSummary[];
  locale?: "zh" | "en";
  onSelectSession(id: string): void;
};

export function XuenessStartPage({
  actions,
  sessions,
  locale = "zh",
  onSelectSession,
}: XuenessStartPageProps): React.JSX.Element | null {
  const recent = recentSessionSummaries(sessions, 5);
  if (actions.length === 0 && recent.length === 0) return null;
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
  );
}
