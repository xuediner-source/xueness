import React, { useEffect, useState } from "react";
import { get, post } from "../../xuenessApi";
import { t as tr } from "../../i18n";
import "../../styles/diagnostics.css";

type Diagnostics = { runtime?: Record<string, unknown>; plugins?: unknown[]; sessions?: unknown[]; storage?: Record<string, unknown> };
export function XuenessDiagnosticsPanel(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<Diagnostics | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [days, setDays] = useState(30);
  const [busy, setBusy] = useState(false);
  const [confirmCleanup, setConfirmCleanup] = useState(false);
  const refresh = async () => {
    setBusy(true); setError("");
    try {
      setSnapshot(await get<Diagnostics>("/api/diagnostics/export"));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  useEffect(() => { void refresh(); }, []);
  const download = () => {
    if (!snapshot) return;
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "xueness-diagnostics-redacted.json"; anchor.click();
    URL.revokeObjectURL(url);
  };
  const cleanup = async () => {
    setBusy(true); setError(""); setNotice("");
    try { const result = await post<{ removedLogs: number }>("/api/diagnostics/cleanup", { confirmed: true, olderThanDays: days }); setNotice(tr("已清理日志：") + result.removedLogs); setConfirmCleanup(false); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const counts = snapshot?.storage ?? {};
  return <section className="xn-diagnostics" data-testid="diagnostics-panel">
    <header><div><h3>{tr("诊断与维护")}</h3><p>{tr("导出内容已脱敏；清理只删除超过保留期的日志。")}</p></div><div><button type="button" disabled={busy} onClick={() => void refresh()}>{tr("刷新")}</button><button type="button" disabled={!snapshot} onClick={download}>{tr("导出脱敏 JSON")}</button></div></header>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {snapshot && <>
      <div className="xn-diagnostics__cards">{Object.entries(counts).map(([key, value]) => <article key={key}><span>{key}</span><strong>{typeof value === "object" ? JSON.stringify(value) : String(value)}</strong></article>)}</div>
      <details><summary>{tr("运行环境")}</summary><pre>{JSON.stringify(snapshot.runtime ?? {}, null, 2)}</pre></details>
      <details><summary>{tr("插件状态")} ({snapshot.plugins?.length ?? 0})</summary><pre>{JSON.stringify(snapshot.plugins ?? [], null, 2)}</pre></details>
      <details><summary>{tr("会话状态")} ({snapshot.sessions?.length ?? 0})</summary><pre>{JSON.stringify(snapshot.sessions ?? [], null, 2)}</pre></details>
      <section className="xn-diagnostics__cleanup"><h4>{tr("清理旧日志")}</h4><label>{tr("保留天数")}<input type="number" min={1} max={3650} value={days} onChange={e => setDays(Number(e.target.value))} /></label><button type="button" disabled={busy || !Number.isInteger(days) || days < 1 || days > 3650} onClick={() => setConfirmCleanup(true)}>{tr("查看清理确认")}</button></section>
    </>}
    {confirmCleanup && <div className="xn-diagnostics__backdrop"><section role="alertdialog" aria-modal="true"><h3>{tr("确认清理旧日志")}</h3><p>{tr("将删除早于")}{days}{tr("天的日志文件。其他存储数据不会更改。")}</p><div><button type="button" onClick={() => setConfirmCleanup(false)}>{tr("取消")}</button><button type="button" disabled={busy} onClick={() => void cleanup()}>{tr("确认清理")}</button></div></section></div>}
  </section>;
}
