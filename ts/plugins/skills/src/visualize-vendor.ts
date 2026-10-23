/**
 * `scripts/vendor.py` of the bundled visualize skill: a `<script>` whose `src`
 * is a pinned vendor URL (`assets/vendor/manifest.json`) gets the bundled file
 * as a `data:` URL, so a rendered visualization makes no network request.
 *
 * The scan follows Python 3.11's `html.parser.HTMLParser` (the HTML5 rework,
 * `convert_charrefs=False`, fed once and never closed): comments, declarations
 * and processing instructions are skipped, raw-text elements end only at their
 * end tag, and an unfinished construct or an invalid `&#` reference ends the
 * scan. Only start tag text is rewritten: attributes keep their order with
 * lowercased names and values unescaped, then escaped again. Named references
 * other than amp, lt, gt, quot, apos and nbsp stay as written.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const LOCATE_TAG_END = /[a-zA-Z][^\t\n\r\f />]*[\t\n\r\f /]*(?:(?<=['"\t\n\r\f /])[^\t\n\r\f />][^\t\n\r\f /=>]*(?:[\t\n\r\f ]*=[\t\n\r\f ]*(?:'[^']*'|"[^"]*"|(?!['"])[^>\t\n\r\f ]*))?[\t\n\r\f /]*)*>?/y;
const TAG_FIND = /([a-zA-Z][^\t\n\r\f />]*)(?:[\t\n\r\f ]|\/(?!>))*/y;
const ATTR_FIND = /((?<=['"\t\n\r\f /])[^\t\n\r\f />][^\t\n\r\f /=>]*)([\t\n\r\f ]*=[\t\n\r\f ]*('[^']*'|"[^"]*"|(?!['"])[^>\t\n\r\f ]*))?(?:[\t\n\r\f ]|\/(?!>))*/y;
const CHARREF = /&#(?:[0-9]+|[xX][0-9a-fA-F]+)[^0-9a-fA-F]/y;
const ENTITYREF = /&[a-zA-Z][-.a-zA-Z0-9]*[^a-zA-Z0-9]/y;
const INCOMPLETE = /&[a-zA-Z#]/y;
const COMMENT_CLOSE = /--!?>/g;
const COMMENT_ABRUPT_CLOSE = /-?>/y;
const RAW_TEXT = new Set(["script", "style", "xmp", "iframe", "noembed", "noframes", "plaintext"]);
const ESCAPABLE_RAW_TEXT = new Set(["textarea", "title"]);
const LETTER = /[a-zA-Z]/;

export interface ScriptStartTag {
  start: number;
  end: number;
  attrs: Array<[string, string | null]>;
  /** The tag text ends with `/>` (kept on the rewritten tag). */
  selfClosing: boolean;
}

const at = (pattern: RegExp, text: string, index: number): RegExpExecArray | null => { pattern.lastIndex = index; return pattern.exec(text); };
const after = (match: RegExpExecArray): number => match.index + match[0].length;

/** Python `html.unescape`: numeric references per HTML5, a few named ones. */
const CHARREF_ANY = /&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/g;
const NAMED: Record<string, string> = { "amp;": "&", amp: "&", "lt;": "<", lt: "<", "gt;": ">", gt: ">", "quot;": "\"", quot: "\"", "apos;": "'", "nbsp;": "\u00a0", nbsp: "\u00a0" };
const WINDOWS_1252 = new TextDecoder("windows-1252");
function numericReference(num: number): string {
  if (num === 0) return "\ufffd";
  if (num === 0x0d) return "\r";
  if (num >= 0x80 && num <= 0x9f) return WINDOWS_1252.decode(Uint8Array.of(num));
  if ((num >= 0xd800 && num <= 0xdfff) || num > 0x10ffff) return "\ufffd";
  if ((num >= 0x1 && num <= 0x8) || num === 0xb || (num >= 0xe && num <= 0x1f) || num === 0x7f || (num >= 0xfdd0 && num <= 0xfdef) || (num & 0xfffe) === 0xfffe) return "";
  return String.fromCodePoint(num);
}
export function unescapeHtml(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(CHARREF_ANY, (_whole, reference: string) => {
    if (reference[0] === "#") {
      const hex = reference[1] === "x" || reference[1] === "X";
      return numericReference(Number.parseInt(reference.slice(hex ? 2 : 1).replace(/;$/, ""), hex ? 16 : 10));
    }
    if (Object.hasOwn(NAMED, reference)) return NAMED[reference]!;
    for (let length = reference.length - 1; length > 1; length--) {
      const prefix = reference.slice(0, length);
      if (Object.hasOwn(NAMED, prefix)) return NAMED[prefix]! + reference.slice(length);
    }
    return "&" + reference;
  });
}

/** Python `html.escape(text, quote=True)`. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
}

type StartTag = { end: number; tag: string; attrs: Array<[string, string | null]>; kind: "start" | "startend" | "data" };
function parseStartTag(html: string, i: number): StartTag | null {
  const endpos = after(at(LOCATE_TAG_END, html, i + 1)!);
  if (html[endpos - 1] !== ">") return null;
  const name = at(TAG_FIND, html, i + 1)!;
  let k = after(name);
  const tag = name[1]!.toLowerCase(), attrs: Array<[string, string | null]> = [];
  while (k < endpos) {
    const match = at(ATTR_FIND, html, k);
    if (!match) break;
    let value: string | null = match[2] ? match[3]! : null;
    if (value && (value[0] === "'" || value[0] === "\"") && value.at(-1) === value[0]) value = value.slice(1, -1);
    if (value) value = unescapeHtml(value);
    attrs.push([match[1]!.toLowerCase(), value]);
    k = after(match);
  }
  const rest = html.slice(k, endpos).trim();
  return { end: endpos, tag, attrs, kind: rest === ">" ? "start" : rest === "/>" ? "startend" : "data" };
}
const bogusComment = (html: string, i: number): number => { const close = html.indexOf(">", i + 2); return close < 0 ? -1 : close + 1; };
function parseEndTag(html: string, i: number): number {
  if (html.indexOf(">", i + 2) < 0) return -1;
  if (!LETTER.test(html[i + 2] ?? "")) return html[i + 2] === ">" ? i + 3 : bogusComment(html, i);
  const end = after(at(LOCATE_TAG_END, html, i + 2)!);
  return html[end - 1] === ">" ? end : -1;
}
function parseComment(html: string, i: number): number {
  const close = at(COMMENT_CLOSE, html, i + 4) ?? at(COMMENT_ABRUPT_CLOSE, html, i + 4);
  return close ? after(close) : -1;
}
function parseDeclaration(html: string, i: number): number {
  if (html.startsWith("<!--", i)) return parseComment(html, i);
  if (html.startsWith("<![CDATA[", i)) { const close = html.indexOf("]]>", i + 9); return close < 0 ? -1 : close + 3; }
  if (html.slice(i, i + 9).toLowerCase() === "<!doctype") { const close = html.indexOf(">", i + 9); return close < 0 ? -1 : close + 1; }
  if (html.startsWith("<![", i)) { const close = html.indexOf(">", i + 3); return close < 0 ? -1 : close + 1; }
  return bogusComment(html, i);
}

/** The `script` start tags `HTMLParser.handle_starttag` reports, in order. */
export function scriptStartTags(html: string): ScriptStartTag[] {
  const found: ScriptStartTag[] = [];
  const n = html.length;
  let i = 0, raw: { elem: string; escapable: boolean } | null = null;
  while (i < n) {
    if (raw?.elem === "plaintext") break;
    const interesting = raw ? new RegExp(`${raw.escapable ? "&|" : ""}</${raw.elem}(?=[\\t\\n\\r\\f />])`, "gi") : /[&<]/g;
    const next = at(interesting, html, i);
    if (!next && raw) break;
    i = next ? next.index : n;
    if (i === n) break;
    if (html[i] === "<") {
      let k: number;
      if (LETTER.test(html[i + 1] ?? "")) {
        const tag = parseStartTag(html, i);
        if (!tag) break;
        if (tag.kind !== "data" && tag.tag === "script") found.push({ start: i, end: tag.end, attrs: tag.attrs, selfClosing: html.slice(i, tag.end).endsWith("/>") });
        if (tag.kind === "start" && RAW_TEXT.has(tag.tag)) raw = { elem: tag.tag, escapable: false };
        else if (tag.kind === "start" && ESCAPABLE_RAW_TEXT.has(tag.tag)) raw = { elem: tag.tag, escapable: true };
        k = tag.end;
      } else if (html.startsWith("</", i)) {
        k = parseEndTag(html, i);
        if (k >= 0 && LETTER.test(html[i + 2] ?? "")) raw = null;
      } else if (html.startsWith("<!--", i)) k = parseComment(html, i);
      else if (html.startsWith("<?", i)) { const close = html.indexOf(">", i + 2); k = close < 0 ? -1 : close + 1; }
      else if (html.startsWith("<!", i)) k = parseDeclaration(html, i);
      else if (i + 1 < n) k = i + 1;
      else break;
      if (k < 0) break;
      i = k;
    } else if (html.startsWith("&#", i)) {
      const reference = at(CHARREF, html, i);
      if (!reference) break;
      i = html[after(reference) - 1] === ";" ? after(reference) : after(reference) - 1;
    } else {
      const reference = at(ENTITYREF, html, i);
      if (reference) { i = html[after(reference) - 1] === ";" ? after(reference) : after(reference) - 1; continue; }
      if (at(INCOMPLETE, html, i) || i + 1 >= n) break;
      i += 1;
    }
  }
  return found;
}

interface VendorResource { url: string; file: string; sha256: string }
const DATA_URLS = new Map<string, string>();
function dataUrl(vendorDir: string, entry: VendorResource): string {
  if (typeof entry.file !== "string" || !/^[a-z0-9][a-z0-9.-]*\.js$/.test(entry.file)) throw new Error("invalid bundled resource path");
  const path = join(vendorDir, entry.file), key = `${path}\0${entry.sha256}`;
  const cached = DATA_URLS.get(key);
  if (cached) return cached;
  const contents = readFileSync(path);
  if (createHash("sha256").update(contents).digest("hex") !== entry.sha256) throw new Error(`bundled resource hash mismatch: ${entry.file}`);
  const url = "data:text/javascript;base64," + contents.toString("base64");
  DATA_URLS.set(key, url);
  return url;
}

/** `embed_vendor_scripts`: the HTML with every pinned vendor script inlined. */
export function embedVendorScripts(html: string, vendorDir: string): string {
  const manifest = JSON.parse(readFileSync(join(vendorDir, "manifest.json"), "utf8")) as { resources: VendorResource[] };
  const resources = new Map(manifest.resources.map((entry) => [entry.url, entry]));
  if (resources.size !== manifest.resources.length) throw new Error("duplicate bundled resource URL");
  const parts: string[] = [];
  let previous = 0;
  for (const tag of scriptStartTags(html)) {
    const src = tag.attrs.find(([name]) => name === "src")?.[1] ?? null;
    const entry = src === null ? undefined : resources.get(src);
    if (!entry) continue;
    const inline = dataUrl(vendorDir, entry);
    const attributes = tag.attrs.map(([name, value]) => value === null ? name : `${name}="${escapeHtml(name === "src" ? inline : value)}"`).join(" ");
    parts.push(html.slice(previous, tag.start), `<script ${attributes}${tag.selfClosing ? "/>" : ">"}`);
    previous = tag.end;
  }
  parts.push(html.slice(previous));
  return parts.join("");
}
