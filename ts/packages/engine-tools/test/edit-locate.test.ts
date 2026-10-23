/**
 * Guards locateEdit adds on top of the ZCode v3.15.1 Edit handler order
 * (see src/edit-locate.ts), and the per-occurrence deletion rule.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyEditToContent, countOccurrences, findEditMatch, locateEdit } from "../src/index.ts";

describe("locateEdit guards", () => {
  it("refuses a whitespace-only old_string that only line-trimming can place", () => {
    const content = "a\n\nb\n";
    assert.deepEqual(findEditMatch({ content, search: "\t\t", replaceAll: false }), {
      status: "matched", strategy: "line_trimmed", actualString: "", candidateCount: 2,
    });
    assert.deepEqual(locateEdit(content, "\t\t", "x", false), { status: "not_found" });
    assert.deepEqual(locateEdit("a\n  \nb", "\t", "x", false), { status: "not_found" });
  });

  it("still allows an exact whitespace old_string", () => {
    const located = locateEdit("a  b\n", "  ", " ", false);
    assert.equal(located.status, "matched");
  });

  it("treats overlapping line-trimmed windows as ambiguous instead of taking the first", () => {
    const content = "  a\n  a\n  a";
    assert.equal(countOccurrences(content, "  a\n  a"), 1);
    assert.deepEqual(locateEdit(content, "a\na", "b\nb", false), { status: "ambiguous", strategy: "line_trimmed", count: 2 });
  });

  it("rejects repeated identical text found by a forgiving strategy", () => {
    const content = "x = \u201ca\u201d\ny = 1\nx = \u201ca\u201d\n";
    assert.deepEqual(locateEdit(content, 'x = "a"', 'x = "b"', false), { status: "ambiguous", strategy: "quote_normalized", count: 2 });
    const all = locateEdit(content, 'x = "a"', 'x = "b"', true);
    assert.equal(all.status, "matched");
    if (all.status === "matched") {
      assert.equal(all.spans.length, 2);
      assert.equal(applyEditToContent(content, all.actualOldString, all.actualNewString, true), "x = \u201cb\u201d\ny = 1\nx = \u201cb\u201d\n");
    }
  });

  it("does not curl straight code quotes after a whitespace-only (line_trimmed) match", () => {
    const content = "  s = \"a\"; t = \u201cb\u201d\n";
    const located = locateEdit(content, '      s = "a"; t = \u201cb\u201d', 's = "c"; t = \u201cb\u201d', false);
    assert.equal(located.status, "matched");
    if (located.status === "matched") {
      assert.equal(located.strategy, "line_trimmed");
      assert.equal(located.actualNewString, 's = "c"; t = \u201cb\u201d');
    }
  });

  it("keeps new_string as written when the matched text mixes straight and curly quotes", () => {
    const content = "x = \"a\" + \u201cb\u201d\n";
    const located = locateEdit(content, 'x = "a" + "b"', 'x = "c" + "b"', false);
    assert.equal(located.status, "matched");
    if (located.status === "matched") {
      assert.equal(located.strategy, "quote_normalized");
      assert.equal(located.actualNewString, 'x = "c" + "b"');
    }
  });

  it("curls quotes when the matched text uses curly quotes only", () => {
    const located = locateEdit("say \u201chi\u201d\n", 'say "hi"', 'say "bye"', false);
    assert.equal(located.status === "matched" && located.actualNewString, "say \u201cbye\u201d");
  });
});

describe("deleting with an empty new_string", () => {
  it("takes the newline only for occurrences that start a line", () => {
    assert.equal(applyEditToContent("keep\nremove\nlast\n", "remove", "", false), "keep\nlast\n");
    assert.equal(applyEditToContent("a = foo\nb\n", "foo", "", false), "a = \nb\n");
    assert.equal(applyEditToContent("keep\nremove", "remove", "", false), "keep\n");
  });

  it("removes every occurrence with replace_all, not only those followed by a newline", () => {
    assert.equal(applyEditToContent("removeX\nremove\n", "remove", "", true), "X\n");
    assert.equal(applyEditToContent("a foo\nfoo bar\n", "foo", "", true), "a \n bar\n");
  });
});
