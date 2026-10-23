/** XLSX part of Python `office_preview.preview_bytes`. */
import { pyFloat, pyInt, pyRound } from "@xueness/contracts";
import { find, findall, joinedText, type XmlElement } from "./xml.ts";
import { boundedText, NS, type Package, type Row, type Truncation } from "./preview-common.ts";

const R_ID = `{${NS.r}}id`;
const HEX8 = /^[0-9A-Fa-f]{8}$/;
/** `items[int(text)]` with Python's negative indexes; throws on a bad index like IndexError/ValueError. */
function pick<T>(items: T[], text: string): T {
  const index = pyInt(text), item = items[index < 0 ? items.length + index : index];
  if (item === undefined) throw new Error("IndexError");
  return item;
}

function cellStyles(pkg: Package, mark: () => void): Row[] {
  if (!pkg.has("xl/styles.xml")) return [];
  const root = pkg.xml("xl/styles.xml");
  const fonts = findall(root, "s:fonts/s:font", NS), fills = findall(root, "s:fills/s:fill", NS), xfs = findall(root, "s:cellXfs/s:xf", NS);
  if (xfs.length > 256) mark();
  return xfs.slice(0, 256).map((xf) => {
    const style: Row = {};
    try {
      const font = pick(fonts, xf.attrib.fontId ?? "0");
      if (find(font, "s:b", NS)) style.bold = true;
      if (find(font, "s:i", NS)) style.italic = true;
      const rgb = find(font, "s:color", NS)?.attrib.rgb ?? "";
      if (HEX8.test(rgb)) style.color = "#" + rgb.slice(-6);
      const size = find(font, "s:sz", NS);
      if (size) { try { style.fontSize = Math.min(48, Math.max(6, pyFloat(size.attrib.val ?? "11"))); } catch { /* ValueError */ } }
    } catch { /* IndexError, ValueError */ }
    try {
      const fill = find(pick(fills, xf.attrib.fillId ?? "0"), "s:patternFill/s:fgColor", NS);
      const rgb = fill?.attrib.rgb ?? "";
      if (HEX8.test(rgb)) style.background = "#" + rgb.slice(-6);
    } catch { /* IndexError, ValueError */ }
    const align = find(xf, "s:alignment", NS)?.attrib.horizontal;
    if (align && ["left", "center", "right", "justify"].includes(align)) style.align = align;
    return style;
  });
}

function sheetRows(sheet: XmlElement, shared: string[], styles: Row[], truncation: Truncation, mark: () => void): { rows: string[][]; cellStyles: Row[][] } {
  const rows: string[][] = [], cellStyles: Row[][] = [];
  const allRows = findall(sheet, "s:sheetData/s:row", NS);
  for (const row of allRows.slice(0, 200)) {
    const cells: string[] = new Array(50).fill(""), rowStyles: Row[] = Array.from({ length: 50 }, () => ({}));
    for (const cell of findall(row, "s:c", NS)) {
      const letters = /^[A-Z]+/.exec(cell.attrib.r ?? "");
      if (!letters) continue;
      let index = 0;
      for (const char of letters[0]) index = index * 26 + char.charCodeAt(0) - 64;
      if (index < 1 || index > 50) { mark(); continue; }
      const value = find(cell, "s:v", NS);
      let text = value ? value.text || "" : joinedText(cell, ".//s:t", NS);
      if (cell.attrib.t === "s" && /^\p{Nd}+$/u.test(text)) { const at = pyInt(text); text = at < shared.length ? shared[at]! : ""; }
      const formula = find(cell, "s:f", NS);
      if (!text && formula) text = "=" + (formula.text || "");
      cells[index - 1] = boundedText(text, truncation);
      try { const at = pyInt(cell.attrib.s ?? "0"); if (at >= 0 && at < styles.length) rowStyles[index - 1] = styles[at]!; } catch { /* ValueError */ }
    }
    while (cells.length && !cells.at(-1)) cells.pop();
    rows.push(cells); cellStyles.push(rowStyles.slice(0, cells.length));
  }
  if (allRows.length > 200) mark();
  return { rows, cellStyles };
}

export function previewSheets(pkg: Package, truncation: Truncation): { sections: Row[]; truncated: boolean } {
  let truncated = false;
  const mark = (): void => { truncated = true; };
  const shared = pkg.has("xl/sharedStrings.xml") ? findall(pkg.xml("xl/sharedStrings.xml"), "s:si", NS).map((item) => boundedText(joinedText(item, ".//s:t", NS), truncation)) : [];
  const relationships = pkg.relationships("xl/_rels/workbook.xml.rels", "xl/workbook.xml");
  const styles = cellStyles(pkg, mark);
  const sheets = findall(pkg.xml("xl/workbook.xml"), "s:sheets/s:sheet", NS), sections: Row[] = [];
  for (const sheet of sheets.slice(0, 20)) {
    const name = relationships[sheet.attrib[R_ID] ?? ""] ?? "";
    if (!name) continue;
    const { rows, cellStyles: styled } = sheetRows(pkg.xml(name), shared, styles, truncation, mark);
    const root = pkg.xml(name), columns: Row[] = [];
    const columnItems = findall(root, "s:cols/s:col", NS);
    if (columnItems.length > 50) mark();
    for (const column of columnItems.slice(0, 50)) {
      try {
        const lo = pyInt(column.attrib.min ?? "0"), hi = pyInt(column.attrib.max ?? "0"), width = pyFloat(column.attrib.width ?? "0");
        if (lo >= 1 && lo <= hi && hi <= 50 && width > 0 && width <= 100) columns.push({ min: lo, max: hi, width: pyRound(width, 2), hidden: column.attrib.hidden === "1" });
      } catch { continue; }
    }
    const merges = findall(root, "s:mergeCells/s:mergeCell", NS);
    if (merges.length > 200) mark();
    const merged = merges.slice(0, 200).map((item) => item.attrib.ref ?? "").filter((ref) => /^[A-Z]{1,3}\p{Nd}+:[A-Z]{1,3}\p{Nd}+$/u.test(ref));
    sections.push({ name: sheet.attrib.name ?? "Sheet", blocks: [{ type: "table", table: rows, cellStyles: styled, columns, mergedRanges: merged }] });
  }
  if (sheets.length > 20) mark();
  return { sections, truncated };
}
