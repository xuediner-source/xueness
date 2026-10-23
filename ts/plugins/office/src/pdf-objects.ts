/**
 * PDF object layer for bounded text extraction: tokenizer, indirect objects,
 * classic and stream cross-reference tables, object streams and the stream
 * filters text needs (Flate with PNG/TIFF predictors, ASCII85, ASCIIHex).
 * Every decoded stream is capped; anything malformed throws.
 */
import { inflateSync } from "node:zlib";

export class PdfName { readonly name: string; constructor(name: string) { this.name = name; } }
export class PdfRef { readonly num: number; readonly gen: number; constructor(num: number, gen: number) { this.num = num; this.gen = gen; } }
export class PdfStream { readonly dict: PdfDict; readonly raw: Buffer; constructor(dict: PdfDict, raw: Buffer) { this.dict = dict; this.raw = raw; } }
export type PdfDict = Map<string, PdfValue>;
export type PdfValue = number | boolean | null | string | Buffer | PdfName | PdfRef | PdfStream | PdfDict | PdfValue[];
/** Operators come back from the content tokenizer as this. */
export class PdfOp { readonly op: string; constructor(op: string) { this.op = op; } }

export class PdfError extends Error { override name = "PdfError"; }
export const MAX_STREAM_BYTES = 2_000_000;
const DELIMITER = new Set("()<>[]{}/%".split("").map((c) => c.charCodeAt(0)));
const WHITE = new Set([0, 9, 10, 12, 13, 32]);

export class Lexer {
  readonly data: Buffer;
  at: number;
  constructor(data: Buffer, at = 0) { this.data = data; this.at = at; }
  private skip(): void {
    for (;;) {
      while (this.at < this.data.length && WHITE.has(this.data[this.at]!)) this.at += 1;
      if (this.data[this.at] !== 0x25) return;
      while (this.at < this.data.length && this.data[this.at] !== 10 && this.data[this.at] !== 13) this.at += 1;
    }
  }
  private regular(): string {
    const start = this.at;
    while (this.at < this.data.length && !WHITE.has(this.data[this.at]!) && !DELIMITER.has(this.data[this.at]!)) this.at += 1;
    return this.data.subarray(start, this.at).toString("latin1");
  }
  private literal(): Buffer {
    const out: number[] = []; let depth = 1; this.at += 1;
    while (this.at < this.data.length) {
      const c = this.data[this.at++]!;
      if (c === 0x5c) {
        const n = this.data[this.at++];
        if (n === undefined) break;
        const map: Record<number, number> = { 0x6e: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12, 0x28: 0x28, 0x29: 0x29, 0x5c: 0x5c };
        if (map[n] !== undefined) out.push(map[n]!);
        else if (n >= 0x30 && n <= 0x37) {
          let value = n - 0x30;
          for (let k = 0; k < 2 && this.data[this.at]! >= 0x30 && this.data[this.at]! <= 0x37; k += 1) value = value * 8 + this.data[this.at++]! - 0x30;
          out.push(value & 0xff);
        } else if (n === 13) { if (this.data[this.at] === 10) this.at += 1; }
        else if (n !== 10) out.push(n);
        continue;
      }
      if (c === 0x28) depth += 1;
      if (c === 0x29 && --depth === 0) return Buffer.from(out);
      out.push(c);
    }
    throw new PdfError("unterminated string");
  }
  /** One object, operator or `R` reference; `undefined` at the end of data. */
  next(allowOps = false): PdfValue | PdfOp | undefined {
    this.skip();
    if (this.at >= this.data.length) return undefined;
    const c = this.data[this.at]!;
    if (c === 0x28) return this.literal();
    if (c === 0x2f) { this.at += 1; return new PdfName(this.regular().replace(/#([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(Number.parseInt(h, 16)))); }
    if (c === 0x5b) { this.at += 1; const items: PdfValue[] = []; for (;;) { this.skip(); if (this.data[this.at] === 0x5d) { this.at += 1; return items; } const item = this.value(allowOps); items.push(item); } }
    if (c === 0x3c && this.data[this.at + 1] === 0x3c) {
      this.at += 2; const dict: PdfDict = new Map();
      for (;;) {
        this.skip();
        if (this.data[this.at] === 0x3e && this.data[this.at + 1] === 0x3e) { this.at += 2; return dict; }
        const key = this.next();
        if (!(key instanceof PdfName)) throw new PdfError("dictionary key must be a name");
        dict.set(key.name, this.value(allowOps));
      }
    }
    if (c === 0x3c) {
      const end = this.data.indexOf(0x3e, this.at);
      if (end < 0) throw new PdfError("unterminated hex string");
      let hex = this.data.subarray(this.at + 1, end).toString("latin1").replace(/\s+/g, "");
      if (!/^[0-9A-Fa-f]*$/.test(hex)) throw new PdfError("invalid hex string");
      if (hex.length % 2) hex += "0";
      this.at = end + 1; return Buffer.from(hex, "hex");
    }
    if (c === 0x5d || c === 0x3e || c === 0x29 || c === 0x7b || c === 0x7d) { this.at += 1; if (allowOps) return new PdfOp(String.fromCharCode(c)); throw new PdfError("unexpected delimiter"); }
    const word = this.regular();
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
      if (/^\d+$/.test(word) && !allowOps) {
        const ahead = /^[\0\t\n\f\r ]+(\d+)[\0\t\n\f\r ]+R(?![^\0\t\n\f\r ()<>\[\]{}\/%])/.exec(this.data.subarray(this.at, this.at + 32).toString("latin1"));
        if (ahead) { this.at += ahead[0].length; return new PdfRef(Number(word), Number(ahead[1])); }
      }
      return Number(word);
    }
    if (word === "true" || word === "false") return word === "true";
    if (word === "null") return null;
    if (!word) throw new PdfError("unexpected byte");
    return new PdfOp(word);
  }
  value(allowOps = false): PdfValue {
    const item = this.next(allowOps);
    if (item === undefined || item instanceof PdfOp && !allowOps) throw new PdfError("unexpected token");
    return item as PdfValue;
  }
}

function predictor(data: Buffer, parms: PdfDict | undefined): Buffer {
  const kind = Number(parms?.get("Predictor") ?? 1);
  if (kind < 10 && kind !== 2) return data;
  const columns = Number(parms?.get("Columns") ?? 1), colors = Number(parms?.get("Colors") ?? 1), bits = Number(parms?.get("BitsPerComponent") ?? 8);
  if (columns > 20_000) throw new PdfError("flate columns exceed the limit");
  const bpp = Math.max(1, Math.ceil(colors * bits / 8)), row = Math.ceil(columns * colors * bits / 8);
  if (row > 500_000) throw new PdfError("flate row exceeds the limit");
  if (kind === 2) { const out = Buffer.from(data); for (let i = bpp; i < out.length; i += 1) if (i % row >= bpp) out[i] = (out[i]! + out[i - bpp]!) & 0xff; return out; }
  const out: number[] = []; let prior = new Array(row).fill(0);
  for (let at = 0; at + 1 + row <= data.length; at += row + 1) {
    const type = data[at]!, line = Array.from(data.subarray(at + 1, at + 1 + row));
    for (let i = 0; i < row; i += 1) {
      const left = i >= bpp ? line[i - bpp]! : 0, up = prior[i]!, ul = i >= bpp ? prior[i - bpp]! : 0;
      const p = left + up - ul, pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - ul);
      const add = type === 1 ? left : type === 2 ? up : type === 3 ? (left + up) >> 1 : type === 4 ? (pa <= pb && pa <= pc ? left : pb <= pc ? up : ul) : 0;
      line[i] = (line[i]! + add) & 0xff;
    }
    out.push(...line); prior = line;
  }
  return Buffer.from(out);
}

function ascii85(data: Buffer): Buffer {
  const text = data.toString("latin1").replace(/\s+/g, "").replace(/^<~/, "");
  const end = text.indexOf("~>"), body = end >= 0 ? text.slice(0, end) : text;
  const out: number[] = []; let group: number[] = [];
  for (const char of body) {
    if (char === "z" && !group.length) { out.push(0, 0, 0, 0); continue; }
    const code = char.charCodeAt(0) - 33;
    if (code < 0 || code > 84) throw new PdfError("invalid ASCII85 data");
    group.push(code);
    if (group.length === 5) { let v = 0; for (const g of group) v = v * 85 + g; out.push(v >>> 24 & 255, v >>> 16 & 255, v >>> 8 & 255, v & 255); group = []; }
  }
  if (group.length) { const n = group.length; while (group.length < 5) group.push(84); let v = 0; for (const g of group) v = v * 85 + g; out.push(...[v >>> 24 & 255, v >>> 16 & 255, v >>> 8 & 255, v & 255].slice(0, n - 1)); }
  return Buffer.from(out);
}

/** Decoded stream bytes; `resolve` dereferences indirect filter parameters. */
export function decodeStream(stream: PdfStream, resolve: (value: PdfValue | undefined) => PdfValue | undefined, limit = MAX_STREAM_BYTES): Buffer {
  const filters = resolve(stream.dict.get("Filter")), parms = resolve(stream.dict.get("DecodeParms"));
  const list = (filters instanceof PdfName ? [filters] : Array.isArray(filters) ? filters.map((item) => resolve(item)) : []) as PdfValue[];
  const parmList = Array.isArray(parms) ? parms.map((item) => resolve(item)) : [parms];
  let data = stream.raw;
  list.forEach((filter, index) => {
    const name = filter instanceof PdfName ? filter.name : "";
    const parm = parmList[index] instanceof Map ? parmList[index] as PdfDict : undefined;
    if (name === "FlateDecode" || name === "Fl") {
      try { data = inflateSync(data, { maxOutputLength: limit + 1, finishFlush: 2 }); } catch (error) { throw new PdfError((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE" ? "stream exceeds the decompressed limit" : "invalid Flate data"); }
      data = predictor(data, parm);
    } else if (name === "ASCII85Decode" || name === "A85") data = ascii85(data);
    else if (name === "ASCIIHexDecode" || name === "AHx") { let hex = data.toString("latin1").replace(/\s+|>.*$/gs, ""); if (hex.length % 2) hex += "0"; data = Buffer.from(hex, "hex"); }
    else throw new PdfError(`unsupported filter ${name}`);
    if (data.length > limit) throw new PdfError("stream exceeds the decompressed limit");
  });
  return data;
}
