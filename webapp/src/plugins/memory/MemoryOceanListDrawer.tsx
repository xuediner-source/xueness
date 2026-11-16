import React, { useEffect, useMemo, useRef, useState } from "react";
import { Trash2, X } from "lucide-react";
import { t as tr, tf } from "../../i18n";
import { ago, kindLabel, type OceanNode } from "./oceanApi";
import { kindColor, type OceanMood } from "./oceanPalette";

/** List drawer for scanning, filtering, multi-selecting, and batch-forgetting memories. */
export function MemoryOceanListDrawer({
  listed,
  selected,
  checkedIds,
  mood,
  busy,
  onClose,
  onSelect,
  onToggle,
  onToggleAll,
  onForgetMany,
}: {
  listed: readonly OceanNode[];
  selected: string | null;
  checkedIds: ReadonlySet<string>;
  mood: OceanMood;
  busy: boolean;
  onClose(): void;
  onSelect(id: string): void;
  onToggle(id: string, checked: boolean): void;
  onToggleAll(ids: readonly string[], checked: boolean): void;
  onForgetMany(ids: readonly string[]): Promise<void>;
}): React.JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const allRef = useRef<HTMLInputElement>(null);

  const deletableIds = useMemo(
    () => listed.filter((item) => item.origin !== "curated").map((item) => item.id),
    [listed],
  );
  const selectedIds = useMemo(
    () => deletableIds.filter((id) => checkedIds.has(id)),
    [deletableIds, checkedIds],
  );

  const allSelected = deletableIds.length > 0 && selectedIds.length === deletableIds.length;
  const partiallySelected = selectedIds.length > 0 && selectedIds.length < deletableIds.length;

  useEffect(() => {
    if (allRef.current) allRef.current.indeterminate = partiallySelected;
  }, [partiallySelected]);

  useEffect(() => {
    if (selectedIds.length === 0) setConfirming(false);
  }, [selectedIds.length]);

  const confirmDelete = async (): Promise<void> => {
    await onForgetMany(selectedIds);
    setConfirming(false);
  };

  return (
    <aside className="xn-ocean-drawer xn-ocean-drawer--list" aria-label={tr("记忆列表")}>
      <header>
        <h3>{tf("{0} 段记忆", [listed.filter((item) => item.status === "active").length])}</h3>
        <button type="button" className="xn-ocean-icon" aria-label={tr("关闭")} onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </button>
      </header>

      <div className="xn-ocean-drawer__bar">
        <label className="xn-ocean-drawer__select-all">
          <input
            ref={allRef}
            type="checkbox"
            checked={allSelected}
            disabled={busy || deletableIds.length === 0}
            onChange={(event) => onToggleAll(deletableIds, event.target.checked)}
          />
          <span>{tr("全选")}</span>
        </label>
        <div className="xn-ocean-drawer__actions">
          <span className="xn-ocean-drawer__count">{tf("已选 {0} 项", [selectedIds.length])}</span>
          <button
            type="button"
            className="xn-ocean-button xn-ocean-button--danger xn-ocean-drawer__delete"
            disabled={busy || selectedIds.length === 0}
            onClick={() => setConfirming(true)}
          >
            <Trash2 size={14} aria-hidden="true" />
            {tr("删除所选")}
          </button>
        </div>
      </div>

      {confirming && selectedIds.length > 0 && (
        <div className="xn-ocean-detail__confirm xn-ocean-drawer__confirm" role="alert">
          <p>{tf("确定遗忘所选的 {0} 段记忆？它会从记忆之海中删除，无法撤销。", [selectedIds.length])}</p>
          <div>
            <button type="button" className="xn-ocean-button" disabled={busy} onClick={() => setConfirming(false)}>
              {tr("取消")}
            </button>
            <button
              type="button"
              className="xn-ocean-button xn-ocean-button--danger"
              disabled={busy}
              onClick={() => void confirmDelete()}
            >
              {tr("确认删除")}
            </button>
          </div>
        </div>
      )}

      <ul>
        {listed.map((item) => {
          const curated = item.origin === "curated";
          const checked = !curated && checkedIds.has(item.id);
          return (
            <li key={item.id} className="xn-ocean-drawer__item">
              {curated ? (
                <span className="xn-ocean-drawer__check-spacer" title={tr("记忆轨道只读条目")} aria-hidden="true" />
              ) : (
                <label className="xn-ocean-drawer__check">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={busy}
                    aria-label={tf("选择记忆：{0}", [item.summary])}
                    onChange={(event) => onToggle(item.id, event.target.checked)}
                  />
                </label>
              )}
              <button
                type="button"
                className="xn-ocean-drawer__row"
                aria-current={item.id === selected || undefined}
                data-archived={item.status === "archived" || undefined}
                onClick={() => onSelect(item.id)}
              >
                <span
                  className="xn-ocean-dot"
                  style={{ background: kindColor(mood, curated ? "curated" : item.kind) }}
                  aria-hidden="true"
                />
                <span>
                  <strong>{item.summary}</strong>
                  <small>
                    {kindLabel(item.kind)} · {item.scope === "global" ? tr("所有项目") : item.project?.label} · {ago(item.updatedAt)}
                  </small>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
