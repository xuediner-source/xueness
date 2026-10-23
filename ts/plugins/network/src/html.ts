/**
 * The page text Python's network plugin extracts: CPython 3.11
 * `html.parser.HTMLParser(convert_charrefs=True)` fed once (never closed, so an
 * unfinished tail is dropped), with the plugin's `_Text` handler: every
 * stripped data chunk outside script/style/noscript, joined by newlines.
 * `unescape` is `html.unescape`.
 */
import { pyStrip } from "@xueness/contracts";
import { HTML5, INVALID_CHARREFS, INVALID_CODEPOINTS } from "./html-entities.ts";

/** Python's `int()` refuses decimal strings over 4300 digits (`sys.set_int_max_str_digits`). */
export class IntDigitsError extends Error { override name = "ValueError"; }

const CHARREF = /&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/gu;

function replaceCharref(s: string): string {
  if (s[0] === "#") {
    const hex = s[1] === "x" || s[1] === "X";
    const digits = (hex ? s.slice(2) : s.slice(1)).replace(/;+$/, "");
    if (!hex && digits.length > 4300) throw new IntDigitsError("Exceeds the limit (4300 digits) for integer string conversion");
    const big = BigInt(hex ? "0x" + digits : digits);
    const num = big > 0x110000n ? 0x110000 : Number(big);
    const invalid = INVALID_CHARREFS.get(num);
    if (invalid !== undefined) return invalid;
    if ((num >= 0xd800 && num <= 0xdfff) || num > 0x10ffff) return "\ufffd";
    if (INVALID_CODEPOINTS.has(num)) return "";
    return String.fromCodePoint(num);
  }
  if (Object.hasOwn(HTML5, s)) return HTML5[s]!;
  const points = Array.from(s);
  for (let x = points.length - 1; x > 1; x -= 1) {
    const prefix = points.slice(0, x).join("");
    if (Object.hasOwn(HTML5, prefix)) return HTML5[prefix]! + points.slice(x).join("");
  }
  return "&" + s;
}

/** `html.unescape`. */
export function unescape(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(CHARREF, (_match, group: string) => replaceCharref(group));
}

const STARTTAG_OPEN = /<[a-zA-Z]/y;
const ENDTAG_OPEN = /<\/[a-zA-Z]/y;
const TAGFIND = /([a-zA-Z][^\t\n\r\f />]*)(?:[\t\n\r\f ]|\/(?!>))*/y;
const ATTRFIND = /((?<=['"\t\n\r\f /])[^\t\n\r\f />][^\t\n\r\f /=>]*)([\t\n\r\f ]*=[\t\n\r\f ]*('[^']*'|"[^"]*"|(?!['"])[^>\t\n\r\f ]*))?(?:[\t\n\r\f ]|\/(?!>))*/y;
const LOCATE_TAGEND = /[a-zA-Z][^\t\n\r\f />]*[\t\n\r\f /]*(?:(?<=['"\t\n\r\f /])[^\t\n\r\f />][^\t\n\r\f /=>]*(?:[\t\n\r\f ]*=[\t\n\r\f ]*(?:'[^']*'|"[^"]*"|(?!['"])[^>\t\n\r\f ]*))?[\t\n\r\f /]*)*>?/y;
const COMMENT_CLOSE = /--!?>/g;
const COMMENT_ABRUPT = /-?>/y;
const CDATA = new Set(["script", "style", "xmp", "iframe", "noembed", "noframes"]);
const RCDATA = new Set(["textarea", "title"]);
const HIDDEN = new Set(["script", "style", "noscript"]);

function at(re: RegExp, text: string, index: number): RegExpExecArray | null {
  re.lastIndex = index;
  return re.exec(text);
}

/** UTF-16 index of the code point `count` places before the end (0 when there are fewer). */
function pointsBeforeEnd(text: string, count: number): number {
  let index = text.length;
  for (let seen = 0; seen < count && index > 0; seen += 1) {
    const low = text.charCodeAt(index - 1);
    index -= index > 1 && low >= 0xdc00 && low <= 0xdfff && text.charCodeAt(index - 2) >= 0xd800 && text.charCodeAt(index - 2) <= 0xdbff ? 2 : 1;
  }
  return index;
}

/** `transport._Text().feed(text)` followed by `"\n".join(parser.parts)`. */
export function htmlText(raw: string): string {
  const parts: string[] = [];
  let hidden = 0;
  let cdata: string | null = null, escapable = true, cdataRe: RegExp | null = null;
  const data = (text: string): void => { const stripped = pyStrip(text); if (!hidden && stripped) parts.push(stripped); };
  const start = (tag: string): void => { if (HIDDEN.has(tag)) hidden += 1; };
  const end = (tag: string): void => { if (HIDDEN.has(tag)) hidden = Math.max(0, hidden - 1); };
  const setCdata = (tag: string, canEscape: boolean): void => {
    cdata = tag; escapable = canEscape;
    cdataRe = tag === "plaintext" ? null : new RegExp(`</${tag}(?=[\\t\\n\\r\\f />])`, "gi");
  };
  const bogus = (i: number): number => { const pos = raw.indexOf(">", i + 2); return pos < 0 ? -1 : pos + 1; };
  const startTag = (i: number): number => {
    const located = at(LOCATE_TAGEND, raw, i + 1)!;
    const endpos = located.index + located[0].length;
    if (raw[endpos - 1] !== ">") return -1;
    const found = at(TAGFIND, raw, i + 1)!;
    let k = found.index + found[0].length;
    const tag = found[1]!.toLowerCase();
    while (k < endpos) { const m = at(ATTRFIND, raw, k); if (!m) break; k = m.index + m[0].length; }
    const close = pyStrip(raw.slice(k, endpos));
    if (close !== ">" && close !== "/>") { data(raw.slice(i, endpos)); return endpos; }
    if (close.endsWith("/>")) { start(tag); end(tag); return endpos; }
    start(tag);
    if (CDATA.has(tag) || tag === "plaintext") setCdata(tag, false);
    else if (RCDATA.has(tag)) setCdata(tag, true);
    return endpos;
  };
  const endTag = (i: number): number => {
    if (raw.indexOf(">", i + 2) < 0) return -1;
    if (!at(ENDTAG_OPEN, raw, i)) return raw[i + 2] === ">" ? i + 3 : bogus(i);
    const located = at(LOCATE_TAGEND, raw, i + 2)!;
    const j = located.index + located[0].length;
    if (raw[j - 1] !== ">") return -1;
    end(at(TAGFIND, raw, i + 2)![1]!.toLowerCase());
    cdata = null; escapable = true; cdataRe = null;
    return j;
  };
  const declaration = (i: number): number => {
    if (raw.startsWith("<![CDATA[", i)) { const j = raw.indexOf("]]>", i + 9); return j < 0 ? -1 : j + 3; }
    if (raw.slice(i, i + 9).toLowerCase() === "<!doctype") { const gt = raw.indexOf(">", i + 9); return gt < 0 ? -1 : gt + 1; }
    if (raw.startsWith("<![", i)) { const j = raw.indexOf(">", i + 3); return j < 0 ? -1 : j + 1; }
    return bogus(i);
  };
  const n = raw.length;
  let i = 0;
  while (i < n) {
    let j: number;
    if (cdata === null) {
      j = raw.indexOf("<", i);
      if (j < 0) {
        const last = raw.lastIndexOf("&");
        if (last >= Math.max(i, pointsBeforeEnd(raw, 34)) && !/[\t\n\r\f ;]/.test(raw.slice(last))) break;
        j = n;
      }
    } else if (cdataRe === null) j = n;
    else {
      const re: RegExp = cdataRe; re.lastIndex = i;
      const match = re.exec(raw);
      if (!match) break;
      j = match.index;
    }
    if (i < j) data(escapable ? unescape(raw.slice(i, j)) : raw.slice(i, j));
    i = j;
    if (i === n) break;
    let k: number;
    if (at(STARTTAG_OPEN, raw, i)) k = startTag(i);
    else if (raw.startsWith("</", i)) k = endTag(i);
    else if (raw.startsWith("<!--", i)) {
      COMMENT_CLOSE.lastIndex = i + 4;
      const match = COMMENT_CLOSE.exec(raw) ?? at(COMMENT_ABRUPT, raw, i + 4);
      k = match ? match.index + match[0].length : -1;
    } else if (raw.startsWith("<?", i)) { const gt = raw.indexOf(">", i + 2); k = gt < 0 ? -1 : gt + 1; }
    else if (raw.startsWith("<!", i)) k = declaration(i);
    else if (i + 1 < n) { data("<"); k = i + 1; }
    else break;
    if (k < 0) break;
    i = k;
  }
  return parts.join("\n");
}
