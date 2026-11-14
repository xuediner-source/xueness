/**
 * Where each memory floats. A small force simulation: memories repel their
 * neighbours (bucketed in a grid, so the cost stays linear), linked memories
 * pull toward a rest length that shortens as the link strengthens, and each
 * constellation drifts toward its own anchor on a golden-angle spiral. Start
 * positions come from a hash of the id, and a refresh keeps every memory it
 * already placed, so the map is stable between visits and new memories settle
 * in among the old.
 *
 * Depth is the ocean's memory metaphor: fresh or recently recalled memories
 * float near the surface (bright, large), forgotten ones sink (dim, small).
 */
import type { OceanEdge, OceanNode } from "./oceanApi";

export interface Body {
  id: string; node: OceanNode; x: number; y: number; vx: number; vy: number;
  /** 0 at the surface … 1 in the abyss. */
  depth: number;
  /** Per-memory animation offset. */
  phase: number;
}
export interface Link { a: Body; b: Body; edge: OceanEdge }

const DAY = 86_400_000;
const CELL = 140;

/** FNV-1a: a stable number in [0, 1) for a string. */
export function hash01(text: string): number {
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) { value ^= text.charCodeAt(index); value = Math.imul(value, 16777619); }
  return (value >>> 0) / 4294967296;
}

export function depthOf(node: OceanNode, now = Date.now()): number {
  if (node.status === "archived") return 0.95;
  const touched = Math.max(Date.parse(node.updatedAt) || 0, Date.parse(node.lastRecalledAt ?? "") || 0);
  const age = touched ? Math.max(0, (now - touched) / DAY) : 90;
  const sink = 1 - Math.exp(-age / 30);
  return Math.min(0.9, Math.max(0, sink * 0.85 - Math.min(0.25, node.recalls * 0.02) - (node.importance - 3) * 0.05));
}

export class OceanLayout {
  bodies: Body[] = [];
  links: Link[] = [];
  readonly byId = new Map<string, Body>();
  #anchors = new Map<number, { x: number; y: number }>();
  #alpha = 1;

  /** Replace the data, keeping the place and motion of every memory already laid out. */
  set(nodes: readonly OceanNode[], edges: readonly OceanEdge[], clusterCount: number): void {
    const previous = new Map(this.bodies.map((body) => [body.id, body]));
    this.#anchors.clear();
    for (let index = 0; index < clusterCount; index += 1) {
      const angle = index * 2.399963, radius = 150 * Math.sqrt(index + 0.6);
      this.#anchors.set(index, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius * 0.72 });
    }
    const outer = 150 * Math.sqrt(clusterCount + 1.6);
    this.bodies = nodes.map((node) => {
      const old = previous.get(node.id);
      const depth = depthOf(node);
      if (old) { old.node = node; old.depth = depth; return old; }
      const anchor = node.cluster !== null ? this.#anchors.get(node.cluster) : null;
      const angle = hash01(node.id) * Math.PI * 2, spread = hash01(node.id + "~");
      const base = anchor ?? { x: Math.cos(angle) * outer, y: Math.sin(angle) * outer * 0.72 };
      const reach = anchor ? 40 + spread * 70 : spread * 60;
      return { id: node.id, node, x: base.x + Math.cos(angle * 3) * reach, y: base.y + Math.sin(angle * 3) * reach, vx: 0, vy: 0, depth, phase: hash01(node.id + "*") * Math.PI * 2 };
    });
    this.byId.clear();
    for (const body of this.bodies) this.byId.set(body.id, body);
    this.links = edges.flatMap((edge) => {
      const a = this.byId.get(edge.a), b = this.byId.get(edge.b);
      return a && b ? [{ a, b, edge }] : [];
    });
    this.#alpha = previous.size && this.bodies.every((body) => previous.has(body.id)) ? Math.max(this.#alpha, 0.25) : 1;
  }

  get settled(): boolean { return this.#alpha < 0.004; }

  /** Run until settled (for reduced motion or a first paint), bounded. */
  settle(maxTicks = 400): void { for (let tick = 0; tick < maxTicks && !this.settled; tick += 1) this.tick(); }

  /** One step; returns false once the layout has come to rest. */
  tick(): boolean {
    if (this.settled) return false;
    const alpha = this.#alpha;
    const grid = new Map<string, Body[]>();
    for (const body of this.bodies) {
      const key = `${Math.floor(body.x / CELL)}:${Math.floor(body.y / CELL)}`;
      const cell = grid.get(key);
      if (cell) cell.push(body); else grid.set(key, [body]);
    }
    for (const body of this.bodies) {
      const cx = Math.floor(body.x / CELL), cy = Math.floor(body.y / CELL);
      for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) {
        for (const other of grid.get(`${cx + dx}:${cy + dy}`) ?? []) {
          if (other === body) continue;
          let x = body.x - other.x, y = body.y - other.y;
          let distance = x * x + y * y;
          if (distance < 1) { x = hash01(body.id + other.id) - 0.5; y = hash01(other.id + body.id) - 0.5; distance = 1; }
          if (distance > CELL * CELL) continue;
          const force = (2600 * alpha) / distance;
          body.vx += x * force / Math.sqrt(distance); body.vy += y * force / Math.sqrt(distance);
        }
      }
    }
    for (const { a, b, edge } of this.links) {
      const x = b.x - a.x, y = b.y - a.y;
      const distance = Math.max(1, Math.hypot(x, y));
      const rest = 60 + (1 - edge.weight) * 90;
      const pull = (distance - rest) * 0.035 * edge.weight * alpha / distance;
      a.vx += x * pull; a.vy += y * pull; b.vx -= x * pull; b.vy -= y * pull;
    }
    for (const body of this.bodies) {
      const anchor = body.node.cluster !== null ? this.#anchors.get(body.node.cluster) : undefined;
      const strength = anchor ? 0.014 : 0.004;
      body.vx += ((anchor?.x ?? 0) - body.x) * strength * alpha;
      body.vy += ((anchor?.y ?? 0) - body.y) * strength * alpha;
      body.vx *= 0.8; body.vy *= 0.8;
      body.x += Math.max(-30, Math.min(30, body.vx)); body.y += Math.max(-30, Math.min(30, body.vy));
    }
    this.#alpha *= 0.985;
    return true;
  }

  /** World bounds of the given bodies. */
  bounds(bodies: readonly Body[] = this.bodies): { x: number; y: number; width: number; height: number } {
    if (!bodies.length) return { x: -200, y: -150, width: 400, height: 300 };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const body of bodies) { minX = Math.min(minX, body.x); minY = Math.min(minY, body.y); maxX = Math.max(maxX, body.x); maxY = Math.max(maxY, body.y); }
    return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
  }
}
