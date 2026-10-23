/** Differential: planning delivery checks of Office outputs through this plugin's extractor vs Python. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { checkDelivery } from "@xueness/plugin-planning";
import { buildDocument, deliveryContentText } from "../src/index.ts";
import { writeZip } from "../src/zip.ts";
import { PROJECT_ROOT, runPython } from "../../../test-support/python-oracle.ts";
import { officeUnavailableReason } from "./oracle.ts";

type Row = Record<string, unknown>;
const oracle = (inputs: Row[]): unknown[] => JSON.parse(runPython(readFileSync(join(PROJECT_ROOT, "ts/test-support/python/delivery_oracle.py"), "utf8"), JSON.stringify(inputs)));

describe("office delivery content matches Python", { skip: officeUnavailableReason() }, () => {
  it("visible text, links, truncation and the plugin switch", async () => {
    const root = mkdtempSync(join(tmpdir(), "office-delivery-"));
    try {
      writeFileSync(join(root, "report.docx"), buildDocument("docx", { title: "季度报告", paragraphs: [{ text: "Requested section https://one.test/a" }], tables: [{ rows: [["https://two.test/b", "x"]] }] }));
      writeFileSync(join(root, "deck.pptx"), buildDocument("pptx", { slides: [{ title: "Requested section", bullets: ["https://one.test/a"] }] }));
      writeFileSync(join(root, "data.xlsx"), buildDocument("xlsx", { sheets: [{ name: "Requested section", rows: [["value", 3]] }] }));
      writeFileSync(join(root, "paper.pdf"), buildDocument("pdf", { title: "Requested section", paragraphs: [{ text: "body https://one.test/a https://two.test/b" }] }));
      writeFileSync(join(root, "long.docx"), writeZip([{ name: "[Content_Types].xml", data: "<Types/>" }, { name: "word/document.xml", data: `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${"<w:p><w:r><w:t>Requested section</w:t></w:r></w:p>".repeat(501)}</w:body></w:document>` }]));
      writeFileSync(join(root, "broken.pptx"), "not a zip");
      const check = (path: string, extra: Row = {}, params: Row = {}): Row => ({ op: "check", root, session: { task: "Write report", delivery_requirements: [{ id: "out", label: "Report", path, contains: ["Requested section"], min_links: 2, ...extra }] }, ...params });
      const inputs: Row[] = [check("report.docx"), check("deck.pptx", { min_links: 1 }), check("data.xlsx", { min_links: 0 }), check("paper.pdf"), check("long.docx", { min_links: 0 }), check("broken.pptx"), check("report.docx", {}, { disabled: ["office"] }), check("report.docx", {}, { denied: ["report.docx"] }), check("REPORT.DOCX")];
      const expected = oracle(inputs);
      for (const [index, item] of inputs.entries()) {
        const actual = await checkDelivery(root, structuredClone(item.session) as Row, "", { enabled: (id) => !((item.disabled as string[] | undefined) ?? []).includes(id), canRead: (path) => !((item.denied as string[] | undefined) ?? []).includes(path), officeText: deliveryContentText });
        assert.deepEqual(actual, expected[index], `case ${index}`);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
