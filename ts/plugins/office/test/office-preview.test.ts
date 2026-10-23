/** Differential: the bounded Office preview DTO against Python `office_preview.preview_bytes(..., include_full_document=False)`. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDocument, previewBytes, type OfficeFormat } from "../src/index.ts";
import { writeZip } from "../src/zip.ts";
import { officeUnavailableReason, pythonOffice, type OracleResult } from "./oracle.ts";

const skip = officeUnavailableReason();
const unpositioned = (message: string): string => message.replace(/: line \d+, column \d+$/, "");
const ts = (suffix: string, data: Buffer): unknown => { try { return { preview: previewBytes(data, suffix) }; } catch (error) { return { error: unpositioned((error as Error).message) }; } };
const py = (result: OracleResult): unknown => result.error !== undefined ? { error: unpositioned(result.error) } : { preview: result.preview };

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f8cfc000000301010018dd8db00000000049454e44ae426082", "hex");
const rels = (targets: string[]): string => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${targets.map((target, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${target}"${target.startsWith("http") ? ' TargetMode="External"' : ""}/>`).join("")}</Relationships>`;
const blips = (count: number): string => Array.from({ length: count }, (_v, index) => `<w:r><w:drawing><a:blip r:embed="rId${index + 1}"/></w:drawing></w:r>`).join("");
const imageDocx = writeZip([
  { name: "[Content_Types].xml", data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
  { name: "word/document.xml", data: `<w:document ${W}><w:body><w:p><w:r><w:t>pic</w:t></w:r>${blips(6)}</w:p></w:body></w:document>` },
  { name: "word/_rels/document.xml.rels", data: rels(["media/a.png", "media/fake.png", "../../../etc/passwd.png", "https://example.com/x.png", "media/missing.jpg", "media/a.PNG"]) },
  { name: "word/media/a.png", data: PNG }, { name: "word/media/fake.png", data: "GIF89a" }, { name: "word/media/a.PNG", data: PNG },
]);

const DOCUMENTS: Array<[OfficeFormat, unknown]> = [
  ["docx", { title: "报告", paragraphs: [{ text: "Hello", style: "Heading 1" }, { text: " a\tb\nc ", bold: true }, { text: "斜体", italic: true, style: "List Bullet" }], tables: [{ rows: [["a", "b"], ["c"]] }] }],
  ["pptx", { title: "Deck", slides: [{ title: "S1", paragraphs: ["p a\nb"], bullets: ["x", "y"] }, { paragraphs: ["only body"] }, {}] }],
  ["xlsx", { sheets: [{ name: "S", rows: [["a", 1, 2.5, true, null, "=SUM(A1)"], [1e-7, " sp "]] }, { name: "空", rows: [] }] }],
];

describe("office preview matches Python", { skip }, () => {
  it("previews packages written by either backend, plus hostile packages, identically", () => {
    const built = pythonOffice(DOCUMENTS.map(([format, document]) => ({ op: "build", format, document })));
    assert.deepEqual(built.map((row) => row.error ?? null), DOCUMENTS.map(() => null));
    const inputs: Array<[string, Buffer]> = [];
    DOCUMENTS.forEach(([format, document], index) => {
      inputs.push([`.${format}`, buildDocument(format, document)], [`.${format}`, Buffer.from(built[index]!.data!, "base64")]);
    });
    const docx = inputs[0]![1];
    inputs.push(
      [".docx", Buffer.from("not a zip")], [".pptx", writeZip([{ name: "[Content_Types].xml", data: "<Types/>" }])],
      [".docx", writeZip([{ name: "word/document.xml", data: '<!DOCTYPE x [<!ENTITY e "boom">]><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">&e;</w:document>' }])],
      [".xlsx", writeZip([{ name: "xl/workbook.xml", data: "<broken" }])], [".odt", docx], [".DOCX", docx], [".docx", docx.subarray(0, docx.length - 40)], [".docx", imageDocx],
    );
    const expected = pythonOffice(inputs.map(([suffix, data]) => ({ op: "preview", suffix, data })));
    const shown = JSON.stringify(ts(".docx", imageDocx));
    assert.equal(shown.split("data:image/png;base64,").length - 1, 2, "only the two valid embedded PNGs are previewed: " + shown.slice(0, 400));
    inputs.forEach(([suffix, data], index) => assert.deepEqual(ts(suffix, data), py(expected[index]!), `${suffix} #${index}`));
  });
});
