/**
 * Shared OOXML authoring pieces plus the DOCX writer. The XML mirrors what
 * python-docx writes for `_make_docx` (pStyle ids, run properties, tabs and
 * breaks, Table Grid tables, the US Letter section) so `office_read` sees the
 * same structure whichever backend created the file.
 */
import { writeZip } from "./zip.ts";

export const XML_DECL = "<?xml version='1.0' encoding='UTF-8' standalone='yes'?>\n";
export const LXML_ERROR = "All strings must be XML compatible: Unicode or ASCII, no NULL bytes or control characters";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
export const PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
export const CT = "application/vnd.openxmlformats-officedocument";

/** lxml refuses C0 controls other than tab/newline/CR, U+FFFE/U+FFFF and lone surrogates. */
export function xmlIncompatible(text: string): boolean {
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff\ud800-\udfff]/u.test(text);
}
export function requireXml(...texts: string[]): void { for (const text of texts) if (xmlIncompatible(text)) throw new Error(LXML_ERROR); }

/** Text content as lxml serialises it (`\r` becomes a character reference). */
export const esc = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r/g, "&#13;");
export const escAttr = (text: string): string => esc(text).replace(/"/g, "&quot;").replace(/\n/g, "&#10;").replace(/\t/g, "&#9;");
const PY_WS = "[\\t\\n\\v\\f\\r\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
const PY_SPACE_EDGE = new RegExp(`^${PY_WS}|${PY_WS}$`);
/** `<tag>` with `xml:space="preserve"` when Python's `str.strip()` would change the text. */
export function textElement(tag: string, text: string): string {
  if (!text) return `<${tag}/>`;
  const space = PY_SPACE_EDGE.test(text) ? ' xml:space="preserve"' : "";
  return `<${tag}${space}>${esc(text)}</${tag}>`;
}

export function relationships(items: Array<[string, string, string]>): string {
  return `${XML_DECL}<Relationships xmlns="${PKG_REL}">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${type}" Target="${escAttr(target)}"/>`).join("")}</Relationships>`;
}

export function contentTypes(overrides: Array<[string, string]>): string {
  return `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides.map(([part, type]) => `<Override PartName="${part}" ContentType="${type}"/>`).join("")}</Types>`;
}

export function coreProperties(title: string, creator: string): string {
  return `${XML_DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">${title ? `<dc:title>${esc(title)}</dc:title>` : "<dc:title/>"}<dc:creator>${creator}</dc:creator><cp:revision>1</cp:revision><dcterms:created xsi:type="dcterms:W3CDTF">2000-01-01T00:00:00Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">2000-01-01T00:00:00Z</dcterms:modified></cp:coreProperties>`;
}

export const appProperties = (application: string): string => `${XML_DECL}<Properties xmlns="${CT.replace("application/vnd.openxmlformats-officedocument", "http://schemas.openxmlformats.org/officeDocument/2006")}/extended-properties"><Application>${application}</Application></Properties>`;

export function packageRels(main: string): string {
  return relationships([["rId1", `${REL}/officeDocument`, main], ["rId2", `${PKG_REL}/metadata/core-properties`, "docProps/core.xml"], ["rId3", `${REL}/extended-properties`, "docProps/app.xml"]]);
}
export { REL };

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const STYLE_IDS: Record<string, string> = { Title: "Title", Subtitle: "Subtitle", "List Bullet": "ListBullet", "List Number": "ListNumber" };
for (let level = 1; level <= 6; level += 1) STYLE_IDS[`Heading ${level}`] = `Heading${level}`;

/** python-docx `run.text`: `\t` is a tab, `\n`/`\r` are breaks. */
function runContent(text: string): string {
  let out = "", chunk = "";
  const flush = (): void => { if (chunk) out += textElement("w:t", chunk); chunk = ""; };
  for (const char of text) {
    if (char === "\t") { flush(); out += "<w:tab/>"; }
    else if (char === "\n" || char === "\r") { flush(); out += "<w:br/>"; }
    else chunk += char;
  }
  flush();
  return out;
}

function stylesXml(): string {
  const para = (id: string, name: string, extra: string): string => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>${extra}</w:style>`;
  const headings = [1, 2, 3, 4, 5, 6].map((level) => para(`Heading${level}`, `heading ${level}`, `<w:pPr><w:keepNext/><w:spacing w:before="${level === 1 ? 480 : 200}" w:after="0"/><w:outlineLvl w:val="${level - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${[28, 26, 24, 22, 22, 22][level - 1]}"/></w:rPr>`)).join("");
  return `${XML_DECL}<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:eastAsiaTheme="minorEastAsia" w:hAnsiTheme="minorHAnsi" w:cstheme="minorBidi"/><w:sz w:val="24"/><w:szCs w:val="24"/><w:lang w:val="en-US" w:eastAsia="en-US" w:bidi="ar-SA"/></w:rPr></w:rPrDefault><w:pPrDefault/></w:docDefaults>` +
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>` +
    `<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/></w:style>` +
    para("Title", "Title", '<w:pPr><w:spacing w:after="300"/><w:contextualSpacing/></w:pPr><w:rPr><w:spacing w:val="5"/><w:kern w:val="28"/><w:sz w:val="52"/><w:szCs w:val="52"/></w:rPr>') +
    para("Subtitle", "Subtitle", '<w:pPr><w:numPr><w:ilvl w:val="1"/></w:numPr></w:pPr><w:rPr><w:i/><w:spacing w:val="15"/></w:rPr>') + headings +
    para("ListBullet", "List Bullet", '<w:pPr><w:ind w:left="360" w:hanging="360"/><w:contextualSpacing/></w:pPr>') +
    para("ListNumber", "List Number", '<w:pPr><w:ind w:left="360" w:hanging="360"/><w:contextualSpacing/></w:pPr>') +
    `<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>` +
    `<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:uiPriority w:val="59"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:tblPr><w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`).join("")}</w:tblBorders></w:tblPr></w:style></w:styles>`;
}

export interface DocxDocument { title: string; paragraphs: Array<{ text: string; style: string; bold: boolean; italic: boolean }>; tables: Array<{ rows: string[][] }> }

export function makeDocx(document: DocxDocument): Buffer {
  requireXml(document.title, ...document.paragraphs.map((p) => p.text), ...document.tables.flatMap((t) => t.rows.flat()));
  const body: string[] = [];
  if (document.title) body.push(`<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r>${runContent(document.title)}</w:r></w:p>`);
  for (const item of document.paragraphs) {
    const style = STYLE_IDS[item.style];
    const rPr = `<w:rPr>${item.bold ? "<w:b/>" : '<w:b w:val="0"/>'}${item.italic ? "<w:i/>" : '<w:i w:val="0"/>'}</w:rPr>`;
    body.push(`<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : "<w:pPr/>"}<w:r>${rPr}${runContent(item.text)}</w:r></w:p>`);
  }
  for (const table of document.tables) {
    const width = Math.max(...table.rows.map((row) => row.length)), col = Math.trunc(8640 / width);
    const cell = (text: string | undefined): string => `<w:tc><w:tcPr><w:tcW w:type="dxa" w:w="${col}"/></w:tcPr>${text ? `<w:p><w:r>${runContent(text)}</w:r></w:p>` : "<w:p/>"}</w:tc>`;
    body.push(`<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:type="auto" w:w="0"/><w:tblLook w:firstColumn="1" w:firstRow="1" w:lastColumn="0" w:lastRow="0" w:noHBand="0" w:noVBand="1" w:val="04A0"/></w:tblPr><w:tblGrid>${`<w:gridCol w:w="${col}"/>`.repeat(width)}</w:tblGrid>${table.rows.map((row) => `<w:tr>${Array.from({ length: width }, (_v, i) => cell(row[i])).join("")}</w:tr>`).join("")}</w:tbl>`);
  }
  const documentXml = `${XML_DECL}<w:document xmlns:w="${W}" xmlns:r="${REL}"><w:body>${body.join("")}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800" w:header="720" w:footer="720" w:gutter="0"/><w:cols w:space="720"/><w:docGrid w:linePitch="360"/></w:sectPr></w:body></w:document>`;
  return writeZip([
    ["[Content_Types].xml", contentTypes([["/docProps/app.xml", `${CT}.extended-properties+xml`], ["/docProps/core.xml", "application/vnd.openxmlformats-package.core-properties+xml"], ["/word/document.xml", `${CT}.wordprocessingml.document.main+xml`], ["/word/styles.xml", `${CT}.wordprocessingml.styles+xml`]])],
    ["_rels/.rels", packageRels("word/document.xml")],
    ["docProps/core.xml", coreProperties(document.title, "Xueness")],
    ["docProps/app.xml", appProperties("Xueness")],
    ["word/document.xml", documentXml],
    ["word/_rels/document.xml.rels", relationships([["rId1", `${REL}/styles`, "styles.xml"]])],
    ["word/styles.xml", stylesXml()],
  ].map(([name, text]) => ({ name: name!, data: Buffer.from(text!, "utf8") })));
}
