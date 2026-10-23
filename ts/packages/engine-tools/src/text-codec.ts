/**
 * Text encoding detection and lossless round trips.
 *
 * Files keep their encoding when the agent edits them: UTF-8 (with or
 * without BOM), UTF-16 with BOM, and the Chinese legacy encodings GBK and
 * GB18030. Node can decode GB18030 but not encode it, so the encoder table is
 * derived from the platform decoder once and every encode is verified by
 * decoding it again. Content that cannot round-trip is refused, never mangled.
 */

export type TextEncodingName = "utf-8" | "utf-8-bom" | "utf-16le" | "utf-16be" | "gbk" | "gb18030";

export class BinaryFileError extends Error {
  override name = "BinaryFileError";
  readonly code = "binary_file";
}

export class UnsupportedEncodingError extends Error {
  override name = "UnsupportedEncodingError";
  readonly code = "unsupported_encoding";
}

const SAMPLE_BYTES = 8192;
const CONTROL_RATIO = 0.1;

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return bytes.length >= prefix.length && prefix.every((byte, index) => bytes[index] === byte);
}

/** NUL bytes or many control bytes in the first 8 KiB mean binary. */
export function looksBinary(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, SAMPLE_BYTES);
  if (!sample.length) return false;
  let control = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) control += 1;
  }
  return control / sample.length > CONTROL_RATIO;
}

function isUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** True when a GB18030 four-byte sequence (lead, 0x30-0x39, ...) occurs. */
function hasFourByteSequence(bytes: Uint8Array): boolean {
  for (let index = 0; index < bytes.length;) {
    const byte = bytes[index] as number;
    if (byte < 0x80) index += 1;
    else if ((bytes[index + 1] ?? 0) >= 0x30 && (bytes[index + 1] ?? 0) <= 0x39) return true;
    else index += 2;
  }
  return false;
}

export function detectEncoding(bytes: Uint8Array): TextEncodingName {
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) return "utf-8-bom";
  if (startsWith(bytes, [0xff, 0xfe])) return "utf-16le";
  if (startsWith(bytes, [0xfe, 0xff])) return "utf-16be";
  if (looksBinary(bytes)) throw new BinaryFileError("binary file is not supported as text");
  if (isUtf8(bytes)) return "utf-8";
  let text: string;
  try {
    text = new TextDecoder("gb18030", { fatal: true }).decode(bytes);
  } catch {
    throw new UnsupportedEncodingError("unsupported text encoding (not UTF-8, UTF-16 or GB18030)");
  }
  const encoding: TextEncodingName = hasFourByteSequence(bytes) ? "gb18030" : "gbk";
  const again = encodeGb(text, encoding === "gbk");
  if (again === null || !sameBytes(again, bytes)) {
    throw new UnsupportedEncodingError("file does not round-trip as GB18030; refusing to treat it as text");
  }
  return encoding;
}

export interface DecodedText {
  text: string;
  encoding: TextEncodingName;
}

export function decodeText(bytes: Uint8Array, encoding: TextEncodingName = detectEncoding(bytes)): DecodedText {
  const label = encoding === "utf-8-bom" ? "utf-8" : encoding === "gbk" ? "gb18030" : encoding;
  return { text: new TextDecoder(label).decode(bytes), encoding };
}

export function encodeText(text: string, encoding: TextEncodingName): Uint8Array {
  switch (encoding) {
    case "utf-8":
      return Buffer.from(text, "utf8");
    case "utf-8-bom":
      return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")]);
    case "utf-16le":
      return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
    case "utf-16be": {
      const body = Buffer.from(text, "utf16le");
      body.swap16();
      return Buffer.concat([Buffer.from([0xfe, 0xff]), body]);
    }
    case "gbk":
    case "gb18030": {
      const bytes = encodeGb(text, encoding === "gbk");
      if (bytes === null || new TextDecoder("gb18030").decode(bytes) !== text) {
        throw new UnsupportedEncodingError(`content cannot be encoded as ${encoding.toUpperCase()}; keep to characters the file's encoding supports`);
      }
      return bytes;
    }
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

interface GbTables {
  twoByte: Map<number, number>;
  fourByte: Map<number, number>;
}

let tables: GbTables | null = null;

/** Invert the platform GB18030 decoder once (two-byte and BMP four-byte forms). */
function gbTables(): GbTables {
  if (tables) return tables;
  const decoder = new TextDecoder("gb18030");
  const twoByte = new Map<number, number>();
  const pairs: number[] = [];
  const probe: number[] = [];
  for (let lead = 0x81; lead <= 0xfe; lead += 1) {
    for (let trail = 0x40; trail <= 0xfe; trail += 1) {
      if (trail === 0x7f) continue;
      pairs.push((lead << 8) | trail);
      probe.push(lead, trail, 0x0a);
    }
  }
  decoder.decode(Uint8Array.from(probe)).split("\n").forEach((char, index) => {
    const code = char.codePointAt(0);
    if (code === undefined || code === 0xfffd || [...char].length !== 1 || twoByte.has(code)) return;
    twoByte.set(code, pairs[index] as number);
  });
  const fourByte = new Map<number, number>();
  const quads: number[] = [];
  for (let pointer = 0; pointer < 39420; pointer += 1) quads.push(...pointerBytes(pointer), 0x0a);
  decoder.decode(Uint8Array.from(quads)).split("\n").forEach((char, pointer) => {
    const code = char.codePointAt(0);
    if (code === undefined || code === 0xfffd || [...char].length !== 1 || twoByte.has(code) || fourByte.has(code)) return;
    fourByte.set(code, pointer);
  });
  tables = { twoByte, fourByte };
  return tables;
}

function pointerBytes(pointer: number): [number, number, number, number] {
  const b1 = Math.floor(pointer / 12600);
  const rest = pointer % 12600;
  return [b1 + 0x81, Math.floor(rest / 1260) + 0x30, Math.floor((rest % 1260) / 10) + 0x81, (rest % 10) + 0x30];
}

/** Encode with the derived table; `gbkOnly` refuses four-byte forms. Null when unencodable. */
function encodeGb(text: string, gbkOnly: boolean): Uint8Array | null {
  const { twoByte, fourByte } = gbTables();
  const out: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    if (code < 0x80) {
      out.push(code);
      continue;
    }
    const pair = twoByte.get(code);
    if (pair !== undefined) {
      out.push(pair >> 8, pair & 0xff);
      continue;
    }
    if (gbkOnly) return null;
    const pointer = fourByte.get(code) ?? (code >= 0x10000 && code <= 0x10ffff ? 189000 + code - 0x10000 : undefined);
    if (pointer === undefined) return null;
    out.push(...pointerBytes(pointer));
  }
  return Uint8Array.from(out);
}
