/**
 * Lines between memories.
 *
 * An unlit link takes the blended colour of the two memories it joins and a
 * style from its relation: an explicit link is a firmer line, a shared tag a
 * thin one, similar content a dotted one, a superseded memory a dashed one.
 * Links are batched into one path per colour pair, style and strength, so a
 * thousand links cost a few dozen strokes. Links of the hovered or selected
 * memory are lit with a gradient and comets of light running along them, and
 * the strongest links of the whole ocean carry a slow mote each.
 */
import type { OceanEdge } from "./oceanApi";
import { along, bend, type Frame } from "./oceanDraw";
import { hash01, type Body, type Link } from "./oceanLayout";
import { mix, rgba, starSprite, type Rgb } from "./oceanPalette";

export interface Placed { x: number; y: number; r: number }

const STYLE: Readonly<Record<OceanEdge["kind"], { width: number; dash: number[]; lift: number }>> = {
  related: { width: 1.35, dash: [], lift: 0.05 },
  tags: { width: 1, dash: [], lift: 0 },
  similar: { width: 0.9, dash: [1.5, 4.5], lift: 0.02 },
  supersedes: { width: 1, dash: [5, 6], lift: 0.03 },
};

/** The links worth an ambient mote: the strongest ones, a bounded number. */
export function strongestLinks(links: readonly Link[], count = 40): Link[] {
  return [...links].sort((a, b) => b.edge.weight - a.edge.weight).slice(0, count);
}

export function drawLinks(frame: Frame, links: readonly Link[], placed: ReadonlyMap<string, Placed>, colorOf: (body: Body) => Rgb, focus: string | null, fade: number, ambient: readonly Link[], bloom: CanvasRenderingContext2D): void {
  const { context, palette, time } = frame;
  const batches = new Map<string, { path: Path2D; color: Rgb; kind: OceanEdge["kind"]; level: number }>();
  const lit: { a: Placed; b: Placed; c: { x: number; y: number }; from: Rgb; to: Rgb; seed: number; kind: OceanEdge["kind"] }[] = [];
  for (const { a, b, edge } of links) {
    const from = placed.get(a.id), to = placed.get(b.id);
    if (!from || !to) continue;
    const seed = hash01(edge.a + edge.b), control = bend(from.x, from.y, to.x, to.y, seed > 0.5 ? 1 : -1);
    if (focus && (a.id === focus || b.id === focus)) { lit.push({ a: from, b: to, c: control, from: colorOf(a), to: colorOf(b), seed, kind: edge.kind }); continue; }
    const level = Math.min(3, Math.floor(edge.weight * 4));
    const colorA = colorOf(a), colorB = colorOf(b);
    const key = `${colorA.join()}|${colorB.join()}|${edge.kind}|${level}`;
    let batch = batches.get(key);
    if (!batch) { batch = { path: new Path2D(), color: mix(mix(colorA, colorB), palette.line, 0.45), kind: edge.kind, level }; batches.set(key, batch); }
    batch.path.moveTo(from.x, from.y); batch.path.quadraticCurveTo(control.x, control.y, to.x, to.y);
  }
  context.lineCap = "round";
  for (const batch of batches.values()) {
    const style = STYLE[batch.kind];
    context.strokeStyle = rgba(batch.color, (0.06 + batch.level * 0.06 + style.lift) * fade * frame.intro);
    context.lineWidth = style.width;
    context.setLineDash(style.dash);
    context.stroke(batch.path);
  }
  context.setLineDash([]);
  for (const line of lit) {
    const gradient = context.createLinearGradient(line.a.x, line.a.y, line.b.x, line.b.y);
    gradient.addColorStop(0, rgba(line.from, 0.9)); gradient.addColorStop(1, rgba(line.to, 0.9));
    context.strokeStyle = gradient; context.lineWidth = STYLE[line.kind].width + 0.6;
    context.setLineDash(STYLE[line.kind].dash);
    context.beginPath(); context.moveTo(line.a.x, line.a.y); context.quadraticCurveTo(line.c.x, line.c.y, line.b.x, line.b.y); context.stroke();
    context.setLineDash([]);
    if (frame.reduced) continue;
    for (const offset of [0, 1 / 3, 2 / 3]) comet(context, bloom, line, (time * 0.3 + line.seed + offset) % 1, mix(line.from, line.to, 0.5), 1);
  }
  if (frame.reduced || frame.low) return;
  for (const { a, b, edge } of ambient) {
    if (focus && (a.id === focus || b.id === focus)) continue;
    const from = placed.get(a.id), to = placed.get(b.id);
    if (!from || !to) continue;
    const seed = hash01(edge.a + edge.b), control = bend(from.x, from.y, to.x, to.y, seed > 0.5 ? 1 : -1);
    let t = (time * 0.08 * (0.5 + edge.weight) + seed) % 1;
    if (seed > 0.5) t = 1 - t;
    comet(context, bloom, { a: from, b: to, c: control }, t, mix(colorOf(a), colorOf(b)), 0.6 * edge.weight * fade * frame.intro);
  }
}

/** A short-tailed spark at `t` along a link: crisp points on the line, their light in the bloom. */
function comet(context: CanvasRenderingContext2D, bloom: CanvasRenderingContext2D, line: { a: Placed; b: Placed; c: { x: number; y: number } }, t: number, color: Rgb, alpha: number): void {
  const sprite = starSprite(color, 0);
  for (let step = 0; step < 5; step += 1) {
    const at = t - step * 0.014;
    if (at < 0) break;
    const point = along(line.a.x, line.a.y, line.c.x, line.c.y, line.b.x, line.b.y, at);
    const size = 8 - step * 1.3, fade = alpha * (1 - step * 0.2);
    context.globalAlpha = fade;
    context.drawImage(sprite, point.x - size / 2, point.y - size / 2, size, size);
    if (step === 0) { bloom.fillStyle = rgba(color, fade * 0.8); bloom.beginPath(); bloom.arc(point.x, point.y, 2.6, 0, Math.PI * 2); bloom.fill(); }
  }
  context.globalAlpha = 1;
}
