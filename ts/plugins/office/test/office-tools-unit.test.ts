/**
 * Office tool behaviour without the Python oracle. Cases come from the Python
 * suite (tests/test_office_tools.py) and, for the PDF path, from ZCode's
 * read-pdf tests (apps/zcode-cli/packages/core/tests/read-pdf.test.ts: non-regular
 * path, size limit, missing header), adapted to Xueness' error texts.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { deflateSync } from "node:zlib";
import { createToolEnv, runTool } from "@xueness/engine-tools";
import { deliveryContentText, officeTools, safeZip } from "../src/index.ts";
import { writeZip } from "../src/zip.ts";

type Row = Record<string, unknown>;
function harness() {
  const root = mkdtempSync(join(tmpdir(), "office-unit-")), session: Row = { id: "s1" };
  const tools = new Map(officeTools({ session: () => session }).map((tool) => [tool.name, tool]));
  const env = createToolEnv({ cwd: root, artifactsDir: join(tmpdir(), "office-unit-artifacts"), owner: "s1" });
  const call = async (name: string, args: Row) => runTool(tools.get(name)!, args, env);
  return { root, session, call, done: () => rmSync(root, { recursive: true, force: true }) };
}
const word = (paragraphs: string[]): Buffer => writeZip([
  { name: "[Content_Types].xml", data: "<Types/>" },
  { name: "word/document.xml", data: `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join("")}</w:body></w:document>` },
]);
function onePagePdf(content: string): Buffer {
  const stream = deflateSync(Buffer.from(content, "latin1"));
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n${stream.toString("latin1")}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"];
  let body = "%PDF-1.4\n"; const offsets: number[] = [];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(body, "latin1")); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

describe("office tools", () => {
  it("create and read every supported format", async () => {
    const h = harness();
    try {
      const documents: Array<[string, Row, (document: Row) => void]> = [
        ["a.docx", { title: "报告", paragraphs: [{ text: "正文" }], tables: [{ rows: [["k", "v"]] }] }, (d) => assert.deepEqual(d, { paragraphs: [{ text: "报告", style: "Title" }, { text: "正文" }, { text: "" }], tables: [{ rows: [["k", "v"]] }] })],
        ["a.pptx", { slides: [{ title: "T", bullets: ["one"] }] }, (d) => assert.deepEqual(d, { slides: [{ paragraphs: ["• one"], title: "T" }] })],
        ["a.xlsx", { sheets: [{ name: "数据", rows: [["n", 1.5, true]] }] }, (d) => assert.deepEqual(d, { sheets: [{ name: "数据", rows: [["n", "1.5", "1"]] }] })],
        ["a.pdf", { title: "P", paragraphs: [{ text: "hello 世界" }] }, (d) => assert.deepEqual(d, { title: "P", pages: [{ number: 1, text: "P\nhello 世界\n" }] })],
      ];
      for (const [path, document, check] of documents) {
        const format = path.split(".")[1]!;
        const created = await h.call("office_create", { path, format, document });
        assert.equal(created.ok, true, created.output);
        const read = await h.call("office_read", { path });
        assert.equal(read.ok, true, read.output);
        const data = read.data as Row;
        assert.equal(data.sha256, (created.data as Row).sha256);
        assert.equal(data.truncated, false);
        check(data.document as Row);
        assert.match(deliveryContentText(readFileSync(join(h.root, path)), `.${format}`), /./);
      }
      assert.deepEqual(Object.keys(h.session._office_read_proofs as Row), ["a.docx", "a.pptx", "a.xlsx", "a.pdf"]);
    } finally { h.done(); }
  });

  it("replace requires a session read and rejects a stale or externally edited digest", async () => {
    const h = harness();
    try {
      await h.call("office_create", { path: "r.docx", format: "docx", document: { title: "v1" } });
      const doc = { paragraphs: [{ text: "v2" }] };
      const read = (await h.call("office_read", { path: "r.docx" })).data as Row;
      const stale = await h.call("office_replace", { path: "r.docx", format: "docx", expected_sha256: "f".repeat(64), document: doc });
      assert.deepEqual([stale.error?.code, stale.error?.message], ["permission_denied", "read this exact path in the current session before replacing it"]);
      writeFileSync(join(h.root, "r.docx"), "x", { flag: "a" });
      const edited = await h.call("office_replace", { path: "r.docx", format: "docx", expected_sha256: read.sha256, document: doc });
      assert.equal(edited.error?.message, "office file changed after office_read; read it again before replacing");
      const again = (await h.call("office_read", { path: "r.docx" })).data as Row;
      const replaced = await h.call("office_replace", { path: "r.docx", format: "docx", expected_sha256: again.sha256, document: doc });
      assert.equal(replaced.ok, true, replaced.output);
      assert.equal(Object.hasOwn(h.session._office_read_proofs as Row, "r.docx"), false, "a replace consumes the proof");
      const reused = await h.call("office_replace", { path: "r.docx", format: "docx", expected_sha256: again.sha256, document: doc });
      assert.equal(reused.error?.code, "permission_denied");
    } finally { h.done(); }
  });

  it("zip member traversal is rejected before preview", () => {
    assert.throws(() => safeZip(writeZip([{ name: "../outside", data: "no" }])), /unsafe member/);
  });

  it("a truncated read does not authorize replacing the full document", async () => {
    const h = harness();
    try {
      writeFileSync(join(h.root, "long.docx"), word(Array.from({ length: 501 }, (_v, i) => `Paragraph ${i}`)));
      const read = await h.call("office_read", { path: "long.docx" });
      assert.equal((read.data as Row).truncated, true);
      assert.equal(Object.hasOwn((h.session._office_read_proofs ?? {}) as Row, "long.docx"), false);
      const replaced = await h.call("office_replace", { path: "long.docx", format: "docx", expected_sha256: (read.data as Row).sha256, document: { paragraphs: [{ text: "replacement" }] } });
      assert.equal(replaced.error?.code, "permission_denied");
    } finally { h.done(); }
  });

  it("a long DOCX paragraph is clipped to 8000 characters and reported truncated", async () => {
    const h = harness();
    try {
      writeFileSync(join(h.root, "long-paragraph.docx"), word(["A".repeat(12_000)]));
      const data = (await h.call("office_read", { path: "long-paragraph.docx" })).data as Row;
      assert.equal(((data.document as Row).paragraphs as Row[])[0]!.text, "A".repeat(8000));
      assert.equal(data.truncated, true);
    } finally { h.done(); }
  });

  it("a long single PDF page is clipped to 10000 characters and reported truncated", async () => {
    const h = harness();
    try {
      writeFileSync(join(h.root, "long-page.pdf"), onePagePdf(`BT /F1 12 Tf 20 700 Td (${"P".repeat(20_000)}) Tj ET`));
      const data = (await h.call("office_read", { path: "long-page.pdf" })).data as Row;
      assert.equal(((data.document as Row).pages as Row[])[0]!.text, "P".repeat(10_000));
      assert.equal(data.truncated, true);
      assert.equal(Object.hasOwn((h.session._office_read_proofs ?? {}) as Row, "long-page.pdf"), false);
    } finally { h.done(); }
  });

  it("ZCode read-pdf cases: non-regular path, size limit and missing header", async () => {
    const h = harness();
    try {
      mkdirSync(join(h.root, "folder.pdf"));
      writeFileSync(join(h.root, "huge.pdf"), Buffer.alloc(8_000_001));
      writeFileSync(join(h.root, "plain.pdf"), "just text");
      assert.equal((await h.call("office_read", { path: "folder.pdf" })).error?.message, "office path must be a regular file");
      assert.equal((await h.call("office_read", { path: "huge.pdf" })).error?.message, "office file exceeds the 8 MB read limit");
      assert.equal((await h.call("office_read", { path: "plain.pdf" })).error?.message, "invalid PDF document");
    } finally { h.done(); }
  });

  it("PDF text follows TJ gaps, vertical moves and the ' operator", async () => {
    const h = harness();
    try {
      writeFileSync(join(h.root, "ops.pdf"), onePagePdf("BT /F1 10 Tf 12 TL 50 700 Td [(Hel) 20 (lo) -600 (World)] TJ (next) ' 0 -40 Td (far) Tj ET"));
      const data = (await h.call("office_read", { path: "ops.pdf" })).data as Row;
      assert.equal(((data.document as Row).pages as Row[])[0]!.text, "Hello World\nnext\nfar");
    } finally { h.done(); }
  });
});
