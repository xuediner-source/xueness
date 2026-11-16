/**
 * Constellations drawn like an old star chart over the sea.
 *
 * Each constellation gets a cloud of four soft blobs in its members' colours,
 * slowly orbiting its centre; a dotted boundary that follows the convex hull
 * of its members, pushed outward and smoothed; and its name, letter-spaced
 * above a hairline that fades at both ends, with the member count. Labels for
 * the memories around the hovered or selected one sit on small dark pills so
 * they stay legible over bright water.
 */
import { drawNebula, type Frame } from "./oceanDraw";
import type { Placed } from "./oceanLinks";
import { rgba, type Rgb } from "./oceanPalette";

export interface Group { id: number; name: string; points: Placed[]; colors: Rgb[] }

const centroid = (points: readonly Placed[]): { x: number; y: number } => ({
  x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
  y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
});

/** Convex hull (monotone chain), counter-clockwise. */
function hull(points: readonly Placed[]): { x: number; y: number }[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: Placed, a: Placed, b: Placed): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Placed[] = [], upper: Placed[] = [];
  for (const point of sorted) { while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, point) <= 0) lower.pop(); lower.push(point); }
  for (const point of [...sorted].reverse()) { while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, point) <= 0) upper.pop(); upper.push(point); }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

export function drawClouds(frame: Frame, groups: readonly Group[], scale: number): void {
  const { context, time } = frame;
  for (const group of groups) {
    if (group.points.length < 2) continue;
    const middle = centroid(group.points);
    const spread = Math.min(160 * scale, Math.max(...group.points.map((point) => Math.hypot(point.x - middle.x, point.y - middle.y))));
    const base = (56 + Math.sqrt(group.points.length) * 40) * scale;
    for (let index = 0; index < 4; index += 1) {
      const angle = group.id * 1.7 + index * (Math.PI / 2) + time * 0.015 * (index % 2 ? 1 : -1);
      const reach = spread * (0.25 + 0.15 * index);
      const breath = frame.reduced ? 0 : 0.02 * Math.sin(time * 0.35 + group.id + index);
      drawNebula(context, middle.x + Math.cos(angle) * reach, middle.y + Math.sin(angle) * reach * 0.7, base * (0.65 + 0.15 * index),
        group.colors[index % group.colors.length]!, (0.022 + breath * 0.4) * frame.intro);
    }
  }
}

export function drawCharts(frame: Frame, groups: readonly Group[], zoom: number, font: string): void {
  const { context, palette } = frame;
  const visibility = Math.max(0, Math.min(1, (zoom - 0.3) * 3)) * Math.max(0, Math.min(1, (2.4 - zoom) * 1.5)) * frame.intro;
  if (visibility < 0.02) return;
  context.save();
  for (const group of groups) {
    if (group.points.length < 2) continue;
    const middle = centroid(group.points);
    let top = Math.min(...group.points.map((point) => point.y));
    if (group.points.length >= 3) {
      const outline = hull(group.points).map((point) => {
        const dx = point.x - middle.x, dy = point.y - middle.y, length = Math.hypot(dx, dy) || 1;
        return { x: point.x + (dx / length) * 26, y: point.y + (dy / length) * 26 };
      });
      top = Math.min(...outline.map((point) => point.y));
      const mid = (i: number): { x: number; y: number } => { const a = outline[i % outline.length]!, b = outline[(i + 1) % outline.length]!; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; };
      context.beginPath();
      const start = mid(outline.length - 1);
      context.moveTo(start.x, start.y);
      outline.forEach((point, index) => { const next = mid(index); context.quadraticCurveTo(point.x, point.y, next.x, next.y); });
      context.closePath();
      context.strokeStyle = rgba(palette.line, 0.2 * visibility); context.lineWidth = 0.7;
      context.setLineDash([1, 6]); context.lineDashOffset = 0;
      context.stroke();
      context.setLineDash([]);
    }
    const label = group.name.toUpperCase().split("").join(" ");
    const y = top - 14;
    context.font = `500 10.5px ${font}`; context.textAlign = "center"; context.textBaseline = "middle";
    context.fillStyle = palette.ink; context.globalAlpha = visibility * 0.9;
    context.fillText(label, middle.x, y);
    const width = context.measureText(label).width;
    context.font = `10px ${font}`; context.globalAlpha = visibility * 0.55;
    context.fillText(`· ${group.points.length}`, middle.x + width / 2 + 14, y);
    const rule = context.createLinearGradient(middle.x - width / 2 - 10, 0, middle.x + width / 2 + 10, 0);
    rule.addColorStop(0, "rgba(255, 255, 255, 0)"); rule.addColorStop(0.5, palette.ink); rule.addColorStop(1, "rgba(255, 255, 255, 0)");
    context.fillStyle = rule; context.globalAlpha = visibility * 0.35;
    context.fillRect(middle.x - width / 2 - 10, y + 8, width + 20, 0.7);
  }
  context.restore();
}

export interface Tag { x: number; y: number; r: number; text: string; color: Rgb; quiet?: boolean }

/**
 * Labels on small dark pills, in priority order: a label that would overlap
 * one already placed (or leave the canvas) is skipped, so they never stack.
 * Quiet labels (summaries when zoomed in) are smaller and dimmer.
 */
export function drawTags(frame: Frame, items: readonly Tag[], font: string): void {
  const { context } = frame;
  const taken: { left: number; top: number; right: number; bottom: number }[] = [];
  context.save();
  context.textAlign = "center"; context.textBaseline = "middle";
  for (const item of items) {
    const chars = Array.from(item.text), limit = item.quiet ? 22 : 18;
    const text = chars.length > limit ? chars.slice(0, limit - 1).join("") + "…" : item.text;
    context.font = `${item.quiet ? 10.5 : 11}px ${font}`;
    const width = context.measureText(text).width + 14, height = item.quiet ? 16 : 18, y = item.y + item.r + 6 + height / 2;
    const box = { left: item.x - width / 2 - 3, top: y - height / 2 - 2, right: item.x + width / 2 + 3, bottom: y + height / 2 + 2 };
    if (box.left < 0 || box.right > frame.width || box.bottom > frame.height) continue;
    if (taken.some((other) => box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top)) continue;
    taken.push(box);
    context.globalAlpha = (item.quiet ? 0.7 : 0.9) * frame.intro;
    context.fillStyle = item.quiet ? "rgba(12, 13, 16, 0.5)" : "rgba(12, 13, 16, 0.74)";
    context.beginPath(); context.roundRect(item.x - width / 2, y - height / 2, width, height, 5); context.fill();
    context.strokeStyle = item.quiet ? "rgba(255, 255, 255, 0.07)" : rgba(item.color, 0.3); context.lineWidth = 0.6; context.stroke();
    context.fillStyle = item.quiet ? "rgba(232, 236, 242, 0.72)" : "rgba(240, 242, 245, 0.94)";
    context.fillText(text, item.x, y + 0.5);
  }
  context.restore();
}
