/**
 * GIF decode of the first frame (LZW, global or local palette, transparency,
 * interlace) onto a transparent logical screen. GIFs are not re-encoded:
 * an oversized GIF goes down the JPEG ladder (see prepare.ts).
 */
import { createRaster, ImageCodecError, type Raster } from "./raster.ts";

export function isGif(data: Uint8Array): boolean {
  return data.length >= 6 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46;
}

function lzw(data: Uint8Array, minSize: number, pixels: number): Uint8Array {
  if (minSize < 2 || minSize > 11) throw new ImageCodecError("invalid GIF LZW code size");
  const out = new Uint8Array(pixels);
  const clear = 1 << minSize, end = clear + 1;
  const prefix = new Int32Array(4096), suffix = new Uint8Array(4096), firsts = new Uint8Array(4096), lengths = new Int32Array(4096);
  for (let code = 0; code < clear; code += 1) { suffix[code] = code; firsts[code] = code; lengths[code] = 1; prefix[code] = -1; }
  let size = minSize + 1, next = end + 1, previous = -1, written = 0, bits = 0, count = 0;
  for (let at = 0; at < data.length && written < pixels;) {
    while (count < size && at < data.length) { bits |= data[at++]! << count; count += 8; }
    if (count < size) break;
    const code = bits & ((1 << size) - 1);
    bits >>>= size; count -= size;
    if (code === clear) { size = minSize + 1; next = end + 1; previous = -1; continue; }
    if (code === end) break;
    let entry: number;
    if (code < next) entry = code;
    else if (code === next && previous >= 0) entry = previous;
    else throw new ImageCodecError("corrupt GIF image data");
    if (previous >= 0 && next < 4096) {
      prefix[next] = previous; suffix[next] = code < next ? firsts[code]! : firsts[previous]!;
      firsts[next] = firsts[previous]!; lengths[next] = lengths[previous]! + 1; next += 1;
      if (next === 1 << size && size < 12) size += 1;
    }
    const output = code;
    const length = lengths[output]!;
    for (let walk = output, remaining = length; remaining > 0 && walk >= 0; remaining -= 1, walk = prefix[walk]!) {
      if (written + remaining - 1 < pixels) out[written + remaining - 1] = suffix[walk]!;
    }
    written += length;
    previous = code;
  }
  return out;
}

export function decodeGif(data: Uint8Array): Raster {
  if (!isGif(data) || data.length < 13) throw new ImageCodecError("not a GIF file");
  const width = data[6]! | (data[7]! << 8), height = data[8]! | (data[9]! << 8), flags = data[10]!;
  const raster = createRaster(width, height);
  let at = 13, global: Uint8Array | null = null, transparent = -1;
  if (flags & 0x80) { const size = 3 * (1 << ((flags & 7) + 1)); global = data.subarray(at, at + size); at += size; }
  while (at < data.length) {
    const block = data[at++]!;
    if (block === 0x3b) break;
    if (block === 0x21) {
      const label = data[at++]!;
      if (label === 0xf9 && data[at] === 4) transparent = data[at + 1]! & 1 ? data[at + 4]! : -1;
      while (at < data.length && data[at] !== 0) at += data[at]! + 1;
      at += 1;
      continue;
    }
    if (block !== 0x2c) throw new ImageCodecError("corrupt GIF block structure");
    const left = data[at]! | (data[at + 1]! << 8), top = data[at + 2]! | (data[at + 3]! << 8);
    const w = data[at + 4]! | (data[at + 5]! << 8), h = data[at + 6]! | (data[at + 7]! << 8), local = data[at + 8]!;
    at += 9;
    let palette = global;
    if (local & 0x80) { const size = 3 * (1 << ((local & 7) + 1)); palette = data.subarray(at, at + size); at += size; }
    if (!palette) throw new ImageCodecError("GIF frame has no colour table");
    const minSize = data[at++]!;
    const parts: Uint8Array[] = [];
    while (at < data.length && data[at] !== 0) { parts.push(data.subarray(at + 1, at + 1 + data[at]!)); at += data[at]! + 1; }
    const indexes = lzw(Buffer.concat(parts), minSize, w * h);
    const rows: number[] = [];
    if (local & 0x40) for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]] as const) for (let y = start; y < h; y += step) rows.push(y);
    else for (let y = 0; y < h; y += 1) rows.push(y);
    rows.forEach((y, row) => {
      const ty = top + y;
      if (ty >= height) return;
      for (let x = 0; x < w; x += 1) {
        const tx = left + x, index = indexes[row * w + x]!;
        if (tx >= width || index === transparent || index * 3 + 2 >= palette!.length) continue;
        const target = (ty * width + tx) * 4;
        raster.data[target] = palette![index * 3]!; raster.data[target + 1] = palette![index * 3 + 1]!; raster.data[target + 2] = palette![index * 3 + 2]!; raster.data[target + 3] = 255;
      }
    });
    return raster;
  }
  throw new ImageCodecError("GIF has no image");
}
