import test from "node:test";
import assert from "node:assert/strict";
import { parseSearchPage, searchTranscripts, type TranscriptHit } from "./sessionSearch";
import { buildCommandPaletteResults } from "./CommandPalette";

const sid = "a".repeat(32);
const hit: TranscriptHit = { session: { id: sid, task: "unrelated title", status: "completed" }, snippet: "正文里的中文关键词", role: "assistant", messageIndex: 2, compacted: false };
const page = (cursor: string | null = null) => ({ query: "中文", matches: [hit], nextCursor: cursor, scanned: 1, skipped: 0 });

test("transcript hits merge with title search and deduplicate by session", () => {
  const contentOnly = buildCommandPaletteResults("中文", [], [hit.session], false, [hit]);
  assert.equal(contentOnly.length, 1);
  assert.equal(contentOnly[0].kind === "session" && contentOnly[0].snippet, hit.snippet);
  assert.equal(buildCommandPaletteResults("unrelated", [], [hit.session], false, [hit]).length, 1);
  assert.equal(buildCommandPaletteResults("", [], [], false, [hit]).length, 0);
});

test("transcript response rejects invalid identities and bounded page shapes", () => {
  assert.deepEqual(parseSearchPage(page(), "中文"), page());
  for (const value of [{ ...page(), query: "stale" }, { ...page(), nextCursor: "../../" }, { ...page(), scanned: -1 }, { ...page(), matches: [{ ...hit, session: { ...hit.session, id: "bad" } }] }]) {
    assert.throws(() => parseSearchPage(value, "中文"));
  }
});

test("progressive search cancels remaining pages when the query changes", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let requests = 0;
  globalThis.fetch = async () => { requests++; return new Response(JSON.stringify(page(sid)), { headers: { "Content-Type": "application/json" } }); };
  try {
    await searchTranscripts("中文", controller.signal, state => {
      assert.equal(state.matches[0].snippet, hit.snippet);
      controller.abort();
    });
    assert.equal(requests, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("a repeated server cursor stops instead of spinning indefinitely", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; return new Response(JSON.stringify(page(sid)), { headers: { "Content-Type": "application/json" } }); };
  try {
    await assert.rejects(searchTranscripts("中文", new AbortController().signal, () => {}), /did not advance/);
    assert.equal(requests, 2);
  } finally { globalThis.fetch = originalFetch; }
});
