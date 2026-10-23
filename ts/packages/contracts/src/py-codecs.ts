/**
 * Python's text codecs where a byte-exact error decision matters: strict
 * UTF-8 (optionally `surrogatepass`), `json.detect_encoding`, and the
 * `str.encode("utf-8")` refusal of lone surrogates.
 */
import { PyValueError } from "./py-ops.ts";

export class PyUnicodeDecodeError extends PyValueError {
  override name = "UnicodeDecodeError";
}
export class PyUnicodeEncodeError extends PyValueError {
  override name = "UnicodeEncodeError";
}

const STRICT = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function continuation(byte: number | undefined): boolean {
  return byte !== undefined && byte >= 0x80 && byte <= 0xbf;
}

/** Manual decoder used only when `surrogatepass` must accept ED A0..BF xx. */
function decodeSurrogatePass(raw: Uint8Array, codec: string): string {
  const out: number[] = [];
  let index = 0;
  while (index < raw.length) {
    const b0 = raw[index] as number;
    let size = 0;
    let point = 0;
    if (b0 < 0x80) {
      size = 1;
      point = b0;
    } else if (b0 >= 0xc2 && b0 <= 0xdf && continuation(raw[index + 1])) {
      size = 2;
      point = ((b0 & 0x1f) << 6) | ((raw[index + 1] as number) & 0x3f);
    } else if (b0 >= 0xe0 && b0 <= 0xef && continuation(raw[index + 1]) && continuation(raw[index + 2])) {
      const b1 = raw[index + 1] as number;
      if (b0 !== 0xe0 || b1 >= 0xa0) {
        size = 3;
        point = ((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | ((raw[index + 2] as number) & 0x3f);
      }
    } else if (b0 >= 0xf0 && b0 <= 0xf4 && continuation(raw[index + 1]) && continuation(raw[index + 2]) && continuation(raw[index + 3])) {
      const b1 = raw[index + 1] as number;
      if ((b0 !== 0xf0 || b1 >= 0x90) && (b0 !== 0xf4 || b1 <= 0x8f)) {
        size = 4;
        point = ((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | (((raw[index + 2] as number) & 0x3f) << 6) | ((raw[index + 3] as number) & 0x3f);
      }
    }
    if (!size) throw new PyUnicodeDecodeError(codec === "utf-8" ? utf8DecodeErrorMessage(raw, true) : `'${codec}' codec can't decode byte 0x${b0.toString(16).padStart(2, "0")} in position ${index}`);
    out.push(point);
    index += size;
  }
  let text = "";
  for (let start = 0; start < out.length; start += 4096) {
    text += String.fromCodePoint(...out.slice(start, start + 4096));
  }
  return text;
}

/**
 * CPython's diagnostic for the first undecodable UTF-8 sequence
 * (`stringlib/codecs.h`): its position, byte span and reason. With
 * `surrogatePass`, a complete ED A0..BF xx sequence is accepted, as the
 * `surrogatepass` handler accepts it; anything else re-raises the strict error.
 */
export function utf8DecodeErrorMessage(raw: Uint8Array, surrogatePass = false): string {
  const end = raw.length;
  for (let index = 0; index < end;) {
    const ch = raw[index] as number, left = end - index, ch2 = raw[index + 1];
    let size = 0, span = 1, reason = "invalid continuation byte";
    if (ch < 0x80) size = 1;
    else if (ch < 0xc2 || ch > 0xf4) reason = "invalid start byte";
    else if (left < 2) [span, reason] = [left, "unexpected end of data"];
    else if (ch < 0xe0) size = continuation(ch2) ? 2 : 0;
    else {
      const four = ch >= 0xf0, need = four ? 4 : 3;
      const surrogate = !four && surrogatePass && ch === 0xed && left >= 3 && continuation(ch2) && continuation(raw[index + 2]);
      const second = continuation(ch2) && (surrogate || !(four ? ((ch2 as number) < 0x90 ? ch === 0xf0 : ch === 0xf4) : ((ch2 as number) < 0xa0 ? ch === 0xe0 : ch === 0xed)));
      let valid = second ? 2 : 1;
      while (second && valid < need && valid < left && continuation(raw[index + valid])) valid += 1;
      if (valid === need) size = need;
      else if (second && valid === left) [span, reason] = [left, "unexpected end of data"];
      else span = valid;
    }
    if (!size) {
      return span === 1 ? `'utf-8' codec can't decode byte 0x${ch.toString(16).padStart(2, "0")} in position ${index}: ${reason}`
        : `'utf-8' codec can't decode bytes in position ${index}-${index + span - 1}: ${reason}`;
    }
    index += size;
  }
  return "'utf-8' codec can't decode bytes";
}

/** `raw.decode("utf-8", errors)` for `strict` or `surrogatepass`. */
export function pyDecodeUtf8(raw: Uint8Array, surrogatePass = false): string {
  try {
    return STRICT.decode(raw);
  } catch {
    if (!surrogatePass) throw new PyUnicodeDecodeError(utf8DecodeErrorMessage(raw));
    return decodeSurrogatePass(raw, "utf-8");
  }
}

function decodeUnits(raw: Uint8Array, width: 2 | 4, little: boolean, codec: string): string {
  if (raw.length % width) throw new PyUnicodeDecodeError(`'${codec}' codec can't decode bytes: truncated data`);
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  let text = "";
  for (let index = 0; index < raw.length; index += width) {
    if (width === 2) {
      text += String.fromCharCode(view.getUint16(index, little));
      continue;
    }
    const point = view.getUint32(index, little);
    if (point > 0x10ffff) throw new PyUnicodeDecodeError(`'${codec}' codec can't decode bytes: code point not in range(0x110000)`);
    text += String.fromCodePoint(point);
  }
  return text;
}

function startsWith(raw: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => raw[index] === byte);
}

/** `json.loads(bytes)`: `detect_encoding` then decode with `surrogatepass`. */
export function pyJsonDecodeBytes(raw: Uint8Array): string {
  if (startsWith(raw, [0, 0, 0xfe, 0xff])) return decodeUnits(raw.subarray(4), 4, false, "utf-32");
  if (startsWith(raw, [0xff, 0xfe, 0, 0])) return decodeUnits(raw.subarray(4), 4, true, "utf-32");
  if (startsWith(raw, [0xfe, 0xff])) return decodeUnits(raw.subarray(2), 2, false, "utf-16");
  if (startsWith(raw, [0xff, 0xfe])) return decodeUnits(raw.subarray(2), 2, true, "utf-16");
  if (startsWith(raw, [0xef, 0xbb, 0xbf])) return pyDecodeUtf8(raw.subarray(3), true);
  const [b0, b1, b2, b3] = raw;
  if (raw.length >= 4) {
    if (!b0) return b1 ? decodeUnits(raw, 2, false, "utf-16-be") : decodeUnits(raw, 4, false, "utf-32-be");
    if (!b1) return b2 || b3 ? decodeUnits(raw, 2, true, "utf-16-le") : decodeUnits(raw, 4, true, "utf-32-le");
  } else if (raw.length === 2) {
    if (!b0) return decodeUnits(raw, 2, false, "utf-16-be");
    if (!b1) return decodeUnits(raw, 2, true, "utf-16-le");
  }
  return pyDecodeUtf8(raw, true);
}

/** True when `text.encode("utf-8")` would raise for a lone surrogate. */
export function hasLoneSurrogate(text: string): boolean {
  return /\p{Surrogate}/u.test(text);
}

/** `text.encode("utf-8")`, refusing lone surrogates like Python. */
export function pyEncodeUtf8(text: string): Buffer {
  if (hasLoneSurrogate(text)) throw new PyUnicodeEncodeError("'utf-8' codec can't encode character: surrogates not allowed");
  return Buffer.from(text, "utf8");
}

/** `text.encode("utf-8", "surrogatepass")`: lone surrogates become ED xx xx. */
export function pyEncodeUtf8SurrogatePass(text: string): Buffer {
  if (!hasLoneSurrogate(text)) return Buffer.from(text, "utf8");
  const parts: Buffer[] = [];
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    if (code >= 0xd800 && code <= 0xdfff) {
      parts.push(Buffer.from([0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f)]));
    } else {
      parts.push(Buffer.from(char, "utf8"));
    }
  }
  return Buffer.concat(parts);
}
