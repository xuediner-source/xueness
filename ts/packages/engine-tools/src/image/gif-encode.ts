/**
 * GIF89a encode of one frame for the Read image budget. ZCode keeps a GIF's
 * format on the compression ladder (jimp `getBuffer(JimpMime.gif)`), so an
 * oversized GIF shrinks as a GIF instead of falling straight to JPEG; this is
 * the pure-TS equivalent. One frame only, matching the decoder: an animated
 * source already loses its other frames on the way in.
 *
 * The palette is a weighted median cut over a 5:5:5 histogram, so every bucket
 * maps to exactly one entry and no nearest-colour search is needed per pixel.
 * Alpha is binary in GIF: a pixel below `ALPHA_CUTOFF` takes the reserved
 * transparent index, everything else is opaque.
 */
import { ImageCodecError, type Raster } from "./raster.ts";

const MAX_COLORS = 256;
/** One palette slot is reserved for the transparent index. */
const OPAQUE_COLORS = 255;
const BUCKETS = 1 << 15;
const ALPHA_CUTOFF = 128;
const MAX_EDGE = 0xffff;
const MAX_CODE = 4096;

const bucketOf = (red: number, green: number, blue: number): number =>
  ((red >> 3) << 10) | ((green >> 3) << 5) | (blue >> 3);

interface Box { keys: number[]; weight: number }

/** Weighted median cut; every histogram bucket ends up owned by exactly one box. */
function cut(histogram: Map<number, number>, limit: number): { colors: number[]; owner: Uint8Array } {
  const keys = [...histogram.keys()];
  const boxes: Box[] = [{ keys, weight: keys.reduce((sum, key) => sum + histogram.get(key)!, 0) }];
  while (boxes.length < limit) {
    let pick = -1, heaviest = 1;
    for (let at = 0; at < boxes.length; at += 1) {
      const box = boxes[at]!;
      if (box.keys.length > 1 && box.weight > heaviest) { pick = at; heaviest = box.weight; }
    }
    if (pick < 0) break;
    const box = boxes[pick]!;
    let shift = 10, spread = -1;
    for (const candidate of [10, 5, 0]) {
      let low = 31, high = 0;
      for (const key of box.keys) {
        const value = (key >> candidate) & 31;
        if (value < low) low = value;
        if (value > high) high = value;
      }
      if (high - low > spread) { spread = high - low; shift = candidate; }
    }
    box.keys.sort((left, right) => ((left >> shift) & 31) - ((right >> shift) & 31));
    const half = box.weight / 2;
    let split = 1, running = histogram.get(box.keys[0]!)!;
    while (split < box.keys.length - 1 && running < half) { running += histogram.get(box.keys[split]!)!; split += 1; }
    const left = box.keys.slice(0, split), right = box.keys.slice(split);
    const leftWeight = left.reduce((sum, key) => sum + histogram.get(key)!, 0);
    boxes[pick] = { keys: left, weight: leftWeight };
    boxes.push({ keys: right, weight: box.weight - leftWeight });
  }
  const owner = new Uint8Array(BUCKETS), colors: number[] = [];
  boxes.forEach((box, index) => {
    let red = 0, green = 0, blue = 0, weight = 0;
    for (const key of box.keys) {
      const count = histogram.get(key)!;
      red += ((key >> 10) & 31) * count;
      green += ((key >> 5) & 31) * count;
      blue += (key & 31) * count;
      weight += count;
      owner[key] = index;
    }
    const scale = (value: number): number => Math.min(255, Math.round((value / weight) * (255 / 31)));
    colors.push(scale(red), scale(green), scale(blue));
  });
  return { colors, owner };
}

/** LSB-first bit packer: GIF fills each byte from the low end of the code. */
class Packer {
  private readonly out: number[] = [];
  private bits = 0;
  private count = 0;
  push(code: number, size: number): void {
    this.bits |= code << this.count;
    this.count += size;
    while (this.count >= 8) { this.out.push(this.bits & 0xff); this.bits >>>= 8; this.count -= 8; }
  }
  done(): number[] {
    if (this.count > 0) this.out.push(this.bits & 0xff);
    return this.out;
  }
}

/**
 * Variable-width LZW. The decoder in `gif.ts` is one entry behind the encoder
 * (it assigns its first entry only when it reads the second code), so it grows
 * the width when its own next free code reaches `1 << size`. The encoder's
 * counter is one higher at the same point in the stream, so it must grow one
 * step later: at `(1 << size) + 1`.
 */
function compress(indexes: Uint8Array, minSize: number): number[] {
  const clear = 1 << minSize, end = clear + 1;
  let size = minSize + 1, next = end + 1;
  const packer = new Packer();
  const dictionary = new Map<number, number>();
  packer.push(clear, size);
  let prefix = indexes.length ? indexes[0]! : -1;
  for (let at = 1; at < indexes.length; at += 1) {
    const suffix = indexes[at]!;
    const key = (prefix << 8) | suffix;
    const known = dictionary.get(key);
    if (known !== undefined) { prefix = known; continue; }
    packer.push(prefix, size);
    if (next < MAX_CODE) {
      dictionary.set(key, next);
      next += 1;
      if (next === (1 << size) + 1 && size < 12) size += 1;
    } else {
      packer.push(clear, size);
      dictionary.clear();
      size = minSize + 1;
      next = end + 1;
    }
    prefix = suffix;
  }
  if (prefix >= 0) packer.push(prefix, size);
  packer.push(end, size);
  return packer.done();
}

/** One frame, a global colour table, and the transparent index when needed. */
export function encodeGif(raster: Raster): Buffer {
  const { width, height, data } = raster;
  if (width > MAX_EDGE || height > MAX_EDGE) throw new ImageCodecError("image dimensions exceed the GIF limit");
  const histogram = new Map<number, number>();
  let transparent = false;
  for (let at = 0; at < data.length; at += 4) {
    if (data[at + 3]! < ALPHA_CUTOFF) { transparent = true; continue; }
    const key = bucketOf(data[at]!, data[at + 1]!, data[at + 2]!);
    histogram.set(key, (histogram.get(key) ?? 0) + 1);
  }
  const limit = Math.max(1, Math.min(transparent ? OPAQUE_COLORS : MAX_COLORS, histogram.size));
  const { colors, owner } = histogram.size === 0
    ? { colors: [0, 0, 0], owner: new Uint8Array(BUCKETS) }
    : cut(histogram, limit);
  const base = transparent ? 1 : 0;
  const entries = base + colors.length / 3;
  let tableBits = 1;
  while ((1 << tableBits) < entries) tableBits += 1;
  // GIF requires a minimum LZW code size of 2 even for a two-entry table.
  const minSize = Math.max(2, tableBits);
  const indexes = new Uint8Array(width * height);
  for (let at = 0, pixel = 0; at < data.length; at += 4, pixel += 1) {
    indexes[pixel] = data[at + 3]! < ALPHA_CUTOFF ? 0 : owner[bucketOf(data[at]!, data[at + 1]!, data[at + 2]!)]! + base;
  }

  const out: number[] = [];
  const byte = (value: number): void => { out.push(value & 0xff); };
  const short = (value: number): void => { byte(value); byte(value >> 8); };
  for (const char of "GIF89a") byte(char.charCodeAt(0));
  short(width); short(height);
  // Global colour table, 8-bit colour resolution, size 2^tableBits.
  byte(0x80 | 0x70 | (tableBits - 1)); byte(0); byte(0);
  for (let at = 0; at < 1 << tableBits; at += 1) {
    byte(colors[at * 3] ?? 0); byte(colors[at * 3 + 1] ?? 0); byte(colors[at * 3 + 2] ?? 0);
  }
  if (transparent) { byte(0x21); byte(0xf9); byte(0x04); byte(0x01); short(0); byte(0); byte(0); }
  byte(0x2c); short(0); short(0); short(width); short(height); byte(0);
  byte(minSize);
  const packed = compress(indexes, minSize);
  for (let at = 0; at < packed.length; at += 255) {
    const chunk = packed.slice(at, at + 255);
    byte(chunk.length);
    for (const value of chunk) byte(value);
  }
  byte(0);
  byte(0x3b);
  return Buffer.from(out);
}
