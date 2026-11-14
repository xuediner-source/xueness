import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookText, List, Maximize2, Minus, Plus, RefreshCw, Search, Sparkles, X } from "lucide-react";
import { t as tr, tf } from "../../i18n";
import { ago, eventKey, forgetMemory, kindLabel, loadOcean, OCEAN_KINDS, updateMemory, type OceanKind, type OceanNode, type OceanView } from "./oceanApi";
import { currentMood, kindColor, prefersReducedMotion, type OceanMood } from "./oceanPalette";
import { OceanScene } from "./oceanScene";
import type { MemoryTrack } from "../../xuenessWorkspace";
import { MemoryOceanDetail } from "./MemoryOceanDetail";
import { MemoryOceanEditor } from "./MemoryOceanEditor";
import { MemoryPanel } from "./MemoryPanel";
import { XuenessMemoryEditor } from "./index";
import "./memory-ocean.css";

const POLL_MS = 15_000;
/** On opening, saves and recalls this recent are replayed so the last conversation's memories light up. */
const REPLAY_MS = 30 * 60_000;
const REPLAY_MAX = 8;
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
  const headerRef = useRef<HTMLElement>(null);
  const seen = useRef<Set<string> | null>(null);
  const fly = useRef(false);
  const [view, setView] = useState<OceanView | null>(null);
  const [error, setError] = useState("");
  const [scope, setScope] = useState<"here" | "all">("all");
  const [kinds, setKinds] = useState<ReadonlySet<OceanKind>>(new Set());
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);
  const [editing, setEditing] = useState<OceanNode | "new" | null>(null);
  const [drawer, setDrawer] = useState<"list" | "tracks" | null>(null);
  const [mood, setMood] = useState<OceanMood>(currentMood);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const scene = new OceanScene(canvas, {
      hover: (id, at) => setHover(id && at ? { id, ...at } : null),
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
    // The header wraps on narrow widths; the scene frames the ocean below whatever it covers.
    const header = headerRef.current;
    const measure = (): void => { if (header) scene.setTopInset(header.offsetTop + header.offsetHeight + 12); };
    measure();
    const sizes = new ResizeObserver(measure);
    if (header) sizes.observe(header);
    return () => { observer.disconnect(); sizes.disconnect(); media?.removeEventListener("change", sync); scene.destroy(); sceneRef.current = null; };
  }, []);

  const refresh = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      const next = await loadOcean(workspaceRoot, signal);
      if (signal?.aborted) return;
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

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(controller.signal); }, POLL_MS);
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
  const hovered = hover && view?.nodes.find((item) => item.id === hover.id);
  const recallsToday = useMemo(() => (view?.events ?? []).filter((event) => event.kind === "recall" && Date.now() - Date.parse(event.at) < 86_400_000).reduce((sum, event) => sum + event.ids.length, 0), [view]);
  const listed = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/u).filter(Boolean);
    return (view?.nodes ?? []).filter((item) => (scope === "all" || item.here) && (!kinds.size || kinds.has(item.kind))
      && words.every((word) => `${item.summary}\n${item.text}\n${item.tags.join(" ")}`.toLowerCase().includes(word)))
      .sort((a, b) => Number(a.status === "archived") - Number(b.status === "archived") || b.importance - a.importance || b.updatedAt.localeCompare(a.updatedAt));
  }, [view, scope, kinds, query]);

  const act = async (work: () => Promise<unknown>, after?: () => void): Promise<void> => {
    setBusy(true);
    try { await work(); after?.(); await refresh(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  const toggleKind = (kind: OceanKind): void => setKinds((current) => { const next = new Set(current); if (next.has(kind)) next.delete(kind); else next.add(kind); return next; });
  const empty = !!view && !view.nodes.length;

  return <section className="xn-ocean" data-mood={mood} aria-label={tr("记忆之海")}>
    <canvas ref={canvasRef} className="xn-ocean__canvas" tabIndex={0} role="application" aria-roledescription={tr("记忆星图")}
      aria-label={tr("记忆星图：拖动平移，滚轮或双指缩放，方向键移动，+ 和 - 缩放，0 回到全景，点击光点查看记忆")} />
    <header ref={headerRef} className="xn-ocean__head">
      <div className="xn-ocean__title">
        <h2><Sparkles size={18} aria-hidden="true" />{tr("记忆之海")}</h2>
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
        <button type="button" className="xn-ocean-icon" aria-pressed={drawer === "list"} aria-label={tr("列表")} title={tr("列表")} onClick={() => setDrawer(drawer === "list" ? null : "list")}><List size={16} aria-hidden="true" /></button>
        {tracks && <button type="button" className="xn-ocean-icon" aria-pressed={drawer === "tracks"} aria-label={tr("记忆轨道")} title={tr("记忆轨道")} onClick={() => setDrawer(drawer === "tracks" ? null : "tracks")}><BookText size={16} aria-hidden="true" /></button>}
        <button ref={addButtonRef} type="button" className="xn-ocean-button xn-ocean-button--primary" onClick={() => setEditing("new")}><Plus size={14} aria-hidden="true" />{tr("记住一件事")}</button>
      </div>
    </header>

    {drawer === "list" && <aside className="xn-ocean-drawer xn-ocean-drawer--list" aria-label={tr("记忆列表")}>
      <header><h3>{tf("{0} 段记忆", [listed.filter((item) => item.status === "active").length])}</h3><button type="button" className="xn-ocean-icon" aria-label={tr("关闭")} onClick={() => setDrawer(null)}><X size={16} aria-hidden="true" /></button></header>
      <ul>{listed.map((item) => <li key={item.id}><button type="button" aria-current={item.id === selected || undefined} data-archived={item.status === "archived" || undefined} onClick={() => choose(item.id)}>
        <span className="xn-ocean-dot" style={{ background: kindColor(mood, item.origin === "curated" ? "curated" : item.kind) }} aria-hidden="true" />
        <span><strong>{item.summary}</strong><small>{kindLabel(item.kind)} · {item.scope === "global" ? tr("所有项目") : item.project?.label} · {ago(item.updatedAt)}</small></span>
      </button></li>)}</ul>
    </aside>}

    {drawer === "tracks" && <aside className="xn-ocean-drawer xn-ocean-drawer--tracks" aria-label={tr("记忆轨道")}>
      <header><h3>{tr("记忆轨道")}</h3><button type="button" className="xn-ocean-icon" aria-label={tr("关闭")} onClick={() => setDrawer(null)}><X size={16} aria-hidden="true" /></button></header>
      <div className="xn-ocean-drawer__body">{tracks && <MemoryPanel tracks={tracks.value} error={tracks.error} loading={tracks.loading} />}<XuenessMemoryEditor /></div>
    </aside>}

    {node && view && <MemoryOceanDetail node={node} view={view} mood={mood} busy={busy} onClose={() => setSelected(null)} onSelect={choose}
      onEdit={() => setEditing(node)} onForget={() => void act(() => forgetMemory(node.id), () => setSelected(null))}
      onRestore={() => void act(() => updateMemory(node.id, { version: node.version, status: "active" }))} />}

    {hovered && hover && hovered.id !== selected && <div className="xn-ocean-tip" style={{ left: hover.x + 16, top: hover.y + 14 }} aria-hidden="true">
      <span className="xn-ocean-chip"><span className="xn-ocean-dot" style={{ background: kindColor(mood, hovered.origin === "curated" ? "curated" : hovered.kind) }} />{kindLabel(hovered.kind)}</span>
      <strong>{hovered.summary}</strong>
      {hovered.tags.length > 0 && hovered.origin !== "curated" && <small>{hovered.tags.map((tag) => `#${tag}`).join(" ")}</small>}
    </div>}

    <footer className="xn-ocean__legend" role="group" aria-label={tr("按类型筛选")}>
      {OCEAN_KINDS.map((kind) => <button key={kind} type="button" aria-pressed={kinds.has(kind)} data-dim={kinds.size > 0 && !kinds.has(kind) || undefined} onClick={() => toggleKind(kind)}>
        <span className="xn-ocean-dot" style={{ background: kindColor(mood, kind), boxShadow: `0 0 10px ${kindColor(mood, kind)}` }} aria-hidden="true" />
        {kindLabel(kind)}<small>{view?.stats.kinds[kind] ?? 0}</small>
      </button>)}
    </footer>
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

    {editing && <MemoryOceanEditor node={editing === "new" ? null : editing} mood={mood} workspaceRoot={workspaceRoot} returnFocusTo={addButtonRef.current}
      onClose={() => setEditing(null)} onSaved={(id) => { setEditing(null); void refresh().then(() => choose(id)); }} />}
  </section>;
}
