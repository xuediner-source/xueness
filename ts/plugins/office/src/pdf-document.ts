/** Cross-reference tables, object resolution and the page tree of one PDF. */
import { decodeStream, Lexer, MAX_STREAM_BYTES, PdfError, PdfName, PdfOp, PdfRef, PdfStream, type PdfDict, type PdfValue } from "./pdf-objects.ts";

type XrefEntry = { kind: "offset"; offset: number } | { kind: "packed"; stream: number; index: number };
const MAX_OBJECTS = 200_000;
export const MAX_PAGE_TREE_ENTRIES = 1000;

export class PdfDocument {
  readonly xref = new Map<number, XrefEntry>();
  trailer: PdfDict = new Map();
  private readonly cache = new Map<number, PdfValue>();
  private readonly packed = new Map<number, Map<number, PdfValue>>();
  private readonly resolving = new Set<number>();

  readonly data: Buffer;
  constructor(data: Buffer) {
    this.data = data;
    if (!data.subarray(0, 1024).includes("%PDF-")) throw new PdfError("missing PDF header");
    const tail = data.subarray(Math.max(0, data.length - 2048)).toString("latin1");
    const match = /startxref\s+(\d+)\s+%%EOF/g; let found: RegExpExecArray | null, last: string | undefined;
    while ((found = match.exec(tail))) last = found[1];
    if (last === undefined) throw new PdfError("missing startxref");
    const seen = new Set<number>(); let offset: number | undefined = Number(last), first = true;
    while (offset !== undefined) {
      if (seen.has(offset) || seen.size > 64) throw new PdfError("cross-reference loop");
      seen.add(offset);
      const trailer = this.readXref(offset);
      if (first) { this.trailer = trailer; first = false; }
      const stm = trailer.get("XRefStm");
      if (typeof stm === "number" && !seen.has(stm)) { seen.add(stm); this.readXref(stm); }
      const prev = trailer.get("Prev");
      offset = typeof prev === "number" ? prev : undefined;
    }
  }

  private readXref(offset: number): PdfDict {
    if (offset < 0 || offset >= this.data.length) throw new PdfError("startxref is out of range");
    const lexer = new Lexer(this.data, offset), first = lexer.next();
    if (first instanceof PdfOp && first.op === "xref") {
      for (;;) {
        const start = lexer.next();
        if (start instanceof PdfOp && start.op === "trailer") break;
        const count = lexer.next();
        if (typeof start !== "number" || typeof count !== "number" || count < 0 || start + count > MAX_OBJECTS) throw new PdfError("invalid xref subsection");
        for (let i = 0; i < count; i += 1) {
          const off = lexer.next(), gen = lexer.next(), kind = lexer.next();
          if (typeof off !== "number" || typeof gen !== "number" || !(kind instanceof PdfOp)) throw new PdfError("invalid xref entry");
          if (kind.op === "n" && !this.xref.has(start + i)) this.xref.set(start + i, { kind: "offset", offset: off });
          else if (kind.op === "f" && !this.xref.has(start + i)) this.xref.set(start + i, { kind: "offset", offset: -1 });
        }
      }
      const trailer = lexer.value();
      if (!(trailer instanceof Map)) throw new PdfError("invalid trailer");
      return trailer;
    }
    lexer.at = offset;
    const stream = this.objectAt(offset);
    if (!(stream instanceof PdfStream) || (stream.dict.get("Type") as PdfName | undefined)?.name !== "XRef") throw new PdfError("invalid cross-reference stream");
    const widths = stream.dict.get("W"), size = Number(stream.dict.get("Size"));
    if (!Array.isArray(widths) || widths.length !== 3 || !widths.every((w) => typeof w === "number" && w >= 0 && w <= 8)) throw new PdfError("invalid xref widths");
    const index = (stream.dict.get("Index") as number[] | undefined) ?? [0, size];
    const body = decodeStream(stream, (v) => this.resolve(v)), w = widths as number[], rowSize = w[0]! + w[1]! + w[2]!;
    let at = 0;
    for (let k = 0; k + 1 < index.length; k += 2) {
      const start = Number(index[k]), count = Number(index[k + 1]);
      if (!Number.isInteger(start) || !Number.isInteger(count) || start < 0 || count < 0 || start + count > MAX_OBJECTS) throw new PdfError("invalid xref index");
      for (let i = 0; i < count && at + rowSize <= body.length; i += 1) {
        const field = (n: number, fallback: number): number => { if (!w[n]) return fallback; let v = 0; for (let b = 0; b < w[n]!; b += 1) v = v * 256 + body[at++]!; return v; };
        const type = field(0, 1), a = field(1, 0), b = field(2, 0);
        if (this.xref.has(start + i)) continue;
        if (type === 1) this.xref.set(start + i, { kind: "offset", offset: a });
        else if (type === 2) this.xref.set(start + i, { kind: "packed", stream: a, index: b });
        else if (type === 0) this.xref.set(start + i, { kind: "offset", offset: -1 });
      }
    }
    return stream.dict;
  }

  private objectAt(offset: number): PdfValue {
    const lexer = new Lexer(this.data, offset);
    const num = lexer.next(), gen = lexer.next(), obj = lexer.next();
    if (typeof num !== "number" || typeof gen !== "number" || !(obj instanceof PdfOp) || obj.op !== "obj") throw new PdfError("invalid indirect object");
    const value = lexer.value();
    const save = lexer.at, keyword = lexer.next();
    if (keyword instanceof PdfOp && keyword.op === "stream" && value instanceof Map) {
      let at = lexer.at;
      if (this.data[at] === 13) at += 1;
      if (this.data[at] === 10) at += 1;
      const length = this.resolve(value.get("Length"));
      if (typeof length !== "number" || !Number.isInteger(length) || length < 0 || at + length > this.data.length) throw new PdfError("invalid stream length");
      return new PdfStream(value, this.data.subarray(at, at + length));
    }
    lexer.at = save;
    return value;
  }

  private load(num: number): PdfValue {
    const entry = this.xref.get(num);
    if (!entry || entry.kind === "offset" && entry.offset < 0) return null;
    if (entry.kind === "offset") return this.objectAt(entry.offset);
    let objects = this.packed.get(entry.stream);
    if (!objects) {
      const stream = this.resolve(new PdfRef(entry.stream, 0));
      if (!(stream instanceof PdfStream)) throw new PdfError("invalid object stream");
      const body = decodeStream(stream, (v) => this.resolve(v)), count = Number(stream.dict.get("N")), first = Number(stream.dict.get("First"));
      if (!Number.isInteger(count) || count < 0 || count > MAX_OBJECTS || !Number.isInteger(first) || first < 0) throw new PdfError("invalid object stream header");
      const header = new Lexer(body.subarray(0, first)), pairs: Array<[number, number]> = [];
      for (let i = 0; i < count; i += 1) {
        const n = header.next(), off = header.next();
        if (typeof n !== "number" || typeof off !== "number") throw new PdfError("invalid object stream header");
        pairs.push([n, off]);
      }
      objects = new Map();
      for (const [n, off] of pairs) objects.set(n, new Lexer(body, first + off).value());
      this.packed.set(entry.stream, objects);
    }
    return objects.get(num) ?? null;
  }

  resolve(value: PdfValue | undefined): PdfValue | undefined {
    let current = value, hops = 0;
    while (current instanceof PdfRef) {
      if (hops++ > 32) throw new PdfError("reference chain too deep");
      const num = current.num;
      if (this.cache.has(num)) { current = this.cache.get(num); continue; }
      if (this.resolving.has(num)) throw new PdfError("circular reference");
      this.resolving.add(num);
      try { const loaded = this.load(num); this.cache.set(num, loaded); current = loaded; } finally { this.resolving.delete(num); }
    }
    return current;
  }

  dict(value: PdfValue | undefined): PdfDict | undefined {
    const resolved = this.resolve(value);
    if (resolved instanceof PdfStream) return resolved.dict;
    return resolved instanceof Map ? resolved : undefined;
  }

  bytes(stream: PdfStream, limit = MAX_STREAM_BYTES): Buffer { return decodeStream(stream, (v) => this.resolve(v), limit); }

  get encrypted(): boolean { return this.trailer.has("Encrypt") && this.resolve(this.trailer.get("Encrypt")) !== null; }

  /** Leaf pages in order with inherited resources; the tree is bounded. */
  pages(): Array<{ page: PdfDict; resources: PdfDict | undefined }> {
    const root = this.dict(this.trailer.get("Root")), top = this.dict(root?.get("Pages"));
    if (!top) throw new PdfError("missing page tree");
    const out: Array<{ page: PdfDict; resources: PdfDict | undefined }> = [];
    let visited = 0;
    const walk = (node: PdfDict, inherited: PdfDict | undefined, depth: number, seen: Set<PdfDict>): void => {
      if (depth > 40 || seen.has(node) || ++visited > MAX_PAGE_TREE_ENTRIES) throw new PdfError("page tree exceeds the limit");
      seen.add(node);
      const resources = this.dict(node.get("Resources")) ?? inherited;
      const kids = this.resolve(node.get("Kids"));
      const type = (this.resolve(node.get("Type")) as PdfName | undefined)?.name;
      if (type === "Pages" || Array.isArray(kids) && type !== "Page") {
        for (const kid of Array.isArray(kids) ? kids : []) { const child = this.dict(kid); if (child) walk(child, resources, depth + 1, seen); }
      } else out.push({ page: node, resources });
    };
    walk(top, undefined, 0, new Set());
    return out;
  }

  /** `/Info /Title` as text, or `""`. */
  title(): string {
    const info = this.dict(this.trailer.get("Info")), raw = this.resolve(info?.get("Title"));
    return Buffer.isBuffer(raw) ? textString(raw) : "";
  }
}

const PDFDOC_HIGH = "\u2022\u2020\u2021\u2026\u2014\u2013\u0192\u2044\u2039\u203a\u2212\u2030\u201e\u201c\u201d\u2018\u2019\u201a\u2122\ufb01\ufb02\u0141\u0152\u0160\u0178\u017d\u0131\u0142\u0153\u0161\u017e\ufffd\u20ac";

/** A PDF text string: UTF-16 with BOM, UTF-8 with BOM, else PDFDocEncoding. */
export function textString(raw: Buffer): string {
  if (raw[0] === 0xfe && raw[1] === 0xff) { const body = raw.subarray(2, raw.length - (raw.length % 2)); return Buffer.from(body).swap16().toString("utf16le"); }
  if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) return raw.subarray(3).toString("utf8");
  let out = "";
  for (const byte of raw) out += byte >= 0x80 && byte < 0xa1 ? PDFDOC_HIGH[byte - 0x80] ?? "\ufffd" : String.fromCharCode(byte);
  return out;
}

export { PdfName, PdfStream };
