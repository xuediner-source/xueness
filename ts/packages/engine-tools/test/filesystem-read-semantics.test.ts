/**
 * F05.01 (C-TOOL-10): file read semantics — line/byte ranges, encoding
 * boundaries, large-file paging and comparable result shapes.
 *
 * Invariants pinned here:
 * - Multi-byte UTF-8 and CRLF split across 64 KiB stream chunks never produce
 *   half a character or a stray CR; the range result still carries the
 *   whole-file SHA-256, size and total line count.
 * - Legacy encodings (GBK/GB18030/UTF-16) decode through the bounded fallback
 *   without truncation, keep their encoding and line endings, and refuse
 *   cleanly when they cannot round-trip.
 * - Range reads page with startLine/endLine/nextOffset; a byte range reports
 *   offset/nextOffset/totalBytes against the whole file.
 * - Whole-file and range read shapes are comparable (same revision, totals).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { test } from "node:test";
import { NodeWorkspaceFileSystem, encodeText, type WorkspaceTextRange } from "../src/index.ts";
import { WorkspaceFileTooLargeError } from "../src/filesystem-errors.ts";
import { workspace } from "./helpers.ts";

const CHUNK = 64 * 1024;
const SHA = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

test("UTF-8 boundaries: BOM, multibyte and CRLF across chunk edges keep whole-file digest and totals", async () => {
  const ws = workspace();
  try {
    // "界" (3 bytes) straddles the first chunk edge; "\r\n" straddles the second.
    const content = `ä${"a".repeat(CHUNK - 3)}界界\r\n${"b".repeat(CHUNK - 1)}é\r\nend\n`;
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(content)]);
    await ws.put("utf8-edge.txt", bytes);
    const fs = new NodeWorkspaceFileSystem({ cwd: ws.root, roots: [ws.root] });

    const first = await fs.readTextRange("utf8-edge.txt", 1, 1, 10 * CHUNK);
    assert.equal([...first.lines[0]!.slice(-2)].join(""), "界界");
    assert.ok(first.lines[0]!.startsWith("ä" + "a".repeat(10)), "first line starts before the chunk edge");
    assert.equal(first.encoding, "utf-8-bom");
    assert.equal(first.lineEnding, "CRLF");
    assert.equal(first.totalLines, 3);
    assert.equal(first.nextOffset, 2);

    const rest = await fs.readTextRange("utf8-edge.txt", first.nextOffset!, undefined, 10 * CHUNK);
    assert.deepEqual(rest.lines, ["b".repeat(CHUNK - 1) + "é", "end"]);
    assert.equal(rest.endLine, 3);
    assert.equal(rest.nextOffset, null);
    for (const range of [first, rest]) {
      assert.equal(range.sha256, SHA(bytes), "a range read reports the whole-file hash");
      assert.equal(range.size, bytes.length);
      assert.equal(range.mtimeMs > 0, true);
    }
  } finally {
    ws.dispose();
  }
});

test("legacy encodings range-read through the fallback without truncation", async () => {
  const ws = workspace();
  try {
    const fs = new NodeWorkspaceFileSystem({ cwd: ws.root, roots: [ws.root] });

    const gbkBytes = Buffer.from(encodeText("# 配置\r\n标题 = 旧的标题\r\n第三行 = 结束\r\n", "gbk"));
    await ws.put("legacy-gbk.ini", gbkBytes);
    const gbk = await fs.readTextRange("legacy-gbk.ini", 2, 1, 1 << 20);
    assert.deepEqual(gbk.lines, ["标题 = 旧的标题"]);
    assert.equal(gbk.encoding, "gbk");
    assert.equal(gbk.lineEnding, "CRLF");
    assert.equal(gbk.totalLines, 3);
    assert.equal(gbk.nextOffset, 3);
    assert.equal(gbk.sha256, SHA(gbkBytes));

    const wide = Buffer.from(encodeText("first\n第二行\nthird\n", "utf-16le"));
    await ws.put("legacy-u16.txt", wide);
    const u16 = await fs.readTextRange("legacy-u16.txt", 2, 2, 1 << 20);
    assert.deepEqual(u16.lines, ["第二行", "third"]);
    assert.equal(u16.encoding, "utf-16le");
    assert.equal(u16.totalLines, 3);

    const four = Buffer.from(encodeText("𐌰\nb\n", "gb18030"));
    await ws.put("legacy-gb18030.txt", four);
    const gb = await fs.readTextRange("legacy-gb18030.txt", 1, 5, 1 << 20);
    assert.deepEqual(gb.lines, ["𐌰", "b"]);
    assert.equal(gb.encoding, "gb18030");
  } finally {
    ws.dispose();
  }
});

test("whole-file and range reads return comparable shapes for the same file", async () => {
  const ws = workspace();
  try {
    const text = "one\ntwo\nthree";
    await ws.put("shape.txt", Buffer.from(text, "utf-8"));
    const fs = new NodeWorkspaceFileSystem({ cwd: ws.root, roots: [ws.root] });
    const whole = await fs.readTextFile("shape.txt");
    const cover = await fs.readTextRange("shape.txt", 1, 10, 4096);
    const partial: WorkspaceTextRange = cover;
    assert.equal(partial.encoding, whole.encoding);
    assert.equal(partial.totalLines, whole.content.split("\n").length);
    assert.deepEqual(
      { sha256: partial.sha256, size: partial.size, mtimeMs: partial.mtimeMs },
      { sha256: whole.sha256, size: whole.size, mtimeMs: whole.mtimeMs },
    );
    assert.deepEqual(partial.lines, whole.content.split("\n"));
    assert.equal(partial.nextOffset, null, "a covering range has no next page");
  } finally {
    ws.dispose();
  }
});

test("edge shapes: empty file, missing trailing newline, and offsets past the end", async () => {
  const ws = workspace();
  try {
    const fs = new NodeWorkspaceFileSystem({ cwd: ws.root, roots: [ws.root] });
    await ws.put("empty.txt", Buffer.alloc(0));
    const empty = await fs.readTextRange("empty.txt", 1, 5, 1024);
    assert.deepEqual(empty.lines, []);
    assert.equal(empty.totalLines, 0);
    assert.equal(empty.endLine, 0);
    assert.equal(empty.nextOffset, null);

    await ws.put("no-nl.txt", Buffer.from("one\ntwo", "utf-8"));
    const last = await fs.readTextRange("no-nl.txt", 2, 5, 1024);
    assert.deepEqual(last.lines, ["two"]);
    assert.equal(last.totalLines, 2);
    assert.equal(last.endLine, 2);
    assert.equal(last.nextOffset, null);

    const past = await fs.readTextRange("no-nl.txt", 9, 5, 1024);
    assert.deepEqual(past.lines, []);
    assert.equal(past.startLine, 9);
    assert.equal(past.endLine, 8);
    assert.equal(past.totalLines, 2);
    assert.equal(past.nextOffset, null);

    // A lone CR is not a line break unless an LF follows it.
    await ws.put("cr.txt", Buffer.from("one\rtwo\r\nthree", "utf-8"));
    const cr = await fs.readTextRange("cr.txt", 1, 5, 1024);
    assert.deepEqual(cr.lines, ["one\rtwo", "three"]);
    assert.equal(cr.lineEnding, "CRLF", "the single CRLF is the only real line break");
  } finally {
    ws.dispose();
  }
});

test("byte ranges page against the whole file and both range kinds share the size guard", async () => {
  const ws = workspace();
  try {
    const bytes = Buffer.from([10, 11, 12, 13, 14, 15]);
    await ws.put("page.bin", bytes);
    const fs = new NodeWorkspaceFileSystem({ cwd: ws.root, roots: [ws.root] });
    const page = await fs.readBinaryRange("page.bin", 2, 3, 16);
    assert.deepEqual([...page.bytes], [12, 13, 14], "byte offsets are 0-based");
    assert.equal(page.offset, 2);
    assert.equal(page.nextOffset, 5);
    assert.equal(page.totalBytes, bytes.length);
    assert.equal(page.sha256, SHA(bytes), "a byte range reports the whole-file hash");
    const tail = await fs.readBinaryRange("page.bin", 5, 3, 16);
    assert.deepEqual([...tail.bytes], [15]);
    assert.equal(tail.nextOffset, null);

    await assert.rejects(fs.readBinaryRange("page.bin", 0, 99, 16), WorkspaceFileTooLargeError);
    await ws.put("big.txt", Buffer.from("x".repeat(100)));
    await assert.rejects(fs.readTextRange("big.txt", 1, 5, 50), WorkspaceFileTooLargeError);
    await assert.rejects(fs.readTextRange("big.txt", 1, undefined, 50), WorkspaceFileTooLargeError);
  } finally {
    ws.dispose();
  }
});

test("undecodable bytes are refused as unsupported instead of half-decoded", async () => {
  const ws = workspace();
  try {
    const fs = new NodeWorkspaceFileSystem({ cwd: ws.root, roots: [ws.root] });
    await ws.put("bad.enc", Buffer.from([0x41, 0x81, 0x30, 0x0a]));
    await assert.rejects(fs.readTextRange("bad.enc", 1, 5, 1024), (error: Error & { code?: string }) => error.code === "unsupported_encoding");
    await ws.put("nul.enc", Buffer.from([0x41, 0x00, 0x42, 0x0a]));
    await assert.rejects(fs.readTextRange("nul.enc", 1, 5, 1024), (error: Error & { code?: string }) => error.code === "binary_file");
    // A trailing incomplete multi-byte sequence on disk is a real defect, not a sampling edge.
    await ws.put("cut.enc", Buffer.concat([Buffer.from("ok\n", "utf-8"), Buffer.from([0xe4, 0xb8])]));
    await assert.rejects(fs.readTextRange("cut.enc", 1, 5, 1024), (error: Error & { code?: string }) => error.code === "unsupported_encoding");
    await writeFile(ws.path("cut.enc"), Buffer.concat([Buffer.from("ok\n", "utf-8"), Buffer.from([0xe4, 0xb8, 0xad])]));
    const healed = await fs.readTextRange("cut.enc", 1, 5, 1024);
    assert.deepEqual(healed.lines, ["ok", "中"]);
  } finally {
    ws.dispose();
  }
});
