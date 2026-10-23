/**
 * PNG decode (every colour type and bit depth, Adam7, tRNS) to RGBA, and the
 * "png-optimized" encode of the ZCode image adapter: adaptive per-row filters
 * (pngjs's heuristic) and zlib level 9 with the RLE strategy (jimp
 * `deflateLevel: 9, deflateStrategy: 3`). Opaque images are written as RGB.
 */
import { constants, crc32, deflateSync, inflateSync } from "node:zlib";
import { createRaster, ImageCodecError, isOpaque, type Raster } from "./raster.ts";

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] as const;
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export function isPng(data: Uint8Array): boolean {
  return data.length >= 8 && SIGNATURE.every((byte, index) => data[index] === byte);
}

const u32 = (data: Uint8Array, at: number): number => ((data[at]! << 24) | (data[at + 1]! << 16) | (data[at + 2]! << 8) | data[at + 3]!) >>> 0;

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Reverse the scanline filters of one (sub-)image in place; returns the raw rows. */
function unfilter(data: Uint8Array, offset: number, rows: number, rowBytes: number, bpp: number): Uint8Array {
  const out = new Uint8Array(rows * rowBytes);
  for (let y = 0; y < rows; y += 1) {
    const filter = data[offset + y * (rowBytes + 1)];
    if (filter === undefined) throw new ImageCodecError("truncated PNG image data");
    const source = offset + y * (rowBytes + 1) + 1, row = y * rowBytes, prior = row - rowBytes;
    for (let x = 0; x < rowBytes; x += 1) {
      const raw = data[source + x] ?? 0;
      const left = x >= bpp ? out[row + x - bpp]! : 0, up = y > 0 ? out[prior + x]! : 0, corner = y > 0 && x >= bpp ? out[prior + x - bpp]! : 0;
      let value: number;
      switch (filter) {
        case 0: value = raw; break;
        case 1: value = raw + left; break;
        case 2: value = raw + up; break;
        case 3: value = raw + ((left + up) >> 1); break;
        case 4: value = raw + paeth(left, up, corner); break;
        default: throw new ImageCodecError("invalid PNG filter type");
      }
      out[row + x] = value & 0xff;
    }
  }
  return out;
}

export function decodePng(data: Uint8Array): Raster {
  if (!isPng(data)) throw new ImageCodecError("not a PNG file");
  let at = 8, width = 0, height = 0, depth = 0, colorType = -1, interlace = 0;
  let palette: Uint8Array | null = null, transparency: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (at + 8 <= data.length) {
    const length = u32(data, at), type = String.fromCharCode(data[at + 4]!, data[at + 5]!, data[at + 6]!, data[at + 7]!);
    const body = data.subarray(at + 8, at + 8 + length);
    if (body.length < length) throw new ImageCodecError("truncated PNG chunk");
    if (type === "IHDR") {
      if (length < 13) throw new ImageCodecError("invalid PNG header");
      width = u32(body, 0); height = u32(body, 4); depth = body[8]!; colorType = body[9]!; interlace = body[12]!;
      if (body[10] !== 0 || body[11] !== 0 || interlace > 1) throw new ImageCodecError("unsupported PNG compression, filter or interlace method");
    } else if (type === "PLTE") palette = body;
    else if (type === "tRNS") transparency = body;
    else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    at += 12 + length;
  }
  const channels = CHANNELS[colorType];
  if (!channels || !width || !height || ![1, 2, 4, 8, 16].includes(depth) || (colorType === 3 && (!palette || depth === 16)) || (colorType !== 0 && colorType !== 3 && depth < 8)) {
    throw new ImageCodecError("unsupported PNG format");
  }
  if (!idat.length) throw new ImageCodecError("PNG has no image data");
  const raster = createRaster(width, height);
  const bitsPerPixel = channels * depth, bpp = Math.max(1, bitsPerPixel >> 3);
  const passes = interlace ? ADAM7 : [[0, 0, 1, 1] as const];
  let expected = 0;
  for (const [x0, y0, dx, dy] of passes) {
    const w = Math.ceil((width - x0) / dx), h = Math.ceil((height - y0) / dy);
    if (w > 0 && h > 0) expected += h * (1 + Math.ceil((w * bitsPerPixel) / 8));
  }
  let inflated: Uint8Array;
  try { inflated = inflateSync(Buffer.concat(idat), { maxOutputLength: expected + 65536 }); }
  catch { throw new ImageCodecError("corrupt PNG image data"); }
  const maxSample = (1 << depth) - 1;
  let offset = 0;
  for (const [x0, y0, dx, dy] of passes) {
    const w = Math.ceil((width - x0) / dx), h = Math.ceil((height - y0) / dy);
    if (w <= 0 || h <= 0) continue;
    const rowBytes = Math.ceil((w * bitsPerPixel) / 8);
    const rows = unfilter(inflated, offset, h, rowBytes, bpp);
    offset += h * (rowBytes + 1);
    const sample = (row: number, index: number): number => {
      if (depth === 8) return rows[row + index]!;
      if (depth === 16) return (rows[row + index * 2]! << 8) | rows[row + index * 2 + 1]!;
      const bit = index * depth;
      return (rows[row + (bit >> 3)]! >> (8 - depth - (bit & 7))) & maxSample;
    };
    const to8 = (value: number): number => depth === 16 ? value >> 8 : depth === 8 ? value : Math.round((value * 255) / maxSample);
    for (let y = 0; y < h; y += 1) {
      const row = y * rowBytes;
      for (let x = 0; x < w; x += 1) {
        const target = ((y0 + y * dy) * width + x0 + x * dx) * 4, out = raster.data;
        let r: number, g: number, b: number, a = 255;
        if (colorType === 3) {
          const index = sample(row, x);
          r = palette![index * 3] ?? 0; g = palette![index * 3 + 1] ?? 0; b = palette![index * 3 + 2] ?? 0;
          if (transparency && index < transparency.length) a = transparency[index]!;
        } else if (colorType === 0 || colorType === 4) {
          const raw = sample(row, x * channels);
          r = g = b = to8(raw);
          if (colorType === 4) a = to8(sample(row, x * channels + 1));
          else if (transparency && transparency.length >= 2 && raw === ((transparency[0]! << 8) | transparency[1]!)) a = 0;
        } else {
          const rr = sample(row, x * channels), gg = sample(row, x * channels + 1), bb = sample(row, x * channels + 2);
          r = to8(rr); g = to8(gg); b = to8(bb);
          if (colorType === 6) a = to8(sample(row, x * channels + 3));
          else if (transparency && transparency.length >= 6 && rr === ((transparency[0]! << 8) | transparency[1]!) && gg === ((transparency[2]! << 8) | transparency[3]!) && bb === ((transparency[4]! << 8) | transparency[5]!)) a = 0;
        }
        out[target] = r; out[target + 1] = g; out[target + 2] = b; out[target + 3] = a;
      }
    }
  }
  return raster;
}

function chunk(type: string, body: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, "latin1");
  out.set(body, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)) >>> 0, 8 + body.length);
  return out;
}

/** Encode with per-row adaptive filtering (smallest sum of absolute filtered bytes). */
export function encodePng(raster: Raster): Buffer {
  const { width, height, data } = raster;
  const alpha = !isOpaque(raster), channels = alpha ? 4 : 3, rowBytes = width * channels;
  const filtered = Buffer.alloc(height * (rowBytes + 1));
  let previous = new Uint8Array(rowBytes), current = new Uint8Array(rowBytes);
  const candidate = new Uint8Array(rowBytes), best = new Uint8Array(rowBytes);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0, at = y * width * 4; x < width; x += 1, at += 4) {
      const to = x * channels;
      current[to] = data[at]!; current[to + 1] = data[at + 1]!; current[to + 2] = data[at + 2]!;
      if (alpha) current[to + 3] = data[at + 3]!;
    }
    let bestSum = Infinity, bestType = 0;
    for (let type = 0; type <= 4; type += 1) {
      let sum = 0;
      for (let x = 0; x < rowBytes; x += 1) {
        const left = x >= channels ? current[x - channels]! : 0, up = y > 0 ? previous[x]! : 0, corner = y > 0 && x >= channels ? previous[x - channels]! : 0;
        const predictor = type === 0 ? 0 : type === 1 ? left : type === 2 ? up : type === 3 ? (left + up) >> 1 : paeth(left, up, corner);
        const value = (current[x]! - predictor) & 0xff;
        candidate[x] = value;
        sum += value < 128 ? value : 256 - value;
        if (sum >= bestSum) break;
      }
      if (sum < bestSum) { bestSum = sum; bestType = type; best.set(candidate); }
    }
    filtered[y * (rowBytes + 1)] = bestType;
    filtered.set(best, y * (rowBytes + 1) + 1);
    [previous, current] = [current, previous];
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = alpha ? 6 : 2;
  const compressed = deflateSync(filtered, { level: 9, strategy: constants.Z_RLE });
  return Buffer.concat([Buffer.from(SIGNATURE), chunk("IHDR", header), chunk("IDAT", compressed), chunk("IEND", new Uint8Array(0))]);
}
