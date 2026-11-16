/** Settings → 蜂群: the limits every new swarm starts with. */
import React, { useEffect, useState } from "react";
import { t as tr, useLocale } from "../../i18n";
import { readSwarmSettings, saveSwarmSettings, type SwarmLimits } from "./swarmApi";
import "./swarm.css";

type Field = { key: Exclude<keyof SwarmLimits, "maxActive">; label: string; min: number; max: number };
const FIELDS: Field[] = [
  { key: "maxMembers", label: "每个蜂群最多成员数", min: 2, max: 6 },
  { key: "memberMaxSteps", label: "成员每轮最多步数", min: 5, max: 64 },
  { key: "memberMaxTurns", label: "每个成员最多轮次", min: 1, max: 40 },
  { key: "nudgeLimit", label: "全员停下时提醒协调者的次数", min: 0, max: 10 },
  { key: "wallMinutes", label: "总时长上限（分钟）", min: 5, max: 480 },
];

export function SwarmSettings({ enabled, disabled = false }: { enabled: boolean; disabled?: boolean }): React.JSX.Element {
  useLocale();
  const [values, setValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(enabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const apply = (settings: SwarmLimits) => setValues({ ...Object.fromEntries(FIELDS.map(field => [field.key, String(settings[field.key])])), maxActive: settings.maxActive === null ? "" : String(settings.maxActive) });
  useEffect(() => {
    if (!enabled) { setLoading(false); return undefined; }
    let disposed = false;
    void readSwarmSettings().then(settings => { if (!disposed) apply(settings); })
      .catch(cause => { if (!disposed) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [enabled]);
  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true); setError(""); setNotice("");
    try {
      const patch: Partial<SwarmLimits> = Object.fromEntries(FIELDS.map(field => [field.key, Number(values[field.key])]));
      patch.maxActive = values.maxActive?.trim() ? Number(values.maxActive) : null;
      apply(await saveSwarmSettings(patch));
      setNotice(tr("设置已保存，新启动的蜂群会使用它们。"));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  };
  if (!enabled) return <p>{tr("蜂群插件已关闭。")}</p>;
  return <section className="xn-swarm-settings" data-testid="swarm-settings">
    <p>{tr("模型可以用 swarm_start 提出蜂群计划：协调者分派、工作者并行修改各自拥有的路径、验证者检查结果。你批准一次计划后，每个成员只能写自己的路径、只能运行列出的命令。这里的限制适用于之后新启动的蜂群。")}</p>
    {error && <p className="xn-swarm-error" role="alert">{error}</p>}
    {notice && <p className="xn-swarm-notice" role="status">{notice}</p>}
    {loading ? <p role="status">{tr("正在读取蜂群设置…")}</p> : <form className="xn-swarm-settings__form" onSubmit={event => void save(event)}>
      {FIELDS.map(field => <label key={field.key}><span>{tr(field.label)}</span>
        <input type="number" min={field.min} max={field.max} step={1} required value={values[field.key] ?? ""} disabled={disabled || saving}
          onChange={event => { const value = event.currentTarget.value; setValues(current => ({ ...current, [field.key]: value })); }} /></label>)}
      <label><span>{tr("同时运行的成员数（留空自动：本机模型 1 个，API 2 个）")}</span>
        <input type="number" min={1} max={4} step={1} value={values.maxActive ?? ""} disabled={disabled || saving}
          onChange={event => { const value = event.currentTarget.value; setValues(current => ({ ...current, maxActive: value })); }} /></label>
      <button type="submit" disabled={disabled || saving} aria-busy={saving}>{saving ? tr("正在保存…") : tr("保存")}</button>
    </form>}
  </section>;
}

export default SwarmSettings;
