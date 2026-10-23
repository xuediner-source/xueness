/** apply_patch tool. ZCode file-tool-port ApplyPatch cases plus encoding, paths and atomicity. */
import assert from "node:assert/strict";
import { chmod, lstat, readFile, readlink, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import {
  APPLY_PATCH_DESCRIPTION,
  BUILTIN_TOOLS,
  WRITES_WORKSPACE,
  applyPatchTool,
  createApplyPatchTool,
  editTool,
  encodeText,
  readTool,
} from "../src/index.ts";
import { pythonUnavailableReason, runPython } from "../../../test-support/python-oracle.ts";
import { workspace } from "./helpers.ts";

const ws = workspace();
after(() => ws.dispose());

function envelope(body: string): string {
  return `*** Begin Patch\n${body}\n*** End Patch`;
}

async function located(rel: string): Promise<string> {
  try {
    return await realpath(ws.path(rel));
  } catch {
    return resolve(await realpath(ws.root), rel);
  }
}

describe("apply_patch contract", () => {
  it("exposes the ZCode description, schema and edit-gate metadata", () => {
    const tool = createApplyPatchTool();
    assert.equal(tool.name, "apply_patch");
    assert.equal(tool.description, APPLY_PATCH_DESCRIPTION);
    assert.match(tool.description, /structured file patches/);
    assert.match(tool.description, /do not switch to Python/);
    assert.match(tool.description, /GB2312/);
    assert.doesNotMatch(tool.description, /ZCode|Z\.AI/);
    assert.equal(tool.gate, "edit");
    assert.equal(tool.mutating, true);
    assert.equal(tool.concurrencySafe, false);
    assert.equal(tool.requires, WRITES_WORKSPACE);
    assert.equal(tool.subjectKind, undefined);
    assert.equal(applyPatchTool.name, "apply_patch");
    assert.equal(BUILTIN_TOOLS.some((entry) => entry.name === "apply_patch"), true);
    assert.deepEqual(tool.inputSchema, {
      type: "object",
      additionalProperties: false,
      required: ["patch_text"],
      properties: {
        patch_text: { type: "string", description: "The full structured patch text to apply" },
      },
    });
    assert.deepEqual(tool.subjectPaths?.({
      patch_text: envelope([
        "*** Update File: b.txt",
        "*** Move to: nested/c.txt",
        "@@",
        "-a",
        "+b",
        "*** Delete File: a.txt",
        "*** Add File: d.txt",
        "+z",
      ].join("\n")),
    }), ["b.txt", "nested/c.txt", "a.txt", "d.txt"]);
    assert.throws(() => tool.subjectPaths?.({ patch_text: "not a patch" }), { code: "apply_patch_invalid_patch" });
    assert.throws(() => tool.subjectPaths?.({ patch_text: envelope("") }), (error: { code?: string }) => typeof error.code === "string" && error.code.startsWith("apply_patch_"));
  });

  it("rejects schema mistakes before parsing", async () => {
    assert.equal((await ws.run(applyPatchTool, {})).error?.code, "invalid_argument");
    assert.equal((await ws.run(applyPatchTool, { patch_text: "x", extra: true })).error?.code, "invalid_argument");
  });
});

describe("apply_patch files", () => {
  it("applies the ZCode hunk, reports the model text, and counts the diff", async () => {
    await ws.put("trim.txt", "one\n  two\nthree\n");
    const absolute = await located("trim.txt");
    const result = await ws.run(applyPatchTool, {
      patch_text: envelope(`*** Update File: trim.txt\n@@\n-two\n+changed`),
    });
    assert.equal(result.ok, true, result.output);
    assert.equal(result.output, `Patch applied successfully.\nM ${absolute}`);
    assert.equal(await ws.text("trim.txt"), "one\nchanged\nthree\n");
    assert.equal(result.data?.files[0]?.added, 1);
    assert.equal(result.data?.files[0]?.removed, 1);
    assert.equal(result.data?.files[0]?.type, "update");
    assert.equal(result.data?.files[0]?.path, "trim.txt");
    assert.match(result.data?.files[0]?.diff ?? "", /- {2}two\n\+changed/);
    assert.doesNotMatch(result.output, /---|\+changed/);
  });

  it("adds, updates, deletes and moves only after every section verifies", async () => {
    await ws.put("updated.txt", "old\n");
    await ws.put("removed.txt", "gone\n");
    await ws.put("moved.txt", "from\n");
    const result = await ws.run(applyPatchTool, {
      patch_text: envelope([
        "*** Add File: nested/created.txt",
        "+hi",
        "*** Update File: updated.txt",
        "@@",
        "-old",
        "+new",
        "*** Delete File: removed.txt",
        "*** Update File: moved.txt",
        "*** Move to: dest.txt",
        "@@",
        "-from",
        "+to",
      ].join("\n")),
    });
    const created = await located("nested/created.txt");
    const updated = await located("updated.txt");
    const removed = await located("removed.txt");
    const dest = await located("dest.txt");
    assert.equal(result.output, [
      "Patch applied successfully.",
      `A ${created}`,
      `M ${updated}`,
      `D ${removed}`,
      `M ${dest}`,
    ].join("\n"));
    assert.equal(await ws.text("nested/created.txt"), "hi\n");
    assert.equal(await ws.text("updated.txt"), "new\n");
    await assert.rejects(ws.text("removed.txt"));
    await assert.rejects(ws.text("moved.txt"));
    assert.equal(await ws.text("dest.txt"), "to\n");
    assert.equal(result.data?.files[0]?.type, "add");
    assert.equal(result.data?.files[0]?.added, 1);
    assert.equal(result.data?.files[2]?.type, "delete");
    assert.equal(result.data?.files[2]?.removed, 1);
    assert.equal(result.data?.files[3]?.type, "move");
    assert.equal(result.data?.files[3]?.movePath, dest);
    assert.equal(result.data?.summary, result.output.split("\n").slice(1).join("\n"));
  });

  it("writes nothing when a later hunk, an existing add, or encoding fails", async () => {
    await ws.put("keep.txt", "one\ntwo\n");
    await ws.put("exists.txt", "stay\n");
    const missing = await ws.run(applyPatchTool, {
      patch_text: envelope([
        "*** Add File: created-fail.txt",
        "+created",
        "*** Update File: keep.txt",
        "@@",
        "-missing",
        "+changed",
      ].join("\n")),
    });
    assert.equal(missing.error?.code, "apply_patch_hunk_not_found");
    assert.match(missing.output, /Failed to find expected lines:\nmissing/);
    await assert.rejects(ws.text("created-fail.txt"));
    assert.equal(await ws.text("keep.txt"), "one\ntwo\n");

    const clash = await ws.run(applyPatchTool, {
      patch_text: envelope([
        "*** Update File: keep.txt",
        "@@",
        "-one",
        "+ONE",
        "*** Add File: exists.txt",
        "+nope",
      ].join("\n")),
    });
    assert.equal(clash.error?.code, "apply_patch_file_exists");
    assert.equal(clash.error?.message, `File already exists: ${await located("exists.txt")}`);
    assert.equal(await ws.text("keep.txt"), "one\ntwo\n");
    assert.equal(await ws.text("exists.txt"), "stay\n");

    const gbk = encodeText("标题 = 旧\r\n", "gbk");
    await ws.put("keep-gbk.txt", gbk);
    const encoded = await ws.run(applyPatchTool, {
      patch_text: envelope([
        "*** Add File: created-gbk.txt",
        "+ok",
        "*** Update File: keep-gbk.txt",
        "@@",
        "-标题 = 旧",
        "+标题 = 新 🎉",
      ].join("\n")),
    });
    assert.equal(encoded.error?.code, "unsupported_encoding");
    await assert.rejects(ws.text("created-gbk.txt"));
    assert.deepEqual(await ws.bytes("keep-gbk.txt"), Buffer.from(gbk));
  });

  it("preserves CRLF, a UTF-8 BOM, GBK bytes and the file mode", async () => {
    await ws.put("win.txt", "one\r\ntwo\r\nthree\r\n");
    await chmod(ws.path("win.txt"), 0o640);
    const mode = (await stat(ws.path("win.txt"))).mode & 0o777;
    const crlf = await ws.run(applyPatchTool, {
      patch_text: envelope("*** Update File: win.txt\n@@\n-two\n+2"),
    });
    assert.equal(crlf.ok, true, crlf.output);
    assert.equal(await ws.text("win.txt"), "one\r\n2\r\nthree\r\n");
    assert.equal(crlf.data?.files[0]?.lineEnding, "CRLF");
    assert.equal((await stat(ws.path("win.txt"))).mode & 0o777, mode);

    await ws.put("mix.txt", "a\r\nb\nc\r\n");
    assert.equal((await ws.run(applyPatchTool, { patch_text: envelope("*** Update File: mix.txt\n@@\n-b\n+B") })).ok, true);
    assert.equal(await ws.text("mix.txt"), "a\r\nB\r\nc\r\n");

    await ws.put("bom.txt", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("old\n")]));
    assert.equal((await ws.run(applyPatchTool, { patch_text: envelope("*** Update File: bom.txt\n@@\n-old\n+new") })).ok, true);
    const bom = await ws.bytes("bom.txt");
    assert.deepEqual([...bom.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.equal(bom.subarray(3).toString("utf8"), "new\n");

    const gbk = encodeText("# 配置\r\n标题 = 旧\r\n", "gbk");
    await ws.put("gbk.ini", gbk);
    const edited = await ws.run(applyPatchTool, {
      patch_text: envelope("*** Update File: gbk.ini\n@@\n-标题 = 旧\n+标题 = 新的"),
    });
    assert.equal(edited.ok, true, edited.output);
    assert.equal(edited.data?.files[0]?.encoding, "gbk");
    assert.deepEqual(await ws.bytes("gbk.ini"), Buffer.from(encodeText("# 配置\r\n标题 = 新的\r\n", "gbk")));
    if (!pythonUnavailableReason()) {
      const text = runPython(`import sys; sys.stdout.buffer.write(open(${JSON.stringify(ws.path("gbk.ini"))}, encoding="gbk", newline="").read().encode("utf-8"))`);
      assert.equal(text, "# 配置\r\n标题 = 新的\r\n");
    }

    await ws.put("u16.txt", encodeText("old\n", "utf-16le"));
    assert.equal((await ws.run(applyPatchTool, { patch_text: envelope("*** Update File: u16.txt\n@@\n-old\n+new") })).ok, true);
    assert.deepEqual(await ws.bytes("u16.txt"), Buffer.from(encodeText("new\n", "utf-16le")));
  });

  it("does not require a prior read, then records bytes so edit can continue", async () => {
    await ws.put("chain.txt", "alpha\n");
    const unread = await ws.run(applyPatchTool, { patch_text: envelope("*** Update File: chain.txt\n@@\n-alpha\n+beta") });
    assert.equal(unread.ok, true, unread.output);
    assert.notEqual(unread.error?.code, "read_required");
    const absolute = await located("chain.txt");
    assert.ok(ws.env.tracker.get(absolute));
    const edited = await ws.run(editTool, { path: "chain.txt", old_string: "beta", new_string: "gamma" });
    assert.equal(edited.ok, true, edited.output);
    assert.equal(await ws.text("chain.txt"), "gamma\n");

    await ws.put("seen.txt", "v1\n");
    await ws.run(readTool, { path: "seen.txt" });
    await writeFile(ws.path("seen.txt"), "v2\n");
    const missed = await ws.run(applyPatchTool, { patch_text: envelope("*** Update File: seen.txt\n@@\n-v1\n+v3") });
    assert.equal(missed.error?.code, "apply_patch_hunk_not_found");
    assert.equal(await ws.text("seen.txt"), "v2\n");
    const hit = await ws.run(applyPatchTool, { patch_text: envelope("*** Update File: seen.txt\n@@\n-v2\n+v3") });
    assert.equal(hit.ok, true, hit.output);
    assert.equal(await ws.text("seen.txt"), "v3\n");
  });

  it("rejects paths outside the workspace, including a symlink that escapes it", async () => {
    const outside = await ws.run(applyPatchTool, { patch_text: envelope("*** Add File: ../outside.txt\n+no") });
    assert.equal(outside.error?.code, "path_outside_workspace");
    assert.equal(outside.error?.message, "path is outside the workspace: ../outside.txt");
    await symlink(ws.base, ws.path("escape"), process.platform === "win32" ? "junction" : "dir");
    await writeFile(join(ws.base, "secret.txt"), "s");
    const linked = await ws.run(applyPatchTool, { patch_text: envelope("*** Update File: escape/secret.txt\n@@\n-s\n+t") });
    assert.equal(linked.error?.code, "path_outside_workspace");
    assert.equal(await readFile(join(ws.base, "secret.txt"), "utf8"), "s");

    await ws.put("inside.txt", "ok\n");
    const absolute = await located("inside.txt");
    const inside = await ws.run(applyPatchTool, { patch_text: envelope(`*** Update File: ${absolute}\n@@\n-ok\n+OK`) });
    assert.equal(inside.ok, true, inside.output);
    assert.equal(await ws.text("inside.txt"), "OK\n");
  });

  it("uses ZCode messages for missing files, directories, empty patches and bad hunks", async () => {
    const missing = await located("missing.txt");
    const gone = await ws.run(applyPatchTool, { patch_text: envelope("*** Update File: missing.txt\n@@\n-a\n+b") });
    assert.deepEqual(gone.error, { code: "apply_patch_file_not_exist", message: `File not found: ${missing}` });
    const deleted = await ws.run(applyPatchTool, { patch_text: envelope("*** Delete File: missing.txt") });
    assert.equal(deleted.error?.code, "apply_patch_file_not_exist");

    await ws.put("dir/inner.txt", "x");
    const directory = await located("dir");
    const asFile = await ws.run(applyPatchTool, { patch_text: envelope("*** Delete File: dir\n") });
    assert.deepEqual(asFile.error, { code: "is_directory", message: `Cannot read directory as text file: ${directory}` });
    const addDir = await ws.run(applyPatchTool, { patch_text: envelope("*** Add File: dir\n+x") });
    assert.equal(addDir.error?.message, `File already exists: ${directory}`);

    assert.deepEqual((await ws.run(applyPatchTool, { patch_text: envelope("") })).error, {
      code: "apply_patch_empty_patch",
      message: "patch rejected: empty patch",
    });
    assert.equal((await ws.run(applyPatchTool, { patch_text: "" })).error?.message, "Invalid patch format: missing Begin/End markers");
    assert.equal((await ws.run(applyPatchTool, { patch_text: envelope("*** Update File: dir/inner.txt") })).error?.message, "Update file section has no hunks");

    await ws.put("bin.dat", new Uint8Array([0, 1, 2, 3, 4]));
    const binary = await ws.run(applyPatchTool, { patch_text: envelope("*** Delete File: bin.dat") });
    assert.equal(binary.error?.code, "binary_file");
    assert.equal((await ws.bytes("bin.dat")).length, 5);
  });

  it("follows an in-workspace symlink, creates parents, and refuses to overwrite a move target", async () => {
    await ws.put("target.txt", "one\n");
    let linked = true;
    try { await symlink("target.txt", ws.path("link.txt")); }
    catch (error) { linked = false; if (!["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
    if (linked) {
      const viaLink = await ws.run(applyPatchTool, { patch_text: envelope("*** Update File: link.txt\n@@\n-one\n+two") });
      assert.equal(viaLink.ok, true, viaLink.output);
      assert.equal(await ws.text("target.txt"), "two\n");
      assert.equal((await lstat(ws.path("link.txt"))).isSymbolicLink(), true);
      assert.equal(await readlink(ws.path("link.txt")), "target.txt");
    }

    await ws.put("taken.txt", "keep\n");
    await ws.put("source.txt", "move-me\n");
    await ws.put("already.txt", "previous\n");
    const moved = await ws.run(applyPatchTool, {
      patch_text: envelope("*** Update File: source.txt\n*** Move to: sub/taken-renamed.txt\n@@\n-move-me\n+moved"),
    });
    assert.equal(moved.ok, true, moved.output);
    assert.equal(await ws.text("sub/taken-renamed.txt"), "moved\n");
    await assert.rejects(ws.text("source.txt"));
    // Xueness hardening: a move never overwrites another file, and a move onto itself keeps the file.
    const overwritten = await ws.run(applyPatchTool, {
      patch_text: envelope("*** Update File: sub/taken-renamed.txt\n*** Move to: already.txt\n@@\n-moved\n+landed"),
    });
    assert.equal(overwritten.error?.code, "apply_patch_file_exists");
    assert.equal(await ws.text("already.txt"), "previous\n");
    assert.equal(await ws.text("sub/taken-renamed.txt"), "moved\n");

    const same = await ws.run(applyPatchTool, {
      patch_text: envelope("*** Update File: taken.txt\n*** Move to: ./taken.txt\n@@\n-keep\n+KEEP"),
    });
    assert.equal(same.ok, true, same.output);
    assert.equal(await ws.text("taken.txt"), "KEEP\n");
  });

  it("rejects two sections on one file before writing anything", async () => {
    await ws.put("twice.txt", "a\nb\n");
    await ws.put("other.txt", "x\n");
    const result = await ws.run(applyPatchTool, {
      patch_text: envelope("*** Update File: other.txt\n@@\n-x\n+y\n*** Update File: twice.txt\n@@\n-a\n+A\n*** Update File: ./twice.txt\n@@\n-b\n+B"),
    });
    assert.equal(result.error?.code, "apply_patch_invalid_patch");
    assert.match(result.output, /more than one section touches/);
    assert.equal(await ws.text("twice.txt"), "a\nb\n");
    assert.equal(await ws.text("other.txt"), "x\n");
    const deleteThenAdd = await ws.run(applyPatchTool, { patch_text: envelope("*** Delete File: other.txt\n*** Add File: other.txt\n+new") });
    assert.equal(deleteThenAdd.ok, false);
    assert.equal(await ws.text("other.txt"), "x\n");
  });

  it("applies a heredoc and an end-of-file anchor to the last copy", async () => {
    const heredoc = ["cat <<'EOF'", "*** Begin Patch", "*** Add File: heredoc.txt", "+from-heredoc", "*** End Patch", "EOF"].join("\n");
    assert.equal((await ws.run(applyPatchTool, { patch_text: heredoc })).ok, true);
    assert.equal(await ws.text("heredoc.txt"), "from-heredoc\n");

    await ws.put("copies.txt", "alpha\nbeta\nalpha\nbeta\n");
    const eof = await ws.run(applyPatchTool, {
      patch_text: envelope("*** Update File: copies.txt\n@@\n-alpha\n-beta\n+ALPHA\n+BETA\n*** End of File"),
    });
    assert.equal(eof.ok, true, eof.output);
    assert.equal(await ws.text("copies.txt"), "alpha\nbeta\nALPHA\nBETA\n");
  });

  it("forgets a deleted path on the read tracker", async () => {
    await ws.put("tracked.txt", "gone\n");
    await ws.run(readTool, { path: "tracked.txt" });
    const absolute = await located("tracked.txt");
    assert.ok(ws.env.tracker.get(absolute));
    assert.equal((await ws.run(applyPatchTool, { patch_text: envelope("*** Delete File: tracked.txt") })).ok, true);
    assert.equal(ws.env.tracker.get(absolute), undefined);
  });
});
