/** Read's image and PDF branches (ZCode v3.15.1 `read-image.ts` / `read-pdf.ts`). */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, truncateSync } from "node:fs";
import { test } from "node:test";
import { readTool } from "../src/index.ts";
import { encodePng } from "../src/image/png.ts";
import { createRaster } from "../src/image/raster.ts";
import { parsePdfPageRange, pdfFileSize } from "../src/read-media.ts";
import { workspace } from "./helpers.ts";

const poppler = spawnSync("pdftoppm", ["-v"]).error === undefined && spawnSync("pdfinfo", ["-v"]).error === undefined;

function makePdf(pages: number): Buffer {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${i + 3} 0 R`).join(" ")}] /Count ${pages} >>`];
  for (let i = 0; i < pages; i += 1) objects.push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] >>");
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => { const at = body.length; body += `${index + 1} 0 obj\n${object}\nendobj\n`; return at; });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, "0")} 00000 n \n`).join("")}`;
  return Buffer.from(`${body}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`, "latin1");
}

const png = (): Buffer => {
  const raster = createRaster(4, 3);
  raster.data.fill(200);
  return encodePng(raster);
};

test("images are attached for the model, with ZCode's binary-read refusals", async () => {
  const ws = workspace();
  try {
    const file = await ws.put("shot.png", png());
    const result = await ws.run(readTool, { path: "shot.png" });
    assert.equal(result.ok, true);
    assert.equal(result.output, "[Attached image/png: Read image]");
    assert.deepEqual(result.media, [{ mimeType: "image/png", data: png().toString("base64"), placeholder: "Read image" }]);
    assert.deepEqual(result.data, {
      path: "shot.png", type: "image", mimeType: "image/png", originalSize: png().length, transformedSize: png().length, resized: false, compressed: false,
      compressionStrategy: "original", dimensions: { originalWidth: 4, originalHeight: 3, displayWidth: 4, displayHeight: 3 },
    });
    assert.equal(file, ws.path("shot.png"));
    // Magic bytes win over the extension; junk does not decode.
    await ws.put("really-png.jpg", png());
    assert.equal((await ws.run(readTool, { path: "really-png.jpg" })).output, "[Attached image/png: Read image]");
    await ws.put("junk.gif", "not a gif");
    assert.deepEqual((await ws.run(readTool, { path: "junk.gif" })).error, { code: "read_image_processing_failed", message: "Unable to decode image data" });
    await ws.put("empty.webp", "");
    assert.equal((await ws.run(readTool, { path: "empty.webp" })).output, "Image file is empty (0 bytes)");
    mkdirSync(ws.path("folder.png"));
    assert.equal((await ws.run(readTool, { path: "folder.png" })).output, `Cannot read directory as binary file: ${ws.path("folder.png")}`);
    await ws.put("huge.jpg", "");
    truncateSync(ws.path("huge.jpg"), 21 * 1024 * 1024);
    assert.equal((await ws.run(readTool, { path: "huge.jpg" })).output, "File content (21MB) exceeds maximum allowed size (20MB). Use a smaller file.");
    assert.equal((await ws.run(readTool, { path: "missing.png" })).error?.code, "not_found");
  } finally {
    ws.dispose();
  }
});

test("pages is validated first; PDFs stay on the text path unless the model accepts them", async () => {
  const ws = workspace();
  try {
    await ws.put("doc.pdf", makePdf(2));
    assert.equal((await ws.run(readTool, { path: "doc.pdf", pages: "abc" })).output, 'Invalid pages parameter: "abc". Use formats like "1-5", "3", or "10-20". Pages are 1-indexed.');
    assert.equal((await ws.run(readTool, { path: "doc.pdf", pages: "1-25" })).output, 'Page range "1-25" exceeds maximum of 20 pages per request. Please use a smaller range.');
    assert.equal((await ws.run(readTool, { path: "doc.pdf", pages: "3-" })).output, 'Page range "3-" exceeds maximum of 20 pages per request. Please use a smaller range.');
    const text = await ws.run(readTool, { path: "doc.pdf" });
    assert.equal(text.media, undefined);
    assert.deepEqual(parsePdfPageRange(" 2-4 "), { firstPage: 2, lastPage: 4 });
    assert.equal(parsePdfPageRange("0"), undefined);
    assert.equal(parsePdfPageRange("4-2"), undefined);
    assert.deepEqual([pdfFileSize(512), pdfFileSize(1536), pdfFileSize(20 * 1024 * 1024)], ["512 bytes", "1.5KB", "20MB"]);
  } finally {
    ws.dispose();
  }
});

test("PDF-capable models get the document attached, ZCode's checks and messages", async () => {
  const ws = workspace();
  try {
    ws.env.modelInput = { image: true, pdf: true };
    const pdf = makePdf(2);
    await ws.put("doc.pdf", pdf);
    const result = await ws.run(readTool, { path: "doc.pdf" });
    assert.equal(result.output, `PDF file read: ${ws.path("doc.pdf")} (${pdfFileSize(pdf.length)})\n\n[Attached application/pdf: doc.pdf]`);
    assert.deepEqual(result.media, [{ mimeType: "application/pdf", data: pdf.toString("base64"), placeholder: "doc.pdf" }]);
    await ws.put("empty.pdf", "");
    assert.equal((await ws.run(readTool, { path: "empty.pdf" })).output, `PDF file is empty: ${ws.path("empty.pdf")}`);
    await ws.put("fake.pdf", "hello");
    assert.equal((await ws.run(readTool, { path: "fake.pdf" })).output, `File is not a valid PDF (missing %PDF- header): ${ws.path("fake.pdf")}`);
    mkdirSync(ws.path("dir.pdf"));
    assert.equal((await ws.run(readTool, { path: "dir.pdf" })).output, `Path is not a regular file: ${ws.path("dir.pdf")}`);
    ws.env.modelInput = { image: false, pdf: true };
    assert.equal((await ws.run(readTool, { path: "doc.pdf", pages: "1" })).output, "The current model supports PDF input but does not support image input; remove the pages parameter.");
  } finally {
    ws.dispose();
  }
});

test("pages renders page images with poppler; long PDFs need a range", { skip: poppler ? false : "poppler-utils not installed" }, async () => {
  const ws = workspace();
  try {
    ws.env.modelInput = { image: true, pdf: true };
    const pdf = makePdf(2);
    await ws.put("doc.pdf", pdf);
    await ws.put("long.pdf", makePdf(11));
    assert.equal((await ws.run(readTool, { path: "long.pdf" })).output, 'This PDF has 11 pages, which is too many to read at once. Use the pages parameter to read specific page ranges (e.g., pages: "1-5"). Maximum 20 pages per request.');
    const pages = await ws.run(readTool, { path: "doc.pdf", pages: "1-2" });
    assert.equal(pages.ok, true, pages.output);
    assert.equal(pages.output, [`PDF pages extracted: 2 page(s) from ${ws.path("doc.pdf")} (${pdfFileSize(pdf.length)})`, "[Attached image/jpeg: PDF page 1]", "[Attached image/jpeg: PDF page 2]"].join("\n\n"));
    assert.deepEqual(pages.media?.map((item) => [item.mimeType, item.placeholder, Buffer.from(item.data, "base64").subarray(0, 2).toString("hex")]), [["image/jpeg", "PDF page 1", "ffd8"], ["image/jpeg", "PDF page 2", "ffd8"]]);
    assert.equal((await ws.run(readTool, { path: "doc.pdf", pages: "5" })).output, 'Requested page 5 is outside the document (PDF has 2 pages). Use a range within 1-2, maximum 20 pages per request (e.g. pages: "1-2").');
    await ws.put("broken.pdf", "%PDF-1.4\ngarbage");
    const broken = await ws.run(readTool, { path: "broken.pdf", pages: "1" });
    assert.equal(broken.ok, false);
    assert.match(broken.error!.code, /^pdf_/);
  } finally {
    ws.dispose();
  }
});
