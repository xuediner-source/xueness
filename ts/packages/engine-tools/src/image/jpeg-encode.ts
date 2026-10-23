/**
 * Baseline JPEG encode (JFIF, 4:4:4, the ITU T.81 Annex K tables scaled by
 * quality as IJG libjpeg does) — the encoder jimp uses (jpeg-js) makes the
 * same choices, so ZCode's quality ladder lands on comparable sizes.
 * Alpha is flattened onto white by the caller.
 */
import { forwardDct, ZIGZAG } from "./jpeg-common.ts";
import type { Raster } from "./raster.ts";

const LUMA_QT = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];
const CHROMA_QT = [17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
  ...new Array<number>(32).fill(99)];

const DC_LUMA_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_CHROMA_BITS = [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
const DC_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_LUMA_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
export const AC_LUMA_VALUES = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08,
  0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
  0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6,
  0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa];
const AC_CHROMA_BITS = [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77];
export const AC_CHROMA_VALUES = [
  0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91,
  0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
  0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58,
  0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
  0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4,
  0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
  0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa];

interface Code { code: Int32Array; size: Int32Array }
/** Canonical codes (Annex C) for a bits/values table. */
function codes(bits: readonly number[], values: readonly number[]): Code {
  const code = new Int32Array(256), size = new Int32Array(256);
  let next = 0, k = 0;
  for (let length = 1; length <= 16; length += 1) {
    for (let i = 0; i < bits[length - 1]!; i += 1) { code[values[k]!] = next; size[values[k]!] = length; next += 1; k += 1; }
    next <<= 1;
  }
  return { code, size };
}
const DC_LUMA = codes(DC_LUMA_BITS, DC_VALUES), DC_CHROMA = codes(DC_CHROMA_BITS, DC_VALUES);
const AC_LUMA = codes(AC_LUMA_BITS, AC_LUMA_VALUES), AC_CHROMA = codes(AC_CHROMA_BITS, AC_CHROMA_VALUES);

/** IJG `jpeg_quality_scaling` + `jpeg_add_quant_table` (baseline-limited to 1..255), natural order. */
function scaled(table: readonly number[], quality: number): Int32Array {
  const q = Math.min(100, Math.max(1, Math.round(quality)));
  const factor = q < 50 ? Math.floor(5000 / q) : 200 - q * 2;
  return Int32Array.from(table, (value) => Math.min(255, Math.max(1, Math.floor((value * factor + 50) / 100))));
}

class Writer {
  private chunks: Buffer[] = []; private buffer = Buffer.alloc(65536); private length = 0; private bits = 0; private count = 0;
  byte(value: number): void {
    if (this.length === this.buffer.length) { this.chunks.push(this.buffer); this.buffer = Buffer.alloc(65536); this.length = 0; }
    this.buffer[this.length++] = value;
  }
  bytes(values: readonly number[] | Uint8Array): void { for (const value of values) this.byte(value); }
  u16(value: number): void { this.byte(value >> 8); this.byte(value & 0xff); }
  put(code: number, size: number): void {
    this.bits = (this.bits << size) | (code & ((1 << size) - 1)); this.count += size;
    while (this.count >= 8) {
      const byte = (this.bits >> (this.count - 8)) & 0xff;
      this.byte(byte);
      if (byte === 0xff) this.byte(0);
      this.count -= 8; this.bits &= (1 << this.count) - 1;
    }
  }
  flush(): void { if (this.count > 0) this.put((1 << (8 - this.count)) - 1, 8 - this.count); }
  done(): Buffer { this.chunks.push(this.buffer.subarray(0, this.length)); return Buffer.concat(this.chunks); }
}

function category(value: number): number { let magnitude = Math.abs(value), size = 0; while (magnitude) { size += 1; magnitude >>= 1; } return size; }

export function encodeJpeg(raster: Raster, quality: number): Buffer {
  const { width, height, data } = raster;
  const luma = scaled(LUMA_QT, quality), chroma = scaled(CHROMA_QT, quality);
  const out = new Writer();
  out.bytes([0xff, 0xd8, 0xff, 0xe0]); out.u16(16); out.bytes([0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  out.bytes([0xff, 0xdb]); out.u16(2 + 2 * 65);
  for (const [id, table] of [[0, luma], [1, chroma]] as const) { out.byte(id); for (let k = 0; k < 64; k += 1) out.byte(table[ZIGZAG[k]!]!); }
  out.bytes([0xff, 0xc0]); out.u16(17); out.byte(8); out.u16(height); out.u16(width); out.byte(3);
  out.bytes([1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1]);
  out.bytes([0xff, 0xc4]);
  out.u16(2 + [DC_VALUES, AC_LUMA_VALUES, DC_VALUES, AC_CHROMA_VALUES].reduce((sum, values) => sum + 17 + values.length, 0));
  for (const [id, bits, values] of [[0x00, DC_LUMA_BITS, DC_VALUES], [0x10, AC_LUMA_BITS, AC_LUMA_VALUES], [0x01, DC_CHROMA_BITS, DC_VALUES], [0x11, AC_CHROMA_BITS, AC_CHROMA_VALUES]] as const) {
    out.byte(id); out.bytes(bits); out.bytes(values);
  }
  out.bytes([0xff, 0xda]); out.u16(12); out.byte(3); out.bytes([1, 0x00, 2, 0x11, 3, 0x11]); out.bytes([0, 63, 0]);
  const samples = [new Float64Array(64), new Float64Array(64), new Float64Array(64)];
  const coefficients = new Float64Array(64), scratch = new Float64Array(64);
  const predictors = [0, 0, 0];
  const block = (input: Float64Array, table: Int32Array, dc: Code, ac: Code, channel: number): void => {
    forwardDct(input, coefficients, scratch);
    const quantized = new Int32Array(64);
    for (let k = 0; k < 64; k += 1) { const value = coefficients[ZIGZAG[k]!]! / table[ZIGZAG[k]!]!; quantized[k] = value > 0 ? Math.floor(value + 0.5) : -Math.floor(-value + 0.5); }
    const diff = quantized[0]! - predictors[channel]!;
    predictors[channel] = quantized[0]!;
    const size = category(diff);
    out.put(dc.code[size]!, dc.size[size]!);
    if (size) out.put(diff < 0 ? diff - 1 : diff, size);
    let run = 0;
    for (let k = 1; k < 64; k += 1) {
      const value = quantized[k]!;
      if (value === 0) { run += 1; continue; }
      while (run > 15) { out.put(ac.code[0xf0]!, ac.size[0xf0]!); run -= 16; }
      const bits = category(value), symbol = (run << 4) | bits;
      out.put(ac.code[symbol]!, ac.size[symbol]!);
      out.put(value < 0 ? value - 1 : value, bits);
      run = 0;
    }
    if (run > 0) out.put(ac.code[0]!, ac.size[0]!);
  };
  for (let by = 0; by < height; by += 8) {
    for (let bx = 0; bx < width; bx += 8) {
      for (let y = 0; y < 8; y += 1) {
        const sy = Math.min(height - 1, by + y);
        for (let x = 0; x < 8; x += 1) {
          const at = (sy * width + Math.min(width - 1, bx + x)) * 4, r = data[at]!, g = data[at + 1]!, b = data[at + 2]!, k = y * 8 + x;
          samples[0]![k] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
          samples[1]![k] = -0.168736 * r - 0.331264 * g + 0.5 * b;
          samples[2]![k] = 0.5 * r - 0.418688 * g - 0.081312 * b;
        }
      }
      block(samples[0]!, luma, DC_LUMA, AC_LUMA, 0);
      block(samples[1]!, chroma, DC_CHROMA, AC_CHROMA, 1);
      block(samples[2]!, chroma, DC_CHROMA, AC_CHROMA, 2);
    }
  }
  out.flush();
  out.bytes([0xff, 0xd9]);
  return out.done();
}
