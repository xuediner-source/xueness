/** Differential: Office validation, authoring and bounded reading against the Python plugin, both directions. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDocument, deliveryContentText, readDocument, type OfficeFormat } from "../src/index.ts";
import { writeZip } from "../src/zip.ts";
import { officeUnavailableReason, pythonOffice, type OracleResult } from "./oracle.ts";

const skip = officeUnavailableReason();
// ElementTree appends expat's ": line L, column C" to XML syntax errors; the port reports the same message without the position.
const unpositioned = (message: string): string => message.replace(/: line \d+, column \d+$/, "");
const outcome = (fn: () => unknown): unknown => { try { return fn(); } catch (error) { return { error: unpositioned((error as Error).message) }; } };
const tsRead = (format: string, data: Buffer): unknown => outcome(() => readDocument(data, format as OfficeFormat));
const tsDelivery = (suffix: string, data: Buffer): unknown => outcome(() => ({ text: deliveryContentText(data, suffix) }));
const py = (result: OracleResult): unknown => result.error !== undefined ? { error: unpositioned(result.error) } : result.text !== undefined ? { text: result.text } : { document: result.document, truncated: result.truncated };

const VALID: Array<[OfficeFormat, unknown]> = [
  ["docx", { title: "标题 T", paragraphs: [{ text: "Hello" }, { text: " a\tb\nc\r ", bold: true, style: "Heading 1" }, { text: "x", style: "Title", italic: true }, { text: "" }, { text: "列表", style: "List Number" }], tables: [{ rows: [["a", "b"], ["c"], []] }, { rows: [["", " z "]] }] }],
  ["docx", { paragraphs: [{ text: "\u007f\u0085 emoji 😀 e\u0301" }] }],
  ["docx", { title: "only title" }],
  ["pptx", { title: "Deck", slides: [{ title: "S1", paragraphs: ["p a\nb\r\u000b\u0001", "x".repeat(120)], bullets: ["x", "\t tab"] }, { paragraphs: ["only body"] }, {}] }],
  ["pptx", { slides: [{ title: "日本".repeat(30), bullets: Array.from({ length: 12 }, (_v, i) => `b${i}`) }] }],
  ["xlsx", { title: "TT", sheets: [{ name: "S", rows: [["a", 1, 2.5, true, false, null, "=x"], [1e-7, -0.5, 123456789012345, " sp ", 0.1 + 0.2, -1e99, 2.5e-7, 1e-300]] }, { name: "空", rows: [] }, { name: "Ünï", rows: [[null, null], [], ["a\rb", "a\nb", "\u007f"]] }] }],
  ["pdf", { title: "PDF 标题", paragraphs: [{ text: "第一段 hello" }, { text: "H", style: "heading" }, { text: "" }, { text: "a\nb" }, { text: "word ".repeat(60) }, { text: "T2", style: "title" }, { text: "长".repeat(300) }, { text: "centred title ".repeat(12), style: "title" }] }],
  ["pdf", { paragraphs: Array.from({ length: 120 }, (_v, i) => ({ text: `line ${i} ${"mix 中文 ".repeat(i % 7)}` })) }],
  ["pdf", { title: "centred title ".repeat(9) + "end", paragraphs: [{ text: "x" }] }],
  ["pdf", { title: "a\u0001\ufffe 😀", paragraphs: [{ text: "  spaced   out\ttext  " }] }],
];

const INVALID: Array<[OfficeFormat, unknown]> = [
  ["docx", null], ["docx", []], ["docx", { title: 3 }], ["docx", { title: "x".repeat(8001) }], ["docx", { title: "a\u0000" }], ["docx", {}],
  ["docx", { slides: [] }], ["docx", { paragraphs: {} }], ["docx", { paragraphs: Array(501).fill({ text: "a" }) }], ["docx", { tables: Array(101).fill({ rows: [["a"]] }) }],
  ["docx", { paragraphs: [{ text: "a", extra: 1 }] }], ["docx", { paragraphs: ["a"] }], ["docx", { paragraphs: [{}] }], ["docx", { paragraphs: [{ text: "a", style: "Heading 7" }] }],
  ["docx", { paragraphs: [{ text: "a", bold: 1 }] }], ["docx", { tables: [{ rows: [] }] }], ["docx", { tables: [{ rows: [Array(51).fill("a")] }] }], ["docx", { tables: [{ rows: [[]] }] }],
  ["docx", { tables: [{ rows: [[1]] }] }], ["docx", { title: "a\u0001" }], ["docx", { paragraphs: [{ text: "\u000b" }] }], ["docx", { tables: [{ rows: [["\ufffe"]] }] }],
  ["docx", { paragraphs: Array.from({ length: 51 }, () => ({ text: "x".repeat(8000) })) }],
  ["pptx", { slides: [] }], ["pptx", { slides: Array(101).fill({}) }], ["pptx", { slides: [{ title: "x".repeat(61) }] }], ["pptx", { slides: [{ paragraphs: Array(21).fill("a") }] }],
  ["pptx", { slides: [{ paragraphs: Array(101).fill("a") }] }], ["pptx", { slides: [{ bullets: ["x".repeat(401)] }] }], ["pptx", { slides: [{ paragraphs: Array(10).fill("x".repeat(100)) }] }],
  ["pptx", { slides: [{ paragraphs: Array(18).fill("a") }] }], ["pptx", { title: "a\u0001", slides: [{}] }], ["pptx", { slides: [{ title: "\ufffe" }] }], ["pptx", { slides: [{ notes: "x" }] }],
  ["xlsx", { sheets: [] }], ["xlsx", { sheets: Array(21).fill({ name: "a", rows: [] }) }], ["xlsx", { sheets: [{ name: " ", rows: [] }] }], ["xlsx", { sheets: [{ name: "a/b", rows: [] }] }],
  ["xlsx", { sheets: [{ name: "'q", rows: [] }] }], ["xlsx", { sheets: [{ name: "x".repeat(32), rows: [] }] }], ["xlsx", { sheets: [{ name: "Ab", rows: [] }, { name: "aB", rows: [] }] }],
  ["xlsx", { sheets: [{ name: "a", rows: Array(501).fill([]) }] }], ["xlsx", { sheets: [{ name: "a", rows: [Array(201).fill(1)] }] }], ["xlsx", { sheets: [{ name: "a", rows: [[1e15]] }] }],
  ["xlsx", { sheets: [{ name: "a", rows: [[1.5e100]] }] }], ["xlsx", { sheets: [{ name: "a", rows: [[{}]] }] }], ["xlsx", { sheets: [{ name: "a", rows: [["a\u0001b"]] }] }],
  ["xlsx", { sheets: [{ name: "a", rows: [["ok", "\ufffe"]] }] }], ["xlsx", { title: "t\u0001", sheets: [{ name: "a", rows: [] }] }], ["xlsx", { sheets: [{ name: "a\u0001", rows: [] }] }],
  ["xlsx", { sheets: Array.from({ length: 5 }, (_v, i) => ({ name: `s${i}`, rows: Array(100).fill(Array(200).fill(null)) })).concat([{ name: "z", rows: [[1]] }]) }],
  ["pdf", {}], ["pdf", { paragraphs: [{ text: "a", style: "Title" }] }], ["pdf", { paragraphs: [{ text: "a", bold: true }] }], ["pdf", { paragraphs: Array(501).fill({ text: "a" }) }],
];

describe("office matches Python", { skip }, () => {
  it("validation and authoring errors carry Python's messages", () => {
    const expected = pythonOffice(INVALID.map(([format, document]) => ({ op: "build", format, document })));
    INVALID.forEach(([format, document], index) => {
      assert.deepEqual(outcome(() => buildDocument(format, document)), { error: expected[index]!.error }, `${format} case ${index}`);
    });
  });

  it("documents created by either backend read back identically in both", () => {
    const built = pythonOffice(VALID.map(([format, document]) => ({ op: "build", format, document })));
    VALID.forEach(([format, document], index) => {
      const ts = buildDocument(format, document), python = Buffer.from(built[index]!.data!, "base64");
      const [pyTs, pyPy, delTs, delPy] = pythonOffice([{ op: "read", format, data: ts }, { op: "read", format, data: python }, { op: "delivery", suffix: `.${format}`, data: ts }, { op: "delivery", suffix: `.${format.toUpperCase()}`, data: python }]);
      assert.deepEqual(tsRead(format, ts), py(pyTs!), `${format} ${index}: TS file`);
      assert.deepEqual(tsRead(format, python), py(pyPy!), `${format} ${index}: Python file`);
      assert.deepEqual(py(pyTs!), py(pyPy!), `${format} ${index}: same reading whichever backend wrote it`);
      assert.deepEqual(tsDelivery(`.${format}`, ts), py(delTs!), `${format} ${index}: delivery text`);
      assert.deepEqual(tsDelivery(`.${format.toUpperCase()}`, python), py(delPy!), `${format} ${index}: delivery text of the Python file`);
    });
  });

  it("hostile and truncated inputs fail or truncate the same way", () => {
    const xml = (body: string): Buffer => Buffer.from(`<?xml version="1.0"?>${body}`);
    const docxWith = (members: Array<{ name: string; data: Buffer | string }>): Buffer => writeZip(members);
    const word = (body: string) => [{ name: "[Content_Types].xml", data: xml("<Types/>") }, { name: "word/document.xml", data: xml(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`) }];
    const long = "<w:p><w:r><w:t>" + "x".repeat(9000) + "</w:t></w:r></w:p>";
    const encrypted = docxWith(word("<w:p/>")); encrypted.writeUInt16LE(encrypted.readUInt16LE(encrypted.lastIndexOf(Buffer.from("PK\u0001\u0002")) + 8) | 1, encrypted.lastIndexOf(Buffer.from("PK\u0001\u0002")) + 8);
    const cases: Array<[string, string, Buffer]> = [
      ["docx", ".docx", docxWith(word(long))],
      ["docx", ".docx", docxWith([...word("<w:p/>"), { name: "../evil", data: "x" }])],
      ["docx", ".docx", docxWith([...word("<w:p/>"), { name: "word/document.xml", data: "x" }])],
      ["docx", ".docx", docxWith([...word("<w:p/>"), { name: "big.xml", data: Buffer.alloc(4_000_001, 32) }])],
      ["docx", ".docx", encrypted],
      ["docx", ".docx", Buffer.from("not a zip")],
      ["docx", ".docx", docxWith(word("<w:p><w:r><w:t>&bad;</w:t></w:r></w:p>"))],
      ["xlsx", ".xlsx", buildDocument("docx", { title: "wrong kind" })],
      ["pdf", ".pdf", Buffer.from("%PDF-1.4\nnothing else")],
      ["pdf", ".pdf", Buffer.from("plain text, no header")],
      ["pdf", ".pdf", buildDocument("pdf", { paragraphs: Array.from({ length: 260 }, () => ({ text: "页".repeat(1500) })) })],
      ["pdf", ".pdf", Buffer.from(buildDocument("pdf", { title: "t".repeat(250), paragraphs: [{ text: "x" }] }))],
      ["pdf", ".txt", buildDocument("pdf", { title: "t" })],
    ];
    const reads = pythonOffice(cases.flatMap(([format, suffix, data]) => [{ op: "read" as const, format, data }, { op: "delivery" as const, suffix, data }]));
    cases.forEach(([format, suffix, data], index) => {
      if (suffix !== ".txt") assert.deepEqual(tsRead(format, data), py(reads[index * 2]!), `read case ${index}`);
      assert.deepEqual(tsDelivery(suffix, data), py(reads[index * 2 + 1]!), `delivery case ${index}`);
    });
  });
});
