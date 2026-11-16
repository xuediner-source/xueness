/**
 * Bloom: the soft light that spills around bright things, done the way a
 * film renderer does it rather than with one big halo per light.
 *
 * Cores, spike beams, auras and comets are drawn into a quarter-resolution
 * light buffer during the frame. `composite` then lays that buffer over the
 * scene twice, blurred at a tight and a medium radius, with the
 * screen blend: light from nearby stars merges into one glow, the falloff is
 * smooth and free of banding, and bright areas saturate gently instead of
 * clipping to white. Where canvas filters are unavailable the upscaled
 * buffer alone (already soft) is used; the quality guard keeps one pass.
 */
export const BLOOM_SCALE = 0.25;

export class OceanBloom {
  readonly #canvas = document.createElement("canvas");
  readonly #context = this.#canvas.getContext("2d")!;
  readonly #filters = "filter" in this.#context;

  /** Clear the buffer for a frame and return it, scaled so callers draw in CSS pixels. */
  begin(width: number, height: number): CanvasRenderingContext2D {
    const w = Math.max(1, Math.ceil(width * BLOOM_SCALE)), h = Math.max(1, Math.ceil(height * BLOOM_SCALE));
    if (this.#canvas.width !== w || this.#canvas.height !== h) { this.#canvas.width = w; this.#canvas.height = h; }
    const context = this.#context;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, w, h);
    context.setTransform(BLOOM_SCALE, 0, 0, BLOOM_SCALE, 0, 0);
    context.globalCompositeOperation = "lighter";
    return context;
  }

  /** Lay the buffer over `target` (drawing in CSS pixels). */
  composite(target: CanvasRenderingContext2D, width: number, height: number, strength: number, low: boolean): void {
    target.save();
    target.globalCompositeOperation = "screen";
    target.imageSmoothingEnabled = true; target.imageSmoothingQuality = "high";
    const passes: [number, number][] = low || !this.#filters ? [[0, 0.95]] : [[3, 0.8], [14, 0.34]];
    for (const [blur, alpha] of passes) {
      if (this.#filters) target.filter = blur ? `blur(${blur}px)` : "none";
      target.globalAlpha = Math.min(1, alpha * strength);
      target.drawImage(this.#canvas, 0, 0, width, height);
    }
    if (this.#filters) target.filter = "none";
    target.restore();
  }
}
