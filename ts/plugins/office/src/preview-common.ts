/** Shared pieces of Python `office_preview.py`: namespaces, relationships, images, bounded text. */
import { pyLen, pySlice } from "@xueness/contracts";
import { parseXml, type XmlElement } from "./xml.ts";
import type { ZipArchive } from "./zip.ts";

export type Row = Record<string, unknown>;
export const NS = Object.freeze({
  w: "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  s: "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  p: "http://schemas.openxmlformats.org/presentationml/2006/main",
  r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
});
export const W_VAL = `{${NS.w}}val`;
export const R_EMBED = `{${NS.r}}embed`;
const IMAGE_MIMES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
export const MAX_IMAGE_COUNT = 16;
const MAX_IMAGE_BYTES = 256_000;
const MAX_IMAGE_TOTAL = 1_000_000;

export interface Truncation { value: boolean }
export interface ImageBudget { images: Row[]; bytes: number; truncated: boolean }

/** `_xml_bytes`: refuse DTDs and entity declarations before parsing. */
export function xmlBytes(raw: Buffer): Buffer {
  const markup = Buffer.from(raw.filter((byte) => byte !== 0)).toString("latin1").toUpperCase();
  if (markup.includes("<!DOCTYPE") || markup.includes("<!ENTITY")) throw new Error("XML entities are not supported");
  return raw;
}

export function boundedText(text: string, truncation: Truncation, limit = 8000): string {
  if (pyLen(text) > limit) truncation.value = true;
  return pySlice(text, limit);
}

/** `posixpath.normpath`. */
export function normpath(path: string): string {
  if (!path) return ".";
  const initial = path.startsWith("//") && !path.startsWith("///") ? 2 : path.startsWith("/") ? 1 : 0;
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part !== ".." || !initial && !parts.length || parts.at(-1) === "..") parts.push(part);
    else if (parts.length) parts.pop();
  }
  return "/".repeat(initial) + parts.join("/") || ".";
}
/** `posixpath.dirname`. */
export function dirname(path: string): string {
  const head = path.slice(0, path.lastIndexOf("/") + 1);
  return head && !/^\/+$/.test(head) ? head.replace(/\/+$/, "") : head;
}
/** `posixpath.join(a, b)` for two parts. */
function join(base: string, target: string): string {
  if (target.startsWith("/") || !base) return target;
  return base.endsWith("/") ? base + target : `${base}/${target}`;
}

/** `Path(name).suffix.lower()`. */
export function suffixOf(name: string): string {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const index = base.lastIndexOf(".");
  return index > 0 && index < base.length - 1 ? base.slice(index).toLowerCase() : "";
}

export class Package {
  private readonly names: Set<string>;
  readonly archive: ZipArchive;
  constructor(archive: ZipArchive) { this.archive = archive; this.names = new Set(archive.names()); }
  has(name: string): boolean { return this.names.has(name); }
  /** `xml(name)`: one bounded XML part. */
  xml(name: string): XmlElement {
    const info = this.archive.get(name);
    if (info.size > 4_000_000) throw new Error("Office XML exceeds preview budget");
    return parseXml(xmlBytes(this.archive.read(info, info.size)));
  }
  /** `_relationship_targets`: internal, package-local targets only. */
  relationships(relsName: string, ownerName: string): Record<string, string> {
    if (!this.has(relsName)) return {};
    const root = parseXml(xmlBytes(this.archive.read(this.archive.get(relsName))));
    const base = dirname(ownerName), result: Record<string, string> = {};
    for (const rel of root.children) {
      const rid = rel.attrib.Id, rawTarget = rel.attrib.Target ?? "";
      if (!rid || !rawTarget || rel.attrib.TargetMode === "External") continue;
      const target = rawTarget.replace(/\\/g, "/");
      const resolved = target.startsWith("/") ? target.replace(/^\/+/, "") : normpath(join(base, target));
      if (resolved.startsWith("../") || resolved === ".." || resolved.startsWith("/")) continue;
      result[rid] = resolved;
    }
    return result;
  }
  /** `_image_data`: one validated embedded image within the budget. */
  image(target: string | undefined, budget: ImageBudget): Row | null {
    if (!target || budget.images.length >= MAX_IMAGE_COUNT) return null;
    const mime = IMAGE_MIMES[suffixOf(target)];
    if (!mime || !this.has(target)) return null;
    const info = this.archive.get(target);
    if (info.size <= 0 || info.size > MAX_IMAGE_BYTES || budget.bytes + info.size > MAX_IMAGE_TOTAL) { budget.truncated = true; return null; }
    const data = this.archive.read(info, info.size);
    const starts = (signature: string): boolean => data.subarray(0, signature.length).equals(Buffer.from(signature, "latin1"));
    const valid = mime === "image/png" ? starts("\x89PNG\r\n\x1a\n") : mime === "image/jpeg" ? starts("\xff\xd8\xff")
      : mime === "image/gif" ? starts("GIF87a") || starts("GIF89a") : starts("RIFF") && data.subarray(8, 12).toString("latin1") === "WEBP";
    if (!valid) return null;
    budget.bytes += data.length;
    const record = { mime, dataUrl: `data:${mime};base64,${data.toString("base64")}`, alt: "" };
    budget.images.push(record);
    return record;
  }
}

/** `str.isdigit()` as far as Office attributes go (decimal digits). */
export const isDigits = (value: string | undefined): value is string => !!value && /^\p{Nd}+$/u.test(value);
export const HEX6 = /^[0-9A-Fa-f]{6}$/;
