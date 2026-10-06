import React, { useEffect, useState } from "react";
import "./ToolExecutionSettings.css";
import { get } from "../../xuenessApi";
import { t as tr, tf } from "../../i18n";
import type { SettingsMap } from "../../xuenessSettings";
import { SettingsGroup, SettingsRow } from "../settings/SettingsPrimitives";

export function ToolExecutionSettings({ values, disabled = false, onUpdate }: {
  values: SettingsMap; disabled?: boolean; onUpdate?: (key: string, value: unknown) => unknown;
}): React.ReactElement {
  const limit = Number.isInteger(values.toolsCallBudgetLimit) ? Number(values.toolsCallBudgetLimit) : 100;
  const [draft, setDraft] = useState(String(limit));
  const [error, setError] = useState("");
  useEffect(() => { setDraft(String(limit)); setError(""); }, [limit]);
  const toggle = (key: string, label: string) => <input type="checkbox" role="switch" className="xn-settings-switch"
    aria-label={tr(label)} checked={values[key] === true} disabled={disabled || !onUpdate}
    onChange={event => { void onUpdate?.(key, event.currentTarget.checked); }} />;
  const commit = () => {
    const value = Number(draft);
    if (!draft.trim() || !Number.isInteger(value) || value < 1 || value > 10000) { setError(tr("请输入 1 到 10000 之间的整数。")); return; }
    setError("");
    if (value !== limit) void onUpdate?.("toolsCallBudgetLimit", value);
  };
  return <SettingsGroup title={tr("工具执行实验功能")} description={tr("实验开关不会授予工具权限；所有操作仍需通过原有审批。") }>
    <SettingsRow label={tr("工具干跑预览")} description={tr("预览受支持的文件写入、编辑和命令；其他副作用工具会被拒绝。预览不是完整沙盒。")}
      control={toggle("toolsDryRunEnabled", "工具干跑预览")} />
    <SettingsRow label={tr("每轮工具调用预算")} description={tr("限制当前用户轮次的工具调用；恢复会话不会重置计数，新的用户消息开始下一轮。")}
      control={toggle("toolsCallBudgetEnabled", "每轮工具调用预算")} />
    <SettingsRow label={tr("每轮调用上限")} description={tr("默认 100 次；达到上限后停止执行工具，并报告原因。")}
      control={<div className="xn-tool-budget-limit"><input type="number" min={1} max={10000} step={1} aria-label={tr("每轮调用上限")} value={draft}
        disabled={disabled || !onUpdate || values.toolsCallBudgetEnabled !== true}
        onChange={event => setDraft(event.currentTarget.value)} onBlur={commit}
        onKeyDown={event => { if (event.nativeEvent.isComposing || event.keyCode === 229) return; if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { setDraft(String(limit)); setError(""); } }} />
        {error && <p role="alert">{error}</p>}</div>} />
  </SettingsGroup>;
}

type BudgetStatus = { enabled: boolean; used: number; limit: number; remaining: number; turn_id?: string };
export function parseToolBudget(value: unknown): BudgetStatus {
  const data = value as BudgetStatus | null;
  if (!data || typeof data.enabled !== "boolean") throw new Error("Invalid tool budget response");
  if (!data.enabled) return { enabled: false, used: 0, limit: 0, remaining: 0 };
  if (![data.used, data.limit, data.remaining].every(Number.isInteger) || data.used < 0 || data.limit < 1 || data.limit > 10000
    || data.remaining !== Math.max(0, data.limit - data.used)) throw new Error("Invalid tool budget response");
  return data;
}

export function ToolCallBudgetStatus({ sessionId, enabled, revision }: { sessionId: string; enabled: boolean; revision?: unknown }): React.ReactElement | null {
  const [state, setState] = useState<{ id: string; budget?: BudgetStatus; error?: boolean }>();
  useEffect(() => {
    if (!enabled) { setState(undefined); return; }
    const abort = new AbortController();
    void get<unknown>(`/api/tools/call-budget?session=${encodeURIComponent(sessionId)}`, abort.signal)
      .then(value => { if (!abort.signal.aborted) setState({ id: sessionId, budget: parseToolBudget(value) }); })
      .catch(() => { if (!abort.signal.aborted) setState({ id: sessionId, error: true }); });
    return () => abort.abort();
  }, [enabled, sessionId, revision]);
  if (!enabled || state?.id !== sessionId) return null;
  if (state.error) return <p className="xn-tool-budget" role="status">{tr("工具预算状态暂不可用。")}</p>;
  if (!state.budget?.enabled) return null;
  return <p className="xn-tool-budget" role="status" data-testid="tool-call-budget">{tf("工具调用 {0} / {1} · 剩余 {2}", [state.budget.used, state.budget.limit, state.budget.remaining])}</p>;
}
