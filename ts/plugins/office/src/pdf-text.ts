/**
 * Plain text of one PDF page in reading order, close to pypdf's
 * `extract_text()` on simple layouts: `T*`, `'`, `"` and vertical moves end
 * lines, wide `TJ` gaps become spaces, fonts decode through ToUnicode, UCS-2
 * CMaps or single-byte encodings, and form XObjects are bounded.
 */
import { PdfDocument } from "./pdf-document.ts";
import { Lexer, PdfError, PdfName, PdfOp, PdfStream, type PdfDict, type PdfValue } from "./pdf-objects.ts";

const MAX_FORM_INVOCATIONS = 100;
const CP1252_HIGH = "\u20ac\ufffd\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\ufffd\u017d\ufffd\ufffd\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\ufffd\u017e\u0178";
const GLYPHS: Record<string, string> = {
  space: " ", exclam: "!", quotedbl: "\"", numbersign: "#", dollar: "$", percent: "%", ampersand: "&", quotesingle: "'", quoteright: "\u2019", quoteleft: "\u2018",
  parenleft: "(", parenright: ")", asterisk: "*", plus: "+", comma: ",", hyphen: "-", period: ".", slash: "/", colon: ":", semicolon: ";", less: "<", equal: "=",
  greater: ">", question: "?", at: "@", bracketleft: "[", backslash: "\\", bracketright: "]", underscore: "_", braceleft: "{", bar: "|", braceright: "}",
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", bullet: "\u2022", endash: "\u2013",
  emdash: "\u2014", quotedblleft: "\u201c", quotedblright: "\u201d", fi: "fi", fl: "fl", ellipsis: "\u2026",
};

/** Text of a string operand and its advance in text-space units (glyph widths / 1000). */
type Decoder = { decode: (raw: Buffer) => string; advance: (raw: Buffer) => number; spaceWidth: number };

function glyph(name: string): string | undefined {
  if (GLYPHS[name] !== undefined) return GLYPHS[name];
  if (/^[A-Za-z]$/.test(name)) return name;
  const uni = /^uni([0-9A-Fa-f]{4})+$/.exec(name);
  if (uni) return (name.slice(3).match(/.{4}/g) ?? []).map((h) => String.fromCharCode(Number.parseInt(h, 16))).join("");
  const u = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (u) return String.fromCodePoint(Number.parseInt(u[1]!, 16));
  return undefined;
}

function utf16(raw: Buffer): string {
  const even = raw.subarray(0, raw.length - (raw.length % 2));
  return Buffer.from(even).swap16().toString("utf16le");
}

function parseCMap(data: Buffer): { lengths: number[]; map: Map<string, string> } {
  const lexer = new Lexer(data), map = new Map<string, string>(), lengths = new Set<number>();
  const tokens: Array<PdfValue | PdfOp> = [];
  for (let token = lexer.next(true); token !== undefined; token = lexer.next(true)) {
    if (!(token instanceof PdfOp)) { tokens.push(token); continue; }
    const args = tokens.splice(0);
    if (token.op === "endcodespacerange") for (let i = 0; i + 1 < args.length; i += 2) if (Buffer.isBuffer(args[i])) lengths.add((args[i] as Buffer).length);
    if (token.op === "endbfchar") for (let i = 0; i + 1 < args.length; i += 2) {
      const src = args[i], dst = args[i + 1];
      if (Buffer.isBuffer(src) && Buffer.isBuffer(dst)) map.set(src.toString("hex"), utf16(dst));
    }
    if (token.op === "endbfrange") for (let i = 0; i + 2 < args.length; i += 3) {
      const lo = args[i], hi = args[i + 1], dst = args[i + 2];
      if (!Buffer.isBuffer(lo) || !Buffer.isBuffer(hi)) continue;
      const start = Number.parseInt(lo.toString("hex") || "0", 16), end = Number.parseInt(hi.toString("hex") || "0", 16);
      if (end < start || end - start > 65535) continue;
      for (let code = start; code <= end; code += 1) {
        const key = code.toString(16).padStart(lo.length * 2, "0");
        if (Array.isArray(dst)) { const item = dst[code - start]; if (Buffer.isBuffer(item)) map.set(key, utf16(item)); }
        else if (Buffer.isBuffer(dst)) {
          const base = Buffer.from(dst);
          if (base.length) base.writeUIntBE((base.readUIntBE(Math.max(0, base.length - 2), Math.min(2, base.length)) + code - start) & 0xffff, Math.max(0, base.length - 2), Math.min(2, base.length));
          map.set(key, utf16(base));
        }
      }
    }
  }
  return { lengths: [...lengths].sort((a, b) => a - b), map };
}

export function fontDecoder(doc: PdfDocument, font: PdfDict | undefined): Decoder {
  const subtype = (doc.resolve(font?.get("Subtype")) as PdfName | undefined)?.name;
  const encoding = doc.resolve(font?.get("Encoding"));
  const composite = subtype === "Type0";
  const toUnicode = doc.resolve(font?.get("ToUnicode"));
  let cmap: ReturnType<typeof parseCMap> | undefined;
  if (toUnicode instanceof PdfStream) { try { cmap = parseCMap(doc.bytes(toUnicode)); } catch { cmap = undefined; } }
  const encodingName = encoding instanceof PdfName ? encoding.name : "";
  const fallback = composite
    ? (encodingName.endsWith("UCS2-H") || encodingName.endsWith("UTF16-H") ? utf16 : (raw: Buffer) => utf16(raw))
    : singleByte(doc, encoding, encodingName);
  const decode = (raw: Buffer): string => {
    if (!cmap || !cmap.map.size) return fallback(raw);
    const lengths = cmap.lengths.length ? cmap.lengths : [composite ? 2 : 1];
    let out = "";
    for (let at = 0; at < raw.length;) {
      let matched = false;
      for (const length of lengths) {
        const hit = cmap.map.get(raw.subarray(at, at + length).toString("hex"));
        if (hit !== undefined) { out += hit; at += length; matched = true; break; }
      }
      if (!matched) { const length = lengths[0]!; out += fallback(raw.subarray(at, at + length)); at += length; }
    }
    return out;
  };
  const widths = glyphWidths(doc, font, composite, encodingName);
  const codeLength = composite ? 2 : 1;
  const advance = (raw: Buffer): number => { let total = 0; for (let at = 0; at + codeLength <= raw.length; at += codeLength) total += widths(composite ? raw.readUInt16BE(at) : raw[at]!); return total / 1000; };
  return { decode, advance, spaceWidth: widths(32) / 1000 || 0.25 };
}

/** Glyph width by code: simple fonts use FirstChar/Widths, CID fonts W/DW (UCS-2 CMaps map ASCII to CIDs 1-95). */
function glyphWidths(doc: PdfDocument, font: PdfDict | undefined, composite: boolean, encodingName: string): (code: number) => number {
  if (!composite) {
    const first = doc.resolve(font?.get("FirstChar")), list = doc.resolve(font?.get("Widths"));
    const missing = doc.resolve(doc.dict(font?.get("FontDescriptor"))?.get("MissingWidth"));
    const fallback = typeof missing === "number" && missing > 0 ? missing : 500;
    if (typeof first !== "number" || !Array.isArray(list)) return () => fallback;
    return (code) => { const value = doc.resolve(list[code - first]); return typeof value === "number" ? value : fallback; };
  }
  const descendant = doc.dict((doc.resolve(font?.get("DescendantFonts")) as PdfValue[] | undefined)?.[0]);
  const dw = doc.resolve(descendant?.get("DW")), table = new Map<number, number>();
  const w = doc.resolve(descendant?.get("W"));
  if (Array.isArray(w)) for (let i = 0; i < w.length && table.size < 65536;) {
    const start = doc.resolve(w[i]), next = doc.resolve(w[i + 1]);
    if (typeof start !== "number") break;
    if (Array.isArray(next)) { next.forEach((value, k) => { const v = doc.resolve(value); if (typeof v === "number") table.set(start + k, v); }); i += 2; }
    else { const width = doc.resolve(w[i + 2]); if (typeof next !== "number" || typeof width !== "number") break; for (let c = start; c <= Math.min(next, start + 65535); c += 1) table.set(c, width); i += 3; }
  }
  const ucs2 = /UCS2-H$|UTF16-H$/.test(encodingName), base = typeof dw === "number" ? dw : 1000;
  return (code) => { const cid = ucs2 ? (code >= 0x20 && code <= 0x7e ? code - 0x1f : -1) : code; return table.get(cid) ?? base; };
}

function singleByte(doc: PdfDocument, encoding: PdfValue | undefined, name: string): (raw: Buffer) => string {
  const table: string[] = [];
  for (let code = 0; code < 256; code += 1) table.push(code >= 0x80 && code < 0xa0 && name !== "MacRomanEncoding" ? CP1252_HIGH[code - 0x80]! : String.fromCharCode(code));
  if (encoding instanceof Map) {
    const differences = doc.resolve(encoding.get("Differences"));
    let code = 0;
    for (const item of Array.isArray(differences) ? differences : []) {
      if (typeof item === "number") code = item;
      else if (item instanceof PdfName) { const value = glyph(item.name); if (value !== undefined && code < 256) table[code] = value; code += 1; }
    }
  }
  return (raw) => { let out = ""; for (const byte of raw) out += table[byte]!; return out; };
}

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const multiply = (m: Matrix, n: Matrix): Matrix => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3], m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];

export class PageText {
  private out = "";
  private forms = 0;
  private prev: [number, number] | undefined;
  private readonly doc: PdfDocument;
  constructor(doc: PdfDocument) { this.doc = doc; }

  run(content: Buffer, resources: PdfDict | undefined, ctm: Matrix = IDENTITY, depth = 0): string {
    const lexer = new Lexer(content), fonts = new Map<string, Decoder>();
    const stack: Matrix[] = [];
    let operands: Array<PdfValue> = [], cm: Matrix = ctm, tm: Matrix = IDENTITY, tlm: Matrix = IDENTITY;
    let leading = 0, size = 1, charSpace = 0, wordSpace = 0, scale = 1;
    let decoder: Decoder = { decode: (raw) => raw.toString("latin1"), advance: (raw) => raw.length * 0.5, spaceWidth: 0.25 };
    const fontDicts = this.doc.dict(resources?.get("Font"));
    // Like pypdf: a vertical jump of more than half a line ends the line; a horizontal gap wider than a space adds one.
    const separate = (): void => {
      const at = multiply(tm, cm), prev = this.prev;
      if (prev) {
        const height = size * Math.hypot(at[2], at[3]), space = decoder.spaceWidth * size * Math.hypot(at[0], at[1]);
        if (Math.abs(at[5] - prev[1]) > height * 0.5 && this.out && !this.out.endsWith("\n")) this.out += "\n";
        if (at[4] - prev[0] > Math.max(space, 0.5) && this.out && !this.out.endsWith(" ")) this.out += " ";
      }
    };
    const advance = (raw: Buffer): void => {
      const spaces = decoder.spaceWidth && raw.length ? [...raw].filter((byte) => byte === 32).length : 0;
      tm = multiply([1, 0, 0, 1, (decoder.advance(raw) * size + charSpace * raw.length + wordSpace * spaces) * scale, 0], tm);
      const at = multiply(tm, cm); this.prev = [at[4], at[5]];
    };
    const show = (raw: Buffer): void => { separate(); this.out += decoder.decode(raw); advance(raw); };
    const nextLine = (): void => { tlm = multiply([1, 0, 0, 1, 0, -leading], tlm); tm = tlm; this.out += "\n"; const at = multiply(tm, cm); this.prev = [at[4], at[5]]; };
    for (let token = lexer.next(true); token !== undefined; token = lexer.next(true)) {
      if (!(token instanceof PdfOp)) { operands.push(token); continue; }
      const args = operands; operands = [];
      const n = (i: number): number => { const v = args[i]; if (typeof v !== "number") throw new PdfError(`bad operand for ${token.op}`); return v; };
      switch (token.op) {
        case "q": if (stack.length < 64) stack.push(cm); break;
        case "Q": cm = stack.pop() ?? cm; break;
        case "cm": cm = multiply([n(0), n(1), n(2), n(3), n(4), n(5)], cm); break;
        case "BT": tm = tlm = IDENTITY; break;
        case "Tf": {
          const name = args[0] instanceof PdfName ? args[0].name : "";
          size = typeof args[1] === "number" ? args[1] : size;
          let found = fonts.get(name);
          if (!found) { found = fontDecoder(this.doc, this.doc.dict(fontDicts?.get(name))); fonts.set(name, found); }
          decoder = found; break;
        }
        case "TL": leading = n(0); break;
        case "Tc": charSpace = n(0); break;
        case "Tw": wordSpace = n(0); break;
        case "Tz": scale = n(0) / 100; break;
        case "Td": case "TD": tlm = tm = multiply([1, 0, 0, 1, n(0), n(1)], tlm); if (token.op === "TD") leading = -n(1); break;
        case "Tm": tm = tlm = [n(0), n(1), n(2), n(3), n(4), n(5)]; break;
        case "T*": nextLine(); break;
        case "Tj": if (Buffer.isBuffer(args[0])) show(args[0]); break;
        case "'": nextLine(); if (Buffer.isBuffer(args[0])) show(args[0]); break;
        case "\"": wordSpace = n(0); charSpace = n(1); nextLine(); if (Buffer.isBuffer(args[2])) show(args[2]); break;
        case "TJ": for (const item of Array.isArray(args[0]) ? args[0] : []) {
          if (Buffer.isBuffer(item)) show(item);
          else if (typeof item === "number") {
            if (item < -decoder.spaceWidth * 1000 && this.out && !/\s$/.test(this.out)) this.out += " ";
            tm = multiply([1, 0, 0, 1, -item / 1000 * size * scale, 0], tm);
            const at = multiply(tm, cm); this.prev = [at[4], at[5]];
          }
        } break;
        case "BI": this.skipInlineImage(lexer); break;
        case "Do": this.form(args[0], resources, cm, depth); break;
        default: break;
      }
    }
    return this.out;
  }

  private skipInlineImage(lexer: Lexer): void {
    for (let token = lexer.next(true); token !== undefined; token = lexer.next(true)) if (token instanceof PdfOp && token.op === "ID") break;
    const data = lexer.data, at = lexer.at + 1;
    for (let i = at; i + 1 < data.length; i += 1) if (data[i] === 0x45 && data[i + 1] === 0x49 && (i + 2 >= data.length || /\s/.test(String.fromCharCode(data[i + 2]!))) && /\s/.test(String.fromCharCode(data[i - 1] ?? 32))) { lexer.at = i + 2; return; }
    lexer.at = data.length;
  }

  private form(name: PdfValue | undefined, resources: PdfDict | undefined, cm: Matrix, depth: number): void {
    if (!(name instanceof PdfName) || depth > 8) return;
    const object = this.doc.resolve(this.doc.dict(resources?.get("XObject"))?.get(name.name));
    if (!(object instanceof PdfStream) || (this.doc.resolve(object.dict.get("Subtype")) as PdfName | undefined)?.name !== "Form") return;
    if (++this.forms > MAX_FORM_INVOCATIONS) throw new PdfError("form XObject invocations exceed the limit");
    const matrix = this.doc.resolve(object.dict.get("Matrix"));
    const own = Array.isArray(matrix) && matrix.length === 6 && matrix.every((v) => typeof v === "number") ? matrix as Matrix : IDENTITY;
    this.run(this.doc.bytes(object), this.doc.dict(object.dict.get("Resources")) ?? resources, multiply(own, cm), depth + 1);
  }
}
