import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { NodeWorkspaceFileSystem } from "../src/index.ts";
import { WorkspaceRevisionMismatchError } from "../src/filesystem-errors.ts";
import { workspace } from "./helpers.ts";

test("streams UTF-8 emoji and a CRLF split across chunk boundaries with a whole-file hash", async () => {
  const ws = workspace();
  try {
    const content = `${"a".repeat(65_534)}🙂\r\n${"b".repeat(65_531)}\r\nend\r\n`;
    const bytes = Buffer.from(content);
    await ws.put("large.txt", bytes);
    const fs = new NodeWorkspaceFileSystem({ cwd: ws.root, roots: [ws.root] });
    const range = await fs.readTextRange("large.txt", 1, 3, 200_000);
    assert.deepEqual(range.lines, [`${"a".repeat(65_534)}🙂`, "b".repeat(65_531), "end"]);
    assert.equal(range.lineEnding, "CRLF");
    assert.equal(range.totalLines, 3);
    assert.equal(range.nextOffset, null);
    assert.equal(range.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(range.size, bytes.length);
  } finally {
    ws.dispose();
  }
});

test("reads positioned byte ranges at offsets and EOF, and honors cancellation", async () => {
  const ws = workspace();
  try {
    await ws.put("bytes.bin", Buffer.from([0, 1, 2, 3, 4, 5, 6]));
    const fs = new NodeWorkspaceFileSystem({ cwd: ws.root, roots: [ws.root] });
    const page = await fs.readBinaryRange("bytes.bin", 3, 3, 3);
    assert.deepEqual([...page.bytes], [3, 4, 5]);
    assert.equal(page.offset, 3);
    assert.equal(page.nextOffset, 6);
    assert.equal(page.totalBytes, 7);
    const eof = await fs.readBinaryRange("bytes.bin", 7, 3, 3);
    assert.deepEqual([...eof.bytes], []);
    assert.equal(eof.nextOffset, null);
    await assert.rejects(fs.readBinaryRange("bytes.bin", 0, 1, 1, { signal: AbortSignal.abort() }), { code: "cancelled" });
  } finally {
    ws.dispose();
  }
});

test("checks create-only and stale SHA revisions before atomic replacement", async () => {
  const ws = workspace();
  try {
    const fs = new NodeWorkspaceFileSystem({ cwd: ws.root, roots: [ws.root] });
    const created = await fs.writeTextFile("note.txt", "first", { expectedRevision: null });
    assert.equal(created.sha256, createHash("sha256").update("first").digest("hex"));
    await assert.rejects(fs.writeTextFile("note.txt", "no overwrite", { expectedRevision: null }), WorkspaceRevisionMismatchError);
    assert.equal(await ws.text("note.txt"), "first");

    await writeFile(ws.path("note.txt"), "external change");
    await assert.rejects(fs.writeTextFile("note.txt", "stale replacement", { expectedRevision: created.sha256 }), WorkspaceRevisionMismatchError);
    assert.equal(await ws.text("note.txt"), "external change");
    const current = await fs.readTextFile("note.txt");
    await fs.writeTextFile("note.txt", "fresh replacement", { expectedRevision: current.sha256 });
    assert.equal(await ws.text("note.txt"), "fresh replacement");
  } finally {
    ws.dispose();
  }
});

test("rejects symlink escapes for range reads", async (context) => {
  const ws = workspace();
  try {
    const outside = join(ws.base, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "secret.bin"), Buffer.from([1, 2, 3]));
    try {
      await symlink(outside, ws.path("escape"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      context.skip(`symlink unavailable: ${String(error)}`);
      return;
    }
    const fs = new NodeWorkspaceFileSystem({ cwd: ws.root, roots: [ws.root] });
    await assert.rejects(fs.readBinaryRange("escape/secret.bin", 0, 1, 1), { code: "path_outside_workspace" });
  } finally {
    ws.dispose();
  }
});
