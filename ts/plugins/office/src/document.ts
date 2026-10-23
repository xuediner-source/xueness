/** `_document_object`: Python's structured document validation, limits and messages. */
import { isPyFloatValue, isPyIntValue, JsonFloat, pyCasefold, pyLen, pyStrip } from "@xueness/contracts";
import type { DocxDocument } from "./ooxml-write.ts";
import type { PdfStyle } from "./pdf-write.ts";
import type { PptxDocument } from "./write-pptx.ts";
import type { XlsxCell, XlsxDocument } from "./write-xlsx.ts";

export const FORMATS = ["docx", "pptx", "xlsx", "pdf"] as const;
export type OfficeFormat = typeof FORMATS[number];
export const MAX_TEXT_CHARS = 8000;
const MAX_DOCUMENT_CHARS = 400_000, MAX_SLIDES = 100, MAX_SHEETS = 20, MAX_ROWS = 500, MAX_COLUMNS = 200, MAX_XLSX_CELLS = 100_000;
export const WORD_STYLES = new Set(["Normal", "Title", "Subtitle", "Heading 1", "Heading 2", "Heading 3", "Heading 4", "Heading 5", "Heading 6", "List Bullet", "List Number"]);

export type CheckedDocument =
  | { format: "docx"; document: DocxDocument } | { format: "pptx"; document: PptxDocument }
  | { format: "xlsx"; document: XlsxDocument } | { format: "pdf"; document: { title: string; paragraphs: Array<{ text: string; style: PdfStyle }> } };

type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof JsonFloat);
const get = (item: Obj, key: string, fallback: unknown): unknown => Object.hasOwn(item, key) ? item[key] : fallback;
const fail = (message: string): never => { throw new Error(message); };

function onlyKeys(item: unknown, allowed: string[], field: string): asserts item is Obj {
  if (!isObject(item) || Object.keys(item).some((key) => !allowed.includes(key))) fail(`invalid ${field} fields`);
}

class Budget {
  used = 0;
  text(value: unknown, field: string): string {
    if (typeof value !== "string" || value.includes("\0") || pyLen(value) > MAX_TEXT_CHARS) fail(`${field} must be text of at most ${MAX_TEXT_CHARS} characters`);
    this.used += pyLen(value as string);
    if (this.used > MAX_DOCUMENT_CHARS) fail("document text exceeds the 400000 character limit");
    return value as string;
  }
}

function docx(document: Obj, title: string, budget: Budget): DocxDocument {
  onlyKeys(document, ["title", "paragraphs", "tables"], "DOCX document");
  const paragraphs = get(document, "paragraphs", []), tables = get(document, "tables", []);
  if (!Array.isArray(paragraphs) || paragraphs.length > 500) fail("DOCX paragraphs must be a list of at most 500 items");
  if (!Array.isArray(tables) || tables.length > 100) fail("DOCX tables must be a list of at most 100 items");
  const checkedParagraphs = (paragraphs as unknown[]).map((item) => {
    onlyKeys(item, ["text", "style", "bold", "italic"], "paragraph");
    const text = budget.text(get(item, "text", null), "paragraph text"), style = get(item, "style", "Normal");
    if (typeof style !== "string" || !WORD_STYLES.has(style)) fail("unsupported DOCX paragraph style");
    const bold = get(item, "bold", false), italic = get(item, "italic", false);
    if (typeof bold !== "boolean" || typeof italic !== "boolean") fail("paragraph bold and italic values must be boolean");
    return { text, style: style as string, bold: bold as boolean, italic: italic as boolean };
  });
  const checkedTables = (tables as unknown[]).map((table) => {
    onlyKeys(table, ["rows"], "table");
    const rows = get(table, "rows", null);
    if (!Array.isArray(rows) || !rows.length || rows.length > 200) fail("a DOCX table needs 1 to 200 rows");
    let width = 0;
    const checkedRows = (rows as unknown[]).map((row) => {
      if (!Array.isArray(row) || row.length > 50) fail("DOCX table rows must have at most 50 cells");
      width = Math.max(width, (row as unknown[]).length);
      return (row as unknown[]).map((value) => budget.text(value, "table cell"));
    });
    if (!width) fail("DOCX table rows must contain cells");
    return { rows: checkedRows };
  });
  if (!title && !checkedParagraphs.length && !checkedTables.length) fail("DOCX document needs a title, paragraph or table");
  return { title, paragraphs: checkedParagraphs, tables: checkedTables };
}

function pptx(document: Obj, title: string, budget: Budget): PptxDocument {
  onlyKeys(document, ["title", "slides"], "PPTX document");
  const slides = get(document, "slides", null);
  if (!Array.isArray(slides) || slides.length < 1 || slides.length > MAX_SLIDES) fail("PPTX document needs 1 to 100 slides");
  return { title, slides: (slides as unknown[]).map((slide) => {
    onlyKeys(slide, ["title", "paragraphs", "bullets"], "slide");
    const slideTitle = budget.text(get(slide, "title", ""), "slide title");
    if (pyLen(slideTitle) > 60) fail("slide titles are limited to 60 characters");
    const paragraphs = get(slide, "paragraphs", []), bullets = get(slide, "bullets", []);
    if (!Array.isArray(paragraphs) || paragraphs.length > 100 || !Array.isArray(bullets) || bullets.length > 100) fail("slide paragraphs and bullets must each have at most 100 items");
    if ((paragraphs as unknown[]).length + (bullets as unknown[]).length > 20) fail("a slide can have at most 20 paragraphs and bullets");
    const checkedParagraphs = (paragraphs as unknown[]).map((value) => budget.text(value, "slide paragraph"));
    const checkedBullets = (bullets as unknown[]).map((value) => budget.text(value, "slide bullet"));
    const all = [...checkedParagraphs, ...checkedBullets];
    if (all.some((value) => pyLen(value) > 400)) fail("slide paragraphs and bullets are limited to 400 characters each");
    if (all.reduce((sum, value) => sum + Math.max(1, Math.ceil(pyLen(value) / 50)), 0) > 18) fail("slide content exceeds the bounded text layout");
    return { title: slideTitle, paragraphs: checkedParagraphs, bullets: checkedBullets };
  }) };
}

function xlsx(document: Obj, title: string, budget: Budget): XlsxDocument {
  onlyKeys(document, ["title", "sheets"], "XLSX document");
  const sheets = get(document, "sheets", null);
  if (!Array.isArray(sheets) || sheets.length < 1 || sheets.length > MAX_SHEETS) fail("XLSX document needs 1 to 20 sheets");
  const names = new Set<string>();
  let totalCells = 0;
  return { title, sheets: (sheets as unknown[]).map((sheet) => {
    onlyKeys(sheet, ["name", "rows"], "sheet");
    const name = get(sheet, "name", null);
    if (typeof name !== "string" || !pyStrip(name) || pyLen(name) > 31 || [..."[]:*?/\\"].some((char) => name.includes(char)) || name.startsWith("'") || name.endsWith("'")) fail("invalid worksheet name");
    const folded = pyCasefold(name as string);
    if (names.has(folded)) fail("worksheet names must be unique");
    names.add(folded);
    budget.text(name, "worksheet name");
    const rows = get(sheet, "rows", null);
    if (!Array.isArray(rows) || rows.length > MAX_ROWS) fail("worksheet rows must be a list of at most 500 rows");
    return { name: name as string, rows: (rows as unknown[]).map((row) => {
      if (!Array.isArray(row) || row.length > MAX_COLUMNS) fail("worksheet rows must have at most 200 cells");
      totalCells += (row as unknown[]).length;
      if (totalCells > MAX_XLSX_CELLS) fail("XLSX document exceeds 100000 populated cell slots");
      return (row as unknown[]).map((value): XlsxCell => {
        if (value === null || typeof value === "boolean") return value;
        // Tool arguments are decoded without `lossless`, so `1e16` arrives as an integral JS number.
        // Past 2**53 an integer literal and a float literal are indistinguishable; treat those as floats.
        if (isPyIntValue(value) && !(typeof value === "number" && !Number.isSafeInteger(value))) {
          if ((typeof value === "bigint" ? (value < 0n ? -value : value) : Math.abs(value)) > 999_999_999_999_999) fail("XLSX integers are limited to 15 digits");
          return value;
        }
        if (isPyFloatValue(value) || typeof value === "number") {
          const number = Number(value);
          if (!Number.isFinite(number) || Math.abs(number) > 1e100) fail("XLSX numbers must be finite and within range");
          return value;
        }
        if (typeof value === "string") return budget.text(value, "worksheet cell");
        return fail("XLSX cells must be text, number, boolean or null");
      });
    }) };
  }) };
}

function pdf(document: Obj, title: string, budget: Budget): Extract<CheckedDocument, { format: "pdf" }>["document"] {
  onlyKeys(document, ["title", "paragraphs"], "PDF document");
  const paragraphs = get(document, "paragraphs", []);
  if (!Array.isArray(paragraphs) || paragraphs.length > 500) fail("PDF paragraphs must be a list of at most 500 items");
  const checked = (paragraphs as unknown[]).map((item) => {
    onlyKeys(item, ["text", "style"], "PDF paragraph");
    const text = budget.text(get(item, "text", null), "PDF paragraph"), style = get(item, "style", "body");
    if (style !== "title" && style !== "heading" && style !== "body") fail("PDF style must be title, heading or body");
    return { text, style: style as PdfStyle };
  });
  if (!title && !checked.length) fail("PDF document needs a title or paragraph");
  return { title, paragraphs: checked };
}

export function documentObject(document: unknown, format: OfficeFormat): CheckedDocument {
  if (!isObject(document)) fail("document must be an object");
  const item = document as Obj, budget = new Budget();
  const title = budget.text(get(item, "title", ""), "title");
  if (format === "docx") return { format, document: docx(item, title, budget) };
  if (format === "pptx") return { format, document: pptx(item, title, budget) };
  if (format === "xlsx") return { format, document: xlsx(item, title, budget) };
  return { format, document: pdf(item, title, budget) };
}
