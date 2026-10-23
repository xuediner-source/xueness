/**
 * RGBA rasters for the Read image pipeline: the decoded form every codec
 * produces and consumes, plus the resampling and EXIF orientation that the
 * ZCode image adapter (jimp `scaleToFit` with bicubic, EXIF rotate) applies.
 */

export interface Raster {
  width: number;
  height: number;
  /** Row-major RGBA, 4 bytes per pixel, straight (not premultiplied) alpha. */
  data: Uint8Array;
}

export class ImageCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageCodecError";
  }
}

/** Decoded images larger than this many pixels are refused (200 MB of RGBA). */
export const MAX_DECODED_PIXELS = 50_000_000;

export function createRaster(width: number, height: number): Raster {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new ImageCodecError("invalid image dimensions");
  if (width * height > MAX_DECODED_PIXELS) throw new ImageCodecError("image dimensions exceed the decoder limit");
  return { width, height, data: new Uint8Array(width * height * 4) };
}

export function isOpaque(raster: Raster): boolean {
  const { data } = raster;
  for (let index = 3; index < data.length; index += 4) if (data[index] !== 255) return false;
  return true;
}

/** Bicubic (a = -0.5) kernel; widened by the scale factor when shrinking, as area-aware resamplers do. */
function cubic(x: number): number {
  const t = Math.abs(x);
  if (t < 1) return (1.5 * t - 2.5) * t * t + 1;
  if (t < 2) return ((-0.5 * t + 2.5) * t - 4) * t + 2;
  return 0;
}

interface Weights { start: Int32Array; count: Int32Array; values: Float32Array; span: number }

function weights(source: number, target: number): Weights {
  const scale = source / target;
  const stretch = Math.max(1, scale);
  const support = 2 * stretch;
  const span = Math.ceil(2 * support) + 2;
  const start = new Int32Array(target), count = new Int32Array(target), values = new Float32Array(target * span);
  for (let out = 0; out < target; out += 1) {
    const center = (out + 0.5) * scale;
    const first = Math.max(0, Math.floor(center - support)), last = Math.min(source - 1, Math.ceil(center + support));
    let total = 0, n = 0;
    for (let input = first; input <= last && n < span; input += 1) {
      const weight = cubic((input + 0.5 - center) / stretch);
      values[out * span + n] = weight; total += weight; n += 1;
    }
    if (total !== 0) for (let k = 0; k < n; k += 1) values[out * span + k]! /= total;
    start[out] = first; count[out] = n;
  }
  return { start, count, values, span };
}

const clamp = (value: number): number => value <= 0 ? 0 : value >= 255 ? 255 : Math.round(value);

/** Resample to `width` × `height` with premultiplied alpha (no dark fringes at transparent edges). */
export function resize(source: Raster, width: number, height: number): Raster {
  if (width === source.width && height === source.height) return { width, height, data: source.data.slice() };
  const target = createRaster(width, height);
  const horizontal = weights(source.width, width), vertical = weights(source.height, height);
  // Pass 1: rows, into premultiplied floats.
  const middle = new Float32Array(width * source.height * 4);
  const src = source.data;
  for (let y = 0; y < source.height; y += 1) {
    const row = y * source.width * 4;
    for (let x = 0; x < width; x += 1) {
      let r = 0, g = 0, b = 0, a = 0;
      const first = horizontal.start[x]!, n = horizontal.count[x]!, base = x * horizontal.span;
      for (let k = 0; k < n; k += 1) {
        const weight = horizontal.values[base + k]!, at = row + (first + k) * 4, alpha = src[at + 3]! * weight;
        r += src[at]! * alpha; g += src[at + 1]! * alpha; b += src[at + 2]! * alpha; a += alpha;
      }
      const out = (y * width + x) * 4;
      middle[out] = r; middle[out + 1] = g; middle[out + 2] = b; middle[out + 3] = a;
    }
  }
  // Pass 2: columns, then un-premultiply.
  const dst = target.data;
  for (let y = 0; y < height; y += 1) {
    const first = vertical.start[y]!, n = vertical.count[y]!, base = y * vertical.span;
    for (let x = 0; x < width; x += 1) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < n; k += 1) {
        const weight = vertical.values[base + k]!, at = ((first + k) * width + x) * 4;
        r += middle[at]! * weight; g += middle[at + 1]! * weight; b += middle[at + 2]! * weight; a += middle[at + 3]! * weight;
      }
      const out = (y * width + x) * 4;
      if (a <= 0) { dst[out] = dst[out + 1] = dst[out + 2] = dst[out + 3] = 0; continue; }
      dst[out] = clamp(r / a); dst[out + 1] = clamp(g / a); dst[out + 2] = clamp(b / a); dst[out + 3] = clamp(a);
    }
  }
  return target;
}

/** jimp `scaleToFit(maxEdge, maxEdge)`: shrink so the longest edge is `maxEdge`; never enlarge. */
export function fitWithin(source: Raster, maxEdge: number): Raster {
  const longest = Math.max(source.width, source.height);
  if (longest <= maxEdge) return source;
  const factor = maxEdge / longest;
  return resize(source, Math.max(1, Math.round(source.width * factor)), Math.max(1, Math.round(source.height * factor)));
}

/** Apply an EXIF orientation (1–8) so the raster reads upright. */
export function orient(source: Raster, orientation: number): Raster {
  if (!Number.isInteger(orientation) || orientation < 2 || orientation > 8) return source;
  const swap = orientation >= 5;
  const width = swap ? source.height : source.width, height = swap ? source.width : source.height;
  const target = createRaster(width, height);
  const sw = source.width, sh = source.height;
  for (let y = 0; y < sh; y += 1) {
    for (let x = 0; x < sw; x += 1) {
      let tx: number, ty: number;
      switch (orientation) {
        case 2: tx = sw - 1 - x; ty = y; break;
        case 3: tx = sw - 1 - x; ty = sh - 1 - y; break;
        case 4: tx = x; ty = sh - 1 - y; break;
        case 5: tx = y; ty = x; break;
        case 6: tx = sh - 1 - y; ty = x; break;
        case 7: tx = sh - 1 - y; ty = sw - 1 - x; break;
        default: tx = y; ty = sw - 1 - x; break;
      }
      const from = (y * sw + x) * 4, to = (ty * width + tx) * 4;
      target.data[to] = source.data[from]!; target.data[to + 1] = source.data[from + 1]!; target.data[to + 2] = source.data[from + 2]!; target.data[to + 3] = source.data[from + 3]!;
    }
  }
  return target;
}

/**
 * Drop alpha for a format that has none: keep the stored colour and make every
 * pixel opaque. jimp's JPEG encoder ignores the alpha channel the same way, so
 * a transparent area keeps the colour the source stored under it instead of
 * being repainted white.
 */
export function dropAlpha(source: Raster): Raster {
  const target = { width: source.width, height: source.height, data: new Uint8Array(source.data.length) };
  const src = source.data, dst = target.data;
  for (let index = 0; index < src.length; index += 4) {
    dst[index] = src[index]!; dst[index + 1] = src[index + 1]!; dst[index + 2] = src[index + 2]!; dst[index + 3] = 255;
  }
  return target;
}
