/**
 * Quote style, escapes, line-number stripping and literal replacement.
 *
 * Ported from the Edit match helpers in
 * apps/zcode-cli/packages/core/src/tool/handlers/edit.ts and
 * apps/zcode-cli/packages/core/src/tool/edit-matchers.ts
 * (v3.15.1 @ aac4755666d09fdcd70272fcf063c077a639015f).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyEditToContent,
  countOccurrences,
  normalizeLineEndings,
  normalizeReplacementForMatch,
  preserveQuoteStyle,
  stripReadLineNumberPrefixes,
  type EditMatchStrategy,
} from "../src/index.ts";

const STRATEGIES = [
  "exact",
  "quote_normalized",
  "line_number_prefix_stripped",
  "escape_normalized",
  "unicode_escape_normalized",
  "line_trimmed",
  "indentation_flexible",
  "block_anchor",
] as const satisfies readonly EditMatchStrategy[];

describe("normalizeLineEndings", () => {
  it("folds CRLF and leaves bare CR and LF alone", () => {
    assert.equal(normalizeLineEndings("a\r\nb\nc\r"), "a\nb\nc\r");
    assert.equal(normalizeLineEndings("a\nb"), "a\nb");
    assert.equal(normalizeLineEndings(""), "");
  });
});

describe("stripReadLineNumberPrefixes", () => {
  it("accepts colon-space and tab prefixes, including a mix, on every line", () => {
    assert.equal(stripReadLineNumberPrefixes("1: foo\n2: bar"), "foo\nbar");
    assert.equal(stripReadLineNumberPrefixes("12: foo"), "foo");
    assert.equal(stripReadLineNumberPrefixes("1: \tfirst\n2: \tsecond"), "\tfirst\n\tsecond");
    assert.equal(stripReadLineNumberPrefixes("10\tfoo\n11\tbar"), "foo\nbar");
    assert.equal(stripReadLineNumberPrefixes("1: foo\n2\tbar"), "foo\nbar");
    assert.equal(stripReadLineNumberPrefixes("1: foo\n2: \n3: bar"), "foo\n\nbar");
  });

  it("returns null when any line has no prefix", () => {
    assert.equal(stripReadLineNumberPrefixes("1: foo\nbar"), null);
    assert.equal(stripReadLineNumberPrefixes("1: foo\n2: bar\n"), null);
    assert.equal(stripReadLineNumberPrefixes("1: foo\n\n3: bar"), null);
    assert.equal(stripReadLineNumberPrefixes("1:foo"), null);
    assert.equal(stripReadLineNumberPrefixes("1:\tfoo"), null);
    assert.equal(stripReadLineNumberPrefixes(""), null);
  });
});

describe("normalizeReplacementForMatch", () => {
  it("unescapes visible characters only for escape_normalized", () => {
    const escaped = "\\n\\t\\r\\\"\\'`\\\\$\\q";
    for (const strategy of STRATEGIES) {
      const result = normalizeReplacementForMatch(strategy, escaped);
      if (strategy === "escape_normalized") {
        assert.equal(result, "\n\t\r\"'`\\$\\q");
      } else {
        assert.equal(result, escaped);
      }
    }
    assert.equal(normalizeReplacementForMatch("unicode_escape_normalized", String.raw`\u0041`), String.raw`\u0041`);
    assert.equal(normalizeReplacementForMatch("escape_normalized", String.raw`\u0041`), String.raw`\u0041`);
  });
});

describe("preserveQuoteStyle", () => {
  it("leaves the replacement alone when the match did not change the search", () => {
    assert.equal(preserveQuoteStyle("hello", "hello", "bye"), "bye");
    assert.equal(preserveQuoteStyle("\u201chello\u201d", "\u201chello\u201d", '"bye"'), '"bye"');
  });

  it("curls straight quotes to match the file, including apostrophes and dashes", () => {
    assert.equal(preserveQuoteStyle('"hello"', "\u201chello\u201d", '"bye"'), "\u201cbye\u201d");
    assert.equal(preserveQuoteStyle("it's", "it\u2019s", "it's fine"), "it\u2019s fine");
    assert.equal(preserveQuoteStyle("it's", "it\u2019s", "'bye'"), "\u2018bye\u2019");
    assert.equal(preserveQuoteStyle('"a"', "\u201ca\u201d", "\u2014\"b\""), "\u2014\u201cb\u201d");
    assert.equal(preserveQuoteStyle('"a"', "\u201ca\u201d", "\u2013\"b\""), "\u2013\u201cb\u201d");
    assert.equal(preserveQuoteStyle("中'文", "中\u2019文", "中'文"), "中\u2019文");
    assert.equal(preserveQuoteStyle('"a"', "\u201ca\u201d", "中\"文\""), "中\u201d文\u201d");
    assert.equal(preserveQuoteStyle('"a"', "\u201ca\u201d", "中 \"文\""), "中 \u201c文\u201d");
    assert.equal(preserveQuoteStyle("\"it's\"", "\u201cit\u2019s\u201d", "\"it's\""), "\u201cit\u2019s\u201d");
  });

  it("does not invent curly quotes when the file text is straight", () => {
    assert.equal(preserveQuoteStyle("\u201chello\u201d", '"hello"', "\u201cbye\u201d"), "\u201cbye\u201d");
    assert.equal(preserveQuoteStyle("\u201chello\u201d", '"hello"', '"bye"'), '"bye"');
  });

  it("curls a quote that opens after whitespace, a bracket or a newline", () => {
    assert.equal(preserveQuoteStyle('"a"', "\u201ca\u201d", "(\n\"b\")"), "(\n\u201cb\u201d)");
    assert.equal(preserveQuoteStyle('"a"', "\u201ca\u201d", "[\"b\"]"), "[\u201cb\u201d]");
    assert.equal(preserveQuoteStyle('"a"', "\u201ca\u201d", "{\"b\"}"), "{\u201cb\u201d}");
  });
});

describe("countOccurrences", () => {
  it("counts non-overlapping hits", () => {
    assert.equal(countOccurrences("aaaa", "aa"), 2);
    assert.equal(countOccurrences("aaa", "aa"), 1);
    assert.equal(countOccurrences("foo\nfoo\nkeep\n", "foo"), 2);
    assert.equal(countOccurrences("abc", "z"), 0);
    assert.equal(countOccurrences("", "a"), 0);
  });
});

describe("applyEditToContent", () => {
  it("replaces literally, including dollar tokens and an empty deletion", () => {
    assert.equal(applyEditToContent("first TOKEN\nsecond TOKEN\n", "first TOKEN", "first $$ and $&", false), "first $$ and $&\nsecond TOKEN\n");
    assert.equal(applyEditToContent("foo\nfoo\nkeep\n", "foo", "bar", true), "bar\nbar\nkeep\n");
    assert.equal(applyEditToContent("foo\nfoo\nkeep\n", "foo", "bar", false), "bar\nfoo\nkeep\n");
    assert.equal(applyEditToContent("keep\nremove\nlast\n", "remove", "", false), "keep\nlast\n");
    assert.equal(applyEditToContent("keep\nremove\nlast\n", "remove\n", "", false), "keep\nlast\n");
    assert.equal(applyEditToContent("keep\nremove", "remove", "", false), "keep\n");
  });
});
