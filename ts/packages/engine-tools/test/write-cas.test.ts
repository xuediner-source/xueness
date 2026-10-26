/**
 * F05.02 (C-TOOL-09): write/edit read-proof and atomic CAS semantics.
 *
 * Invariants pinned here:
 * - A range read or a token-truncated view is not proof that the whole file
 *   was read: write/edit answer read_required until a full read happens. A
 *   later range read clears an earlier full read's proof (latest-wins, the
 *   same rule the read-state restore applies after a cold start).
 * - The revision check runs immediately before the atomic rename: an external
 *   change in the window between read and write is rejected, the external
 *   content survives, and no temporary siblings are left behind.
 * - Multi-span replace_all terminates when the replacement contains the
 *   search text and keeps CRLF outside the edited spans.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { editTool, NodeWorkspaceFileSystem, readTool, writeTool } from "../src/index.ts";
import { WorkspaceRevisionMismatchError } from "../src/filesystem-errors.ts";
import { FILE_PARTIAL_READ_MESSAGE } from "../src/file-state.ts";
import { workspace } from "./helpers.ts";

describe("read proof", () => {
  it("refuses to write or edit after only a range read, then accepts after a full read", async () => {
    const ws = workspace();
    try {
      await ws.put("proof.txt", "alpha\nbeta\ngamma\n");
      const range = await ws.run(readTool, { path: "proof.txt", offset: 1, limit: 2 });
      assert.equal(range.ok, true);
      assert.equal(range._read_state?.snapshot.partial, true, "a non-covering range is a partial snapshot");
      assert.equal(range._read_state?.range, true);

      const write = await ws.run(writeTool, { path: "proof.txt", content: "nope\n" });
      assert.equal(write.ok, false);
      assert.equal(write.error?.code, "read_required");
      assert.equal(write.output, FILE_PARTIAL_READ_MESSAGE);
      const edit = await ws.run(editTool, { path: "proof.txt", old_string: "alpha", new_string: "ALPHA" });
      assert.equal(edit.error?.code, "read_required");
      assert.equal(edit.output, FILE_PARTIAL_READ_MESSAGE);
      assert.equal(await ws.text("proof.txt"), "alpha\nbeta\ngamma\n");

      await ws.run(readTool, { path: "proof.txt" });
      const accepted = await ws.run(editTool, { path: "proof.txt", old_string: "alpha", new_string: "ALPHA" });
      assert.equal(accepted.ok, true, accepted.output);
      assert.equal(await ws.text("proof.txt"), "ALPHA\nbeta\ngamma\n");
    } finally {
      ws.dispose();
    }
  });

  it("clears an earlier full read's proof when a later range read happens (matches cold restore)", async () => {
    const ws = workspace();
    try {
      await ws.put("latest.txt", "one\ntwo\nthree\n");
      await ws.run(readTool, { path: "latest.txt" });
      await ws.run(readTool, { path: "latest.txt", offset: 3, limit: 1 });
      const result = await ws.run(writeTool, { path: "latest.txt", content: "x\n" });
      assert.equal(result.ok, false);
      assert.equal(result.error?.code, "read_required");
      // A covering range (offset 1, enough limit) does carry the whole file.
      await ws.run(readTool, { path: "latest.txt", offset: 1, limit: 99 });
      const covered = await ws.run(writeTool, { path: "latest.txt", content: "whole file seen\n" });
      assert.equal(covered.ok, true, covered.output);
    } finally {
      ws.dispose();
    }
  });

  it("treats a token-truncated whole-file view as partial, not as a full read", async () => {
    const ws = workspace();
    try {
      const line = "z".repeat(120);
      await ws.put("truncated.txt", Array.from({ length: 1000 }, () => line).join("\n"));
      const first = await ws.run(readTool, { path: "truncated.txt" });
      assert.equal(first.ok, true);
      assert.match(first.output, /^<system-reminder>The file is too large to display in full/);
      assert.equal(first._read_state?.snapshot.partial, true);
      const result = await ws.run(writeTool, { path: "truncated.txt", content: "small\n" });
      assert.equal(result.ok, false);
      assert.equal(result.error?.code, "read_required");
      assert.equal(result.output, FILE_PARTIAL_READ_MESSAGE);
      assert.equal((await ws.text("truncated.txt")).length > 100_000, true, "the file is untouched");
    } finally {
      ws.dispose();
    }
  });
});

describe("atomic CAS", () => {
  it("revalidates the revision right before the rename and leaves no temporary files", async () => {
    const ws = workspace();
    try {
      const fs = new NodeWorkspaceFileSystem({ cwd: ws.root, roots: [ws.root] });
      const path = ws.path("cas.txt");
      await writeFile(path, "v1\n");
      const read = await fs.readTextFile("cas.txt");

      // An external change lands inside the window between the early read and
      // the atomic replacement; the pre-rename check must reject it.
      await writeFile(path, "v2 external\n");
      await assert.rejects(
        fs.writeTextFile(path, "agent rewrite\n", { expectedRevision: read.sha256 }),
        WorkspaceRevisionMismatchError,
      );
      assert.equal(await ws.text("cas.txt"), "v2 external\n");
      const leftovers = (await readdir(ws.root)).filter((name) => name.includes(".tmp"));
      assert.deepEqual(leftovers, [], "a failed CAS cleans its temporary sibling");

      const fresh = await fs.readTextFile("cas.txt");
      const written = await fs.writeTextFile(path, "agent rewrite\n", { expectedRevision: fresh.sha256 });
      assert.equal(await ws.text("cas.txt"), "agent rewrite\n");
      assert.equal(written.sha256, createHash("sha256").update("agent rewrite\n").digest("hex"));
      assert.deepEqual((await readdir(ws.root)).filter((name) => name.includes(".tmp")), []);
    } finally {
      ws.dispose();
    }
  });

  it("honours cancellation before any bytes reach the target", async () => {
    const ws = workspace();
    try {
      const fs = new NodeWorkspaceFileSystem({ cwd: ws.root, roots: [ws.root] });
      await ws.put("cancel.txt", "keep\n");
      await assert.rejects(
        fs.writeTextFile("cancel.txt", "dropped\n", { expectedRevision: undefined, signal: AbortSignal.abort() }),
        (error: Error & { code?: string }) => error.code === "cancelled",
      );
      assert.equal(await ws.text("cancel.txt"), "keep\n");
      assert.deepEqual((await readdir(ws.root)).filter((name) => name.includes(".tmp")), []);
    } finally {
      ws.dispose();
    }
  });

  it("maps a lost revision race at the tool surface to stale_file", async () => {
    const ws = workspace();
    try {
      await ws.put("race-cas.txt", "v1\n");
      await ws.run(readTool, { path: "race-cas.txt" });
      await writeFile(join(ws.root, "race-cas.txt"), "user beat the agent\n");
      const result = await ws.run(writeTool, { path: "race-cas.txt", content: "agent\n" });
      assert.equal(result.ok, false);
      assert.equal(result.error?.code, "stale_file");
      assert.match(result.output, /^File has been modified since read/);
      assert.equal(await ws.text("race-cas.txt"), "user beat the agent\n");
    } finally {
      ws.dispose();
    }
  });
});

describe("multi-replace", () => {
  it("terminates when the replacement contains the search text, and counts every span", async () => {
    const ws = workspace();
    try {
      await ws.put("grow.txt", "a-b-a-b-a\n");
      await ws.run(readTool, { path: "grow.txt" });
      const result = await ws.run(editTool, { path: "grow.txt", old_string: "a", new_string: "aa", replace_all: true });
      assert.equal(result.ok, true, result.output);
      assert.equal(result.data?.replacements, 3, "three original occurrences, no rescan of replaced text");
      assert.equal(await ws.text("grow.txt"), "aa-b-aa-b-aa\n");
    } finally {
      ws.dispose();
    }
  });

  it("keeps CRLF on every replaced span across multiple lines", async () => {
    const ws = workspace();
    try {
      await ws.put("multi-crlf.txt", "one\r\nskip\r\nthree\r\n");
      await ws.run(readTool, { path: "multi-crlf.txt" });
      const result = await ws.run(editTool, { path: "multi-crlf.txt", old_string: "one", new_string: "1", replace_all: true });
      assert.equal(result.ok, true, result.output);
      const alsoThree = await ws.run(editTool, { path: "multi-crlf.txt", old_string: "three\n", new_string: "3\n" });
      assert.equal(alsoThree.ok, true, alsoThree.output);
      assert.equal(await ws.text("multi-crlf.txt"), "1\r\nskip\r\n3\r\n");
    } finally {
      ws.dispose();
    }
  });
});
