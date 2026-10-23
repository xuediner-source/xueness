/** Parser and hunk matcher. Cases follow ZCode patch-parser.ts and patch-apply.ts. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { derivePatchedContent, parseStructuredPatch } from "../src/index.ts";

function patch(body: string): string {
  return `*** Begin Patch\n${body}\n*** End Patch`;
}

describe("parseStructuredPatch", () => {
  it("parses add, delete, update and move in appearance order", () => {
    const sections = parseStructuredPatch(patch([
      "*** Add File: src/new.ts",
      "+export const n = 1;",
      "+",
      "*** Delete File: src/old.ts",
      "*** Update File: src/app.ts",
      "*** Move to: src/main.ts",
      "@@ function main",
      " export function main() {",
      "-  return 1;",
      "+  return 2;",
      "*** End of File",
    ].join("\n")));

    assert.deepEqual(sections, [
      { type: "add", path: "src/new.ts", contents: "export const n = 1;\n\n" },
      { type: "delete", path: "src/old.ts" },
      {
        type: "update",
        path: "src/app.ts",
        movePath: "src/main.ts",
        chunks: [{
          oldLines: ["export function main() {", "  return 1;"],
          newLines: ["export function main() {", "  return 2;"],
          changeContext: "function main",
          endOfFile: true,
        }],
      },
    ]);
  });

  it("ignores a preamble, skips blank lines, and unwraps a heredoc", () => {
    const heredoc = [
      "cat <<'EOF'",
      "*** Begin Patch",
      "*** Add File: a.txt",
      "+hello",
      "*** End Patch",
      "EOF",
    ].join("\n");
    assert.deepEqual(parseStructuredPatch(`notes\n${patch("*** Add File: a.txt\n+hello")}\ntrailer`), [
      { type: "add", path: "a.txt", contents: "hello\n" },
    ]);
    assert.deepEqual(parseStructuredPatch(heredoc), [{ type: "add", path: "a.txt", contents: "hello\n" }]);
    assert.deepEqual(parseStructuredPatch(["<<PATCH", "*** Begin Patch", "*** Delete File: z.txt", "*** End Patch", "PATCH"].join("\n")), [
      { type: "delete", path: "z.txt" },
    ]);
  });

  it("normalises CR and CRLF patch text before parsing", () => {
    const crlf = "*** Begin Patch\r\n*** Add File: a.txt\r\n+one\r\n+two\r\n*** End Patch\r\n";
    assert.deepEqual(parseStructuredPatch(crlf), [{ type: "add", path: "a.txt", contents: "one\ntwo\n" }]);
    assert.deepEqual(parseStructuredPatch(crlf.replaceAll("\r\n", "\r")), [{ type: "add", path: "a.txt", contents: "one\ntwo\n" }]);
  });

  it("accepts an update with no hunks and an empty envelope", () => {
    assert.deepEqual(parseStructuredPatch(patch("*** Update File: a.txt")), [
      { type: "update", path: "a.txt", movePath: undefined, chunks: [] },
    ]);
    assert.deepEqual(parseStructuredPatch(patch("\n\n")), []);
  });

  it("rejects malformed envelopes with ZCode's messages", () => {
    assert.throws(() => parseStructuredPatch("no markers"), /Invalid patch format: missing Begin\/End markers/);
    assert.throws(() => parseStructuredPatch(patch("*** Rename File: a.txt")), /Invalid patch section header: \*\*\* Rename File: a\.txt/);
    assert.throws(() => parseStructuredPatch(patch("*** Add File: a.txt\nhello")), /Invalid add file line: hello/);
    assert.throws(() => parseStructuredPatch(patch("*** Update File: a.txt\nnot a hunk")), /Invalid update hunk header: not a hunk/);
    assert.throws(() => parseStructuredPatch(patch("*** Update File: a.txt\n@@\nno prefix")), /Invalid update hunk line: no prefix/);
    assert.throws(() => parseStructuredPatch(patch("*** Add File:")), /Missing path for \*\*\* Add File:/);
    assert.throws(() => parseStructuredPatch(patch("*** Delete File:   ")), /Missing path for \*\*\* Delete File:/);
    assert.throws(() => parseStructuredPatch("*** End Patch\n*** Begin Patch"), /Invalid patch format: missing Begin\/End markers/);
  });

  it("does not treat a Move header that is not the next line as a move", () => {
    assert.throws(
      () => parseStructuredPatch(patch("*** Update File: a.txt\n\n*** Move to: b.txt\n@@\n-a\n+b")),
      /Invalid update hunk header: \*\*\* Move to: b\.txt/,
    );
  });
});

describe("derivePatchedContent", () => {
  it("replaces an exact hunk and keeps a trailing newline", () => {
    const next = derivePatchedContent("one\ntwo\nthree\n", [{
      oldLines: ["two"],
      newLines: ["TWO"],
    }]);
    assert.equal(next.content, "one\nTWO\nthree\n");
  });

  it("matches the ZCode file-tool case where indentation differs by trim", () => {
    const next = derivePatchedContent("one\n  two\nthree\n", [{
      oldLines: ["two"],
      newLines: ["changed"],
    }]);
    assert.equal(next.content, "one\nchanged\nthree\n");
  });

  it("matches trimEnd before the looser trim", () => {
    const next = derivePatchedContent("keep\nvalue  \n", [{
      oldLines: ["value"],
      newLines: ["VALUE"],
    }]);
    assert.equal(next.content, "keep\nVALUE\n");
  });

  it("folds curly quotes, dashes, ellipsis and nbsp", () => {
    const next = derivePatchedContent("say “hi” — wait…\u00A0x\n", [{
      oldLines: ['say "hi" - wait... x'],
      newLines: ["said"],
    }]);
    assert.equal(next.content, "said\n");
  });

  it("uses @@ context and the end-of-file anchor to pick one of two copies", () => {
    const file = "function a() {\n  return 1;\n}\nfunction b() {\n  return 1;\n}\n";
    const context = derivePatchedContent(file, [{
      changeContext: "function b() {",
      oldLines: ["  return 1;"],
      newLines: ["  return 2;"],
    }]);
    assert.equal(context.content, "function a() {\n  return 1;\n}\nfunction b() {\n  return 2;\n}\n");

    const eof = derivePatchedContent("alpha\nbeta\nalpha\nbeta\n", [{
      oldLines: ["alpha", "beta"],
      newLines: ["ALPHA", "BETA"],
      endOfFile: true,
    }]);
    assert.equal(eof.content, "alpha\nbeta\nALPHA\nBETA\n");
  });

  it("inserts when the hunk has no old lines and drops a trailing empty pattern line", () => {
    assert.equal(derivePatchedContent("a\nb\n", [{ oldLines: [], newLines: ["c"] }]).content, "a\nb\nc\n");
    assert.equal(derivePatchedContent("", [{ oldLines: [], newLines: ["hello"] }]).content, "hello\n");
    const stripped = derivePatchedContent("a\nb\n", [{
      oldLines: ["a", "b", ""],
      newLines: ["a", "B", ""],
    }]);
    assert.equal(stripped.content, "a\nB\n");
  });

  it("reports the missing context and the original expected lines", () => {
    assert.throws(
      () => derivePatchedContent("a\n", [{ changeContext: "missing", oldLines: ["a"], newLines: ["b"] }]),
      (error: unknown) => error instanceof Error && error.message === "Failed to find context 'missing'",
    );
    assert.throws(
      () => derivePatchedContent("a\n", [{ oldLines: ["gone", "away"], newLines: ["x"] }]),
      (error: unknown) => error instanceof Error && error.message === "Failed to find expected lines:\ngone\naway",
    );
  });

  it("applies two hunks and adds a trailing newline the file did not have", () => {
    const next = derivePatchedContent("alpha\nbeta", [
      { oldLines: ["alpha"], newLines: ["ALPHA"] },
      { oldLines: ["beta"], newLines: ["BETA"] },
    ]);
    assert.equal(next.content, "ALPHA\nBETA\n");
  });
});
