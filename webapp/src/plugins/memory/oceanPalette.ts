/**
 * Memory Ocean colours and pre-rendered sprites. The sea is always night (the
 * owner's choice: glowing memories need darkness); the two appearances only
 * change its mood. Classic is a cold deep-sea teal, paper a warmer ink-indigo
 * with sepia light. Each kind of memory has its own bioluminescent hue.
 *
 * Every soft shape that is drawn many times a frame (stars, bokeh discs,
 * bubbles) is rendered once per colour into a small canvas and reused as an
 * image, which is far cheaper than a gradient per draw.
 */
import type { OceanKind } from "./oceanApi";

export type OceanMood = "classic" | "paper";
export type Rgb = readonly [number, number, number];

export interface OceanPalette {
  /** Sea gradient from the lit surface down to the abyss. */
  depths: readonly string[];
  /** Light falling through the water (shafts). */
  shaft: string;
  /** Caustic nets and the surface sheen. */
  caustic: Rgb;
  /** Faint glow rising from the abyss. */
  abyss: Rgb;
  /** Drifting plankton and marine snow. */
  plankton: Rgb;
  /** Unlit lines between memories. */
  line: Rgb;
  kinds: Readonly<Record<OceanKind | "curated", Rgb>>;
  /** Constellation names and other text drawn on the water. */
  ink: string;
}

/** Starlight hues: soft enough that a white-hot core and its tinted bloom read as light, not paint. */
const KINDS: Readonly<Record<OceanKind | "curated", Rgb>> = {
  preference: [248, 170, 196],
  fact: [130, 222, 230],
  decision: [246, 212, 140],
  experience: [184, 168, 252],
  pitfall: [246, 166, 112],
  curated: [210, 220, 232],
};

export const PALETTES: Readonly<Record<OceanMood, OceanPalette>> = {
  classic: {
    depths: ["#0d4158", "#082d42", "#051b2d", "#020a15"],
    shaft: "rgba(140, 220, 255, 0.05)",
    caustic: [150, 230, 255],
    abyss: [40, 160, 190],
    plankton: [150, 220, 255],
    line: [120, 200, 230],
    kinds: KINDS,
    ink: "rgba(214, 240, 255, 0.78)",
  },
  paper: {
    depths: ["#283357", "#1b2444", "#111830", "#090c1b"],
    shaft: "rgba(255, 226, 180, 0.045)",
    caustic: [255, 226, 186],
    abyss: [120, 110, 210],
    plankton: [255, 228, 196],
    line: [214, 196, 168],
    kinds: { ...KINDS, fact: [150, 204, 250], curated: [232, 222, 204] },
    ink: "rgba(250, 236, 214, 0.8)",
  },
};

export const rgba = (color: Rgb, alpha: number): string => `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;

/** Mix toward white: the hot core of a light. */
export const core = (color: Rgb, amount = 0.6): Rgb => [0, 1, 2].map((index) => Math.round(color[index]! + (255 - color[index]!) * amount)) as unknown as Rgb;

/** Blend two colours; `amount` 0 is `a`, 1 is `b`. */
export const mix = (a: Rgb, b: Rgb, amount = 0.5): Rgb => [0, 1, 2].map((index) => Math.round(a[index]! + (b[index]! - a[index]!) * amount)) as unknown as Rgb;

/** CSS colour for a kind, for the legend and cards outside the canvas. */
export const kindColor = (mood: OceanMood, kind: OceanKind | "curated"): string => rgba(PALETTES[mood].kinds[kind], 1);

const sprites = new Map<string, HTMLCanvasElement>();
function sprite(key: string, size: number, paint: (context: CanvasRenderingContext2D, size: number) => void): HTMLCanvasElement {
  const cached = sprites.get(key);
  if (cached) return cached;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  paint(canvas.getContext("2d")!, size);
  sprites.set(key, canvas);
  return canvas;
}

/**
 * A star as an optical point-spread function, rendered per pixel: a sharp
 * Gaussian core, a steep Moffat inner glow and a very faint wide halo, the
 * falloff a real lens gives a point of light. The centre burns near white
 * and only the outer light carries the hue, so it reads as light, not paint.
 * `soft` (0–2) widens every term for memories deeper in the water.
 */
export function starSprite(color: Rgb, soft = 0): HTMLCanvasElement {
  return sprite(`star:${color.join()}:${soft}`, 96, (context, size) => {
    const image = context.createImageData(size, size), data = image.data, half = size / 2, widen = 1 + soft * 0.8;
    for (let py = 0; py < size; py += 1) for (let px = 0; px < size; px += 1) {
      const r = Math.hypot(px + 0.5 - half, py + 0.5 - half) / half;
      if (r >= 1) continue;
      const coreTerm = Math.exp(-((r / (0.05 * widen)) ** 2));
      const glow = 0.42 * (1 + (r / (0.1 * widen)) ** 2) ** -2.6;
      const halo = 0.055 * Math.exp(-((r / (0.42 * widen)) ** 2));
      const edge = r > 0.78 ? 1 - (r - 0.78) / 0.22 : 1;
      const intensity = Math.min(1, (coreTerm * (1 - soft * 0.25) + glow + halo) * edge);
      const white = (1 - Math.min(1, r / (0.2 * widen))) ** 1.8;
      const index = (py * size + px) * 4;
      data[index] = color[0] + (255 - color[0]) * white;
      data[index + 1] = color[1] + (255 - color[1]) * white;
      data[index + 2] = color[2] + (255 - color[2]) * white;
      data[index + 3] = intensity * 255;
    }
    context.putImageData(image, 0, 0);
  });
}

/** An out-of-focus disc with a slightly brighter rim, like lens bokeh. */
export function bokehSprite(color: Rgb): HTMLCanvasElement {
  return sprite(`bokeh:${color.join()}`, 128, (context, size) => {
    const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, rgba(color, 0.55));
    gradient.addColorStop(0.72, rgba(color, 0.7));
    gradient.addColorStop(0.86, rgba(core(color, 0.3), 0.9));
    gradient.addColorStop(1, rgba(color, 0));
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
  });
}

/** A small rising bubble: a thin rim, a faint body and a highlight. */
export function bubbleSprite(color: Rgb): HTMLCanvasElement {
  return sprite(`bubble:${color.join()}`, 32, (context, size) => {
    const half = size / 2;
    const body = context.createRadialGradient(half, half, half * 0.5, half, half, half * 0.95);
    body.addColorStop(0, rgba(color, 0.04)); body.addColorStop(0.85, rgba(color, 0.22)); body.addColorStop(1, rgba(core(color, 0.6), 0.75));
    context.fillStyle = body;
    context.beginPath(); context.arc(half, half, half * 0.95, 0, Math.PI * 2); context.fill();
    context.fillStyle = "rgba(255, 255, 255, 0.85)";
    context.beginPath(); context.ellipse(half - half * 0.35, half - half * 0.4, half * 0.22, half * 0.13, -0.6, 0, Math.PI * 2); context.fill();
  });
}

/** The appearance in use: paper is the default palette, classic is `data-xn-palette="claudex"`. */
export function currentMood(): OceanMood {
  return document.documentElement.dataset.xnPalette === "claudex" ? "classic" : "paper";
}

/** Settings → 减少动效 or the system preference. */
export function prefersReducedMotion(): boolean {
  return document.documentElement.dataset.xnMotion === "reduced" || (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
}
