/**
 * Baseline and progressive JPEG decode to RGBA (Huffman, 8-bit precision,
 * any sampling factors, restart intervals, grayscale, YCbCr, Adobe RGB/CMYK/
 * YCCK). Structure after pdf.js `jpg.js` (Apache-2.0): every scan decodes into
 * per-component coefficient blocks; the inverse DCT runs once at the end.
 * The EXIF orientation is reported so the caller can turn the image upright.
 */
import { inverseDct, ZIGZAG } from "./jpeg-common.ts";
import { createRaster, ImageCodecError, type Raster } from "./raster.ts";

interface Huffman { maxcode: Int32Array; valptr: Int32Array; mincode: Int32Array; values: Uint8Array }
interface Component {
  id: number; h: number; v: number; tq: number;
  blocksPerLine: number; blocksPerColumn: number; stride: number; rows: number;
  blocks: Int16Array; pred: number; dc: Huffman | null; ac: Huffman | null;
}
interface Frame { progressive: boolean; width: number; height: number; components: Component[]; maxH: number; maxV: number; mcusPerLine: number; mcusPerColumn: number }

function buildHuffman(counts: Uint8Array, values: Uint8Array): Huffman {
  const maxcode = new Int32Array(18).fill(-1), valptr = new Int32Array(17), mincode = new Int32Array(17);
  let code = 0, k = 0;
  for (let length = 1; length <= 16; length += 1) {
    const n = counts[length - 1]!;
    valptr[length] = k; mincode[length] = code;
    code += n; k += n;
    maxcode[length] = n ? code - 1 : -1;
    code <<= 1;
  }
  maxcode[17] = 0x7fffffff;
  return { maxcode, valptr, mincode, values };
}

class Bits {
  offset: number; data: Uint8Array; private value = 0; private count = 0;
  constructor(data: Uint8Array, offset: number) { this.data = data; this.offset = offset; }
  reset(): void { this.count = 0; }
  bit(): number {
    if (this.count === 0) {
      const byte = this.data[this.offset];
      if (byte === undefined) return 0;
      if (byte === 0xff) {
        const next = this.data[this.offset + 1];
        // A marker ends the entropy-coded data: feed zeros and stay before it.
        if (next !== 0x00) return 0;
        this.offset += 2;
      } else this.offset += 1;
      this.value = byte; this.count = 8;
    }
    this.count -= 1;
    return (this.value >> this.count) & 1;
  }
  receive(length: number): number { let value = 0; for (let i = 0; i < length; i += 1) value = (value << 1) | this.bit(); return value; }
  extend(length: number): number {
    if (length === 0) return 0;
    if (length === 1) return this.bit() ? 1 : -1;
    const value = this.receive(length);
    return value >= 1 << (length - 1) ? value : value + (-1 << length) + 1;
  }
  decode(table: Huffman | null): number {
    if (!table) throw new ImageCodecError("JPEG scan uses an undefined Huffman table");
    let code = this.bit(), length = 1;
    while (code > table.maxcode[length]!) {
      code = (code << 1) | this.bit(); length += 1;
      if (length > 16) throw new ImageCodecError("invalid JPEG Huffman code");
    }
    return table.values[table.valptr[length]! + code - table.mincode[length]!] ?? 0;
  }
}

interface ScanState { start: number; end: number; prev: number; shift: number; eobrun: number; acState: number; acNext: number }

function decodeBlock(bits: Bits, frame: Frame, component: Component, at: number, scan: ScanState): void {
  const blocks = component.blocks;
  if (!frame.progressive) {
    const t = bits.decode(component.dc);
    blocks[at] = component.pred += t === 0 ? 0 : bits.extend(t);
    for (let k = 1; k < 64;) {
      const rs = bits.decode(component.ac), s = rs & 15, r = rs >> 4;
      if (s === 0) { if (r < 15) break; k += 16; continue; }
      k += r;
      if (k > 63) break;
      blocks[at + ZIGZAG[k]!] = bits.extend(s);
      k += 1;
    }
    return;
  }
  if (scan.start === 0) {
    if (scan.prev === 0) { const t = bits.decode(component.dc); blocks[at] = component.pred += (t === 0 ? 0 : bits.extend(t)) * (1 << scan.shift); }
    else if (bits.bit()) blocks[at] = blocks[at]! | (1 << scan.shift);
    return;
  }
  if (scan.prev === 0) {
    if (scan.eobrun > 0) { scan.eobrun -= 1; return; }
    for (let k = scan.start; k <= scan.end;) {
      const rs = bits.decode(component.ac), s = rs & 15, r = rs >> 4;
      if (s === 0) {
        if (r < 15) { scan.eobrun = bits.receive(r) + (1 << r) - 1; break; }
        k += 16; continue;
      }
      k += r;
      if (k > 63) break;
      blocks[at + ZIGZAG[k]!] = bits.extend(s) * (1 << scan.shift);
      k += 1;
    }
    return;
  }
  // AC successive approximation (refinement).
  let r = 0;
  for (let k = scan.start; k <= scan.end; k += 1) {
    const z = at + ZIGZAG[k]!, coef = blocks[z]!, sign = coef < 0 ? -1 : 1;
    switch (scan.acState) {
      case 0: {
        const rs = bits.decode(component.ac), s = rs & 15;
        r = rs >> 4;
        if (s === 0) {
          if (r < 15) { scan.eobrun = bits.receive(r) + (1 << r); scan.acState = 4; }
          else { r = 16; scan.acState = 1; }
        } else {
          if (s !== 1) throw new ImageCodecError("invalid JPEG AC refinement");
          scan.acNext = bits.extend(s);
          scan.acState = r ? 2 : 3;
        }
        k -= 1;
        continue;
      }
      case 1: case 2:
        if (coef) blocks[z] = coef + sign * (bits.bit() << scan.shift);
        else { r -= 1; if (r === 0) scan.acState = scan.acState === 2 ? 3 : 0; }
        break;
      case 3:
        if (coef) blocks[z] = coef + sign * (bits.bit() << scan.shift);
        else { blocks[z] = scan.acNext << scan.shift; scan.acState = 0; }
        break;
      default:
        if (coef) blocks[z] = coef + sign * (bits.bit() << scan.shift);
    }
  }
  if (scan.acState === 4) { scan.eobrun -= 1; if (scan.eobrun === 0) scan.acState = 0; }
}

function decodeScan(data: Uint8Array, offset: number, frame: Frame, components: Component[], interval: number, scan: ScanState): number {
  const bits = new Bits(data, offset);
  const single = components.length === 1;
  const total = single ? components[0]!.blocksPerLine * components[0]!.blocksPerColumn : frame.mcusPerLine * frame.mcusPerColumn;
  let mcu = 0;
  while (mcu < total) {
    const count = interval ? Math.min(total - mcu, interval) : total;
    for (const component of components) component.pred = 0;
    scan.eobrun = 0; scan.acState = 0; bits.reset();
    for (let n = 0; n < count; n += 1, mcu += 1) {
      if (single) {
        const component = components[0]!, row = Math.floor(mcu / component.blocksPerLine), col = mcu % component.blocksPerLine;
        decodeBlock(bits, frame, component, 64 * (row * component.stride + col), scan);
        continue;
      }
      const mcuRow = Math.floor(mcu / frame.mcusPerLine), mcuCol = mcu % frame.mcusPerLine;
      for (const component of components) {
        for (let j = 0; j < component.v; j += 1) {
          for (let k = 0; k < component.h; k += 1) decodeBlock(bits, frame, component, 64 * ((mcuRow * component.v + j) * component.stride + mcuCol * component.h + k), scan);
        }
      }
    }
    // Find the next marker; continue past a restart marker, stop at anything else.
    let at = bits.offset;
    while (at + 1 < data.length && !(data[at] === 0xff && data[at + 1] !== 0x00 && data[at + 1] !== 0xff)) at += 1;
    if (at + 1 >= data.length) return data.length;
    const marker = data[at + 1]!;
    if (marker >= 0xd0 && marker <= 0xd7) { bits.offset = at + 2; continue; }
    return at;
  }
  let at = bits.offset;
  while (at + 1 < data.length && !(data[at] === 0xff && data[at + 1] !== 0x00 && !(data[at + 1]! >= 0xd0 && data[at + 1]! <= 0xd7) && data[at + 1] !== 0xff)) at += 1;
  return at;
}

function exifOrientation(segment: Uint8Array): number {
  if (segment.length < 14 || String.fromCharCode(...segment.subarray(0, 4)) !== "Exif") return 1;
  const tiff = segment.subarray(6), little = tiff[0] === 0x49;
  const u16 = (at: number): number => little ? tiff[at]! | (tiff[at + 1]! << 8) : (tiff[at]! << 8) | tiff[at + 1]!;
  const u32 = (at: number): number => (little ? (tiff[at]! | (tiff[at + 1]! << 8) | (tiff[at + 2]! << 16) | (tiff[at + 3]! << 24)) : ((tiff[at]! << 24) | (tiff[at + 1]! << 16) | (tiff[at + 2]! << 8) | tiff[at + 3]!)) >>> 0;
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return 1;
  for (let entry = 0, count = u16(ifd); entry < count; entry += 1) {
    const at = ifd + 2 + entry * 12;
    if (at + 12 > tiff.length) break;
    if (u16(at) === 0x0112) return u16(at + 8);
  }
  return 1;
}

export interface DecodedJpeg { raster: Raster; orientation: number }

export function decodeJpeg(data: Uint8Array): DecodedJpeg {
  if (data[0] !== 0xff || data[1] !== 0xd8) throw new ImageCodecError("not a JPEG file");
  const quant: Int32Array[] = [], dcTables: (Huffman | null)[] = [], acTables: (Huffman | null)[] = [];
  let frame: Frame | null = null, interval = 0, adobe = -1, orientation = 1, offset = 2;
  const u16 = (at: number): number => (data[at]! << 8) | data[at + 1]!;
  while (offset + 4 <= data.length) {
    if (data[offset] !== 0xff) { offset += 1; continue; }
    const marker = data[offset + 1]!;
    if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { offset += marker === 0xff ? 1 : 2; continue; }
    if (marker === 0xd9) break;
    const length = u16(offset + 2), body = data.subarray(offset + 4, offset + 2 + length);
    if (length < 2 || body.length < length - 2) throw new ImageCodecError("truncated JPEG segment");
    let next = offset + 2 + length;
    if (marker === 0xdb) {
      for (let at = 0; at < body.length;) {
        const precision = body[at]! >> 4, id = body[at]! & 15, table = new Int32Array(64);
        at += 1;
        for (let k = 0; k < 64; k += 1) { table[ZIGZAG[k]!] = precision ? (body[at]! << 8) | body[at + 1]! : body[at]!; at += precision ? 2 : 1; }
        quant[id] = table;
      }
    } else if (marker === 0xc4) {
      for (let at = 0; at + 17 <= body.length;) {
        const kind = body[at]! >> 4, id = body[at]! & 15, counts = body.subarray(at + 1, at + 17);
        const total = counts.reduce((sum, n) => sum + n, 0), values = body.slice(at + 17, at + 17 + total);
        (kind === 0 ? dcTables : acTables)[id] = buildHuffman(counts, values);
        at += 17 + total;
      }
    } else if (marker === 0xdd) interval = u16(offset + 4);
    else if (marker === 0xe1 && orientation === 1) orientation = exifOrientation(body);
    else if (marker === 0xee && body.length >= 12 && String.fromCharCode(...body.subarray(0, 5)) === "Adobe") adobe = body[11]!;
    else if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (frame) throw new ImageCodecError("JPEG has more than one frame");
      if (body[0] !== 8) throw new ImageCodecError("unsupported JPEG sample precision");
      const height = u16(offset + 5), width = u16(offset + 7), count = body[5]!;
      if (!width || !height || count < 1 || count > 4) throw new ImageCodecError("unsupported JPEG frame");
      const components: Component[] = [];
      for (let i = 0; i < count; i += 1) {
        const at = 6 + i * 3, h = body[at + 1]! >> 4, v = body[at + 1]! & 15;
        if (h < 1 || h > 4 || v < 1 || v > 4) throw new ImageCodecError("invalid JPEG sampling factors");
        components.push({ id: body[at]!, h, v, tq: body[at + 2]!, blocksPerLine: 0, blocksPerColumn: 0, stride: 0, rows: 0, blocks: new Int16Array(0), pred: 0, dc: null, ac: null });
      }
      const maxH = Math.max(...components.map((c) => c.h)), maxV = Math.max(...components.map((c) => c.v));
      const mcusPerLine = Math.ceil(width / (8 * maxH)), mcusPerColumn = Math.ceil(height / (8 * maxV));
      createRaster(width, height); // dimension limit before allocating coefficients
      for (const c of components) {
        c.blocksPerLine = Math.ceil(Math.ceil((width * c.h) / maxH) / 8); c.blocksPerColumn = Math.ceil(Math.ceil((height * c.v) / maxV) / 8);
        c.stride = mcusPerLine * c.h; c.rows = mcusPerColumn * c.v; c.blocks = new Int16Array(64 * c.stride * c.rows);
      }
      frame = { progressive: marker === 0xc2, width, height, components, maxH, maxV, mcusPerLine, mcusPerColumn };
    } else if (marker >= 0xc3 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      throw new ImageCodecError("unsupported JPEG coding process");
    } else if (marker === 0xda) {
      if (!frame) throw new ImageCodecError("JPEG scan before frame header");
      const count = body[0]!, scanComponents: Component[] = [];
      for (let i = 0; i < count; i += 1) {
        const component = frame.components.find((c) => c.id === body[1 + i * 2]);
        if (!component) throw new ImageCodecError("JPEG scan names an unknown component");
        component.dc = dcTables[body[2 + i * 2]! >> 4] ?? null; component.ac = acTables[body[2 + i * 2]! & 15] ?? null;
        scanComponents.push(component);
      }
      const at = 1 + count * 2;
      const scan: ScanState = { start: body[at]!, end: body[at + 1]!, prev: body[at + 2]! >> 4, shift: body[at + 2]! & 15, eobrun: 0, acState: 0, acNext: 0 };
      next = decodeScan(data, offset + 2 + length, frame, scanComponents, interval, scan);
    }
    offset = next;
  }
  if (!frame) throw new ImageCodecError("JPEG has no frame");
  return { raster: render(frame, quant, adobe), orientation };
}

function render(frame: Frame, quant: Int32Array[], adobe: number): Raster {
  const planes = frame.components.map((component) => {
    const table = quant[component.tq];
    if (!table) throw new ImageCodecError("JPEG references an undefined quantization table");
    const width = component.stride * 8, plane = new Uint8Array(width * component.rows * 8);
    const coefficients = new Float64Array(64), scratch = new Float64Array(64);
    for (let row = 0; row < component.rows; row += 1) {
      for (let col = 0; col < component.stride; col += 1) {
        const at = 64 * (row * component.stride + col);
        for (let i = 0; i < 64; i += 1) coefficients[i] = component.blocks[at + i]! * table[i]!;
        inverseDct(coefficients, plane, row * 8 * width + col * 8, width, scratch);
      }
    }
    return { plane, width, sx: component.h / frame.maxH, sy: component.v / frame.maxV };
  });
  const raster = createRaster(frame.width, frame.height), out = raster.data, n = planes.length;
  const ids = frame.components.map((c) => c.id);
  const rgbIds = n === 3 && ids[0] === 0x52 && ids[1] === 0x47 && ids[2] === 0x42;
  const transform = n === 3 ? (adobe === 0 || rgbIds ? 0 : 1) : n === 4 ? (adobe > 0 ? 2 : 0) : 0;
  const clamp = (value: number): number => value <= 0 ? 0 : value >= 255 ? 255 : Math.round(value);
  const columns = planes.map((p) => Int32Array.from({ length: frame.width }, (_, x) => Math.floor(x * p.sx)));
  const rows = new Int32Array(n);
  for (let y = 0; y < frame.height; y += 1) {
    for (let i = 0; i < n; i += 1) rows[i] = Math.floor(y * planes[i]!.sy) * planes[i]!.width;
    const p0 = planes[0]!.plane, x0 = columns[0]!, r0 = rows[0]!;
    for (let x = 0, at = y * frame.width * 4; x < frame.width; x += 1, at += 4) {
      let r: number, g: number, b: number;
      const c0 = p0[r0 + x0[x]!]!;
      if (n < 3) r = g = b = c0;
      else {
        const c1 = planes[1]!.plane[rows[1]! + columns[1]![x]!]!, c2 = planes[2]!.plane[rows[2]! + columns[2]![x]!]!;
        if (transform === 0) { r = c0; g = c1; b = c2; }
        else { r = clamp(c0 + 1.402 * (c2 - 128)); g = clamp(c0 - 0.344136 * (c1 - 128) - 0.714136 * (c2 - 128)); b = clamp(c0 + 1.772 * (c1 - 128)); }
        if (n === 4) {
          // Adobe CMYK is stored inverted; YCCK's colour part converts to inverted CMY (jpeg-js / libjpeg).
          if (transform === 2) { r = 255 - r; g = 255 - g; b = 255 - b; }
          const k = planes[3]!.plane[rows[3]! + columns[3]![x]!]!;
          r = clamp((r * k) / 255); g = clamp((g * k) / 255); b = clamp((b * k) / 255);
        }
      }
      out[at] = r; out[at + 1] = g; out[at + 2] = b; out[at + 3] = 255;
    }
  }
  return raster;
}
