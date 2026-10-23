/**
 * CPython 3.11 `str.encode("idna")` (`encodings.idna`, IDNA 2003): the ASCII
 * fast path, nameprep with the Unicode 3.2 stringprep tables, and RFC 3492
 * punycode with the `xn--` prefix. Throws where Python raises UnicodeError.
 */
import { B1, B2, D1, D2, NFKC_3_2, PROHIBITED } from "./stringprep-tables.ts";

export class IdnaError extends Error { override name = "UnicodeError"; }

function inRanges(ranges: readonly (readonly [number, number])[], code: number): boolean {
  let low = 0, high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1, [start, end] = ranges[middle]!;
    if (code < start) high = middle - 1; else if (code > end) low = middle + 1; else return true;
  }
  return false;
}

const isAscii = (text: string): boolean => /^[\x00-\x7f]*$/.test(text);

/** NFKC as of Unicode 3.2: characters whose form changed since are taken one by one. */
function nfkc32(text: string): string {
  let out = "", run = "";
  for (const char of text) {
    const old = NFKC_3_2.get(char.codePointAt(0)!);
    if (old === undefined) { run += char; continue; }
    out += run.normalize("NFKC") + old; run = "";
  }
  return out + run.normalize("NFKC");
}

function nameprep(label: string): string {
  let mapped = "";
  for (const char of label) {
    const code = char.codePointAt(0)!;
    if (inRanges(B1, code)) continue;
    mapped += B2.get(code) ?? char;
  }
  const prepared = nfkc32(mapped);
  const codes = Array.from(prepared, (char) => char.codePointAt(0)!);
  for (const code of codes) if (inRanges(PROHIBITED, code)) throw new IdnaError("Invalid character");
  const randal = codes.map((code) => inRanges(D1, code));
  if (randal.some(Boolean)) {
    if (codes.some((code) => inRanges(D2, code))) throw new IdnaError("Violation of BIDI requirement 2");
    if (!randal[0] || !randal[randal.length - 1]) throw new IdnaError("Violation of BIDI requirement 3");
  }
  return prepared;
}

/** RFC 3492 encoding (Python's `punycode` codec). */
export function punycode(text: string): string {
  const codes = Array.from(text, (char) => char.codePointAt(0)!);
  const base = codes.filter((code) => code < 0x80);
  let output = String.fromCharCode(...base);
  let handled = base.length;
  if (handled) output += "-";
  const digit = (d: number): string => String.fromCharCode(d < 26 ? 97 + d : 22 + d);
  const adapt = (delta: number, points: number, first: boolean): number => {
    delta = first ? Math.floor(delta / 700) : delta >> 1;
    delta += Math.floor(delta / points);
    let k = 0;
    while (delta > 455) { delta = Math.floor(delta / 35); k += 36; }
    return k + Math.floor((36 * delta) / (delta + 38));
  };
  let n = 0x80, delta = 0, bias = 72;
  const b = handled;
  while (handled < codes.length) {
    const m = Math.min(...codes.filter((code) => code >= n));
    delta += (m - n) * (handled + 1);
    n = m;
    for (const code of codes) {
      if (code < n) delta += 1;
      if (code !== n) continue;
      let q = delta;
      for (let k = 36; ; k += 36) {
        const t = k <= bias ? 1 : k >= bias + 26 ? 26 : k - bias;
        if (q < t) break;
        output += digit(t + ((q - t) % (36 - t)));
        q = Math.floor((q - t) / (36 - t));
      }
      output += digit(q);
      bias = adapt(delta, handled + 1, handled === b);
      delta = 0; handled += 1;
    }
    delta += 1; n += 1;
  }
  return output;
}

function toAscii(label: string): string {
  if (isAscii(label)) { if (label.length > 0 && label.length < 64) return label; throw new IdnaError("label empty or too long"); }
  const prepared = nameprep(label);
  if (isAscii(prepared)) { if (prepared.length > 0 && prepared.length < 64) return prepared; throw new IdnaError("label empty or too long"); }
  if (prepared.startsWith("xn--")) throw new IdnaError("Label starts with ACE prefix");
  const encoded = "xn--" + punycode(prepared);
  if (encoded.length > 0 && encoded.length < 64) return encoded;
  throw new IdnaError("label empty or too long");
}

/** `host.encode("idna").decode("ascii")`. */
export function idnaEncode(host: string): string {
  if (!host) return "";
  if (isAscii(host)) {
    const labels = host.split(".");
    for (const label of labels.slice(0, -1)) if (!(label.length > 0 && label.length < 64)) throw new IdnaError("label empty or too long");
    if (labels[labels.length - 1]!.length >= 64) throw new IdnaError("label too long");
    return host;
  }
  const labels = host.split(/[.\u3002\uff0e\uff61]/);
  let trailing = "";
  if (labels.length && !labels[labels.length - 1]) { trailing = "."; labels.pop(); }
  return labels.map(toAscii).join(".") + trailing;
}
