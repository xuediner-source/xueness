/**
 * The Memory Ocean canvas: camera, animation loop, effects and pointer
 * handling, independent of React. The page hands it data and filters and
 * hears back what is hovered or selected. Layers: the sea (`oceanAmbient`),
 * constellation clouds and charts (`oceanCharts`), links (`oceanLinks`) and
 * the memories themselves (`oceanDraw`).
 *
 * Light: the memories are the only lights. Each is a small optical point
 * with one soft falloff; importance adds a hairline ring, then a reticle of
 * two hairline spikes; often-recalled ones have a mote or two in orbit. The
 * selection is marked like an instrument (ring, ticked ring, axis marks),
 * not with more glow.
 *
 * Motion: on opening the camera dives in while the scene fades up and the
 * memories light by depth; memories sway and twinkle; lit links carry one
 * spark each; a recall rings out and sends sparks along a memory's links; a
 * new memory rises and blooms; search hits ping; a click leaves one
 * expanding hairline; a pan glides on. With reduced
 * motion the layout settles at once and frames are drawn only when something
 * changes. The loop stops while the page is hidden, and a quality guard drops
 * the heavier ambient layers when frames get expensive.
 */
import type { OceanCluster, OceanView } from "./oceanApi";
import { OceanAmbient } from "./oceanAmbient";
import { drawCharts, drawClouds, drawTags, type Group, type Tag } from "./oceanCharts";
import { OceanBloom } from "./oceanBloom";
import { along, bend, bloomStar, drawRing, drawStar, type Frame, type Star } from "./oceanDraw";
import { OceanLayout, type Body, type Link } from "./oceanLayout";
import { drawLinks, strongestLinks, type Placed } from "./oceanLinks";
import { PALETTES, rgba, type OceanMood, type Rgb } from "./oceanPalette";

export interface SceneFilter { scope: "here" | "all"; kinds: ReadonlySet<string>; query: string }
export interface SceneEvents {
  hover(id: string | null, at: { x: number; y: number } | null): void;
  select(id: string | null): void;
  clusterName(cluster: OceanCluster): string;
}
interface Effect { kind: "pulse" | "birth" | "ripple"; id?: string; x?: number; y?: number; start: number }

const PULSE = 1.6, BIRTH = 1.8, RIPPLE = 0.7, INTRO = 1.8;
/** Clear margin kept around the framed ocean inside the stage. */
const EDGE = 16;
/** With nothing to react to, the ambient drift is drawn at about 30 frames a second. */
const IDLE_FRAME_MS = 30;
const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value));
const ease = (value: number): number => { const t = clamp(value, 0, 1); return t * t * (3 - 2 * t); };

export class OceanScene {
  readonly #canvas: HTMLCanvasElement;
  readonly #context: CanvasRenderingContext2D;
  readonly #events: SceneEvents;
  readonly #layout = new OceanLayout();
  readonly #ambient = new OceanAmbient();
  readonly #bloom = new OceanBloom();
  #strong: Link[] = [];
  #view: OceanView | null = null;
  #filter: SceneFilter = { scope: "all", kinds: new Set(), query: "" };
  #visible = new Set<string>();
  /** Visible bodies in layout order, and the same back to front; rebuilt only when the data or the filter changes. */
  #bodies: Body[] = [];
  #ordered: Body[] = [];
  /** False while the stage is scrolled out of view or its panel is hidden: nothing is drawn. */
  #shown = true;
  #matches: Set<string> | null = null;
  #camera = { x: 0, y: 0, zoom: 1 };
  #target: { x: number; y: number; zoom: number } | null = null;
  #velocity = { x: 0, y: 0 };
  #effects: Effect[] = [];
  #placed = new Map<string, Placed>();
  #hovered: string | null = null;
  #selected: string | null = null;
  #pointer: { x: number; y: number } | null = null;
  #mood: OceanMood = "paper";
  #reduced = false;
  #low = false;
  #cost = 6;
  #frame = 0;
  #last = 0;
  #clock = 0;
  #delta = 0;
  #width = 0;
  #height = 0;
  #ratio = 1;
  #font = "sans-serif";
  #inset = 0;
  #top = EDGE;
  #drag = { x: 0, y: 0, moved: 0, at: 0, pointers: new Map<number, { x: number; y: number }>(), pinch: 0 };
  #fitted = false;
  /** Frame the view again when the layout first comes to rest, unless the viewer has moved it. */
  #autoFit = true;
  readonly #cleanup: (() => void)[] = [];

  constructor(canvas: HTMLCanvasElement, events: SceneEvents) {
    this.#canvas = canvas; this.#events = events;
    this.#context = canvas.getContext("2d")!;
    const observer = new ResizeObserver(() => this.#resize());
    observer.observe(canvas);
    this.#cleanup.push(() => observer.disconnect());
    const on = <K extends keyof HTMLElementEventMap>(type: K, handler: (event: HTMLElementEventMap[K]) => void, options?: AddEventListenerOptions): void => {
      canvas.addEventListener(type, handler as EventListener, options);
      this.#cleanup.push(() => canvas.removeEventListener(type, handler as EventListener));
    };
    on("pointerdown", (event) => this.#down(event));
    on("pointermove", (event) => this.#move(event));
    on("pointerup", (event) => this.#up(event));
    on("pointercancel", (event) => { this.#drag.pointers.delete(event.pointerId); });
    on("pointerleave", () => { this.#pointer = null; if (!this.#drag.pointers.size) this.#hover(null, null); this.#wake(); });
    on("wheel", (event) => this.#wheel(event), { passive: false });
    on("dblclick", (event) => this.#zoomAt(event.offsetX, event.offsetY, 1.8));
    on("keydown", (event) => this.#key(event));
    const visibility = (): void => { if (!document.hidden) this.#wake(); };
    document.addEventListener("visibilitychange", visibility);
    this.#cleanup.push(() => document.removeEventListener("visibilitychange", visibility));
    this.#resize();
  }

  setView(view: OceanView): void {
    this.#view = view;
    this.#layout.set(view.nodes, view.edges, view.clusters.length);
    this.#strong = strongestLinks(this.#layout.links);
    // Most of the settling happens before the first frame (fewer ticks for big oceans); the rest
    // plays out live, and the view is framed again once it comes to rest.
    if (this.#reduced) this.#layout.settle();
    else if (!this.#fitted) for (let tick = 0, ticks = clamp(Math.round(40000 / Math.max(1, view.nodes.length)), 80, 320); tick < ticks; tick += 1) this.#layout.tick();
    this.#applyFilter();
    if (!this.#fitted && view.nodes.length) {
      this.fit(true); this.#fitted = true;
      // The opening dive: start higher and wider, then descend to the fitted view.
      if (!this.#reduced) { const target = { ...this.#camera }; this.#camera = { x: target.x, y: target.y - 320 / target.zoom, zoom: target.zoom * 0.55 }; this.#target = target; }
    }
    this.#wake();
  }

  setFilter(filter: SceneFilter): void { this.#filter = filter; this.#applyFilter(); this.#wake(); }
  setMood(mood: OceanMood): void { this.#mood = mood; this.#wake(); }
  /** Stop drawing while the stage is off screen; resume where it left off. */
  setShown(shown: boolean): void { if (shown === this.#shown) return; this.#shown = shown; if (shown) { this.#last = 0; this.#wake(); } }
  setReducedMotion(reduced: boolean): void {
    this.#reduced = reduced;
    if (reduced) { this.#layout.settle(); this.#effects = []; this.#velocity = { x: 0, y: 0 }; if (this.#target) { this.#camera = { ...this.#target }; this.#target = null; } }
    this.#wake();
  }

  /** Select a memory. `fly` centres it (left of the detail card); otherwise the camera moves only when the card would cover it. */
  select(id: string | null, fly = true): void {
    this.#selected = id;
    if (id) this.#autoFit = false;
    const body = id ? this.#layout.byId.get(id) : null;
    if (body) {
      const zoom = fly ? Math.max(this.#camera.zoom, 1.25) : this.#camera.zoom;
      const screenX = (body.x - this.#camera.x) * this.#camera.zoom + this.#width / 2;
      const screenY = (body.y - this.#camera.y) * this.#camera.zoom + this.#height / 2;
      if (fly || screenX > this.#width - this.#inset - 40 || screenY < this.#top) this.#flyTo({ x: body.x + this.#inset / 2 / zoom, y: body.y - (this.#top - EDGE) / 2 / zoom, zoom });
    }
    this.#wake();
  }

  /** Width covered on the right by the detail card, so selection keeps clear of it. */
  setInset(right: number): void { this.#inset = right; }
  /** Height covered at the top of the stage, so the ocean is framed below it. */
  setTopInset(top: number): void { this.#top = top; }
  pulse(ids: readonly string[]): void { this.#addEffects("pulse", ids); }
  birth(ids: readonly string[]): void { this.#addEffects("birth", ids); }
  zoomBy(factor: number): void { this.#zoomAt(this.#width / 2, this.#height / 2, factor); }

  fit(instant = false): void {
    const bodies = this.#bodies;
    const box = this.#layout.bounds(bodies.length ? bodies : this.#layout.bodies);
    // Frame the ocean inside the stage, with room above for constellation names.
    const room = Math.max(160, this.#height - this.#top - EDGE), headroom = 70;
    const zoom = clamp(Math.min((this.#width - 120) / (box.width + 140), room / (box.height + 120 + headroom)), 0.25, 1.6);
    this.#flyTo({ x: box.x + box.width / 2, y: box.y + box.height / 2 - headroom / 2 - (this.#top - EDGE) / 2 / zoom, zoom }, instant);
  }

  destroy(): void { cancelAnimationFrame(this.#frame); this.#frame = 0; for (const undo of this.#cleanup) undo(); }

  #addEffects(kind: "pulse" | "birth", ids: readonly string[]): void {
    if (this.#reduced) return;
    ids.forEach((id, index) => this.#effects.push({ kind, id, start: this.#clock + 0.6 + index * 0.18 }));
    this.#wake();
  }

  #applyFilter(): void {
    const nodes = this.#view?.nodes ?? [];
    this.#visible = new Set(nodes.filter((node) => (this.#filter.scope === "all" || node.here) && (!this.#filter.kinds.size || this.#filter.kinds.has(node.kind))).map((node) => node.id));
    this.#bodies = this.#layout.bodies.filter((body) => this.#visible.has(body.id));
    this.#ordered = [...this.#bodies].sort((a, b) => b.depth - a.depth);
    const words = this.#filter.query.toLowerCase().split(/\s+/u).filter(Boolean);
    this.#matches = words.length ? new Set(nodes.filter((node) => this.#visible.has(node.id)
      && words.every((word) => `${node.summary}\n${node.text}\n${node.tags.join(" ")}`.toLowerCase().includes(word))).map((node) => node.id)) : null;
  }

  #resize(): void {
    const rect = this.#canvas.getBoundingClientRect();
    this.#width = Math.max(1, rect.width); this.#height = Math.max(1, rect.height);
    this.#ratio = Math.min(2, window.devicePixelRatio || 1);
    this.#font = getComputedStyle(this.#canvas).fontFamily || "sans-serif";
    this.#canvas.width = Math.round(this.#width * this.#ratio); this.#canvas.height = Math.round(this.#height * this.#ratio);
    // Sizing a canvas clears it: paint at once so a resize never shows an empty stage while it waits for a frame.
    if (this.#shown) this.#draw();
    this.#wake();
  }

  #flyTo(target: { x: number; y: number; zoom: number }, instant = false): void {
    this.#velocity = { x: 0, y: 0 };
    if (instant || this.#reduced) { this.#camera = { ...target }; this.#target = null; } else this.#target = target;
    this.#wake();
  }

  #wake(): void { if (!this.#frame && this.#shown && !document.hidden) this.#frame = requestAnimationFrame((now) => this.#tick(now)); }

  /** Nothing is moving because of the viewer or the data: only the ambient drift is left to draw. */
  #idle(): boolean {
    return !this.#target && !this.#effects.length && !this.#pointer && !this.#drag.pointers.size && this.#layout.settled
      && this.#clock > INTRO + 1.5 && Math.hypot(this.#velocity.x, this.#velocity.y) <= 6;
  }

  #tick(now: number): void {
    this.#frame = 0;
    if (!this.#reduced && this.#last && now - this.#last < IDLE_FRAME_MS && this.#idle()) { this.#wake(); return; }
    // Real time, so throttled frames do not slow the animations; capped so a return from a hidden page does not jump.
    const delta = this.#last ? Math.min(0.25, (now - this.#last) / 1000) : 0.016;
    this.#last = now;
    this.#delta = this.#reduced ? 0 : delta;
    if (!this.#reduced) { this.#clock += delta; this.#layout.tick(); this.#layout.tick(); }
    const camera = this.#camera;
    if (this.#target) {
      const step = 1 - Math.exp(-delta * 4.5), target = this.#target;
      camera.x += (target.x - camera.x) * step; camera.y += (target.y - camera.y) * step; camera.zoom += (target.zoom - camera.zoom) * step;
      if (Math.abs(target.x - camera.x) < 0.3 && Math.abs(target.y - camera.y) < 0.3 && Math.abs(target.zoom - camera.zoom) < 0.002) { this.#camera = { ...target }; this.#target = null; }
    } else if (Math.hypot(this.#velocity.x, this.#velocity.y) > 6 && !this.#drag.pointers.size) {
      camera.x -= this.#velocity.x * delta / camera.zoom; camera.y -= this.#velocity.y * delta / camera.zoom;
      const decay = Math.exp(-delta * 3.2); this.#velocity.x *= decay; this.#velocity.y *= decay;
    }
    this.#effects = this.#effects.filter((effect) => this.#clock - effect.start < (effect.kind === "pulse" ? PULSE : effect.kind === "birth" ? BIRTH : RIPPLE));
    if (this.#autoFit && this.#fitted && this.#layout.settled && !this.#target) { this.#autoFit = false; this.fit(); }
    const start = performance.now();
    this.#draw();
    this.#cost = this.#cost * 0.95 + (performance.now() - start) * 0.05;
    if (!this.#low && this.#cost > 18) this.#low = true; else if (this.#low && this.#cost < 5) this.#low = false;
    if (!this.#reduced || this.#target || !this.#layout.settled) this.#wake();
    else this.#last = 0;
  }

  #screen(body: Body, time: number): { x: number; y: number } {
    const camera = this.#camera, sway = this.#reduced ? 0 : 1 - body.depth * 0.5;
    const x = body.x + Math.sin(time * 0.27 + body.phase) * 4 * sway, y = body.y + Math.cos(time * 0.21 + body.phase * 1.7) * 3 * sway;
    return { x: (x - camera.x) * camera.zoom + this.#width / 2, y: (y - camera.y) * camera.zoom + this.#height / 2 };
  }

  #colorOf = (body: Body): Rgb => PALETTES[this.#mood].kinds[body.node.origin === "curated" ? "curated" : body.node.kind];

  #draw(): void {
    const context = this.#context, palette = PALETTES[this.#mood], time = this.#clock, view = this.#view;
    const frame: Frame = { context, width: this.#width, height: this.#height, ratio: this.#ratio, time, delta: this.#delta, palette, reduced: this.#reduced,
      low: this.#low, camera: this.#camera, pointer: this.#pointer, intro: this.#reduced ? 1 : ease(time / INTRO) };
    context.setTransform(this.#ratio, 0, 0, this.#ratio, 0, 0);
    this.#ambient.back(frame);
    if (!view) { this.#ambient.front(frame); return; }
    const zoom = this.#camera.zoom, scale = Math.max(0.9, Math.pow(zoom, 0.6));
    const focus = this.#selected ?? this.#hovered;
    const near = new Set<string>();
    if (focus) for (const link of this.#layout.links) { if (link.a.id === focus) near.add(link.b.id); else if (link.b.id === focus) near.add(link.a.id); }
    const bodies = this.#bodies;
    const births = new Map<string, Effect>();
    for (const effect of this.#effects) if (effect.kind === "birth" && effect.id && !births.has(effect.id)) births.set(effect.id, effect);
    const placed = new Map<string, Placed>();
    for (const body of bodies) placed.set(body.id, { ...this.#screen(body, time), r: (4 + body.node.importance * 1.5) * (1 - 0.3 * body.depth) * scale });
    const groups = this.#groups(bodies, placed);
    // Pass 1: clouds and links on the scene, and every star's light into the bloom buffer.
    const bloom = this.#bloom.begin(this.#width, this.#height);
    context.save();
    context.globalCompositeOperation = "lighter";
    drawClouds(frame, groups, scale);
    drawLinks(frame, this.#layout.links, placed, this.#colorOf, focus, focus || this.#matches ? 0.45 : 1, this.#strong, bloom);
    const dim = (id: string): number => this.#matches ? (this.#matches.has(id) ? 1 : 0.16) : focus && id !== focus && !near.has(id) ? 0.5 : 1;
    const stars: { star: Star; body: Body }[] = [];
    for (const body of this.#ordered) {
      const spot = placed.get(body.id)!, node = body.node, color = this.#colorOf(body);
      if (spot.x < -80 || spot.y < -80 || spot.x > this.#width + 80 || spot.y > this.#height + 80) continue;
      // Scintillation, not blinking: a small, slow change in brightness.
      const twinkle = this.#reduced ? 1 : 0.9 + 0.1 * Math.sin(time * 1.4 + body.phase * 5) * Math.sin(time * 0.37 + body.phase);
      const appear = this.#reduced ? 1 : ease((time - 0.35 - body.depth * 0.9 - (body.phase / Math.PI) * 0.15) / 0.9);
      let alpha = (1 - 0.5 * body.depth) * twinkle * dim(body.id) * appear * (this.#filter.scope === "all" && !node.here ? 0.5 : 1);
      let radius = spot.r, y = spot.y + (1 - appear) * 30;
      const birth = births.get(body.id);
      if (birth) {
        const progress = clamp((time - birth.start) / BIRTH, 0, 1), rise = 1 - Math.pow(1 - progress, 3);
        y += (1 - rise) * 60; radius *= 0.2 + rise * (1 + 0.35 * Math.sin(progress * Math.PI)); alpha *= clamp(progress * 2, 0, 1);
        drawRing(context, spot.x, y, radius * (2 + progress * 9), color, (1 - progress) * 0.6, 1.2, 0.42);
      }
      const focused = body.id === this.#selected || body.id === this.#hovered;
      const star: Star = { x: spot.x, y, r: radius, color, alpha, style: node.origin === "curated" ? "curated" : node.status === "archived" ? "archived" : "active",
        depth: body.depth, spikes: node.importance >= 5 ? 1 : 0, corona: node.importance >= 4 ? (node.importance >= 5 ? 1 : 0.55) : 0,
        motes: this.#reduced || this.#low ? 0 : Math.min(2, Math.ceil(node.recalls / 3)), glow: (node.importance - 1) / 4 + (focused ? 0.2 : 0), phase: body.phase, time };
      bloomStar(bloom, star);
      stars.push({ star, body });
      placed.set(body.id, { x: spot.x, y, r: radius });
    }
    context.restore();
    // Pass 2: the blurred light, then the crisp stars and their rings on top of it.
    this.#bloom.composite(context, this.#width, this.#height, frame.intro, this.#low);
    context.save();
    context.globalCompositeOperation = "lighter";
    for (const { star, body } of stars) {
      drawStar(context, star);
      if (this.#matches?.has(body.id)) this.#sonar(context, star.x, star.y, star.r, star.color, time, body.phase, 0.4);
      if (body.id === this.#hovered && body.id !== this.#selected) drawRing(context, star.x, star.y, star.r * 2.4, star.color, 0.5, 0.75);
      if (body.id === this.#selected) this.#halo(context, star.x, star.y, star.r, star.color, time);
    }
    for (const effect of this.#effects) this.#effect(context, effect, placed, time);
    context.restore();
    drawCharts(frame, groups, zoom, this.#font);
    this.#labels(frame, placed, bodies, focus, near);
    this.#ambient.front(frame);
    this.#placed = placed;
  }

  /** Constellations on screen, with their names and their two or three most common colours. */
  #groups(bodies: readonly Body[], placed: ReadonlyMap<string, Placed>): Group[] {
    const view = this.#view!, byCluster = new Map<number, Body[]>();
    for (const body of bodies) if (body.node.cluster !== null) byCluster.set(body.node.cluster, [...byCluster.get(body.node.cluster) ?? [], body]);
    return [...byCluster].flatMap(([id, members]) => {
      const cluster = view.clusters[id];
      if (!cluster || members.length < 2) return [];
      const counts = new Map<string, { color: Rgb; count: number }>();
      for (const body of members) { const color = this.#colorOf(body), key = color.join(); counts.set(key, { color, count: (counts.get(key)?.count ?? 0) + 1 }); }
      const colors = [...counts.values()].sort((a, b) => b.count - a.count).slice(0, 3).map((entry) => entry.color);
      return [{ id, name: this.#events.clusterName(cluster), points: members.map((body) => placed.get(body.id)!), colors }];
    });
  }

  /** Neighbour labels around the focus first, then, when zoomed in, quiet summaries by importance; none overlap. */
  #labels(frame: Frame, placed: ReadonlyMap<string, Placed>, bodies: readonly Body[], focus: string | null, near: ReadonlySet<string>): void {
    const tag = (body: Body, quiet: boolean): Tag[] => { const spot = placed.get(body.id); return spot ? [{ ...spot, text: body.node.summary, color: this.#colorOf(body), quiet }] : []; };
    const tags = [...near].slice(0, 8).flatMap((id) => { const body = this.#layout.byId.get(id); return body ? tag(body, false) : []; });
    if (this.#camera.zoom > 1.4) {
      const rest = bodies.filter((body) => body.id !== focus && !near.has(body.id) && body.node.importance >= 2)
        .sort((a, b) => b.node.importance - a.node.importance || a.depth - b.depth);
      tags.push(...rest.flatMap((body) => tag(body, true)));
    }
    drawTags(frame, tags, this.#font);
  }

  /** Rings that keep leaving a memory, like a sonar ping. */
  #sonar(context: CanvasRenderingContext2D, x: number, y: number, radius: number, color: Rgb, time: number, phase: number, speed: number): void {
    if (this.#reduced) { drawRing(context, x, y, radius * 2.2, color, 0.6); return; }
    for (const lag of [0, 0.5]) {
      const progress = (time * speed + phase / (Math.PI * 2) + lag) % 1;
      drawRing(context, x, y, radius * (1.6 + progress * 4.5), color, (1 - progress) * (1 - progress) * 0.42, 0.7);
    }
  }

  #halo(context: CanvasRenderingContext2D, x: number, y: number, radius: number, color: Rgb, time: number): void {
    // A reticle, not a beacon: one firm hairline ring, a slowly turning ticked ring, and four short marks on the axes.
    const inner = radius * 2.6 + 3, outer = inner + 9;
    drawRing(context, x, y, inner, color, 0.7, 0.8);
    context.save();
    context.strokeStyle = rgba(color, 0.3); context.lineWidth = 0.6;
    context.setLineDash([1, 5]); context.lineDashOffset = -time * 4;
    context.beginPath(); context.arc(x, y, outer, 0, Math.PI * 2); context.stroke();
    context.setLineDash([]);
    context.strokeStyle = rgba(color, 0.55);
    context.beginPath();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) { context.moveTo(x + dx * (outer + 3), y + dy * (outer + 3)); context.lineTo(x + dx * (outer + 9), y + dy * (outer + 9)); }
    context.stroke();
    context.restore();
  }

  #effect(context: CanvasRenderingContext2D, effect: Effect, placed: ReadonlyMap<string, Placed>, time: number): void {
    const progress = (time - effect.start) / (effect.kind === "pulse" ? PULSE : RIPPLE);
    if (progress < 0) return;
    const palette = PALETTES[this.#mood];
    if (effect.kind === "ripple") {
      // A single expanding hairline, easing out.
      const out = 1 - (1 - progress) ** 3;
      drawRing(context, effect.x!, effect.y!, 4 + out * 46, palette.caustic, (1 - progress) ** 2 * 0.4, 0.7);
      return;
    }
    if (effect.kind !== "pulse" || !effect.id) return;
    const spot = placed.get(effect.id), body = this.#layout.byId.get(effect.id);
    if (!spot || !body) return;
    const color = this.#colorOf(body);
    for (const lag of [0, 0.25]) if (progress > lag) drawRing(context, spot.x, spot.y, spot.r * (1.5 + (progress - lag) * 10), color, (1 - progress) * (1 - progress) * 0.7, 1.1);
    for (const link of this.#layout.links) {
      const other = link.a.id === effect.id ? link.b : link.b.id === effect.id ? link.a : null, end = other && placed.get(other.id);
      if (!end) continue;
      const control = bend(spot.x, spot.y, end.x, end.y, 1), point = along(spot.x, spot.y, control.x, control.y, end.x, end.y, clamp(progress * 1.25, 0, 1));
      context.globalAlpha = 1 - progress; context.fillStyle = rgba(color, 1);
      context.beginPath(); context.arc(point.x, point.y, 2.4, 0, Math.PI * 2); context.fill();
      context.globalAlpha = 1;
    }
  }

  #hit(x: number, y: number): string | null {
    let best: string | null = null, distance = Infinity;
    for (const [id, spot] of this.#placed) {
      const d = Math.hypot(spot.x - x, spot.y - y);
      if (d < Math.max(10, spot.r * 1.8) && d < distance) { best = id; distance = d; }
    }
    return best;
  }

  #hover(id: string | null, at: { x: number; y: number } | null): void {
    if (id !== this.#hovered) { this.#hovered = id; this.#canvas.style.cursor = id ? "pointer" : "grab"; this.#wake(); }
    this.#events.hover(id, at);
  }

  #down(event: PointerEvent): void {
    this.#canvas.setPointerCapture(event.pointerId);
    this.#drag.pointers.set(event.pointerId, { x: event.offsetX, y: event.offsetY });
    Object.assign(this.#drag, { x: event.offsetX, y: event.offsetY, moved: 0, at: performance.now() });
    this.#velocity = { x: 0, y: 0 };
    if (this.#drag.pointers.size === 2) { const [a, b] = [...this.#drag.pointers.values()]; this.#drag.pinch = Math.hypot(a!.x - b!.x, a!.y - b!.y); }
  }

  #move(event: PointerEvent): void {
    const drag = this.#drag;
    this.#pointer = { x: event.offsetX, y: event.offsetY };
    if (!drag.pointers.has(event.pointerId)) { const id = this.#hit(event.offsetX, event.offsetY); this.#hover(id, id ? { x: event.offsetX, y: event.offsetY } : null); this.#wake(); return; }
    drag.pointers.set(event.pointerId, { x: event.offsetX, y: event.offsetY });
    if (drag.pointers.size === 2) {
      const [a, b] = [...drag.pointers.values()], span = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      if (drag.pinch) this.#zoomAt((a!.x + b!.x) / 2, (a!.y + b!.y) / 2, span / drag.pinch);
      drag.pinch = span; drag.moved += 10; return;
    }
    const dx = event.offsetX - drag.x, dy = event.offsetY - drag.y, now = performance.now(), elapsed = Math.max(1, now - drag.at) / 1000;
    drag.moved += Math.abs(dx) + Math.abs(dy); drag.x = event.offsetX; drag.y = event.offsetY; drag.at = now;
    if (drag.moved > 4) {
      this.#target = null; this.#autoFit = false;
      this.#camera.x -= dx / this.#camera.zoom; this.#camera.y -= dy / this.#camera.zoom;
      if (!this.#reduced) this.#velocity = { x: this.#velocity.x * 0.5 + (dx / elapsed) * 0.5, y: this.#velocity.y * 0.5 + (dy / elapsed) * 0.5 };
      this.#canvas.style.cursor = "grabbing"; this.#wake();
    }
  }

  #up(event: PointerEvent): void {
    const drag = this.#drag;
    drag.pointers.delete(event.pointerId);
    if (drag.pointers.size) return;
    drag.pinch = 0;
    this.#canvas.style.cursor = this.#hovered ? "pointer" : "grab";
    if (performance.now() - drag.at > 90) this.#velocity = { x: 0, y: 0 };
    if (drag.moved > 4) { this.#wake(); return; }
    const id = this.#hit(event.offsetX, event.offsetY);
    if (!this.#reduced) this.#effects.push({ kind: "ripple", x: event.offsetX, y: event.offsetY, start: this.#clock });
    this.#selected = id;
    this.#events.select(id);
    this.#wake();
  }

  #wheel(event: WheelEvent): void {
    event.preventDefault();
    this.#zoomAt(event.offsetX, event.offsetY, Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015)));
  }

  #zoomAt(x: number, y: number, factor: number): void {
    const zoom = clamp((this.#target ?? this.#camera).zoom * factor, 0.25, 4);
    const worldX = (x - this.#width / 2) / this.#camera.zoom + this.#camera.x, worldY = (y - this.#height / 2) / this.#camera.zoom + this.#camera.y;
    this.#target = null; this.#velocity = { x: 0, y: 0 }; this.#autoFit = false;
    this.#camera = { zoom, x: worldX - (x - this.#width / 2) / zoom, y: worldY - (y - this.#height / 2) / zoom };
    this.#wake();
  }

  #key(event: KeyboardEvent): void {
    const step = 60 / this.#camera.zoom, moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[event.key]) { event.preventDefault(); this.#autoFit = false; this.#camera.x += moves[event.key]![0]; this.#camera.y += moves[event.key]![1]; this.#wake(); }
    else if (event.key === "+" || event.key === "=") this.zoomBy(1.25);
    else if (event.key === "-") this.zoomBy(0.8);
    else if (event.key === "0") this.fit();
    else if (event.key === "Escape" && this.#selected) { this.#selected = null; this.#events.select(null); this.#wake(); }
  }
}
