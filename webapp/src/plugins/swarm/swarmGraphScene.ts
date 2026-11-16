/**
 * The swarm's mention graph, drawn with Memory Ocean's primitives (sea
 * backdrop, optical stars, bent links, bloom) rather than copies of them.
 *
 * The coordinator sits at the centre, the other members on a ring; the user
 * and the host speak from the lower and upper edge. A link's weight is how
 * often one member wrote to another up to the shown post; each post sends a
 * comet from its sender to every recipient. Working members breathe and carry
 * spikes, finished ones glow steadily, stopped ones are dim outlines.
 */
import { along, bend, bloomStar, drawRing, drawSea, drawStar, type Frame, type Star } from "../memory/oceanDraw";
import type { OceanBloom } from "../memory/oceanBloom";
import { core, currentMood, PALETTES, rgba, type OceanPalette, type Rgb } from "../memory/oceanPalette";

export type Role = "coordinator" | "worker" | "verifier";
export interface GraphMember { name: string; role: Role; state: string; running: boolean }
export interface GraphPost { seq: number; from: string; recipients: string[]; to?: { all?: boolean; names?: string[]; groups?: string[] } }
export interface Placed extends GraphMember { x: number; y: number; color: Rgb; phase: number }
export interface Comet { from: string; to: string; born: number; seq: number }
export interface GraphEdge { from: string; to: string; count: number; direct: number; viaAll: number }

export const ROLE_COLORS: Readonly<Record<Role, Rgb>> = { coordinator: [246, 212, 140], worker: [130, 222, 230], verifier: [184, 168, 252] };
const VOICE_COLOR: Rgb = [214, 226, 240];
/** Seconds a comet takes along its link. */
export const COMET_SECONDS = 1.3;

const hash = (text: string): number => { let value = 7; for (const char of text) value = (value * 31 + char.charCodeAt(0)) % 9973; return value / 9973; };

/** Fixed positions: centre for the coordinator, a ring for everyone else, edges for the user and the host. */
export function layout(members: readonly GraphMember[], width: number, height: number): Map<string, Placed> {
  const placed = new Map<string, Placed>();
  const cx = width / 2, cy = height / 2, radius = Math.max(60, Math.min(width, height) * 0.32);
  const coordinator = members.find((member) => member.role === "coordinator");
  const ring = members.filter((member) => member !== coordinator);
  if (coordinator) placed.set(coordinator.name, { ...coordinator, x: cx, y: cy, color: ROLE_COLORS.coordinator, phase: hash(coordinator.name) * 6.28 });
  ring.forEach((member, index) => {
    // Evenly round the coordinator from the top; two members sit above it at ±60° so the three never line up.
    const angle = ring.length === 2 ? -Math.PI / 2 + (index === 0 ? -Math.PI / 3 : Math.PI / 3) : -Math.PI / 2 + (index / Math.max(1, ring.length)) * Math.PI * 2;
    placed.set(member.name, { ...member, x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius * 0.82, color: ROLE_COLORS[member.role], phase: hash(member.name) * 6.28 });
  });
  placed.set("user", { name: "user", role: "worker", state: "voice", running: false, x: cx, y: height - 26, color: VOICE_COLOR, phase: 0 });
  placed.set("system", { name: "system", role: "worker", state: "voice", running: false, x: cx, y: 26, color: VOICE_COLOR, phase: 1 });
  return placed;
}

/** Mentions per directed pair, counting posts up to and including `upTo`. */
export function edgeCounts(posts: readonly GraphPost[], upTo: number, expandAll = false): Map<string, GraphEdge> {
  const edges = new Map<string, GraphEdge>();
  for (const post of posts) {
    if (post.seq > upTo) break;
    const isAll = Boolean(post.to?.all);
    for (const to of post.recipients) {
      const viaAll = isAll && !(post.to?.names ?? []).includes(to);
      if (viaAll && !expandAll) continue;
      const key = `${post.from}→${to}`;
      const edge = edges.get(key) ?? { from: post.from, to, count: 0, direct: 0, viaAll: 0 };
      edge.count += 1;
      if (viaAll) edge.viaAll += 1; else edge.direct += 1;
      edges.set(key, edge);
    }
  }
  return edges;
}

export function broadcastCounts(posts: readonly GraphPost[], upTo: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const post of posts) {
    if (post.seq > upTo) break;
    if (post.to?.all) out.set(post.from, (out.get(post.from) ?? 0) + 1);
  }
  return out;
}

export interface SceneInput {
  context: CanvasRenderingContext2D; bloom: OceanBloom;
  width: number; height: number; ratio: number; time: number; delta: number; reduced: boolean;
  placed: Map<string, Placed>; edges: Map<string, GraphEdge>; broadcasts?: Map<string, number>; comets: readonly Comet[];
  labels: Record<string, string>;
}

function starOf(member: Placed, time: number): Star {
  const killed = member.state === "killed";
  // Members are the focus of this view, so they are drawn larger and brighter than memories in Memory Ocean.
  return { x: member.x, y: member.y, r: member.role === "coordinator" ? 8.5 : 7, color: member.color, alpha: killed ? 0.5 : 1,
    style: killed ? "archived" : "active", depth: member.state === "done" ? 0.15 : 0, spikes: member.running ? 1 : member.role === "coordinator" ? 0.6 : 0.3,
    corona: member.running ? 1 : member.role === "coordinator" ? 0.4 : 0, motes: member.running ? 2 : 0, glow: member.running ? 1 : member.state === "done" ? 0.85 : 0.7, phase: member.phase, time };
}

/** One frame of the graph. */
export function drawScene(input: SceneInput): void {
  const { context, bloom, width, height, ratio, time, reduced, placed } = input;
  const palette: OceanPalette = PALETTES[currentMood()];
  const frame: Frame = { context, width, height, ratio, time, delta: input.delta, palette, reduced, low: false, camera: { x: 0, y: 0, zoom: 1 }, pointer: null, intro: 1 };
  drawSea(frame);
  const light = bloom.begin(width, height);
  const strongest = Math.max(1, ...[...input.edges.values()].map((edge) => edge.count));
  // Links: bent the same way every frame; heavier the more often one wrote to the other.
  context.save();
  context.globalCompositeOperation = "lighter";
  for (const edge of input.edges.values()) {
    const a = placed.get(edge.from), b = placed.get(edge.to);
    if (!a || !b) continue;
    const c = bend(a.x, a.y, b.x, b.y, edge.from < edge.to ? 1 : -1);
    const weight = edge.count / strongest;
    const dashed = edge.direct === 0 && edge.viaAll > 0;
    context.setLineDash(dashed ? [4, 4] : []);
    context.strokeStyle = rgba(palette.line, (dashed ? 0.08 : 0.12) + 0.38 * weight); context.lineWidth = 0.6 + 2.2 * weight;
    context.beginPath(); context.moveTo(a.x, a.y); context.quadraticCurveTo(c.x, c.y, b.x, b.y); context.stroke();
    light.strokeStyle = rgba(a.color, 0.08 + 0.22 * weight); light.lineWidth = 2 + 4 * weight;
    light.beginPath(); light.moveTo(a.x, a.y); light.quadraticCurveTo(c.x, c.y, b.x, b.y); light.stroke();
  }
  context.setLineDash([]);
  // Comets: a bright head and a fading tail travelling from sender to recipient.
  for (const comet of input.comets) {
    const a = placed.get(comet.from), b = placed.get(comet.to);
    if (!a || !b) continue;
    const t = reduced ? 1 : Math.min(1, Math.max(0, (time - comet.born) / COMET_SECONDS));
    if (t >= 1 && !reduced) continue;
    const c = bend(a.x, a.y, b.x, b.y, comet.from < comet.to ? 1 : -1);
    for (let step = 0; step < 6; step += 1) {
      const at = along(a.x, a.y, c.x, c.y, b.x, b.y, Math.max(0, t - step * 0.035));
      const fade = 1 - step / 6;
      light.fillStyle = rgba(core(a.color, 0.3), 0.55 * fade);
      light.beginPath(); light.arc(at.x, at.y, 3.2 * fade + 1, 0, Math.PI * 2); light.fill();
      context.fillStyle = rgba(core(a.color, 0.75), 0.85 * fade);
      context.beginPath(); context.arc(at.x, at.y, 1.6 * fade + 0.4, 0, Math.PI * 2); context.fill();
    }
    if (t > 0.92) drawRing(context, b.x, b.y, 8 + (t - 0.92) * 120, b.color, (1 - t) * 4, 1);
  }
  // Members as stars; the user and the host as quiet points.
  for (const member of placed.values()) {
    if (member.state === "voice") {
      light.fillStyle = rgba(member.color, 0.25); light.beginPath(); light.arc(member.x, member.y, 4, 0, Math.PI * 2); light.fill();
      continue;
    }
    bloomStar(light, starOf(member, reduced ? 0 : time));
  }
  bloom.composite(context, width, height, 1, false);
  for (const member of placed.values()) {
    if (member.state === "voice") {
      context.fillStyle = rgba(member.color, 0.7); context.beginPath(); context.arc(member.x, member.y, 2.2, 0, Math.PI * 2); context.fill();
    } else drawStar(context, starOf(member, reduced ? 0 : time));
  }
  context.restore();
  // Labels under each point.
  context.save();
  context.font = "12px system-ui, sans-serif"; context.textAlign = "center"; context.textBaseline = "top";
  for (const member of placed.values()) {
    const label = input.labels[member.name] ?? `@${member.name}`;
    const below = member.state === "voice" ? 8 : member.role === "coordinator" ? 22 : 18;
    const allCount = input.broadcasts?.get(member.name) ?? 0;
    context.fillStyle = member.state === "killed" ? rgba(VOICE_COLOR, 0.4) : palette.ink;
    context.fillText(allCount > 0 ? `${label} · @all×${allCount}` : label, member.x, member.y + below);
  }
  context.restore();
}
