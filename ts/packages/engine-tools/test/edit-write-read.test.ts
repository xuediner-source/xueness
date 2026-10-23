import assert from "node:assert/strict";
import { symlink, utimes, writeFile, lstat, readlink, chmod, stat } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { editTool, encodeText, normalizeLegacyArgs, readTool, writeTool } from "../src/index.ts";
import { pythonUnavailableReason, runPython } from "../../../test-support/python-oracle.ts";
import { workspace } from "./helpers.ts";

const ws = workspace();
after(() => ws.dispose());

describe("read", () => {
  it("numbers lines, pages, and reports CRLF as LF text", async () => {
    await ws.put("crlf.txt", "one\r\ntwo\r\nthree\r\n");
    const result = await ws.run(readTool, { path: "crlf.txt", offset: 2, limit: 1 });
    assert.equal(result.ok, true);
    // ZCode: no trailer; paging is in data.nextOffset.
    assert.equal(result.output, "2\ttwo");
    assert.deepEqual({ ...result.data, path: undefined }, {
      path: undefined, encoding: "utf-8", lineEnding: "CRLF", totalLines: 3, startLine: 2, endLine: 2, nextOffset: 3,
    });
  });

  it("keeps long lines whole and warns about empty files and offsets past the end (ZCode texts)", async () => {
    await ws.put("long.txt", `${"x".repeat(2500)}\nshort\n`);
    const long = await ws.run(readTool, { path: "long.txt" });
    assert.match(long.output, /^1\tx{2500}\n2\tshort$/);
    await ws.put("empty.txt", "");
    assert.equal((await ws.run(readTool, { path: "empty.txt" })).output, "<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>");
    assert.equal((await ws.run(readTool, { path: "long.txt", offset: 9 })).output,
      "<system-reminder>Warning: the file exists but is shorter than the provided offset (9). The file has 2 lines.</system-reminder>");
  });

  it("refuses binary files, directories and paths outside the workspace with stable codes", async () => {
    await ws.put("bin.dat", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 1, 2]));
    assert.equal((await ws.run(readTool, { path: "bin.dat" })).error?.code, "binary_file");
    await ws.put("dir/inner.txt", "x");
    assert.equal((await ws.run(readTool, { path: "dir" })).error?.code, "is_directory");
    assert.equal((await ws.run(readTool, { path: "../outside.txt" })).error?.code, "path_outside_workspace");
    await symlink(ws.base, ws.path("escape"), process.platform === "win32" ? "junction" : "dir");
    assert.equal((await ws.run(readTool, { path: "escape/ws/dir/inner.txt" })).ok, true, "a link back inside stays allowed");
    await writeFile(join(ws.base, "secret.txt"), "s");
    assert.equal((await ws.run(readTool, { path: "escape/secret.txt" })).error?.code, "path_outside_workspace");
    assert.equal((await ws.run(readTool, { path: "missing.txt" })).error?.code, "not_found");
    assert.equal((await ws.run(readTool, { path: "x", limit: 0 })).error?.code, "invalid_argument");
  });
});

describe("edit", () => {
  it("requires a read first and refuses stale files", async () => {
    await ws.put("fresh.txt", "alpha\nbeta\n");
    const unread = await ws.run(editTool, { path: "fresh.txt", old_string: "alpha", new_string: "ALPHA" });
    assert.equal(unread.error?.code, "read_required");
    await ws.run(readTool, { path: "fresh.txt" });
    await writeFile(ws.path("fresh.txt"), "alpha\nbeta\ngamma\n");
    const stale = await ws.run(editTool, { path: "fresh.txt", old_string: "alpha", new_string: "ALPHA" });
    assert.equal(stale.error?.code, "stale_file");
    assert.equal(await ws.text("fresh.txt"), "alpha\nbeta\ngamma\n");
  });

  it("keeps CRLF and every byte outside the replaced region", async () => {
    const before = "first\r\nsecond\r\nthird\r\n";
    await ws.put("win.txt", before);
    await ws.run(readTool, { path: "win.txt" });
    const result = await ws.run(editTool, { path: "win.txt", old_string: "second\nthird", new_string: "2nd\nline\n3rd" });
    assert.equal(result.ok, true, result.output);
    assert.equal(await ws.text("win.txt"), "first\r\n2nd\r\nline\r\n3rd\r\n");
    assert.match(result.data!.diff, /-second\n-third\n\+2nd\n\+line\n\+3rd/);
    assert.equal(result.output, `The file ${ws.path("win.txt")} has been updated successfully. (file state is current in your context \u2014 no need to Read it back)`);
  });

  it("leaves mixed line endings alone outside the edit", async () => {
    await ws.put("mixed.txt", "a\r\nb\nc\r\nd\n");
    await ws.run(readTool, { path: "mixed.txt" });
    assert.equal((await ws.run(editTool, { path: "mixed.txt", old_string: "c", new_string: "C" })).ok, true);
    assert.equal(await ws.text("mixed.txt"), "a\r\nb\nC\r\nd\n");
  });

  it("keeps a UTF-8 BOM and edits GBK files as GBK", async () => {
    await ws.put("bom.txt", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("名字 = 旧\n")]));
    await ws.run(readTool, { path: "bom.txt" });
    await ws.run(editTool, { path: "bom.txt", old_string: "旧", new_string: "新" });
    assert.deepEqual([...(await ws.bytes("bom.txt")).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.equal((await ws.bytes("bom.txt")).subarray(3).toString("utf8"), "名字 = 新\n");

    const gbk = encodeText("# 配置文件\r\n标题 = 旧的标题\r\n", "gbk");
    await ws.put("gbk.ini", gbk);
    const read = await ws.run(readTool, { path: "gbk.ini" });
    assert.equal(read.output, "1\t# 配置文件\n2\t标题 = 旧的标题");
    const edit = await ws.run(editTool, { path: "gbk.ini", old_string: "旧的标题", new_string: "新的标题：完成" });
    assert.equal(edit.ok, true, edit.output);
    assert.deepEqual(await ws.bytes("gbk.ini"), Buffer.from(encodeText("# 配置文件\r\n标题 = 新的标题：完成\r\n", "gbk")));
    if (!pythonUnavailableReason()) {
      const text = runPython(`import sys; sys.stdout.buffer.write(open(${JSON.stringify(ws.path("gbk.ini"))}, encoding="gbk", newline="").read().encode("utf-8"))`);
      assert.equal(text, "# 配置文件\r\n标题 = 新的标题：完成\r\n");
    }
    const lossy = await ws.run(editTool, { path: "gbk.ini", old_string: "完成", new_string: "完成 🎉" });
    assert.equal(lossy.ok, false, "an emoji cannot be stored in GBK; the edit must be refused, not mangled");
    assert.equal(lossy.error?.code, "unsupported_encoding");
  });

  it("reports ambiguous and missing matches, and supports replace_all", async () => {
    await ws.put("dup.txt", "x = 1\ny = 2\nx = 1\n");
    await ws.run(readTool, { path: "dup.txt" });
    assert.equal((await ws.run(editTool, { path: "dup.txt", old_string: "x = 1", new_string: "x = 3" })).error?.code, "ambiguous_match");
    const missing = await ws.run(editTool, { path: "dup.txt", old_string: "y = 22", new_string: "y = 3" });
    assert.equal(missing.error?.code, "not_found");
    assert.equal(missing.output, "String to replace not found in file.\nString: y = 22");
    const ambiguous = await ws.run(editTool, { path: "dup.txt", old_string: "x = 1", new_string: "x = 3" });
    assert.match(ambiguous.output, /^Found 2 matches of the string to replace, but replace_all is false\./);
    const all = await ws.run(editTool, { path: "dup.txt", old_string: "x = 1", new_string: "x = 3", replace_all: true });
    assert.equal(all.data?.replacements, 2);
    assert.equal(await ws.text("dup.txt"), "x = 3\ny = 2\nx = 3\n");
    assert.match(all.output, /has been updated\. All occurrences were successfully replaced\./);
    const same = await ws.run(editTool, { path: "dup.txt", old_string: "y = 2", new_string: "y = 2" });
    assert.equal(same.error?.code, "no_change");
    assert.equal(same.output, "No changes to make: old_string and new_string are exactly the same.");
  });

  it("accepts text copied from read output and typographic quotes", async () => {
    await ws.put("code.py", "def greet():\n    print(\"hi\")\n    return 1\n");
    const read = await ws.run(readTool, { path: "code.py" });
    const copied = read.output.split("\n").slice(1, 2).join("\n");
    const numbered = await ws.run(editTool, { path: "code.py", old_string: copied, new_string: "    print(\"hello\")" });
    assert.equal(numbered.data?.strategy, "line_number_prefix_stripped");
    const quotes = await ws.run(editTool, { path: "code.py", old_string: "print(“hello”)", new_string: "print(\"hey\")" });
    assert.equal(quotes.data?.strategy, "quote_normalized");
    assert.equal(await ws.text("code.py"), "def greet():\n    print(\"hey\")\n    return 1\n");
  });

  it("uses the ZCode matchers on a CRLF file and keeps CRLF outside the edit", async () => {
    await ws.put("crlf-edit.ts", "function f() {\r\n\tif (ready) {\r\n\t\tload();\r\n\t}\r\n}\r\n");
    await ws.run(readTool, { path: "crlf-edit.ts" });
    const trimmed = await ws.run(editTool, {
      path: "crlf-edit.ts", old_string: "if (ready) {\n  load();\n}", new_string: "\tif (ready) {\n\t\tsave();\n\t}",
    });
    assert.equal(trimmed.ok, true, trimmed.output);
    assert.equal(trimmed.data?.strategy, "line_trimmed");
    assert.equal(await ws.text("crlf-edit.ts"), "function f() {\r\n\tif (ready) {\r\n\t\tsave();\r\n\t}\r\n}\r\n");
    const deleted = await ws.run(editTool, { path: "crlf-edit.ts", old_string: "\t\tsave();", new_string: "" });
    assert.equal(deleted.ok, true, deleted.output);
    assert.equal(await ws.text("crlf-edit.ts"), "function f() {\r\n\tif (ready) {\r\n\t}\r\n}\r\n");
    await ws.put("blank.txt", "a\n\nb");
    await ws.run(readTool, { path: "blank.txt" });
    assert.equal((await ws.run(editTool, { path: "blank.txt", old_string: "\t\t", new_string: "x" })).error?.code, "not_found");
  });

  it("accepts the Python tool's old/new argument names", async () => {
    await ws.put("legacy.txt", "old text\n");
    await ws.run(readTool, { path: "legacy.txt" });
    const result = await ws.run(editTool, normalizeLegacyArgs("edit", { path: "legacy.txt", old: "old", new: "new" }));
    assert.equal(result.ok, true, result.output);
    assert.equal(await ws.text("legacy.txt"), "new text\n");
  });
});

describe("write", () => {
  it("creates new files and directories without a read", async () => {
    const result = await ws.run(writeTool, { path: "new/deep/file.txt", content: "hello\n" });
    assert.equal(result.ok, true, result.output);
    assert.equal(await ws.text("new/deep/file.txt"), "hello\n");
  });

  it("requires a read before overwriting and keeps encoding, line ending, mode and symlinks", async () => {
    const windows = process.platform === "win32";
    const target = windows ? "write-target/target.txt" : "target.txt";
    const link = windows ? "write-link/target.txt" : "link.txt";
    const linkEntry = windows ? "write-link" : link;
    await ws.put(target, encodeText("旧\r\n", "gbk"));
    await chmod(ws.path(target), 0o640);
    const mode = (await stat(ws.path(target))).mode & 0o777;
    await symlink(windows ? ws.path("write-target") : "target.txt", ws.path(linkEntry), windows ? "junction" : "file");
    assert.equal((await ws.run(writeTool, { path: link, content: "x" })).error?.code, "read_required");
    await ws.run(readTool, { path: link });
    const result = await ws.run(writeTool, { path: link, content: "新内容\n第二行\n" });
    assert.equal(result.ok, true, result.output);
    assert.equal((await lstat(ws.path(linkEntry))).isSymbolicLink(), true);
    assert.equal(await readlink(ws.path(linkEntry)), windows ? ws.path("write-target") : "target.txt");
    assert.deepEqual(await ws.bytes(target), Buffer.from(encodeText("新内容\r\n第二行\r\n", "gbk")));
    assert.equal((await stat(ws.path(target))).mode & 0o777, mode);
  });

  it("refuses to overwrite a file changed after the read", async () => {
    await ws.put("race.txt", "v1\n");
    await ws.run(readTool, { path: "race.txt" });
    await writeFile(ws.path("race.txt"), "v2 from the user\n");
    await utimes(ws.path("race.txt"), new Date(), new Date(Date.now() + 5000));
    assert.equal((await ws.run(writeTool, { path: "race.txt", content: "agent\n" })).error?.code, "stale_file");
    assert.equal(await ws.text("race.txt"), "v2 from the user\n");
  });
});
