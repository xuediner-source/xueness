import React, { useEffect, useState } from "react";
import { t as tr, tf, useLocale } from "../../i18n";
import { listProviders, type ProviderSummary } from "../../xuenessApi";
import { Select } from "../../ui/Select";
import { readJudgeSettings, readJudgeStats, saveJudgeSettings, type JudgeRange, type JudgeStats, type JudgeSettings } from "./toolJudgeApi";
import "./tool-judge.css";

const RANGES: [JudgeRange, string][] = [["7d", "7天"], ["30d", "30天"], ["all", "全部"]];
const message = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);

function seconds(ms: number): string {
  if (ms < 1000) return tf("{0} 毫秒", [Math.round(ms)]);
  return tf("{0} 秒", [(ms / 1000).toLocaleString(undefined, { maximumFractionDigits: ms < 10_000 ? 1 : 0 })]);
}

function Stat({ value, label, tone }: { value: string; label: string; tone?: "warn" }): React.JSX.Element {
  return <div className="xn-judge-stats__stat" data-tone={tone}><strong>{value}</strong><span>{label}</span></div>;
}

function JudgeStatsCard({ enabled }: { enabled: boolean }): React.JSX.Element {
  const [range, setRange] = useState<JudgeRange>("30d");
  const [stats, setStats] = useState<JudgeStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!enabled) return undefined;
    let disposed = false;
    setLoading(true);
    void readJudgeStats(range).then(value => { if (!disposed) { setStats(value); setError(""); } })
      .catch(cause => { if (!disposed) setError(message(cause)); })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [enabled, range]);
  const total = stats?.total;
  return <section className="xn-judge-stats" aria-labelledby="xn-judge-stats-title" data-testid="tool-judge-stats">
    <div className="xn-judge-stats__heading">
      <div>
        <h2 id="xn-judge-stats-title">{tr("判定统计")}</h2>
        <p>{tr("只统计已保存会话里的判定计数；没有判定模型时不会有数据。")}</p>
      </div>
      <div className="xn-judge-stats__ranges" role="group" aria-label={tr("统计范围")}>
        {RANGES.map(([id, label]) => <button key={id} type="button" aria-pressed={range === id} onClick={() => setRange(id)}>{tr(label)}</button>)}
      </div>
    </div>
    {error && <p className="xn-judge-settings__feedback is-error" role="alert">{error}</p>}
    {loading && !stats ? <p role="status">{tr("正在读取统计…")}</p> : !total ? <p>{tr("此周期没有判定记录")}</p> : <>
      <div className="xn-judge-stats__grid">
        <Stat value={total.judged.toLocaleString()} label={tr("次已判定的调用")} />
        <Stat value={total.requests.toLocaleString()} label={tr("次判定请求")} />
        <Stat value={seconds(total.judgeMs)} label={tr("判定总耗时")} />
        <Stat value={total.requests > 0 ? seconds(total.judgeMs / total.requests) : "—"} label={tr("平均每次请求")} />
        <Stat value={total.repairsApplied.toLocaleString()} label={tr("次已修正后执行")} />
        <Stat value={total.repairsSucceeded.toLocaleString()} label={tr("次修正后成功")} />
        <Stat value={total.rejectsApplied.toLocaleString()} label={tr("次已拦下")} />
        <Stat value={total.wrongBlocks.toLocaleString()} label={tr("次误拦")} tone={total.wrongBlocks > 0 ? "warn" : undefined} />
        <Stat value={total.passFailures.toLocaleString()} label={tr("次放行后失败")} tone={total.passFailures > 0 ? "warn" : undefined} />
        <Stat value={total.passAvoidableFailures.toLocaleString()} label={tr("其中可避免")} tone={total.passAvoidableFailures > 0 ? "warn" : undefined} />
        <Stat value={total.failures.toLocaleString()} label={tr("次判定请求失败")} />
      </div>
      <p className="xn-judge-stats__verdicts">{tf("放行 {0} · 建议 {1} · 修正 {2} · 拦下 {3} · 不可用 {4}（{5} 个会话）",
        [total.pass, total.advise, total.repair, total.reject, total.unavailable, stats?.sessions ?? 0])}</p>
      {stats && stats.models.length > 0 && <table>
        <caption className="xn-judge-settings__caption">{tr("按判定模型")}</caption>
        <thead><tr><th scope="col">{tr("模型")}</th><th scope="col">{tr("已判定")}</th><th scope="col">{tr("请求")}</th><th scope="col">{tr("平均耗时")}</th><th scope="col">{tr("失败")}</th></tr></thead>
        <tbody>{stats.models.map(row => <tr key={row.model}>
          <td title={row.model}>{row.model}</td><td>{row.judged}</td><td>{row.requests}</td>
          <td>{row.requests > 0 ? seconds(row.judgeMs / row.requests) : "—"}</td><td>{row.failures}</td>
        </tr>)}</tbody>
      </table>}
    </>}
  </section>;
}

type Props = { enabled: boolean; disabled?: boolean };

export function ToolJudgeSettings({ enabled, disabled = false }: Props): React.JSX.Element {
  useLocale();
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [saving, setSaving] = useState(false);
  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  const [applyRepairs, setApplyRepairs] = useState(false);
  const [applyRejects, setApplyRejects] = useState(false);
  const [timeoutSeconds, setTimeoutSeconds] = useState("8");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const apply = (settings: JudgeSettings) => {
    setProviderId(settings.profile?.providerId ?? "");
    setModel(settings.profile?.model ?? "");
    setApplyRepairs(settings.applyRepairs);
    setApplyRejects(settings.applyRejects);
    setTimeoutSeconds(String(settings.timeoutMs / 1000));
  };

  useEffect(() => {
    if (!enabled) { setLoading(false); return undefined; }
    let disposed = false;
    setLoading(true);
    void Promise.all([readJudgeSettings(), listProviders().catch(() => ({ providers: [] as ProviderSummary[] }))]).then(([settings, list]) => {
      if (disposed) return;
      setProviders(list.providers);
      apply(settings);
      setError("");
    }).catch(cause => { if (!disposed) setError(message(cause)); })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [enabled]);

  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!enabled || disabled || saving) return;
    const seconds = Number(timeoutSeconds);
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 60) { setError(tr("超时必须在 1 到 60 秒之间。")); setNotice(""); return; }
    setSaving(true); setError(""); setNotice("");
    try {
      const chosen = providers.find(item => item.id === providerId);
      const profile = providerId ? { providerId, model: model.trim() || chosen?.model || "" } : null;
      apply(await saveJudgeSettings({ profile, applyRepairs, applyRejects, timeoutMs: Math.round(seconds * 1000) }));
      setNotice(profile ? tr("设置已保存。新的运行会使用该判定模型。") : tr("设置已保存。判定已关闭。"));
    } catch (cause) {
      setError(message(cause));
    } finally {
      setSaving(false);
    }
  };

  const known = providers.some(item => item.id === providerId);
  return <section className="xn-judge-settings" data-testid="tool-judge-settings">
    {!enabled ? <p>{tr("工具调用判定已关闭；保存的设置仍会保留。")}</p> : <>
      <p>{tr("可选的判定模型会在高风险工具调用（命令、文件写入与修改、网络、MCP、委派）执行前先审阅一遍，每一步只发一次请求。默认只给出建议；它不是权限闸门，判定慢或不可用时调用照常执行。可选择小型本地模型或 API 模型。本地判定模型与本地主模型共用同一块显卡时，服务端可能需要来回切换模型。")}</p>
      {error && <p className="xn-judge-settings__feedback is-error" role="alert">{error}</p>}
      {notice && <p className="xn-judge-settings__feedback is-success" role="status">{notice}</p>}
      {loading ? <p role="status">{tr("正在读取判定设置…")}</p> : <form className="xn-judge-settings__form" onSubmit={event => void save(event)}>
        <label><span>{tr("判定模型")}</span>
          <Select value={providerId} disabled={disabled || saving} onChange={event => setProviderId(event.currentTarget.value)}>
            <option value="">{tr("关闭")}</option>
            {providers.map(item => <option key={item.id} value={item.id}>{item.name || item.id}</option>)}
            {providerId && !known && <option value={providerId}>{providerId}</option>}
          </Select>
        </label>
        {providerId && <label><span>{tr("模型名（可选）")}</span>
          <input type="text" maxLength={200} value={model} disabled={disabled || saving} autoComplete="off"
            placeholder={providers.find(item => item.id === providerId)?.model ?? ""} onChange={event => setModel(event.currentTarget.value)} />
        </label>}
        <label className="is-check"><input type="checkbox" checked={applyRepairs} disabled={disabled || saving || !providerId}
          onChange={event => setApplyRepairs(event.currentTarget.checked)} /><span>{tr("允许修正参数后再执行")}</span></label>
        <label className="is-check"><input type="checkbox" checked={applyRejects} disabled={disabled || saving || !providerId}
          onChange={event => setApplyRejects(event.currentTarget.checked)} /><span>{tr("允许拦下调用一次（原样重试时放行）")}</span></label>
        <label><span>{tr("判定超时（秒）")}</span>
          <input type="number" min={1} max={60} step={1} value={timeoutSeconds} disabled={disabled || saving || !providerId}
            onChange={event => setTimeoutSeconds(event.currentTarget.value)} />
        </label>
        <button type="submit" disabled={disabled || saving} aria-busy={saving}>{saving ? tr("正在保存…") : tr("保存")}</button>
      </form>}
      <JudgeStatsCard enabled={enabled} />
    </>}
  </section>;
}

export default ToolJudgeSettings;
