/**
 * The Swarm pane for the current conversation: its swarms, their status,
 * and three views — the shared board, the members, and the mention graph.
 * Polls every two seconds only while the pane is mounted, the page is visible
 * and the swarm plugin is effective; the board is fetched incrementally.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { t as tr, tf, useLocale } from "../../i18n";
import { SwarmBoard } from "./SwarmBoard";
import { SwarmGraph } from "./SwarmGraph";
import { SwarmMembers } from "./SwarmMembers";
import { canResume, canStop, listSwarms, readBoard, readSwarm, resumeSwarm, stopSwarm, STATUS_LABELS, type BoardPost, type SwarmDetail, type SwarmSummary } from "./swarmApi";
import "./swarm.css";

type Tab = "board" | "members" | "graph";
const TABS: [Tab, string][] = [["board", "看板"], ["members", "成员"], ["graph", "关系图"]];
const POLL_MS = 2000;
const message = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);

const PAUSE_REASONS: Record<string, string> = {
  server_restart: "Xueness 重启或运行它的进程已结束",
  plugin_disabled: "蜂群插件被关闭",
  wall_clock: "达到总时长上限",
  idle: "全员停下且协调者没有结束",
  coordinator_quota: "协调者触及限额或速率限制",
  coordinator_error: "协调者运行出错",
  coordinator_unavailable: "协调者不可用或已达到轮次上限",
};

export function SwarmPanel({ enabled, sessionId }: { enabled: boolean; sessionId: string | null }): React.JSX.Element {
  useLocale();
  const [swarms, setSwarms] = useState<SwarmSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<SwarmDetail | null>(null);
  const [running, setRunning] = useState<string[]>([]);
  const [posts, setPosts] = useState<BoardPost[]>([]);
  const [tab, setTab] = useState<Tab>("board");
  const [focusSeq, setFocusSeq] = useState<{ seq: number; n: number } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const lastSeq = useRef(0);

  useEffect(() => { setSelected(null); setDetail(null); setPosts([]); setSwarms([]); setLoaded(false); setFocusSeq(null); lastSeq.current = 0; }, [sessionId]);
  useEffect(() => { setDetail(null); setPosts([]); setFocusSeq(null); lastSeq.current = 0; }, [selected]);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!enabled || !sessionId) return;
    try {
      const list = await listSwarms(sessionId, signal);
      setSwarms(list); setLoaded(true);
      const id = selected && list.some(item => item.id === selected) ? selected : list[0]?.id ?? null;
      if (id !== selected) { setSelected(id); return; }
      if (!id) return;
      const [view, board] = await Promise.all([readSwarm(sessionId, id, signal), readBoard(sessionId, id, lastSeq.current, signal)]);
      setDetail(view.swarm); setRunning(view.running);
      if (board.posts.length) { lastSeq.current = board.posts.at(-1)!.seq; setPosts(current => [...current, ...board.posts.filter(post => post.seq > (current.at(-1)?.seq ?? 0))]); }
      setError("");
    } catch (cause) { if (!signal?.aborted) setError(message(cause)); }
  }, [enabled, sessionId, selected]);

  useEffect(() => {
    if (!enabled || !sessionId) return undefined;
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(controller.signal); }, POLL_MS);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [enabled, sessionId, refresh]);

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true); setError("");
    try { await action(); await refresh(); } catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  };

  if (!enabled) return <p className="xn-swarm-empty">{tr("蜂群插件已关闭。")}</p>;
  if (!sessionId) return <p className="xn-swarm-empty">{tr("打开一个对话后，这里显示它的蜂群。")}</p>;
  if (loaded && !swarms.length) return <div className="xn-swarm-empty">
    <p>{tr("这个对话还没有蜂群。")}</p>
    <p>{tr("让模型用蜂群完成可以拆开的任务时，它会用 swarm_start 提出计划：协调者、各自拥有路径的工作者、可选的验证者。你批准一次计划后，蜂群在后台工作，这里显示看板、成员和关系图。")}</p>
  </div>;
  const status = detail?.status ?? swarms.find(item => item.id === selected)?.status;
  const counts = detail ? detail.members.reduce((acc, m) => {
    const st = running.includes(m.name) ? "active" : m.state;
    acc[st] = (acc[st] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>) : {};
  const alerts = detail?.systemAttention ?? [];
  return <section className="xn-swarm" data-testid="swarm-panel">
    <header className="xn-swarm__header">
      {swarms.length > 1 && <select aria-label={tr("选择蜂群")} value={selected ?? ""} onChange={event => setSelected(event.currentTarget.value)}>
        {swarms.map(item => <option key={item.id} value={item.id}>{`${(item.title || item.goal).slice(0, 40)} · ${tr(STATUS_LABELS[item.status])}`}</option>)}
      </select>}
      {status && <span className="xn-swarm-chip" data-tone={status}>{tr(STATUS_LABELS[status])}</span>}
      {detail && <div className="xn-swarm__titlewrap">
        {detail.title && <strong className="xn-swarm__title">{detail.title}</strong>}
        <p className="xn-swarm__goal">{detail.goal}</p>
      </div>}
      <div className="xn-swarm__actions">
        {detail && status && canResume(status) && <button type="button" disabled={busy} onClick={() => void act(() => resumeSwarm(sessionId, detail.id))}>{tr("继续")}</button>}
        {detail && status && canStop(status) && <button type="button" disabled={busy} onClick={() => { if (window.confirm(tr("停止这个蜂群？成员会在当前一步后停下。"))) void act(() => stopSwarm(sessionId, detail.id, tr("用户在蜂群面板中停止"))); }}>{tr("停止")}</button>}
      </div>
    </header>
    {detail && <div className="xn-swarm__stats">
      {counts.active ? <span className="xn-swarm-chip" data-tone="active">{tf("{0} 工作中", [counts.active])}</span> : null}
      {counts.waiting ? <span className="xn-swarm-chip" data-tone="waiting">{tf("{0} 等待", [counts.waiting])}</span> : null}
      {counts.done ? <span className="xn-swarm-chip" data-tone="done">{tf("{0} 已完成", [counts.done])}</span> : null}
      {counts.killed ? <span className="xn-swarm-chip" data-tone="killed">{tf("{0} 已停止", [counts.killed])}</span> : null}
      <span className="xn-swarm-muted">{tf("共 {0} 条帖子", [posts.length])}</span>
    </div>}
    {alerts.length > 0 && <ul className="xn-swarm-attention" aria-label={tr("需要注意")}>
      {alerts.map(alert => <li key={alert.id} data-kind={alert.kind}>
        <span className="xn-swarm-chip" data-tone={alert.kind === "quota" || alert.kind === "error" ? "failed" : "paused"}>{alert.kind === "quota" ? tr("限额/限流") : alert.kind === "error" ? tr("错误") : tr("未回复")}</span>
        <span>{alert.text}</span>
        {alert.seq ? <button type="button" onClick={() => { setFocusSeq({ seq: alert.seq!, n: Date.now() }); setTab("board"); }}>{tf("查看 #{0}", [alert.seq])}</button>
          : <button type="button" onClick={() => setTab("members")}>{tr("处理成员")}</button>}
      </li>)}
    </ul>}
    {detail?.pauseReason && <p className="xn-swarm-muted">{tf("原因：{0}", [PAUSE_REASONS[detail.pauseReason] ? tr(PAUSE_REASONS[detail.pauseReason]!) : detail.pauseReason])}</p>}
    {detail?.outcome && <p className="xn-swarm-outcome" data-status={detail.outcome.status}>{detail.outcome.summary}</p>}
    {detail?.verification && <p className="xn-swarm-verdict" data-verdict={detail.verification.verdict}>{tf("验证结论：{0}", [detail.verification.verdict === "pass" ? tr("通过") : tr("未通过")])} {String(detail.verification.findings ?? "")}</p>}
    {!!detail?.acceptance?.length && <ol className="xn-swarm-criteria" aria-label={tr("验收标准")}>
      {detail.acceptance.map((item, index) => {
        const graded = detail.verification?.criteria?.find((entry) => entry.criterion === index + 1);
        return <li key={index} data-met={graded ? String(graded.met) : undefined}>
          <span className="xn-swarm-criteria__state">{graded ? (graded.met ? tr("满足") : tr("未满足")) : tr("待评定")}</span>
          <span>{item}{graded?.evidence ? <small>{graded.evidence}</small> : null}</span>
        </li>;
      })}
    </ol>}
    {error && <p className="xn-swarm-error" role="alert">{error}</p>}
    <div className="xn-swarm__tabs" role="tablist" aria-label={tr("蜂群视图")}>
      {TABS.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{tr(label)}</button>)}
    </div>
    <div className="xn-swarm__body" role="tabpanel">
      {!detail ? <p role="status">{tr("正在读取蜂群…")}</p>
        : tab === "board" ? <SwarmBoard sessionId={sessionId} swarmId={detail.id} posts={posts} channels={detail.channels} focusSeq={focusSeq} canPost={!["completed", "failed", "cancelled"].includes(detail.status)} onPosted={() => void refresh()} />
          : tab === "members" ? <SwarmMembers sessionId={sessionId} swarmId={detail.id} members={detail.members} running={running} active={!["completed", "failed", "cancelled"].includes(detail.status)} onChanged={() => void refresh()} />
            : <SwarmGraph members={detail.members} posts={posts} running={running} />}
    </div>
  </section>;
}

export default SwarmPanel;
