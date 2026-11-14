/**
 * Drawing primitives for Memory Ocean. Each draws in CSS pixels on a context
 * already scaled for the device pixel ratio; none keeps state except the
 * cached sea backdrop, which only changes with the size and the mood.
 *
 * A memory is drawn in two parts: `bloomStar` puts its light into the bloom
 * buffer (core, aura, the glow of its spikes and motes), and `drawStar` draws
 * the crisp parts on top (the optical star sprite, hairline spikes, motes).
 */
import { core, rgba, starSprite, type OceanPalette, type Rgb } from "./oceanPalette";

/** Everything a layer needs to draw one frame. */
export interface Frame {
  context: CanvasRenderingContext2D;
  width: number; height: number; ratio: number;
  /** Animation clock in seconds; frozen under reduced motion. */
  time: number;
  /** Seconds since the last frame (0 under reduced motion). */
  delta: number;
  palette: OceanPalette;
  reduced: boolean;
  /** The quality guard dropped the heavier ambient layers. */
  low: boolean;
  camera: { x: number; y: number; zoom: number };
  /** The pointer over the canvas, when it is not dragging. */
  pointer: { x: number; y: number } | null;
  /** 0 → 1 while the opening dive plays; 1 afterwards. */
  intro: number;
}

let backdrop: { key: string; canvas: HTMLCanvasElement } | null = null;

/** The sea: lit surface fading to the abyss, a glow rising from the deep, and a vignette. Cached as one image. */
export function drawSea(frame: Frame): void {
  const { context, width, height, ratio, palette } = frame;
  const key = `${width}x${height}@${ratio}:${palette.depths.join()}`;
  if (backdrop?.key !== key) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * ratio)); canvas.height = Math.max(1, Math.round(height * ratio));
    const paint = canvas.getContext("2d")!;
    paint.scale(ratio, ratio);
    const fall = paint.createLinearGradient(0, 0, 0, height);
    palette.depths.forEach((color, index) => fall.addColorStop(index / (palette.depths.length - 1), color));
    paint.fillStyle = fall; paint.fillRect(0, 0, width, height);
    const glow = paint.createRadialGradient(width * 0.5, -height * 0.15, 0, width * 0.5, -height * 0.15, height * 0.95);
    glow.addColorStop(0, "rgba(255, 255, 255, 0.10)"); glow.addColorStop(1, "rgba(255, 255, 255, 0)");
    paint.fillStyle = glow; paint.fillRect(0, 0, width, height);
    paint.save();
    paint.translate(width / 2, height * 1.05); paint.scale(1.6, 0.55);
    const deep = paint.createRadialGradient(0, 0, 0, 0, 0, height * 0.75);
    deep.addColorStop(0, rgba(palette.abyss, 0.16)); deep.addColorStop(0.5, rgba(palette.abyss, 0.05)); deep.addColorStop(1, rgba(palette.abyss, 0));
    paint.fillStyle = deep; paint.fillRect(-width, -height, width * 2, height * 2);
    paint.restore();
    const vignette = paint.createRadialGradient(width / 2, height / 2, Math.min(width, height) * 0.35, width / 2, height / 2, Math.max(width, height) * 0.78);
    vignette.addColorStop(0, "rgba(0, 0, 0, 0)"); vignette.addColorStop(1, "rgba(0, 0, 0, 0.55)");
    paint.fillStyle = vignette; paint.fillRect(0, 0, width, height);
    backdrop = { key, canvas };
  }
  context.drawImage(backdrop.canvas, 0, 0, width, height);
}

/** A soft cloud with a long, edgeless falloff; constellations are made of several. */
export function drawNebula(context: CanvasRenderingContext2D, x: number, y: number, radius: number, color: Rgb, alpha: number): void {
  if (alpha <= 0.003 || radius <= 1) return;
  const haze = context.createRadialGradient(x, y, 0, x, y, radius);
  haze.addColorStop(0, rgba(color, alpha)); haze.addColorStop(0.3, rgba(color, alpha * 0.62)); haze.addColorStop(0.62, rgba(color, alpha * 0.2)); haze.addColorStop(1, rgba(color, 0));
  context.fillStyle = haze;
  context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2); context.fill();
}

/** The control point that bends a link slightly, the same way every frame. */
export function bend(ax: number, ay: number, bx: number, by: number, sign: number): { x: number; y: number } {
  const mx = (ax + bx) / 2, my = (ay + by) / 2, length = Math.hypot(bx - ax, by - ay) || 1;
  return { x: mx - ((by - ay) / length) * length * 0.12 * sign, y: my + ((bx - ax) / length) * length * 0.12 * sign };
}

/** A point at `t` along a bent link. */
export function along(ax: number, ay: number, cx: number, cy: number, bx: number, by: number, t: number): { x: number; y: number } {
  const u = 1 - t;
  return { x: u * u * ax + 2 * u * t * cx + t * t * bx, y: u * u * ay + 2 * u * t * cy + t * t * by };
}

export interface Star {
  x: number; y: number;
  /** Size from importance and depth, in CSS pixels. */
  r: number;
  color: Rgb;
  alpha: number;
  style: "active" | "archived" | "curated";
  /** 0 at the surface … 1 in the abyss: deeper stars are softer and dimmer, as if out of focus. */
  depth: number;
  /** Diffraction spike strength, 0 for none. */
  spikes: number;
  /** A breathing aura around essential memories, 0 for none. */
  corona: number;
  /** Motes in orbit (memories that are often recalled). */
  motes: number;
  /** How much light it sheds into the bloom, 0–1 (from importance): faint memories stay crisp points. */
  glow: number;
  phase: number;
  time: number;
}

const softness = (depth: number): number => depth < 0.3 ? 0 : depth < 0.62 ? 1 : 2;

/** Where mote `index` of a star is now, and whether it passes in front. */
function mote(star: Star, index: number): { x: number; y: number; front: boolean } {
  const angle = star.time * (0.7 + index * 0.23) + star.phase * 3 + index * 2.1, orbit = star.r * (2.4 + index * 0.85);
  const tilt = star.phase + index * 0.8, ox = Math.cos(angle) * orbit, oy = Math.sin(angle) * orbit * 0.38;
  return { x: star.x + ox * Math.cos(tilt) - oy * Math.sin(tilt), y: star.y + ox * Math.sin(tilt) + oy * Math.cos(tilt), front: Math.sin(angle) > 0 };
}

/** The spike length now: a slow scintillation. */
const spikeLength = (star: Star): number => star.r * (8.5 + 1.1 * Math.sin(star.time * 1.1 + star.phase * 2)) * star.spikes * (1 - star.depth * 0.5);
const spikeAngle = (star: Star): number => star.phase * 0.35 + star.time * 0.015;

/** A star's light in the bloom buffer: it becomes the soft glow around it after blurring. */
export function bloomStar(bloom: CanvasRenderingContext2D, star: Star): void {
  if (star.alpha <= 0.01) return;
  const { x, y, r, color } = star;
  if (star.style === "archived") {
    bloom.fillStyle = rgba(color, star.alpha * 0.12);
    bloom.beginPath(); bloom.arc(x, y, r * 0.8, 0, Math.PI * 2); bloom.fill();
    return;
  }
  const strength = star.alpha * (1 - star.depth * 0.45);
  bloom.fillStyle = rgba(core(color, 0.15), strength * (0.26 + 0.56 * star.glow));
  bloom.beginPath(); bloom.arc(x, y, r * (0.4 + 0.68 * star.glow * star.glow + 0.12 * star.glow), 0, Math.PI * 2); bloom.fill();
  if (star.corona > 0) {
    const breath = Math.sin(star.time * 1.1 + star.phase);
    bloom.strokeStyle = rgba(color, strength * star.corona * (0.32 + 0.08 * breath)); bloom.lineWidth = r * 0.7;
    bloom.beginPath(); bloom.arc(x, y, r * (2.5 + 0.25 * breath), 0, Math.PI * 2); bloom.stroke();
  }
  if (star.spikes > 0) {
    const length = spikeLength(star), angle = spikeAngle(star);
    bloom.strokeStyle = rgba(core(color, 0.4), strength * 0.55 * star.spikes); bloom.lineWidth = 1.6;
    for (const turn of [0, Math.PI / 2]) {
      const dx = Math.cos(angle + turn) * length, dy = Math.sin(angle + turn) * length;
      bloom.beginPath(); bloom.moveTo(x - dx * 0.7, y - dy * 0.7); bloom.lineTo(x + dx * 0.7, y + dy * 0.7); bloom.stroke();
    }
  }
  for (let index = 0; index < star.motes; index += 1) {
    const at = mote(star, index);
    bloom.fillStyle = rgba(color, strength * (at.front ? 0.7 : 0.3));
    bloom.beginPath(); bloom.arc(at.x, at.y, 2.2, 0, Math.PI * 2); bloom.fill();
  }
}

/** The crisp star on top of its bloom: optical core, hairline spikes, motes. Expects the "lighter" blend. */
export function drawStar(context: CanvasRenderingContext2D, star: Star): void {
  if (star.alpha <= 0.005) return;
  const { x, y, r, color, alpha } = star;
  if (star.style === "archived") {
    context.globalAlpha = alpha * 0.75;
    context.strokeStyle = rgba(color, 0.55); context.lineWidth = 0.8; context.setLineDash([1.5, 3]);
    context.beginPath(); context.arc(x, y, r * 0.85, 0, Math.PI * 2); context.stroke();
    context.setLineDash([]);
    context.drawImage(starSprite(color, 2), x - r * 1.5, y - r * 1.5, r * 3, r * 3);
    context.globalAlpha = 1;
    return;
  }
  const size = r * (star.style === "curated" ? 5.5 : 7);
  context.globalAlpha = Math.min(1, alpha);
  context.drawImage(starSprite(color, softness(star.depth)), x - size / 2, y - size / 2, size, size);
  if (star.style === "curated") {
    const edge = r * 0.95;
    context.strokeStyle = rgba(core(color, 0.5), 0.7); context.lineWidth = 0.8;
    context.beginPath(); context.moveTo(x, y - edge); context.lineTo(x + edge, y); context.lineTo(x, y + edge); context.lineTo(x - edge, y); context.closePath(); context.stroke();
  }
  if (star.spikes > 0) {
    const length = spikeLength(star), angle = spikeAngle(star);
    // Hairline beams, brightest at the core; a fainter, shorter diagonal pair for the secondary diffraction.
    for (const [turn, reach, width, strength] of [[0, 1, 0.75, 0.9], [Math.PI / 2, 1, 0.75, 0.9], [Math.PI / 4, 0.42, 0.5, 0.35], [-Math.PI / 4, 0.42, 0.5, 0.35]] as const) {
      const dx = Math.cos(angle + turn) * length * reach, dy = Math.sin(angle + turn) * length * reach;
      const beam = context.createLinearGradient(x - dx, y - dy, x + dx, y + dy);
      const hot = rgba(core(color, 0.8), alpha * star.spikes * strength);
      beam.addColorStop(0, rgba(color, 0)); beam.addColorStop(0.42, rgba(color, alpha * star.spikes * strength * 0.25));
      beam.addColorStop(0.5, hot); beam.addColorStop(0.58, rgba(color, alpha * star.spikes * strength * 0.25)); beam.addColorStop(1, rgba(color, 0));
      context.strokeStyle = beam; context.lineWidth = width;
      context.beginPath(); context.moveTo(x - dx, y - dy); context.lineTo(x + dx, y + dy); context.stroke();
    }
  }
  if (star.corona > 0) drawRing(context, x, y, r * (2.5 + 0.25 * Math.sin(star.time * 1.1 + star.phase)), color, alpha * star.corona * 0.12, 0.6);
  for (let index = 0; index < star.motes; index += 1) {
    const at = mote(star, index);
    context.globalAlpha = alpha * (at.front ? 1 : 0.4);
    context.drawImage(starSprite(color, 0), at.x - 4, at.y - 4, 8, 8);
  }
  context.globalAlpha = 1;
}

/** A ring; `squash` < 1 lays it flat like a ripple on water. */
export function drawRing(context: CanvasRenderingContext2D, x: number, y: number, radius: number, color: Rgb, alpha: number, width = 1.4, squash = 1): void {
  if (alpha <= 0.005 || radius <= 0) return;
  context.strokeStyle = rgba(color, alpha); context.lineWidth = width;
  context.beginPath(); context.ellipse(x, y, radius, radius * squash, 0, 0, Math.PI * 2); context.stroke();
}
