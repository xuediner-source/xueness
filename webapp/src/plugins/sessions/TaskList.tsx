import { t as tr } from '../../i18n';
import type { SessionSummary } from "../../xuenessWorkbench";



export type TaskListProps = {
  sessions: SessionSummary[];
  activeId?: string | null;
  onSelect?: (id: string) => void;
};


export function TaskList({ sessions, activeId, onSelect }: TaskListProps) {
  if (!sessions || sessions.length === 0) {
    return (
      <div data-testid="task-list-empty" className="xn-empty-state-note">{tr("暂无任务")}</div>
    );
  }

  return (
    <ul aria-label={tr("任务列表")} className="xn-task-list">
      {sessions.map((s) => {
        const isActive = s.id === activeId;
        return (
          <li key={s.id}>
            <button
              type="button"
              data-testid={`task-item-${s.id}`}
              data-active={isActive ? "true" : undefined}
              aria-current={isActive ? "true" : undefined}
              onClick={onSelect ? () => onSelect(s.id) : undefined}
              className="xn-task-item"
            >
              <span className="xn-task-item__title">
                {s.title || s.task || tr("未命名任务")}
              </span>
              <span className="xn-task-item__status">
                {s.status}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
