/**
 * The space around the memories. It is deliberately almost nothing: the
 * memories are the only lights in the picture, and everything else exists to
 * give them depth.
 *
 * Behind them: the backdrop (one off-axis key light, a vignette and film
 * grain, cached as an image in `drawSea`) and a sparse field of dust that
 * drifts with the camera by its depth, so panning reads as moving through a
 * volume. In front of them: a faint pool of light that follows the pointer
 * and lifts the dust it passes over.
 *
 * Under reduced motion the clock is frozen, so the dust is a still picture
 * and the pointer light is left out.
 */
import { drawSea, type Frame } from "./oceanDraw";
import { rgba } from "./oceanPalette";

interface Particle { x: number; y: number; z: number; phase: number }

const DUST = 110;
const POINTER_REACH = 190;

function generator(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
}

const wrap = (value: number, size: number): number => ((value % size) + size) % size;

export class OceanAmbient {
  readonly #dust: Particle[];

  constructor() {
    const random = generator(2026);
    // Squaring the depth puts most of the dust far away: a few near motes, a quiet haze of distant ones.
    this.#dust = Array.from({ length: DUST }, () => ({ x: random(), y: random(), z: 0.15 + random() ** 2 * 0.85, phase: random() * Math.PI * 2 }));
  }

  /** Layers behind the memories. */
  back(frame: Frame): void {
    drawSea(frame);
    this.#drift(frame);
  }

  /** Layers in front of the memories. */
  front(frame: Frame): void {
    this.#pointerLight(frame);
  }

  /** Dust on a slow diagonal drift; near motes are larger, brighter and move more with the camera. */
  #drift(frame: Frame): void {
    const { context, width, height, time, palette, camera, pointer } = frame;
    for (const mote of this.#dust) {
      const x = wrap(mote.x * width - camera.x * camera.zoom * 0.14 * mote.z + time * 1.6 * mote.z, width);
      const y = wrap(mote.y * height - camera.y * camera.zoom * 0.14 * mote.z - time * 2.2 * mote.z + Math.sin(time * 0.12 + mote.phase) * 6 * mote.z, height);
      const lit = pointer && !frame.reduced ? Math.max(0, 1 - Math.hypot(x - pointer.x, y - pointer.y) / POINTER_REACH) : 0;
      const shimmer = 0.75 + 0.25 * Math.sin(time * 0.8 + mote.phase * 3);
      context.fillStyle = rgba(palette.plankton, ((0.05 + 0.2 * mote.z) * shimmer + lit * lit * 0.5) * frame.intro);
      const size = 0.6 + mote.z * 0.9;
      context.fillRect(x, y, size, size);
    }
  }

  #pointerLight(frame: Frame): void {
    const { context, pointer, palette } = frame;
    if (!pointer || frame.reduced) return;
    context.save();
    context.globalCompositeOperation = "lighter";
    const light = context.createRadialGradient(pointer.x, pointer.y, 0, pointer.x, pointer.y, POINTER_REACH);
    light.addColorStop(0, rgba(palette.caustic, 0.05)); light.addColorStop(0.45, rgba(palette.caustic, 0.016)); light.addColorStop(1, rgba(palette.caustic, 0));
    context.fillStyle = light;
    context.beginPath(); context.arc(pointer.x, pointer.y, POINTER_REACH, 0, Math.PI * 2); context.fill();
    context.restore();
  }
}
