import React, { useEffect, useRef, useState } from "react";
import { get, post } from "../../xuenessApi";
import { t as tr, tf } from "../../i18n";
import { shouldDismissModalOnEscape, useModalFocusScope } from "../shared";
import "../../styles/diagnostics.css";

type Diagnostics = { runtime?: Record<string, unknown>; plugins?: unknown[]; sessions?: unknown[]; storage?: Record<string, unknown> };
export function scheduleObjectUrlRevocation(
  url: string,
  delayMs = 1000,
  revokeFn: (url: string) => void = (u) => URL.revokeObjectURL(u),
): ReturnType<typeof setTimeout> {
  return setTimeout(() => revokeFn(url), delayMs);
}

export function createObjectUrlRevocationQueue(
  revoke: (url: string) => void = url => URL.revokeObjectURL(url),
  schedule: (url: string, delayMs: number, revokeFn: (url: string) => void) => ReturnType<typeof setTimeout> = scheduleObjectUrlRevocation,
  cancel: (timer: ReturnType<typeof setTimeout>) => void = timer => clearTimeout(timer),
) {
  let disposed = false;
  const pending = new Map<ReturnType<typeof setTimeout>, string>();
  return {
    schedule(url: string, delayMs = 1000) {
      if (disposed) { revoke(url); return undefined; }
      let timer: ReturnType<typeof setTimeout>;
      timer = schedule(url, delayMs, value => {
        pending.delete(timer);
        if (!disposed) revoke(value);
      });
      pending.set(timer, url);
      return timer;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const [timer, url] of pending) {
        cancel(timer);
        revoke(url);
      }
      pending.clear();
    },
  };
}

export function cleanupConfirmMessage(days: number): string {
  return tf("将删除早于 {0} 天的日志文件。其他存储数据不会更改。", [days]);
}

export function XuenessDiagnosticsPanel(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<Diagnostics | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [days, setDays] = useState(30);
  const [busy, setBusy] = useState(false);
  const [confirmCleanup, setConfirmCleanup] = useState(false);
  const cleanupDialogRef = React.useRef<HTMLElement | null>(null);
  const cleanupCancelRef = React.useRef<HTMLButtonElement | null>(null);
  useModalFocusScope({ open: confirmCleanup, dialogRef: cleanupDialogRef, initialFocusRef: cleanupCancelRef });
  const mounted = useRef(false);
  const lifecycleGeneration = useRef(0);
  const refreshSequence = useRef(0);
  const revocationQueue = useRef<ReturnType<typeof createObjectUrlRevocationQueue> | null>(null);
  const isCurrent = (generation: number) => mounted.current && lifecycleGeneration.current === generation;
  const refresh = async (generation = lifecycleGeneration.current) => {
    if (!isCurrent(generation)) return;
    const sequence = ++refreshSequence.current;
    setBusy(true); setError("");
    try {
      const result = await get<Diagnostics>("/api/diagnostics/export");
      if (isCurrent(generation) && sequence === refreshSequence.current) setSnapshot(result);
    } catch (e) {
      if (isCurrent(generation) && sequence === refreshSequence.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (isCurrent(generation) && sequence === refreshSequence.current) setBusy(false);
    }
  };
  useEffect(() => {
    mounted.current = true;
    const generation = ++lifecycleGeneration.current;
    const queue = createObjectUrlRevocationQueue();
    revocationQueue.current = queue;
    void refresh(generation);
    return () => {
      mounted.current = false;
      lifecycleGeneration.current += 1;
      refreshSequence.current += 1;
      queue.dispose();
      if (revocationQueue.current === queue) revocationQueue.current = null;
    };
  }, []);
  const download = () => {
    if (!snapshot) return;
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "xueness-diagnostics-redacted.json"; anchor.click();
    if (revocationQueue.current) revocationQueue.current.schedule(url);
    else URL.revokeObjectURL(url);
  };
  const cleanup = async () => {
    const generation = lifecycleGeneration.current;
    if (!isCurrent(generation)) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await post<{ removedLogs: number }>("/api/diagnostics/cleanup", { confirmed: true, olderThanDays: days });
      if (!isCurrent(generation)) return;
      setNotice(tf("已清理日志：{0}", [result.removedLogs])); setConfirmCleanup(false);
      await refresh(generation);
    } catch (e) {
      if (isCurrent(generation)) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (isCurrent(generation)) setBusy(false);
    }
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
    {confirmCleanup && <div className="xn-diagnostics__backdrop"><section
      ref={cleanupDialogRef}
      tabIndex={-1}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="xn-diagnostics-cleanup-title"
      aria-describedby="xn-diagnostics-cleanup-description"
      onKeyDown={event => {
        if (event.key !== "Escape") return;
        if (!shouldDismissModalOnEscape(event, busy)) { event.stopPropagation(); return; }
        event.preventDefault(); event.stopPropagation(); setConfirmCleanup(false);
      }}
    ><h3 id="xn-diagnostics-cleanup-title">{tr("确认清理旧日志")}</h3><p id="xn-diagnostics-cleanup-description">{cleanupConfirmMessage(days)}</p><div><button ref={cleanupCancelRef} type="button" onClick={() => setConfirmCleanup(false)}>{tr("取消")}</button><button type="button" disabled={busy} onClick={() => void cleanup()}>{tr("确认清理")}</button></div></section></div>}
  </section>;
}
