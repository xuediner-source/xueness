/**
 * `_safe_zip`, `_read_office`, `_build_document` and `delivery_content_text`:
 * the Office plugin's bounded read model and authoring entry point.
 */
import { pyLen, pySlice } from "@xueness/contracts";
import { documentObject, FORMATS, MAX_TEXT_CHARS, WORD_STYLES, type OfficeFormat } from "./document.ts";
import { makeDocx } from "./ooxml-write.ts";
import { MAX_DOCUMENT_CHARS, readPdf } from "./pdf-read.ts";
import { makePdf } from "./pdf-write.ts";
import { previewBytes } from "./preview.ts";
import type { Row } from "./preview-common.ts";
import { makePptx } from "./write-pptx.ts";
import { makeXlsx } from "./write-xlsx.ts";
import { BadZipFile, ZipArchive } from "./zip.ts";

export const MAX_FILE_BYTES = 8_000_000;
const MAX_ARCHIVE_ENTRIES = 1200, MAX_ARCHIVE_UNCOMPRESSED = 32_000_000, MAX_XML_PART_BYTES = 4_000_000;
const MAX_SLIDES = 100, MAX_SHEETS = 20, MAX_ROWS = 500, MAX_COLUMNS = 200;

export function safeZip(data: Buffer): void {
  try {
    const archive = new ZipArchive(data);
    if (archive.entries.length > MAX_ARCHIVE_ENTRIES) throw new RangeError("Office archive exceeds the entry limit");
    const seen = new Set<string>();
    let total = 0, actualTotal = 0;
    for (const info of archive.entries) {
      const name = info.name.replace(/\\/g, "/"), parts = name.replace(/\/+$/, "").split("/");
      if (!name || name.startsWith("/") || parts.some((part) => part === "" || part === "." || part === "..") || seen.has(name) || info.flags & 1) throw new RangeError("Office archive contains an unsafe member");
      seen.add(name);
      total += info.size;
      if (total > MAX_ARCHIVE_UNCOMPRESSED) throw new RangeError("Office archive exceeds the decompressed size limit");
      const xml = /\.(xml|rels)$/i.test(name);
      if (xml && info.size > MAX_XML_PART_BYTES) throw new RangeError("Office XML part exceeds the read limit");
      if (info.isDir) continue;
      const archiveRoom = MAX_ARCHIVE_UNCOMPRESSED - actualTotal, limit = xml ? Math.min(archiveRoom, MAX_XML_PART_BYTES) : archiveRoom;
      let body: Buffer;
      try { body = archive.read(info, limit); } catch (error) {
        if (error instanceof BadZipFile && error.message === "member exceeds the size limit") throw new RangeError(limit === archiveRoom ? "Office archive exceeds the decompressed size limit" : "Office XML part exceeds the read limit");
        throw error;
      }
      actualTotal += body.length;
    }
  } catch (error) {
    if (error instanceof RangeError) throw new Error(error.message);
    throw new Error("invalid Office archive");
  }
}

type Section = Row & { blocks?: Row[]; name?: string };

export function readOffice(data: Buffer, format: Exclude<OfficeFormat, "pdf">): { document: Row; truncated: boolean } {
  safeZip(data);
  const preview = previewBytes(data, `.${format}`), sections = (preview.sections ?? []) as Section[];
  let truncated = Boolean(preview.truncated || preview.imageCount);
  const clip = (value: unknown, limit = MAX_TEXT_CHARS): string => { const text = String(value); if (pyLen(text) > limit) truncated = true; return pySlice(text, limit); };
  if (format === "docx") {
    const paragraphs: Row[] = [], tables: Row[] = [];
    if (sections.length > 1) truncated = true;
    for (const section of sections.slice(0, 1)) for (const block of section.blocks ?? []) {
      if (block.type === "table") {
        const raw = (block.table ?? []) as unknown[][];
        if (raw.length > 200 || raw.slice(0, 200).some((row) => row.length > 50)) truncated = true;
        tables.push({ rows: raw.slice(0, 200).map((row) => row.slice(0, 50).map((cell) => clip(cell))) });
      } else if (block.type === "paragraph") {
        const row: Row = { text: clip(block.text ?? "") };
        const style = (block.style as Row | undefined)?.paragraphStyle;
        if (typeof style === "string" && WORD_STYLES.has(style)) row.style = style;
        paragraphs.push(row);
      }
    }
    return { document: { paragraphs, tables }, truncated };
  }
  if (format === "pptx") {
    if (sections.length > MAX_SLIDES) truncated = true;
    const slides = sections.slice(0, MAX_SLIDES).map((section) => {
      const blocks = (section.blocks ?? []).filter((block) => block.text);
      const texts = blocks.map((block) => clip(block.text ?? ""));
      const index = blocks.findIndex((block) => Math.trunc(Number((block.position as Row | undefined)?.y ?? 2_000_000)) < 1_000_000);
      const slide: Row = { paragraphs: texts.filter((_text, i) => i !== index) };
      if (index >= 0) slide.title = texts[index];
      return slide;
    });
    return { document: { slides }, truncated };
  }
  if (sections.length > MAX_SHEETS) truncated = true;
  const sheets: Row[] = [];
  for (const section of sections.slice(0, MAX_SHEETS)) {
    const block = (section.blocks ?? []).find((item) => item.type === "table");
    if (!block) continue;
    const raw = (block.table ?? []) as unknown[][];
    if (raw.length > MAX_ROWS || raw.slice(0, MAX_ROWS).some((row) => row.length > MAX_COLUMNS)) truncated = true;
    sheets.push({ name: clip(section.name ?? "Sheet", 31), rows: raw.slice(0, MAX_ROWS).map((row) => row.slice(0, MAX_COLUMNS).map((value) => clip(value))) });
  }
  return { document: { sheets }, truncated };
}

export function readDocument(data: Buffer, format: OfficeFormat): { document: Row; truncated: boolean } {
  if (format === "pdf") { const result = readPdf(data); return { document: result.document as unknown as Row, truncated: result.truncated }; }
  return readOffice(data, format);
}

export function buildDocument(format: OfficeFormat, document: unknown): Buffer {
  const checked = documentObject(document, format);
  const data = checked.format === "docx" ? makeDocx(checked.document) : checked.format === "pptx" ? makePptx(checked.document)
    : checked.format === "xlsx" ? makeXlsx(checked.document) : makePdf(checked.document);
  if (!data.length || data.length > MAX_FILE_BYTES) throw new Error("generated document exceeds the 8 MB file limit");
  return data;
}

/** Visible text only, failing closed on any truncation (the delivery content check). */
export function deliveryContentText(data: Buffer, suffix: string): string {
  if (!Buffer.isBuffer(data) || data.length > MAX_FILE_BYTES) throw new Error("Office file exceeds the bounded read limit");
  const format = suffix.toLowerCase().replace(/^\.+/, "");
  if (!(FORMATS as readonly string[]).includes(format)) throw new Error("unsupported Office format");
  const { document, truncated } = readDocument(data, format as OfficeFormat);
  if (truncated) throw new Error("Office content is truncated and cannot be checked");
  const visible: string[] = [];
  let size = 0;
  const add = (value: unknown): void => {
    if (typeof value !== "string") throw new Error("invalid parsed Office text");
    if (!value) return;
    const next = size + pyLen(value) + (visible.length ? 1 : 0);
    if (next > MAX_DOCUMENT_CHARS) throw new Error("Office content exceeds the bounded text limit");
    visible.push(value); size = next;
  };
  const list = (value: unknown): Row[] => (Array.isArray(value) ? value : []) as Row[];
  if (format === "docx") {
    for (const paragraph of list(document.paragraphs)) add(paragraph.text);
    for (const table of list(document.tables)) for (const row of list(table.rows) as unknown as unknown[][]) for (const cell of row) add(cell);
  } else if (format === "pptx") {
    for (const slide of list(document.slides)) { if (slide.title !== undefined && slide.title !== null) add(slide.title); for (const paragraph of list(slide.paragraphs) as unknown[]) add(paragraph); }
  } else if (format === "xlsx") {
    for (const sheet of list(document.sheets)) for (const row of list(sheet.rows) as unknown as unknown[][]) for (const cell of row) add(cell);
  } else for (const page of list(document.pages)) add(page.text);
  return visible.join("\n");
}
