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
let grain: HTMLCanvasElement | null = null;

/** A small tile of very faint black and white specks, generated once from a fixed seed. */
function grainTile(): HTMLCanvasElement {
  if (grain) return grain;
  const size = 160, canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const paint = canvas.getContext("2d")!, image = paint.createImageData(size, size);
  let state = 20261115;
  for (let index = 0; index < image.data.length; index += 4) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    const value = (state >>> 0) / 4294967296, light = value > 0.5;
    image.data[index] = image.data[index + 1] = image.data[index + 2] = light ? 255 : 0;
    image.data[index + 3] = Math.abs(value - 0.5) * (light ? 9 : 16);
  }
  paint.putImageData(image, 0, 0);
  grain = canvas;
  return canvas;
}

/** The backdrop: the depth gradient under one off-axis key light, a vignette and film grain. Cached as one image. */
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
    // One key light, off-axis from the upper left, with a long falloff: the only light that is not a memory.
    const reach = Math.hypot(width, height) * 0.85;
    const key_ = paint.createRadialGradient(width * 0.24, -height * 0.18, 0, width * 0.24, -height * 0.18, reach);
    key_.addColorStop(0, rgba(palette.caustic, 0.085)); key_.addColorStop(0.35, rgba(palette.caustic, 0.03)); key_.addColorStop(1, rgba(palette.caustic, 0));
    paint.fillStyle = key_; paint.fillRect(0, 0, width, height);
    // Its faint answer from the opposite corner keeps the far side from going flat.
    const fill = paint.createRadialGradient(width * 0.9, height * 1.15, 0, width * 0.9, height * 1.15, reach * 0.7);
    fill.addColorStop(0, rgba(palette.abyss, 0.05)); fill.addColorStop(1, rgba(palette.abyss, 0));
    paint.fillStyle = fill; paint.fillRect(0, 0, width, height);
    const vignette = paint.createRadialGradient(width / 2, height / 2, Math.min(width, height) * 0.4, width / 2, height / 2, Math.max(width, height) * 0.8);
    vignette.addColorStop(0, "rgba(0, 0, 0, 0)"); vignette.addColorStop(1, "rgba(0, 0, 0, 0.28)");
    paint.fillStyle = vignette; paint.fillRect(0, 0, width, height);
    // Film grain breaks up the banding that long dark gradients show on 8-bit displays.
    paint.setTransform(1, 0, 0, 1, 0, 0);
    paint.fillStyle = paint.createPattern(grainTile(), "repeat")!;
    paint.fillRect(0, 0, canvas.width, canvas.height);
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

/** The spike length now: a slow, slight scintillation. Spikes are axis-aligned, like a reticle, and do not turn. */
const spikeLength = (star: Star): number => star.r * (5.6 + 0.35 * Math.sin(star.time * 0.8 + star.phase * 2)) * star.spikes * (1 - star.depth * 0.5);

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
  // Only the core sheds light: rings, spikes and motes stay crisp, so the glow reads as one soft falloff per memory.
  bloom.fillStyle = rgba(core(color, 0.2), strength * (0.2 + 0.5 * star.glow));
  bloom.beginPath(); bloom.arc(x, y, r * (0.38 + 0.6 * star.glow * star.glow + 0.1 * star.glow), 0, Math.PI * 2); bloom.fill();
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
  const size = r * (star.style === "curated" ? 4.6 : 5.6);
  context.globalAlpha = Math.min(1, alpha);
  context.drawImage(starSprite(color, softness(star.depth)), x - size / 2, y - size / 2, size, size);
  if (star.style === "curated") {
    const edge = r * 0.95;
    context.strokeStyle = rgba(core(color, 0.5), 0.7); context.lineWidth = 0.8;
    context.beginPath(); context.moveTo(x, y - edge); context.lineTo(x + edge, y); context.lineTo(x, y + edge); context.lineTo(x - edge, y); context.closePath(); context.stroke();
  }
  if (star.spikes > 0) {
    const length = spikeLength(star);
    // Two hairlines, horizontal a little longer than vertical, fading out from the core.
    for (const [dx, dy] of [[length, 0], [0, length * 0.72]] as const) {
      const beam = context.createLinearGradient(x - dx, y - dy, x + dx, y + dy);
      beam.addColorStop(0, rgba(color, 0)); beam.addColorStop(0.4, rgba(color, alpha * star.spikes * 0.16));
      beam.addColorStop(0.5, rgba(core(color, 0.85), alpha * star.spikes * 0.7)); beam.addColorStop(0.6, rgba(color, alpha * star.spikes * 0.16)); beam.addColorStop(1, rgba(color, 0));
      context.strokeStyle = beam; context.lineWidth = 0.6;
      context.beginPath(); context.moveTo(x - dx, y - dy); context.lineTo(x + dx, y + dy); context.stroke();
    }
  }
  if (star.corona > 0) drawRing(context, x, y, r * (2.3 + 0.12 * Math.sin(star.time * 0.7 + star.phase)), core(color, 0.3), alpha * star.corona * 0.2, 0.5);
  for (let index = 0; index < star.motes; index += 1) {
    const at = mote(star, index);
    context.globalAlpha = alpha * (at.front ? 1 : 0.4);
    context.drawImage(starSprite(color, 0), at.x - 3, at.y - 3, 6, 6);
  }
  context.globalAlpha = 1;
}

/** A ring; `squash` < 1 lays it flat like a ripple on water. */
export function drawRing(context: CanvasRenderingContext2D, x: number, y: number, radius: number, color: Rgb, alpha: number, width = 1.4, squash = 1): void {
  if (alpha <= 0.005 || radius <= 0) return;
  context.strokeStyle = rgba(color, alpha); context.lineWidth = width;
  context.beginPath(); context.ellipse(x, y, radius, radius * squash, 0, 0, Math.PI * 2); context.stroke();
}
