/**
 * XLSX writer mirroring `_make_xlsx` through openpyxl: inline strings (never
 * formulas), `%.16g` numbers, `t="b"` booleans, skipped `None` cells, and
 * openpyxl's own refusals for control characters.
 */
import { isPyIntValue, JsonFloat } from "@xueness/contracts";
import { appProperties, contentTypes, coreProperties, CT, escAttr, LXML_ERROR, packageRels, REL, relationships, textElement, xmlIncompatible, XML_DECL } from "./ooxml-write.ts";
import { writeZip } from "./zip.ts";

const S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
export type XlsxCell = string | number | bigint | boolean | JsonFloat | null;
export interface XlsxDocument { title: string; sheets: Array<{ name: string; rows: XlsxCell[][] }> }
const ILLEGAL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;

/** C's `%.16g`, which openpyxl uses for floats. */
export function formatG16(value: number): string {
  if (value === 0) return Object.is(value, -0) ? "-0" : "0";
  const [mantissa, exponentText] = value.toExponential(15).split("e") as [string, string];
  const exponent = Number(exponentText), negative = mantissa.startsWith("-");
  const digits = mantissa.replace("-", "").replace(".", "");
  const strip = (text: string): string => text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
  if (exponent < -4 || exponent >= 16) return `${strip(mantissa)}e${exponent < 0 ? "-" : "+"}${String(Math.abs(exponent)).padStart(2, "0")}`;
  const body = exponent >= 0 ? `${digits.slice(0, exponent + 1)}.${digits.slice(exponent + 1)}` : `0.${"0".repeat(-exponent - 1)}${digits}`;
  return `${negative ? "-" : ""}${strip(body)}`;
}

export function columnLetter(index: number): string {
  let out = "";
  for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
  return out;
}

function cellXml(ref: string, value: XlsxCell): string {
  if (typeof value === "string") return `<c r="${ref}" t="inlineStr"><is>${textElement("t", value)}</is></c>`;
  if (typeof value === "boolean") return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
  const text = typeof value === "bigint" ? value.toString() : isPyIntValue(value) ? String(value) : formatG16(Number(value));
  return `<c r="${ref}" t="n"><v>${text}</v></c>`;
}

function sheetXml(rows: XlsxCell[][]): string {
  // openpyxl writes a <row> for every row that got a cell (even None) and sizes the dimension from them.
  const width = Math.max(1, ...rows.map((row) => row.length));
  const last = rows.reduce((max, row, index) => row.length ? index + 1 : max, 0);
  const dimension = last ? `A1:${columnLetter(width)}${last}` : "A1:A1";
  const data = rows.map((row, r) => row.length ? `<row r="${r + 1}">${row.map((value, c) => value === null ? "" : cellXml(`${columnLetter(c + 1)}${r + 1}`, value)).join("")}</row>` : "").join("");
  return `${XML_DECL}<worksheet xmlns="${S}"><sheetPr><outlinePr summaryBelow="1" summaryRight="1"/><pageSetUpPr/></sheetPr><dimension ref="${dimension}"/><sheetViews><sheetView workbookViewId="0"><selection activeCell="A1" sqref="A1"/></sheetView></sheetViews><sheetFormatPr baseColWidth="8" defaultRowHeight="15"/><sheetData>${data}</sheetData><pageMargins left="0.75" right="0.75" top="1" bottom="1" header="0.5" footer="0.5"/></worksheet>`;
}

const STYLES = `${XML_DECL}<styleSheet xmlns="${S}"><numFmts count="0"/><fonts count="1"><font><name val="Calibri"/><family val="2"/><color theme="1"/><sz val="11"/><scheme val="minor"/></font></fonts><fills count="2"><fill><patternFill/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" pivotButton="0" quotePrefix="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0" hidden="0"/></cellStyles><tableStyles count="0" defaultTableStyle="TableStyleMedium9" defaultPivotStyle="PivotStyleLight16"/></styleSheet>`;

export function makeXlsx(document: XlsxDocument): Buffer {
  for (const sheet of document.sheets) for (const row of sheet.rows) for (const value of row) {
    if (typeof value === "string" && ILLEGAL.test(value)) throw new Error(`${value} cannot be used in worksheets.`);
  }
  const texts = [document.title, ...document.sheets.flatMap((sheet) => [sheet.name, ...sheet.rows.flat().filter((v): v is string => typeof v === "string")])];
  if (texts.some(xmlIncompatible)) throw new Error(LXML_ERROR);
  const count = document.sheets.length;
  const files: Array<[string, string]> = [
    ["docProps/app.xml", appProperties("Microsoft Excel Compatible / Xueness")],
    ["docProps/core.xml", coreProperties(document.title, "openpyxl")],
    ...document.sheets.map((sheet, i): [string, string] => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(sheet.rows)]),
    ["xl/styles.xml", STYLES],
    ["_rels/.rels", packageRels("xl/workbook.xml")],
    ["xl/workbook.xml", `${XML_DECL}<workbook xmlns="${S}" xmlns:r="${REL}"><workbookPr/><bookViews><workbookView visibility="visible" minimized="0" showHorizontalScroll="1" showVerticalScroll="1" showSheetTabs="1" tabRatio="600" firstSheet="0" activeTab="0"/></bookViews><sheets>${document.sheets.map((sheet, i) => `<sheet name="${escAttr(sheet.name)}" sheetId="${i + 1}" state="visible" r:id="rId${i + 1}"/>`).join("")}</sheets><definedNames/><calcPr calcId="124519" fullCalcOnLoad="1"/></workbook>`],
    ["xl/_rels/workbook.xml.rels", relationships([...document.sheets.map((_s, i): [string, string, string] => [`rId${i + 1}`, `${REL}/worksheet`, `/xl/worksheets/sheet${i + 1}.xml`]), [`rId${count + 1}`, `${REL}/styles`, "styles.xml"]])],
    ["[Content_Types].xml", contentTypes([["/xl/styles.xml", `${CT}.spreadsheetml.styles+xml`], ["/docProps/core.xml", "application/vnd.openxmlformats-package.core-properties+xml"], ["/docProps/app.xml", `${CT}.extended-properties+xml`],
      ...document.sheets.map((_s, i): [string, string] => [`/xl/worksheets/sheet${i + 1}.xml`, `${CT}.spreadsheetml.worksheet+xml`]), ["/xl/workbook.xml", `${CT}.spreadsheetml.sheet.main+xml`]])],
  ];
  return writeZip(files.map(([name, text]) => ({ name, data: Buffer.from(text, "utf8") })));
}
