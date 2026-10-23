/**
 * Python `office_preview.preview_bytes(data, suffix, include_full_document=False)`:
 * the bounded, read-only DTO for one in-memory OOXML package. No macro, link
 * or formula runs; DTDs and entities are refused.
 */
import { pyLen, pySlice } from "@xueness/contracts";
import { MAX_IMAGE_COUNT, Package, type ImageBudget, type Row, type Truncation } from "./preview-common.ts";
import { previewSheets } from "./preview-sheets.ts";
import { previewSlides } from "./preview-slides.ts";
import { previewWord } from "./preview-word.ts";
import { ZipArchive } from "./zip.ts";

export const MAX_PREVIEW_BYTES = 8_000_000;

/** Bound before serialization, accounting per leaf (Python's second pass). */
function bound(sections: Row[]): { sections: Row[]; truncated: boolean } {
  let remaining = 400000, truncated = false;
  const bounded: Row[] = [];
  for (const section of sections) {
    if (remaining <= 0) { truncated = true; break; }
    const name = String(section.name);
    if (pyLen(name) > 200) truncated = true;
    const target: Row = { name: pySlice(name, 200), blocks: [] };
    if (section.layout && Object.keys(section.layout as Row).length) target.layout = section.layout;
    remaining -= pyLen(target.name as string) + 100;
    for (const block of section.blocks as Row[]) {
      if (remaining <= 0) { truncated = true; break; }
      const output: Row = {};
      for (const key of ["type", "style", "position"]) if (key in block) output[key] = block[key];
      if ("text" in block) {
        const source = block.text as string, text = pySlice(source, Math.max(0, remaining - 100));
        truncated ||= pyLen(text) < pyLen(source);
        remaining -= pyLen(text) + 100;
        output.text = text;
      }
      if ("runs" in block) {
        const runs: Row[] = [], source = block.runs as Row[];
        if (source.length > 500) truncated = true;
        for (const run of source.slice(0, 500)) {
          if (remaining <= 0) { truncated = true; break; }
          const original = String(run.text ?? ""), text = pySlice(original, Math.max(0, remaining - 20));
          truncated ||= pyLen(text) < pyLen(original);
          remaining -= pyLen(text) + 20;
          runs.push({ text, style: run.style ?? {} });
        }
        output.runs = runs;
      }
      if ("table" in block) {
        const table = block.table as string[][], rows: string[][] = [];
        if (table.length > 200 || table.slice(0, 200).some((row) => row.length > 50)) truncated = true;
        for (const row of table.slice(0, 200)) {
          if (remaining <= 0) { truncated = true; break; }
          const cells: string[] = [];
          for (const cell of row.slice(0, 50)) {
            if (remaining <= 0) { truncated = true; break; }
            const text = pySlice(cell, Math.max(0, remaining - 10));
            truncated ||= pyLen(text) < pyLen(cell);
            cells.push(text);
            remaining -= pyLen(text) + 10;
          }
          rows.push(cells);
        }
        truncated ||= rows.length < table.length;
        output.table = rows;
        if ("cellStyles" in block) output.cellStyles = (block.cellStyles as Row[][]).slice(0, rows.length).map((row, index) => row.slice(0, index < rows.length ? rows[index]!.length : 0));
        if ("columns" in block) output.columns = (block.columns as Row[]).slice(0, 50);
        if ("mergedRanges" in block) output.mergedRanges = (block.mergedRanges as string[]).slice(0, 200);
      }
      if ("images" in block) {
        const images = block.images as Row[];
        if (images.length > MAX_IMAGE_COUNT) truncated = true;
        output.images = images.slice(0, MAX_IMAGE_COUNT);
      }
      (target.blocks as Row[]).push(output);
    }
    bounded.push(target);
  }
  return { sections: bounded, truncated };
}

export function previewBytes(data: Buffer, suffix: string): Row {
  if (data.length > MAX_PREVIEW_BYTES) throw new Error("Office file too large");
  const kind = suffix.toLowerCase();
  const archive = new ZipArchive(data);
  if (archive.entries.length > 2000 || archive.entries.reduce((sum, entry) => sum + entry.size, 0) > 40_000_000) throw new Error("Office archive exceeds preview budget");
  const pkg = new Package(archive), truncation: Truncation = { value: false };
  const budget: ImageBudget = { images: [], bytes: 0, truncated: false };
  let parsed: { sections: Row[]; truncated: boolean };
  if (kind === ".docx") parsed = previewWord(pkg, truncation, budget);
  else if (kind === ".pptx") parsed = previewSlides(pkg, truncation, budget);
  else if (kind === ".xlsx") parsed = previewSheets(pkg, truncation);
  else throw new Error("unsupported Office format");
  const result = bound(parsed.sections);
  const truncated = parsed.truncated || truncation.value || result.truncated || budget.truncated;
  return { kind: kind.slice(1), sections: result.sections, truncated, imageCount: budget.images.length };
}
