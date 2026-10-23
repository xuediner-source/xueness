/**
 * Cases ported from ZCode v3.15.1 (aac4755, Apache-2.0) core/tests:
 * read-tool-contract, write-tool-contract, edit-tool-contract and
 * bash-handler / bash-result-mapping. Expected texts are ZCode's; Xueness
 * paths are workspace-relative inputs, so the texts carry the absolute path.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { after, describe, it } from "node:test";
import {
  editTool, estimateTokens, execTool, formatFileSize, readTool, READ_MAX_OUTPUT_TOKENS, semanticNonErrorExit, writeTool, WRITE_STORAGE_SUFFIX,
} from "../src/index.ts";
import { workspace } from "./helpers.ts";

const ws = workspace();
after(() => ws.dispose());
const posix = process.platform === "win32" ? "bash semantics are POSIX-only" : false;

describe("ZCode Read contract", () => {
  it("returns cat -n text and reads past 2000 lines when byte and token budgets allow", async () => {
    await ws.put("many.txt", Array.from({ length: 2500 }, (_, i) => `l${i + 1}`).join("\n"));
    const result = await ws.run(readTool, { path: "many.txt" });
    assert.equal(result.output.split("\n").length, 2500);
    assert.equal(result.output.split("\n").at(-1), "2500\tl2500");
  });

  it("normalizes UTF-8 BOM and CRLF while keeping the requested offset and limit", async () => {
    await ws.put("bom.txt", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a\r\nb\r\nc\r\n")]));
    assert.equal((await ws.run(readTool, { path: "bom.txt", offset: 2, limit: 1 })).output, "2\tb");
  });

  it("returns a missing-file message with cwd and a similar filename suggestion", async () => {
    await ws.put("config.json", "{}");
    const result = await ws.run(readTool, { path: "config.jsn" });
    assert.equal(result.error?.code, "not_found");
    assert.equal(result.output, `File does not exist. Note: your current working directory is ${ws.root}. Did you mean config.json?`);
  });

  it("returns the directory read error", async () => {
    await ws.put("folder/x.txt", "x");
    assert.equal((await ws.run(readTool, { path: "folder" })).output, `Path is a directory: ${ws.path("folder")}`);
  });

  it("rejects unsupported binary extensions and blocking device paths before I/O", async () => {
    assert.equal((await ws.run(readTool, { path: "archive.zip" })).output,
      "This tool cannot read binary files. The file appears to be a binary .zip file. Please use appropriate tools for binary file analysis.");
    assert.equal((await ws.run(readTool, { path: "/dev/zero" })).output, "Cannot read '/dev/zero': this device file would block or produce infinite output.");
  });

  it("refuses whole-file reads above 256KB but not when an explicit limit is given", async () => {
    await ws.put("big.txt", `${"y".repeat(99)}\n`.repeat(3000));
    const whole = await ws.run(readTool, { path: "big.txt" });
    assert.equal(whole.error?.code, "file_too_large");
    assert.equal(whole.output, `File content (${formatFileSize(300_000)}) exceeds maximum allowed size (256KB). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.`);
    const ranged = await ws.run(readTool, { path: "big.txt", offset: 10, limit: 2 });
    assert.equal(ranged.output, `10\t${"y".repeat(99)}\n11\t${"y".repeat(99)}`);
  });

  it("falls back to a partial view on a first read above the token limit, and errors on a range", async () => {
    // 1000 lines of 120 characters: about 41k estimated tokens, still under the 256KB byte guard.
    const line = "z".repeat(120);
    await ws.put("tokens.txt", Array.from({ length: 1000 }, () => line).join("\n"));
    assert.ok(estimateTokens(Array.from({ length: 1000 }, (_, i) => `${i + 1}\t${line}`).join("\n")) > READ_MAX_OUTPUT_TOKENS);
    const first = await ws.run(readTool, { path: "tokens.txt" });
    assert.equal(first.ok, true);
    const notice = first.output.split("\n\n")[0]!;
    assert.match(notice, /^<system-reminder>The file is too large to display in full \(\d+ estimated tokens, limit 25000\)\. Showing a partial view of lines 1-(\d+) of 1000\. Use Read with offset (\d+) and limit 2000 to continue, or use a search tool to find a specific section\.<\/system-reminder>$/);
    const ranged = await ws.run(readTool, { path: "tokens.txt", offset: 2, limit: 999 });
    assert.equal(ranged.error?.code, "file_too_large");
    assert.match(ranged.output, /^File content \(\d+ tokens\) exceeds maximum allowed tokens \(25000\)\./);
  });
});

describe("ZCode Write contract", () => {
  it("maps create and update results for the model", async () => {
    const created = await ws.run(writeTool, { path: "w/new.txt", content: "a\n" });
    assert.equal(created.output, `File created successfully at: ${ws.path("w/new.txt")}${WRITE_STORAGE_SUFFIX}`);
    const again = await ws.run(writeTool, { path: "w/new.txt", content: "a\n" });
    assert.equal(again.output, `The file ${ws.path("w/new.txt")} has been updated successfully.${WRITE_STORAGE_SUFFIX}`, "a no-op overwrite still reports an update");
  });

  it("requires an existing file to be read, and refuses one changed since", async () => {
    await ws.put("w/old.txt", "v1\n");
    assert.equal((await ws.run(writeTool, { path: "w/old.txt", content: "x" })).output, "File has not been read yet. Read it first before writing to it.");
    await ws.run(readTool, { path: "w/old.txt" });
    await writeFile(ws.path("w/old.txt"), "v2 changed\n");
    assert.equal((await ws.run(writeTool, { path: "w/old.txt", content: "x" })).output,
      "File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.");
  });
});

describe("ZCode Edit contract", () => {
  it("writes dollar replacement tokens literally", async () => {
    await ws.put("e/dollar.txt", "first TOKEN\nsecond TOKEN\n");
    await ws.run(readTool, { path: "e/dollar.txt" });
    await ws.run(editTool, { path: "e/dollar.txt", old_string: "first TOKEN", new_string: "first $$ and $&" });
    assert.equal(await ws.text("e/dollar.txt"), "first $$ and $&\nsecond TOKEN\n");
  });

  it("creates a missing file from empty old_string but maps it as an update", async () => {
    const result = await ws.run(editTool, { path: "e/generated/created.txt", old_string: "", new_string: "created\ncontent\n" });
    assert.equal(await ws.text("e/generated/created.txt"), "created\ncontent\n");
    assert.equal(result.output, `The file ${ws.path("e/generated/created.txt")} has been updated successfully.${WRITE_STORAGE_SUFFIX}`);
  });

  it("fills an existing empty file with empty old_string after it has been read, and refuses a nonempty one", async () => {
    await ws.put("e/empty.txt", "");
    assert.equal((await ws.run(editTool, { path: "e/empty.txt", old_string: "", new_string: "filled\n" })).error?.code, "read_required");
    await ws.run(readTool, { path: "e/empty.txt" });
    assert.equal((await ws.run(editTool, { path: "e/empty.txt", old_string: "", new_string: "filled\n" })).ok, true);
    assert.equal(await ws.text("e/empty.txt"), "filled\n");
    assert.equal((await ws.run(editTool, { path: "e/empty.txt", old_string: "", new_string: "again" })).output, "Cannot create new file - file already exists.");
  });

  it("rejects no-op edits before filesystem access", async () => {
    assert.equal((await ws.run(editTool, { path: "e/never.txt", old_string: "a", new_string: "a" })).output,
      "No changes to make: old_string and new_string are exactly the same.");
  });

  it("returns missing-file messages with cwd and similar filename suggestions", async () => {
    await ws.put("e/notes.md", "x");
    assert.equal((await ws.run(editTool, { path: "e/notes.mdx", old_string: "x", new_string: "y" })).output,
      `File does not exist. Note: your current working directory is ${ws.root}. Did you mean notes.md?`);
  });

  it("returns old_string not found and ambiguous-match messages", async () => {
    await ws.put("e/dup.txt", "same\nsame\n");
    await ws.run(readTool, { path: "e/dup.txt" });
    assert.equal((await ws.run(editTool, { path: "e/dup.txt", old_string: "missing", new_string: "x" })).output, "String to replace not found in file.\nString: missing");
    assert.equal((await ws.run(editTool, { path: "e/dup.txt", old_string: "same", new_string: "x" })).output,
      "Found 2 matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: same");
  });
});

describe("ZCode Bash result mapping", { skip: posix }, () => {
  it("prefixes real failures with Exit code and trims stdout and stderr", async () => {
    const result = await ws.run(execTool, { command: "printf '\\n\\nout  \\n'; printf ' err \\n' >&2; exit 2" });
    assert.equal(result.output, "Exit code 2\nout\nerr");
  });

  it("treats grep/rg/diff/test/find exit 1 as a semantic non-error", () => {
    assert.equal(semanticNonErrorExit("rg foo src", 1), "No matches found");
    assert.equal(semanticNonErrorExit("cat a | grep x", 1), "No matches found");
    assert.equal(semanticNonErrorExit("git diff --quiet", 1), "Files differ");
    assert.equal(semanticNonErrorExit("[ -f x ]", 1), "Condition is false");
    assert.equal(semanticNonErrorExit("grep x a; false", 1), undefined, "only the last command decides");
    assert.equal(semanticNonErrorExit("grep x a", 2), undefined);
  });
});
