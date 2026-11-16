/**
 * Memory Ocean colours and pre-rendered sprites. The sea is always night (the
 * owner's choice: glowing memories need darkness); the two appearances only
 * change its temperature, following the app's own neutrals. Each kind of
 * memory has its own muted hue.
 *
 * A star is drawn many times a frame, so it is rendered once per colour into
 * a small canvas and reused as an image, which is far cheaper than a gradient
 * per draw.
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

/**
 * Starlight hues, kept muted: a white-hot core and a tinted bloom read as
 * light, and five quiet pigments sit with the app's neutral surfaces where
 * saturated neon would not.
 */
const KINDS: Readonly<Record<OceanKind | "curated", Rgb>> = {
  preference: [226, 170, 186],
  fact: [150, 204, 214],
  decision: [228, 202, 146],
  experience: [180, 172, 228],
  pitfall: [226, 164, 124],
  curated: [206, 210, 216],
};

/**
 * The water takes its colour from the app, not from a postcard: the default
 * appearance (`paper` mood) is a graphite night next to the neutral greys, the
 * Claudex appearance (`classic` mood) a warm ink-charcoal next to its paper
 * tones. Light in the water is near white with only a trace of temperature.
 */
export const PALETTES: Readonly<Record<OceanMood, OceanPalette>> = {
  classic: {
    depths: ["#2f2a24", "#24201b", "#1a1714", "#100e0c"],
    shaft: "rgba(255, 232, 200, 0.028)",
    caustic: [240, 222, 196],
    abyss: [176, 124, 92],
    plankton: [238, 224, 204],
    line: [206, 190, 168],
    kinds: { ...KINDS, curated: [222, 212, 196] },
    ink: "rgba(238, 232, 220, 0.76)",
  },
  paper: {
    depths: ["#262a31", "#1c1f25", "#14161a", "#0c0d10"],
    shaft: "rgba(220, 232, 255, 0.026)",
    caustic: [214, 224, 238],
    abyss: [110, 128, 168],
    plankton: [214, 222, 234],
    line: [176, 188, 206],
    kinds: KINDS,
    ink: "rgba(232, 236, 242, 0.76)",
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

/** The appearance in use: paper is the default palette, classic is `data-xn-palette="claudex"`. */
export function currentMood(): OceanMood {
  return document.documentElement.dataset.xnPalette === "claudex" ? "classic" : "paper";
}

/** Settings → 减少动效 or the system preference. */
export function prefersReducedMotion(): boolean {
  return document.documentElement.dataset.xnMotion === "reduced" || (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
}
