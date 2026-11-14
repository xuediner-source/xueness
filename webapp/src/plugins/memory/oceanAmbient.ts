/**
 * The sea around the memories, in two passes.
 *
 * Behind them: the backdrop, caustic light nets rippling through the water
 * (computed on a small buffer and stretched, so they cost a few thousand
 * sines a frame), shafts of light, distant bokeh and plankton that brighten
 * near the pointer. In front of them: marine snow, rising bubbles that pop at
 * the surface, near bokeh, the underside of the surface with its glints, and
 * a lantern glow that follows the pointer.
 *
 * Everything moves with the camera by its depth (parallax). Under reduced
 * motion the clock is frozen, so every layer is a still picture; bubbles and
 * the lantern are left out. With the quality guard on (`low`), caustics,
 * bokeh and bubbles are skipped.
 */
import { drawSea, type Frame } from "./oceanDraw";
import { bokehSprite, bubbleSprite, mix, rgba, type Rgb } from "./oceanPalette";

interface Particle { x: number; y: number; z: number; phase: number }
interface Bubble { x: number; y: number; r: number; speed: number; phase: number }
interface Pop { x: number; y: number; at: number }

const CAUSTIC_W = 176, CAUSTIC_H = 110;
/** Wave number of the caustic ridges, in buffer pixels: about a dozen cells across. */
const RIDGE = 0.34;

function generator(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
}

const wrap = (value: number, size: number): number => ((value % size) + size) % size;

/** The surface height (from the top) at `x`. */
function surfaceAt(x: number, time: number, shift: number): number {
  const u = x + shift;
  return 16 + 5 * Math.sin(u * 0.011 + time * 0.55) + 2.6 * Math.sin(u * 0.027 - time * 0.9 + 1.3) + 1.1 * Math.sin(u * 0.061 + time * 1.6);
}

export class OceanAmbient {
  readonly #random = generator(2026);
  readonly #plankton: Particle[];
  readonly #snow: Particle[];
  readonly #orbs: (Particle & { r: number; hue: number })[];
  #bubbles: Bubble[] = [];
  #pops: Pop[] = [];
  #caustic: { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D; image: ImageData; stamp: number } | null = null;
  #tick = 0;

  constructor() {
    const random = this.#random;
    const particles = (count: number): Particle[] => Array.from({ length: count }, () => ({ x: random(), y: random(), z: 0.2 + random() * 0.8, phase: random() * Math.PI * 2 }));
    this.#plankton = particles(220);
    this.#snow = particles(120);
    this.#orbs = particles(11).map((particle, index) => ({ ...particle, r: 36 + random() * 90, hue: index % 5 }));
  }

  /** Layers behind the memories. */
  back(frame: Frame, kinds: readonly Rgb[]): void {
    drawSea(frame);
    if (!frame.low) this.#caustics(frame);
    this.#shafts(frame);
    if (!frame.low) this.#bokeh(frame, kinds, false);
    this.#drift(frame);
  }

  /** Layers in front of the memories. */
  front(frame: Frame, kinds: readonly Rgb[]): void {
    this.#snowfall(frame);
    if (!frame.reduced && !frame.low) this.#rise(frame);
    if (!frame.low) this.#bokeh(frame, kinds, true);
    this.#surface(frame);
    this.#lantern(frame);
  }

  #caustics(frame: Frame): void {
    const { context, width, height, time, palette, camera } = frame;
    if (!this.#caustic) {
      const canvas = document.createElement("canvas");
      canvas.width = CAUSTIC_W; canvas.height = CAUSTIC_H;
      const paint = canvas.getContext("2d")!;
      this.#caustic = { canvas, context: paint, image: paint.createImageData(CAUSTIC_W, CAUSTIC_H), stamp: NaN };
    }
    const buffer = this.#caustic;
    this.#tick += 1;
    // Half rate is plenty for something this soft; a frozen clock computes it once.
    if (buffer.stamp !== time && (this.#tick % 2 === 0 || Number.isNaN(buffer.stamp))) {
      buffer.stamp = time;
      // Three warped wave fields at 60° to each other: where their thin ridges cross, the light
      // gathers into the cellular web that real caustics make. Brightest near the surface.
      const data = buffer.image.data, [r, g, b] = palette.caustic;
      const drift = camera.x * camera.zoom * 0.004;
      for (let py = 0; py < CAUSTIC_H; py += 1) {
        const fade = Math.max(0, 1 - py / (CAUSTIC_H * 0.72));
        for (let px = 0; px < CAUSTIC_W; px += 1) {
          const index = (py * CAUSTIC_W + px) * 4;
          if (fade <= 0) { data[index + 3] = 0; continue; }
          const x = px + drift, y = py;
          const d1 = x, d2 = x * 0.5 + y * 0.866, d3 = -x * 0.5 + y * 0.866;
          const a = Math.sin(d1 * RIDGE + Math.sin(d2 * RIDGE * 0.6 + time * 0.5) * 1.3 + time * 0.55);
          const c = Math.sin(d2 * RIDGE + Math.sin(d3 * RIDGE * 0.6 - time * 0.45) * 1.3 - time * 0.4);
          const e = Math.sin(d3 * RIDGE + Math.sin(d1 * RIDGE * 0.6 + time * 0.35) * 1.3 + time * 0.3);
          let s = 1 - Math.abs(a); s *= s; s *= s; s *= s; s *= s;
          let t = 1 - Math.abs(c); t *= t; t *= t; t *= t; t *= t;
          let u = 1 - Math.abs(e); u *= u; u *= u; u *= u; u *= u;
          const value = Math.min(1.6, s + t + u + (s * t + t * u + u * s) * 2);
          data[index] = r; data[index + 1] = g; data[index + 2] = b; data[index + 3] = Math.min(255, value * fade * fade * 62);
        }
      }
      buffer.context.putImageData(buffer.image, 0, 0);
    }
    context.save();
    context.globalCompositeOperation = "lighter";
    context.globalAlpha = 0.5 * frame.intro;
    context.imageSmoothingEnabled = true; context.imageSmoothingQuality = "high";
    context.drawImage(buffer.canvas, 0, 0, width, height * 0.75);
    context.restore();
  }

  #shafts(frame: Frame): void {
    const { context, width, height, time, palette } = frame;
    context.save();
    context.globalCompositeOperation = "lighter";
    for (let index = 0; index < 6; index += 1) {
      const sway = Math.sin(time * 0.06 + index * 1.9) * width * 0.06;
      const top = width * (0.08 + index * 0.17) + sway, spread = width * (0.04 + (index % 3) * 0.022);
      const fall = context.createLinearGradient(0, 0, 0, height * 0.88);
      fall.addColorStop(0, palette.shaft); fall.addColorStop(1, "rgba(0, 0, 0, 0)");
      context.fillStyle = fall;
      context.globalAlpha = (0.55 + 0.45 * Math.sin(time * 0.17 + index * 2.3)) * frame.intro;
      context.beginPath();
      context.moveTo(top - spread * 0.4, 0); context.lineTo(top + spread * 0.4, 0);
      context.lineTo(top + spread * 2.4 + sway, height * 0.88); context.lineTo(top - spread * 1.2 + sway, height * 0.88);
      context.closePath(); context.fill();
    }
    context.restore();
  }

  #bokeh(frame: Frame, kinds: readonly Rgb[], near: boolean): void {
    const { context, width, height, time, camera } = frame;
    context.save();
    context.globalCompositeOperation = "lighter";
    for (const orb of this.#orbs) {
      if ((orb.z > 0.7) !== near) continue;
      const pull = near ? 0.35 : 0.08;
      const x = wrap(orb.x * (width + 240) - camera.x * camera.zoom * pull * orb.z + Math.sin(time * 0.05 + orb.phase) * 30, width + 240) - 120;
      const y = wrap(orb.y * (height + 240) - camera.y * camera.zoom * pull * orb.z + Math.cos(time * 0.04 + orb.phase) * 24, height + 240) - 120;
      const radius = orb.r * (near ? 1.4 : 0.8);
      context.globalAlpha = (near ? 0.05 : 0.07) * orb.z * (0.7 + 0.3 * Math.sin(time * 0.3 + orb.phase)) * frame.intro;
      context.drawImage(bokehSprite(kinds[orb.hue % kinds.length] ?? [255, 255, 255]), x - radius, y - radius, radius * 2, radius * 2);
    }
    context.restore();
  }

  /** Plankton drifting upward; they brighten in the pointer's lantern. */
  #drift(frame: Frame): void {
    const { context, width, height, time, palette, camera, pointer } = frame;
    for (const particle of this.#plankton) {
      const x = wrap(particle.x * width - camera.x * camera.zoom * 0.12 * particle.z + Math.sin(time * 0.1 + particle.phase) * 14 * particle.z + time * 3 * particle.z, width);
      const y = wrap(particle.y * height - camera.y * camera.zoom * 0.12 * particle.z - time * 4 * particle.z, height);
      const lit = pointer && !frame.reduced ? Math.max(0, 1 - Math.hypot(x - pointer.x, y - pointer.y) / 150) : 0;
      const alpha = ((0.12 + 0.35 * particle.z) * (0.55 + 0.45 * Math.sin(time * 1.3 + particle.phase * 3)) + lit * 0.7) * frame.intro;
      context.fillStyle = rgba(palette.plankton, alpha);
      const size = (0.5 + particle.z * 1.2) * (1 + lit * 0.8);
      context.fillRect(x, y, size, size);
    }
  }

  #snowfall(frame: Frame): void {
    const { context, width, height, time, palette, camera } = frame;
    context.fillStyle = rgba(mix(palette.plankton, [255, 255, 255], 0.4), 1);
    for (const flake of this.#snow) {
      const x = wrap(flake.x * width - camera.x * camera.zoom * 0.2 * flake.z + Math.sin(time * 0.4 + flake.phase) * 8, width);
      const y = wrap(flake.y * height - camera.y * camera.zoom * 0.2 * flake.z + time * (6 + 10 * flake.z), height);
      context.globalAlpha = (0.06 + 0.22 * flake.z) * frame.intro;
      const size = 0.6 + flake.z * 1.4;
      context.beginPath(); context.arc(x, y, size / 2, 0, Math.PI * 2); context.fill();
    }
    context.globalAlpha = 1;
  }

  #rise(frame: Frame): void {
    const { context, width, height, time, delta, palette, camera, pointer } = frame;
    if (this.#bubbles.length < 26 && this.#random() < delta * 1.4) {
      this.#bubbles.push({ x: 0.04 + this.#random() * 0.92, y: height + 12, r: 1.2 + this.#random() * 2.8, speed: 22 + this.#random() * 30, phase: this.#random() * Math.PI * 2 });
    }
    const shift = camera.x * camera.zoom * 0.3;
    const sprite = bubbleSprite(mix(palette.caustic, [255, 255, 255], 0.3));
    const kept: Bubble[] = [];
    for (const bubble of this.#bubbles) {
      bubble.y -= bubble.speed * delta * (1 + (bubble.r - 2) * 0.12);
      const x = bubble.x * width + Math.sin(time * 2.2 + bubble.phase) * (3 + bubble.r);
      if (bubble.y <= surfaceAt(x, time, shift) + 2) { this.#pops.push({ x, y: bubble.y, at: time }); continue; }
      kept.push(bubble);
      const near = pointer ? Math.max(0, 1 - Math.hypot(x - pointer.x, bubble.y - pointer.y) / 160) : 0;
      context.globalAlpha = Math.min(1, 0.55 + near * 0.45) * Math.min(1, (height + 12 - bubble.y) / 60);
      const size = bubble.r * 2 * (1 + 0.08 * Math.sin(time * 6 + bubble.phase));
      context.drawImage(sprite, x - size / 2, bubble.y - size / 2, size, size);
    }
    this.#bubbles = kept;
    this.#pops = this.#pops.filter((pop) => time - pop.at < 0.45);
    for (const pop of this.#pops) {
      const progress = (time - pop.at) / 0.45;
      context.globalAlpha = (1 - progress) * 0.7;
      context.strokeStyle = rgba(palette.caustic, 1); context.lineWidth = 0.8;
      context.beginPath(); context.ellipse(pop.x, pop.y, 2 + progress * 9, (2 + progress * 9) * 0.35, 0, 0, Math.PI * 2); context.stroke();
    }
    context.globalAlpha = 1;
  }

  /** The underside of the surface: a moving sheen, a bright refracting edge and scattered glints. */
  #surface(frame: Frame): void {
    const { context, width, time, palette, camera } = frame;
    const shift = camera.x * camera.zoom * 0.3;
    const points: [number, number][] = [];
    for (let x = -8; x <= width + 8; x += 8) points.push([x, surfaceAt(x, time, shift)]);
    context.save();
    context.globalAlpha = frame.intro;
    const sheen = context.createLinearGradient(0, 0, 0, 26);
    sheen.addColorStop(0, rgba(palette.caustic, 0.26)); sheen.addColorStop(1, rgba(palette.caustic, 0.02));
    context.fillStyle = sheen;
    context.beginPath(); context.moveTo(-8, 0);
    for (const [x, y] of points) context.lineTo(x, y);
    context.lineTo(width + 8, 0); context.closePath(); context.fill();
    context.globalCompositeOperation = "lighter";
    for (const [offset, alpha, line] of [[0, 0.42, 1.2], [3.5, 0.13, 1], [8, 0.05, 2]] as const) {
      context.strokeStyle = rgba(mix(palette.caustic, [255, 255, 255], 0.5), alpha); context.lineWidth = line;
      context.beginPath();
      points.forEach(([x, y], index) => { if (index) context.lineTo(x, y + offset); else context.moveTo(x, y + offset); });
      context.stroke();
    }
    context.fillStyle = "rgba(255, 255, 255, 0.9)";
    for (let index = 1; index < points.length - 1; index += 1) {
      const [x, y] = points[index]!, before = points[index - 1]![1], after = points[index + 1]![1];
      if (!(y > before && y >= after)) continue;
      const twinkle = 0.5 + 0.5 * Math.sin(time * 3 + x * 0.05);
      context.globalAlpha = twinkle * 0.8 * frame.intro;
      context.beginPath(); context.ellipse(x, y + 0.5, 5 + twinkle * 4, 0.9, 0, 0, Math.PI * 2); context.fill();
    }
    context.restore();
  }

  #lantern(frame: Frame): void {
    const { context, pointer, palette } = frame;
    if (!pointer || frame.reduced) return;
    context.save();
    context.globalCompositeOperation = "lighter";
    const light = context.createRadialGradient(pointer.x, pointer.y, 0, pointer.x, pointer.y, 170);
    light.addColorStop(0, rgba(palette.caustic, 0.085)); light.addColorStop(0.4, rgba(palette.caustic, 0.03)); light.addColorStop(1, rgba(palette.caustic, 0));
    context.fillStyle = light;
    context.beginPath(); context.arc(pointer.x, pointer.y, 170, 0, Math.PI * 2); context.fill();
    context.restore();
  }
}
