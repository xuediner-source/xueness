import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookText, List, Maximize2, Minus, Moon, Plus, RefreshCw, Search, Sparkles, X } from "lucide-react";
import { MemoryOceanDreamDrawer } from "./MemoryOceanDreamDrawer";
import { t as tr, tf } from "../../i18n";
import { ago, eventKey, forgetMemories, forgetMemory, kindLabel, loadOcean, OCEAN_KINDS, updateMemory, type OceanKind, type OceanNode, type OceanView } from "./oceanApi";
import { currentMood, kindColor, prefersReducedMotion, type OceanMood } from "./oceanPalette";
import { OceanScene } from "./oceanScene";
import type { MemoryTrack } from "../../xuenessWorkspace";
import { MemoryOceanDetail } from "./MemoryOceanDetail";
import { MemoryOceanEditor } from "./MemoryOceanEditor";
import { MemoryOceanListDrawer } from "./MemoryOceanListDrawer";
import { MemoryPanel } from "./MemoryPanel";
import { XuenessMemoryEditor } from "./index";
import "./memory-ocean.css";

const POLL_MS = 15_000;
/** On opening, saves and recalls this recent are replayed so the last conversation's memories light up. */
const REPLAY_MS = 30 * 60_000;
const REPLAY_MAX = 8;
/** Put the hover tip beside the pointer, flipped to stay inside the stage. */
function placeTip(element: HTMLElement | null, at: { x: number; y: number }): void {
  const stage = element?.parentElement;
  if (!element || !stage) return;
  const x = at.x + 16 + element.offsetWidth > stage.clientWidth ? Math.max(0, at.x - 12 - element.offsetWidth) : at.x + 16;
  const y = at.y + 14 + element.offsetHeight > stage.clientHeight ? Math.max(0, at.y - 10 - element.offsetHeight) : at.y + 14;
  element.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
}

/** Room the detail card takes on the right (its width plus margin); below 720px it is a bottom sheet. */
const cardInset = (): number => window.innerWidth > 720 ? 392 : 0;

/**
 * Memory Ocean: every saved memory as a light in a night sea. Related memories
 * are joined by lines and gather into constellations; fresh memories float
 * near the surface and old ones sink. Saves and recalls made by the agent
 * appear live (the view polls while visible). `tracks` is the state of the
 * optional curated memory tracks, whose panel and editor open in a drawer.
 */
export function MemoryOcean({ workspaceRoot, tracks }: { workspaceRoot?: string; tracks?: { value: MemoryTrack[]; error?: string; loading?: boolean } }): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<OceanScene | null>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const hoverAt = useRef({ x: 0, y: 0 });
  const shown = useRef(true);
  const signature = useRef("");
  const seen = useRef<Set<string> | null>(null);
  const fly = useRef(false);
  const [view, setView] = useState<OceanView | null>(null);
  const [error, setError] = useState("");
  const [scope, setScope] = useState<"here" | "all">("all");
  const [kinds, setKinds] = useState<ReadonlySet<OceanKind>>(new Set());
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [editing, setEditing] = useState<OceanNode | "new" | null>(null);
  const [drawer, setDrawer] = useState<"list" | "tracks" | "dream" | null>(null);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(() => new Set());
  const [mood, setMood] = useState<OceanMood>(currentMood);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const scene = new OceanScene(canvas, {
      // The tip follows the pointer by a transform on its element; React renders only when the hovered memory changes.
      hover: (id, at) => { if (at) { hoverAt.current = at; placeTip(tipRef.current, at); } setHoverId(id && at ? id : null); },
      select: (id) => { fly.current = false; setSelected(id); },
      clusterName: (cluster) => cluster.label ? `#${cluster.label}` : kindLabel(cluster.kind),
    });
    sceneRef.current = scene;
    const sync = (): void => { const next = currentMood(); setMood(next); scene.setMood(next); scene.setReducedMotion(prefersReducedMotion()); };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-xn-palette", "data-xn-motion"] });
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    media?.addEventListener("change", sync);
    // Off screen (another panel, a scrolled-away page) the scene stops drawing and the view stops polling.
    const stage = stageRef.current;
    const sight = typeof IntersectionObserver === "function" && stage ? new IntersectionObserver(([entry]) => {
      const visible = entry?.isIntersecting ?? true, was = shown.current;
      shown.current = visible; scene.setShown(visible);
      if (visible && !was) void refreshRef.current();
    }) : null;
    if (sight && stage) sight.observe(stage);
    return () => { observer.disconnect(); sight?.disconnect(); media?.removeEventListener("change", sync); scene.destroy(); sceneRef.current = null; };
  }, []);

  const refresh = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      const next = await loadOcean(workspaceRoot, signal);
      if (signal?.aborted) return;
      // Most polls bring nothing new: leave the layout, the scene and React alone then.
      const mark = JSON.stringify(next);
      if (mark === signature.current) { setError(""); return; }
      signature.current = mark;
      const scene = sceneRef.current;
      scene?.setView(next);
      const now = Date.now(), first = seen.current === null;
      const fresh = next.events.filter((event) => first ? now - Date.parse(event.at) < REPLAY_MS : !seen.current!.has(eventKey(event)));
      seen.current = new Set(next.events.map(eventKey));
      const present = new Set(next.nodes.map((node) => node.id));
      // Newest first, and only a handful: an opening replay should glint, not flood the sea.
      const ids = (kind: string): string[] => [...new Set(fresh.filter((event) => event.kind === kind).reverse().flatMap((event) => event.ids).filter((id) => present.has(id)))].slice(0, first ? REPLAY_MAX : 24);
      scene?.birth(ids("remember"));
      scene?.pulse(ids("recall"));
      setView(next); setError("");
    } catch (failure) {
      if (!signal?.aborted) setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, [workspaceRoot]);

  const refreshRef = useRef<() => Promise<void>>(() => Promise.resolve());
  useEffect(() => {
    const controller = new AbortController();
    refreshRef.current = () => refresh(controller.signal);
    void refresh(controller.signal);
    const timer = window.setInterval(() => { if (!document.hidden && shown.current) void refresh(controller.signal); }, POLL_MS);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [refresh]);

  useEffect(() => { sceneRef.current?.setFilter({ scope, kinds, query }); }, [scope, kinds, query]);
  useEffect(() => {
    sceneRef.current?.setInset(selected ? cardInset() : 0);
    sceneRef.current?.select(selected, fly.current);
    fly.current = false;
  }, [selected]);

  const choose = (id: string | null): void => { fly.current = true; setSelected(id); };
  const node = view?.nodes.find((item) => item.id === selected) ?? null;
  const hovered = hoverId ? view?.nodes.find((item) => item.id === hoverId) : undefined;
  const recallsToday = useMemo(() => (view?.events ?? []).filter((event) => event.kind === "recall" && Date.now() - Date.parse(event.at) < 86_400_000).reduce((sum, event) => sum + event.ids.length, 0), [view]);
  const listOpen = drawer === "list";
  const listed = useMemo(() => {
    if (!listOpen) return [];
    const words = query.toLowerCase().split(/\s+/u).filter(Boolean);
    return (view?.nodes ?? []).filter((item) => (scope === "all" || item.here) && (!kinds.size || kinds.has(item.kind))
      && words.every((word) => `${item.summary}\n${item.text}\n${item.tags.join(" ")}`.toLowerCase().includes(word)))
      .sort((a, b) => Number(a.status === "archived") - Number(b.status === "archived") || b.importance - a.importance || b.updatedAt.localeCompare(a.updatedAt));
  }, [view, scope, kinds, query, listOpen]);

  useEffect(() => {
    if (!view) return;
    const deletable = new Set(view.nodes.filter((item) => item.origin !== "curated").map((item) => item.id));
    setCheckedIds((current) => {
      if (current.size === 0) return current;
      const next = new Set([...current].filter((id) => deletable.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [view]);

  const act = async (work: () => Promise<unknown>, after?: () => void): Promise<void> => {
    setBusy(true);
    try { await work(); after?.(); await refresh(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  const toggleDrawer = (target: "list" | "tracks" | "dream"): void => {
    const next = drawer === target ? null : target;
    setDrawer(next);
    if (next !== "list") setCheckedIds(new Set());
  };
  const toggleChecked = (id: string, checked: boolean): void => {
    setCheckedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(id); else next.delete(id);
      return next;
    });
  };
  const toggleCheckedAll = (ids: readonly string[], checked: boolean): void => {
    setCheckedIds((current) => {
      const next = new Set(current);
      for (const id of ids) { if (checked) next.add(id); else next.delete(id); }
      return next;
    });
  };
  const forgetChecked = async (ids: readonly string[]): Promise<void> => {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    await act(() => forgetMemories(ids), () => {
      setCheckedIds((current) => new Set([...current].filter((id) => !idSet.has(id))));
      if (selected && idSet.has(selected)) setSelected(null);
    });
  };
  const toggleKind = (kind: OceanKind): void => setKinds((current) => { const next = new Set(current); if (next.has(kind)) next.delete(kind); else next.add(kind); return next; });
  const empty = !!view && !view.nodes.length;

  return <section className="xn-ocean" data-mood={mood} aria-label={tr("记忆之海")}>
    <header className="xn-ocean__head">
      <div className="xn-ocean__title">
        <h2><Sparkles size={16} aria-hidden="true" />{tr("记忆之海")}</h2>
        <p>{view ? tf("{0} 段记忆 · {1} 个星座 · 近 24 小时召回 {2} 次", [view.stats.active, view.clusters.length, recallsToday]) : tr("正在潜入……")}</p>
      </div>
      <div className="xn-ocean__tools">
        <label className="xn-ocean__search"><Search size={14} aria-hidden="true" />
          <input type="search" value={query} placeholder={tr("搜索记忆")} aria-label={tr("搜索记忆")} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <div className="xn-ocean__segment" role="group" aria-label={tr("范围")}>
          <button type="button" aria-pressed={scope === "here"} disabled={!workspaceRoot} title={view?.project?.label} onClick={() => setScope("here")}>{tr("此项目")}</button>
          <button type="button" aria-pressed={scope === "all"} onClick={() => setScope("all")}>{tr("全部")}</button>
        </div>
        <button type="button" className="xn-ocean-button" aria-pressed={drawer === "list"} aria-label={tr("列表")} title={tr("记忆列表与批量管理")} onClick={() => toggleDrawer("list")}><List size={14} aria-hidden="true" />{tr("列表")}</button>
        <button type="button" className="xn-ocean-icon" aria-pressed={drawer === "dream"} aria-label={tr("记忆整理")} title={tr("记忆整理：从最近的对话里合并、更正和补充记忆")} onClick={() => toggleDrawer("dream")}><Moon size={15} aria-hidden="true" /></button>
        {tracks && <button type="button" className="xn-ocean-icon" aria-pressed={drawer === "tracks"} aria-label={tr("记忆轨道")} title={tr("记忆轨道")} onClick={() => toggleDrawer("tracks")}><BookText size={16} aria-hidden="true" /></button>}
        <button ref={addButtonRef} type="button" className="xn-ocean-button xn-ocean-button--primary" onClick={() => setEditing("new")}><Plus size={14} aria-hidden="true" />{tr("记住一件事")}</button>
      </div>
    </header>

    <div ref={stageRef} className="xn-ocean__stage">
    <canvas ref={canvasRef} className="xn-ocean__canvas" tabIndex={0} role="application" aria-roledescription={tr("记忆星图")}
      aria-label={tr("记忆星图：拖动平移，滚轮或双指缩放，方向键移动，+ 和 - 缩放，0 回到全景，点击光点查看记忆")} />

    {drawer === "list" && <MemoryOceanListDrawer listed={listed} selected={selected} checkedIds={checkedIds} mood={mood} busy={busy}
      onClose={() => toggleDrawer("list")} onSelect={(id) => choose(id)} onToggle={toggleChecked} onToggleAll={toggleCheckedAll} onForgetMany={forgetChecked} />}

    {drawer === "dream" && <MemoryOceanDreamDrawer workspaceRoot={workspaceRoot} onClose={() => setDrawer(null)} onApplied={() => void refresh()} />}

    {drawer === "tracks" && <aside className="xn-ocean-drawer xn-ocean-drawer--tracks" aria-label={tr("记忆轨道")}>
      <header><h3>{tr("记忆轨道")}</h3><button type="button" className="xn-ocean-icon" aria-label={tr("关闭")} onClick={() => setDrawer(null)}><X size={16} aria-hidden="true" /></button></header>
      <div className="xn-ocean-drawer__body">{tracks && <MemoryPanel tracks={tracks.value} error={tracks.error} loading={tracks.loading} />}<XuenessMemoryEditor /></div>
    </aside>}

    {node && view && <MemoryOceanDetail node={node} view={view} mood={mood} busy={busy} onClose={() => setSelected(null)} onSelect={choose}
      onEdit={() => setEditing(node)} onForget={() => void act(() => forgetMemory(node.id), () => setSelected(null))}
      onRestore={() => void act(() => updateMemory(node.id, { version: node.version, status: "active" }))} />}

    {hovered && hovered.id !== selected && <div className="xn-ocean-tip" ref={(element) => { tipRef.current = element; placeTip(element, hoverAt.current); }} aria-hidden="true">
      <span className="xn-ocean-chip"><span className="xn-ocean-dot" style={{ background: kindColor(mood, hovered.origin === "curated" ? "curated" : hovered.kind) }} />{kindLabel(hovered.kind)}</span>
      <strong>{hovered.summary}</strong>
      {hovered.tags.length > 0 && hovered.origin !== "curated" && <small>{hovered.tags.map((tag) => `#${tag}`).join(" ")}</small>}
    </div>}

    <div className="xn-ocean__zoom" role="group" aria-label={tr("缩放")}>
      <button type="button" className="xn-ocean-icon" aria-label={tr("缩小")} onClick={() => sceneRef.current?.zoomBy(0.8)}><Minus size={15} aria-hidden="true" /></button>
      <button type="button" className="xn-ocean-icon" aria-label={tr("回到全景")} onClick={() => sceneRef.current?.fit()}><Maximize2 size={14} aria-hidden="true" /></button>
      <button type="button" className="xn-ocean-icon" aria-label={tr("放大")} onClick={() => sceneRef.current?.zoomBy(1.25)}><Plus size={15} aria-hidden="true" /></button>
    </div>

    {empty && !error && <div className="xn-ocean__empty">
      <h3>{tr("海面还很平静")}</h3>
      <p>{tr("在对话里对智能体说「记住……」，或者点「记住一件事」。它学到的偏好、决定和教训会在这里亮起，相关的记忆会连成星座。")}</p>
      <button type="button" className="xn-ocean-button xn-ocean-button--primary" onClick={() => setEditing("new")}><Plus size={14} aria-hidden="true" />{tr("记住一件事")}</button>
    </div>}
    {error && <div className="xn-ocean__error" role="alert">
      <p>{tf("记忆之海暂时无法加载：{0}", [error])}</p>
      <button type="button" className="xn-ocean-button" onClick={() => void refresh()}><RefreshCw size={14} aria-hidden="true" />{tr("重新加载")}</button>
    </div>}
    </div>

    <footer className="xn-ocean__legend" role="group" aria-label={tr("按类型筛选")}>
      {OCEAN_KINDS.map((kind) => <button key={kind} type="button" aria-pressed={kinds.has(kind)} data-dim={kinds.size > 0 && !kinds.has(kind) || undefined} onClick={() => toggleKind(kind)}>
        <span className="xn-ocean-dot" style={{ background: kindColor(mood, kind) }} aria-hidden="true" />
        {kindLabel(kind)}<small>{view?.stats.kinds[kind] ?? 0}</small>
      </button>)}
    </footer>

    {editing && <MemoryOceanEditor node={editing === "new" ? null : editing} mood={mood} workspaceRoot={workspaceRoot} returnFocusTo={addButtonRef.current}
      onClose={() => setEditing(null)} onSaved={(id) => { setEditing(null); void refresh().then(() => choose(id)); }} />}
  </section>;
}
