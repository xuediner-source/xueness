/**
 * Edit matcher cases.
 *
 * Match assertions ported from apps/zcode-cli/packages/core/tests/edit-tool-contract.test.ts
 * and apps/zcode-cli/packages/core/tests/file-tool-port.test.ts
 * (v3.15.1 @ aac4755666d09fdcd70272fcf063c077a639015f).
 * The handler's not-found / ambiguous messages stay with the Edit tool.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectIndentationFlexibleCandidates } from "../src/edit-matchers-blocks.ts";
import {
  applyEditToContent,
  countOccurrences,
  findEditMatch,
  locateEdit,
  normalizeLineEndings,
  normalizeReplacementForMatch,
  preserveQuoteStyle,
  type EditMatchResult,
  type EditMatchStrategy,
} from "../src/index.ts";

type EditOutcome =
  | { status: "not_found" }
  | { status: "ambiguous"; strategy: EditMatchStrategy; candidateCount: number }
  | {
      status: "matched";
      strategy: EditMatchStrategy;
      candidateCount: number;
      oldString: string;
      newString: string;
      content: string;
    };

/** The Edit tool's path: normalize line endings, locateEdit (ZCode handler order plus guards), splice. */
function runEditMatch(content: string, oldString: string, newString: string, replaceAll = false): EditOutcome {
  const normalizedContent = normalizeLineEndings(content);
  const located = locateEdit(normalizedContent, normalizeLineEndings(oldString), normalizeLineEndings(newString), replaceAll);
  if (located.status === "not_found") return located;
  if (located.status === "ambiguous") return { status: "ambiguous", strategy: located.strategy, candidateCount: located.count };
  return {
    status: "matched",
    strategy: located.strategy,
    candidateCount: located.candidateCount,
    oldString: located.actualOldString,
    newString: located.actualNewString,
    content: applyEditToContent(normalizedContent, located.actualOldString, located.actualNewString, replaceAll),
  };
}

function assertMatched(outcome: EditOutcome): asserts outcome is Extract<EditOutcome, { status: "matched" }> {
  assert.equal(outcome.status, "matched", JSON.stringify(outcome));
}

describe("findEditMatch", () => {
  it("replaces one exact string and every exact string when replace_all is set", () => {
    const once = runEditMatch("alpha\nbeta\n", "beta", "gamma");
    assertMatched(once);
    assert.equal(once.strategy, "exact");
    assert.equal(once.candidateCount, 1);
    assert.equal(once.content, "alpha\ngamma\n");

    const all = runEditMatch("foo\nfoo\nkeep\n", "foo", "bar", true);
    assertMatched(all);
    assert.equal(all.strategy, "exact");
    assert.equal(all.candidateCount, 2);
    assert.equal(all.content, "bar\nbar\nkeep\n");
    const renamed = runEditMatch("alpha beta beta", "beta", "gamma", true);
    assertMatched(renamed);
    assert.equal(renamed.content, "alpha gamma gamma");
  });

  it("keeps identical repeated exact text as matched, and the handler count gate rejects it", () => {
    const content = "name\nname\n";
    assert.deepEqual(findEditMatch({ content, search: "name", replaceAll: false }), {
      status: "matched",
      strategy: "exact",
      actualString: "name",
      candidateCount: 2,
    });
    assert.equal(countOccurrences(content, "name"), 2);
    assert.deepEqual(runEditMatch(content, "name", "label"), {
      status: "ambiguous",
      strategy: "exact",
      candidateCount: 2,
    });
  });

  it("returns not_found when the string is absent", () => {
    assert.deepEqual(findEditMatch({ content: "available content", search: "not present", replaceAll: false }), {
      status: "not_found",
    });
  });

  it("writes dollar replacement tokens literally", () => {
    const outcome = runEditMatch("first TOKEN\nsecond TOKEN\n", "first TOKEN", "first $$ and $&");
    assertMatched(outcome);
    assert.equal(outcome.newString, "first $$ and $&");
    assert.equal(outcome.content, "first $$ and $&\nsecond TOKEN\n");
    assert.equal(applyEditToContent("TOKEN TOKEN", "TOKEN", "$$", true), "$$ $$");
  });

  it("deletes the following newline when old_string omits it", () => {
    const outcome = runEditMatch("keep\nremove\nlast\n", "remove", "");
    assertMatched(outcome);
    assert.equal(outcome.content, "keep\nlast\n");
    assert.equal(applyEditToContent("keep\nremove\nlast\n", "remove", "gone", false), "keep\ngone\nlast\n");
    // Per occurrence (edit-matchers-apply.ts): the first "remove" is not a whole line, so it keeps its text after it.
    assert.equal(applyEditToContent("removeX\nremove\n", "remove", "", false), "X\nremove\n");
  });

  it("matches straight quotes against curly quotes and preserves the file quote style", () => {
    const hello = runEditMatch("const msg = \u201chello\u201d\n", '"hello"', '"bye"');
    assertMatched(hello);
    assert.equal(hello.strategy, "quote_normalized");
    assert.equal(hello.oldString, "\u201chello\u201d");
    assert.equal(hello.newString, "\u201cbye\u201d");
    assert.equal(hello.content, "const msg = \u201cbye\u201d\n");

    const label = runEditMatch("const label = \u201cOld value\u201d;\n", '"Old value"', '"New value"');
    assertMatched(label);
    assert.equal(label.oldString, "\u201cOld value\u201d");
    assert.equal(label.newString, "\u201cNew value\u201d");
    assert.equal(label.content, "const label = \u201cNew value\u201d;\n");
  });

  it("prefers an exact straight quote over a curly quote of the same word", () => {
    const match = findEditMatch({
      content: "\"hello\" and \u201chello\u201d",
      search: '"hello"',
      replaceAll: false,
    });
    assert.deepEqual(match, {
      status: "matched",
      strategy: "exact",
      actualString: '"hello"',
      candidateCount: 1,
    });
  });

  it("rejects quote matches whose file slices are not the same text", () => {
    assert.deepEqual(findEditMatch({
      content: "\u201ca\u201d and \u201da\u201c",
      search: '"a"',
      replaceAll: false,
    }), {
      status: "ambiguous",
      strategy: "quote_normalized",
      candidateCount: 2,
    });
  });

  it("matches a unicode escape against the decoded character and leaves the replacement encoded", () => {
    const outcome = runEditMatch("<tag>value</tag>\n", String.raw`\u003Ctag\u003E`, "<node>");
    assertMatched(outcome);
    assert.equal(outcome.strategy, "unicode_escape_normalized");
    assert.equal(outcome.oldString, "<tag>");
    assert.equal(outcome.newString, "<node>");
    assert.equal(outcome.content, "<node>value</tag>\n");
    assert.equal(normalizeReplacementForMatch("unicode_escape_normalized", String.raw`\u0041`), String.raw`\u0041`);
    assert.deepEqual(findEditMatch({ content: "A", search: String.raw`\\u0041`, replaceAll: false }), {
      status: "not_found",
    });
  });

  it("matches a copied read line that contains a real tab, then a visible \\t escape", () => {
    const start = "工作任务\n- [ ] prd auto research 的\n\t- [ ] beta 部分继续";
    const copied = runEditMatch(
      start,
      "- [ ] prd auto research 的\n\t- [ ] beta 部分继续",
      "- [x] prd auto research 的\n\t- [x] beta 部分继续",
    );
    assertMatched(copied);
    assert.equal(copied.strategy, "exact");
    assert.equal(copied.oldString, "- [ ] prd auto research 的\n\t- [ ] beta 部分继续");
    assert.equal(copied.newString, "- [x] prd auto research 的\n\t- [x] beta 部分继续");

    const escaped = runEditMatch(copied.content, String.raw`\t- [x] beta 部分继续`, String.raw`\t- [ ] beta 部分继续`);
    assertMatched(escaped);
    assert.equal(escaped.strategy, "escape_normalized");
    assert.equal(escaped.oldString, "\t- [x] beta 部分继续");
    assert.equal(escaped.newString, "\t- [ ] beta 部分继续");
    assert.ok(escaped.content.includes("\t- [ ] beta 部分继续"));
  });

  it("strips Read line prefixes only when every line has one", () => {
    const outcome = runEditMatch("\tfirst\n\tsecond\n", "1: \tfirst\n2: \tsecond", "\tchanged\n\tsecond");
    assertMatched(outcome);
    assert.equal(outcome.strategy, "line_number_prefix_stripped");
    assert.equal(outcome.oldString, "\tfirst\n\tsecond");
    assert.equal(outcome.content, "\tchanged\n\tsecond\n");

    const tabs = runEditMatch("first\nsecond\n", "1\tfirst\n2\tsecond", "changed\nsecond");
    assertMatched(tabs);
    assert.equal(tabs.strategy, "line_number_prefix_stripped");
    assert.equal(tabs.content, "changed\nsecond\n");

    assert.deepEqual(findEditMatch({ content: "foo\nbar\n", search: "1: foo\n2: bar\n", replaceAll: false }), {
      status: "not_found",
    });
    assert.deepEqual(findEditMatch({ content: "1: foo\nfoo\n", search: "1: foo", replaceAll: false }), {
      status: "matched",
      strategy: "exact",
      actualString: "1: foo",
      candidateCount: 1,
    });
  });

  it("matches extra indentation as line_trimmed and writes new_string unchanged", () => {
    const content = "\tif (ready) {\n\t\tawait Load();\n\t}\n";
    const outcome = runEditMatch(
      content,
      "\t\tif (ready) {\n\t\t\tawait Load();\n\t\t}",
      "\tif (ready) {\n\t\tawait Save();\n\t}",
    );
    assertMatched(outcome);
    assert.equal(outcome.strategy, "line_trimmed");
    assert.equal(outcome.oldString, "\tif (ready) {\n\t\tawait Load();\n\t}");
    assert.equal(outcome.newString, "\tif (ready) {\n\t\tawait Save();\n\t}");
    assert.equal(outcome.content, "\tif (ready) {\n\t\tawait Save();\n\t}\n");
  });

  it("rejects a line-trimmed search that fits more than one distinct line", () => {
    const content = "\tawait Load();\n  await Load();\n";
    assert.deepEqual(findEditMatch({ content, search: "\t\tawait Load();", replaceAll: false }), {
      status: "ambiguous",
      strategy: "line_trimmed",
      candidateCount: 2,
    });
    assert.deepEqual(findEditMatch({ content, search: "\t\tawait Load();", replaceAll: true }), {
      status: "not_found",
    });
    assert.equal(content, "\tawait Load();\n  await Load();\n");
  });

  it("skips broad matchers when replace_all is set, and still replaces exact text", () => {
    assert.deepEqual(findEditMatch({ content: "  foo\n", search: "foo\t", replaceAll: false }), {
      status: "matched",
      strategy: "line_trimmed",
      actualString: "  foo",
      candidateCount: 1,
    });
    assert.deepEqual(findEditMatch({ content: "  foo\n", search: "foo\t", replaceAll: true }), {
      status: "not_found",
    });
    const exact = findEditMatch({ content: "foo\nfoo\n", search: "foo", replaceAll: true });
    assert.deepEqual(exact, {
      status: "matched",
      strategy: "exact",
      actualString: "foo",
      candidateCount: 2,
    });
  });

  it("uses a block anchor when only the middle lines differ within the similarity floor", () => {
    const matched = findEditMatch({
      content: "begin\nabcdefghij\nend\n",
      search: "begin\nabcdefghxy\nend\n",
      replaceAll: false,
    });
    assert.deepEqual(matched, {
      status: "matched",
      strategy: "block_anchor",
      actualString: "begin\nabcdefghij\nend",
      candidateCount: 1,
    });
    assert.deepEqual(findEditMatch({
      content: "begin\nabcdefghij\nend\n",
      search: "begin\nabcdefgxyz\nend",
      replaceAll: false,
    }), { status: "not_found" });
    assert.deepEqual(findEditMatch({
      content: "begin\nabcdefghij\nend\n",
      search: "begin\nabcdefghxy\nend",
      replaceAll: true,
    }), { status: "not_found" });
  });

  it("averages middle-line similarity and rejects two different anchor blocks", () => {
    const onFloor = findEditMatch({
      content: "begin\nsame\nabcde\nend",
      search: "begin\nsame\nabcXY\nend",
      replaceAll: false,
    });
    assert.equal(onFloor.status, "matched");
    if (onFloor.status === "matched") assert.equal(onFloor.strategy, "block_anchor");

    assert.deepEqual(findEditMatch({
      content: "begin\nsame\nabcde\nend",
      search: "begin\nsame\nabxyz\nend",
      replaceAll: false,
    }), { status: "not_found" });

    assert.deepEqual(findEditMatch({
      content: "begin\nabcdefghij\nend\nbegin\nabcdefghyz\nend",
      search: "begin\nabcdefghxy\nend",
      replaceAll: false,
    }), {
      status: "ambiguous",
      strategy: "block_anchor",
      candidateCount: 2,
    });
  });

  it("counts overlapping trimmed windows separately, and the Edit path calls them ambiguous", () => {
    const content = "  a\n  a\n  a";
    const match = findEditMatch({ content, search: "a\na", replaceAll: false });
    assert.deepEqual(match, {
      status: "matched",
      strategy: "line_trimmed",
      actualString: "  a\n  a",
      candidateCount: 2,
    });
    assert.equal(countOccurrences(content, "  a\n  a"), 1);
    // ZCode's handler would replace the first window; locateEdit refuses (edit-locate.ts guard 2).
    assert.deepEqual(runEditMatch(content, "a\na", "b\nb"), { status: "ambiguous", strategy: "line_trimmed", candidateCount: 2 });
  });

  it("folds CRLF before matching so an LF search and a CRLF search hit the same text", () => {
    const crlfFile = runEditMatch("first\r\n\tsecond\r\nthird\r\n", "first\n\tsecond", "first\n\tchanged");
    assertMatched(crlfFile);
    assert.equal(crlfFile.strategy, "exact");
    assert.equal(crlfFile.oldString, "first\n\tsecond");
    assert.equal(crlfFile.content, "first\n\tchanged\nthird\n");

    const crlfSearch = runEditMatch(
      "export function Component() {\n  return <div>old</div>;\n}\n",
      "export function Component() {\r\n  return <div>old</div>;\r\n}",
      "export function Component() {\n  return <div>new</div>;\n}",
    );
    assertMatched(crlfSearch);
    assert.equal(crlfSearch.strategy, "exact");
    assert.equal(crlfSearch.oldString, "export function Component() {\n  return <div>old</div>;\n}");
    assert.equal(crlfSearch.newString, "export function Component() {\n  return <div>new</div>;\n}");
    assert.equal(crlfSearch.content, "export function Component() {\n  return <div>new</div>;\n}\n");

    const inserted = runEditMatch("one\r\ntwo\r\nthree\r\n", "two", "two\r\ninserted");
    assertMatched(inserted);
    assert.equal(inserted.newString, "two\ninserted");
    assert.equal(inserted.content, "one\ntwo\ninserted\nthree\n");
    assert.equal(inserted.content.includes("\r"), false);
  });

  it("matches an empty search through quote normalization", () => {
    const match: EditMatchResult = findEditMatch({ content: "ab", search: "", replaceAll: false });
    assert.deepEqual(match, {
      status: "matched",
      strategy: "quote_normalized",
      actualString: "",
      candidateCount: 3,
    });
  });

  it("classifies a shared-indent change as line_trimmed because that strategy runs first", () => {
    const content = "    if (ready) {\n      return 1;\n    }";
    const search = "  if (ready) {\n    return 1;\n  }";
    const hits = collectIndentationFlexibleCandidates(content, search);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.value, content);
    assert.equal(collectIndentationFlexibleCandidates("    if (ready) {\n    return 1;\n    }", search).length, 0);
    assert.equal(collectIndentationFlexibleCandidates("  if (ready) {\n    return 1; \n  }", search).length, 0);
    const match = findEditMatch({ content, search, replaceAll: false });
    assert.equal(match.status, "matched");
    if (match.status === "matched") {
      assert.equal(match.strategy, "line_trimmed");
      assert.equal(match.actualString, content);
    }
  });
});
