/**
 * The Swarm pane's mention graph: who wrote to whom, as stars and lit links
 * on the night sea (drawn by `swarmGraphScene.ts` with Memory Ocean's
 * primitives). Live, each new post sends comets from its sender to its
 * recipients; the replay slider rebuilds the graph post by post and plays it.
 */
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { t as tr, tf } from "../../i18n";
import { OceanBloom } from "../memory/oceanBloom";
import { prefersReducedMotion } from "../memory/oceanPalette";
import { broadcastCounts, COMET_SECONDS, drawScene, edgeCounts, layout, ROLE_COLORS, type Comet } from "./swarmGraphScene";

const ROLE_TEXT = { coordinator: "协调者", worker: "工作者", verifier: "验证者" } as const;

export interface SwarmGraphMember { name: string; role: "coordinator" | "worker" | "verifier"; state: string }
export interface SwarmGraphPost {
  seq: number; from: string; recipients: string[]; kind: string; at: string;
  to?: { all?: boolean; names?: string[]; groups?: string[] }; text?: string; channel?: string;
}
export interface SwarmGraphProps { members: SwarmGraphMember[]; posts: SwarmGraphPost[]; running: string[] }

/** Base seconds per post while replaying at 1×. */
const REPLAY_STEP = 0.9;
const SPEEDS = [0.5, 1, 2, 4] as const;

export function SwarmGraph({ members, posts, running }: SwarmGraphProps): React.JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 640, height: 420 });
  /** null: live; a number: the replay shows posts up to this seq. */
  const [shown, setShown] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(1);
  const [hideInactive, setHideInactive] = useState(false);
  const [expandAll, setExpandAll] = useState(false);
  const maxSeq = posts.at(-1)?.seq ?? 0;
  const upTo = shown ?? maxSeq;
  const reduced = useMemo(() => prefersReducedMotion(), []);
  const edges = useMemo(() => edgeCounts(posts, upTo, expandAll), [posts, upTo, expandAll]);
  const broadcasts = useMemo(() => expandAll ? new Map<string, number>() : broadcastCounts(posts, upTo), [posts, upTo, expandAll]);
  const visibleMembers = useMemo(() => {
    if (!hideInactive) return members;
    const touched = new Set<string>();
    for (const p of posts) {
      if (p.seq > upTo) break;
      touched.add(p.from);
      for (const r of p.recipients) touched.add(r);
    }
    return members.filter(m => m.role === "coordinator" || running.includes(m.name) || m.state === "active" || touched.has(m.name));
  }, [members, posts, upTo, running, hideInactive]);
  const placed = useMemo(() => layout(visibleMembers.map((member) => ({ ...member, running: running.includes(member.name) })), size.width, size.height), [visibleMembers, running, size]);
  const state = useRef({ comets: [] as Comet[], seen: maxSeq, clock: 0, placed, edges, broadcasts });
  state.current.placed = placed; state.current.edges = edges; state.current.broadcasts = broadcasts;

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.max(280, Math.round(entry!.contentRect.width));
      setSize({ width, height: Math.max(300, Math.min(560, Math.round(width * 0.62))) });
    });
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  const emitComets = (post: SwarmGraphPost, current: typeof state.current) => {
    const targets = !expandAll && post.to?.all ? post.recipients.filter(r => (post.to?.names ?? []).includes(r)) : post.recipients;
    for (const to of targets) current.comets.push({ from: post.from, to, born: current.clock, seq: post.seq });
  };

  // Live: comets for posts that arrived since the last render.
  useEffect(() => {
    const current = state.current;
    if (shown !== null) return;
    for (const post of posts) if (post.seq > current.seen) emitComets(post, current);
    current.seen = Math.max(current.seen, maxSeq);
  }, [posts, maxSeq, shown, expandAll]);

  // Replay: one post per step; comets for the post just reached.
  useEffect(() => {
    if (!playing || shown === null) return;
    if (shown >= maxSeq) { setPlaying(false); return; }
    const timer = window.setTimeout(() => {
      const next = shown + 1;
      const post = posts.find((item) => item.seq === next);
      if (post) emitComets(post, state.current);
      setShown(next);
    }, (REPLAY_STEP * 1000) / speed);
    return () => window.clearTimeout(timer);
  }, [playing, shown, maxSeq, posts, speed, expandAll]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(size.width * ratio); canvas.height = Math.round(size.height * ratio);
    const context = canvas.getContext("2d");
    if (!context) return;
    const bloom = new OceanBloom();
    const labels: Record<string, string> = { user: tr("你"), system: tr("系统") };
    let frame = 0, last = performance.now();
    const paint = (now: number): void => {
      const delta = Math.min(0.25, (now - last) / 1000); last = now;
      const current = state.current;
      if (!reduced) current.clock += delta;
      current.comets = current.comets.filter((comet) => current.clock - comet.born < COMET_SECONDS);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      drawScene({ context, bloom, width: size.width, height: size.height, ratio, time: current.clock, delta, reduced, placed: current.placed, edges: current.edges, broadcasts: current.broadcasts, comets: current.comets, labels });
      if (!reduced) frame = requestAnimationFrame(paint);
    };
    frame = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(frame);
  }, [size, reduced, placed, edges, broadcasts]);

  const stepTo = (seq: number) => {
    setPlaying(false);
    const clamped = Math.max(0, Math.min(maxSeq, seq));
    const post = posts.find(item => item.seq === clamped);
    if (post && clamped > upTo) emitComets(post, state.current);
    setShown(clamped >= maxSeq ? null : clamped);
  };

  const activePost = posts.find(p => p.seq === upTo);
  const total = [...edges.values()].reduce((sum, edge) => sum + edge.count, 0);
  const summary = tf("{0} 位成员，显示到第 {1} 条帖子，共 {2} 次提及。", [visibleMembers.length, upTo, total]);
  return (
    <div className="xn-swarm-graph" ref={wrapRef}>
      <canvas ref={canvasRef} className="xn-swarm-graph-canvas" style={{ width: size.width, height: size.height }} role="img" aria-label={summary} />
      <div className="xn-swarm-graph-controls">
        <button type="button" className="xn-swarm-graph-button" disabled={!maxSeq}
          onClick={() => { if (playing) { setPlaying(false); return; } state.current.comets = []; setShown(shown === null || shown >= maxSeq ? 0 : shown); setPlaying(true); }}>
          {playing ? tr("暂停") : tr("回放")}
        </button>
        <button type="button" className="xn-swarm-graph-button" disabled={!maxSeq || upTo <= 0} aria-label={tr("上一步")} onClick={() => stepTo(upTo - 1)}>←</button>
        <button type="button" className="xn-swarm-graph-button" disabled={!maxSeq || upTo >= maxSeq} aria-label={tr("下一步")} onClick={() => stepTo(upTo + 1)}>→</button>
        <input type="range" min={0} max={maxSeq} value={upTo} aria-label={tr("回放到第几条帖子")} disabled={!maxSeq}
          onChange={(event) => { setPlaying(false); const value = Number(event.currentTarget.value); setShown(value >= maxSeq ? null : value); }} />
        <select aria-label={tr("回放速度")} value={speed} onChange={e => setSpeed(Number(e.currentTarget.value))}>
          {SPEEDS.map(v => <option key={v} value={v}>{v}×</option>)}
        </select>
        <span className="xn-swarm-graph-seq">{shown === null ? tr("实时") : `#${shown} / ${maxSeq}`}</span>
        <button type="button" className="xn-swarm-graph-button" disabled={shown === null} onClick={() => { setPlaying(false); setShown(null); }}>{tr("回到实时")}</button>
      </div>
      <div className="xn-swarm-graph-toggles">
        <label className="xn-swarm-check"><input type="checkbox" checked={hideInactive} onChange={e => setHideInactive(e.currentTarget.checked)} /> {tr("隐藏空闲成员")}</label>
        <label className="xn-swarm-check"><input type="checkbox" checked={expandAll} onChange={e => setExpandAll(e.currentTarget.checked)} /> {tr("展开 @all 广播")}</label>
      </div>
      {activePost && <p className="xn-swarm-graph-caption">
        <strong>#{activePost.seq} @{activePost.from}</strong>
        {activePost.channel && activePost.channel !== "main" ? ` #${activePost.channel}` : ""}
        {activePost.text ? `：${Array.from(activePost.text).slice(0, 140).join("")}` : ""}
      </p>}
      <ul className="xn-swarm-graph-legend" aria-label={tr("图例")}>
        {(["coordinator", "worker", "verifier"] as const).map(role => <li key={role} style={{ "--dot": `rgb(${ROLE_COLORS[role].join(", ")})` } as React.CSSProperties}>{tr(ROLE_TEXT[role])}</li>)}
        <li>{tr("闪烁：正在工作")}</li>
        <li>{tr("虚线：@all 广播")}</li>
      </ul>
      <p className="xn-swarm-graph-summary">{summary}</p>
    </div>
  );
}
