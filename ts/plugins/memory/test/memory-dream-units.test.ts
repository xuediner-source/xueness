import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { dreamKeyDiff } from "../src/memory-dream-diff.ts";
import { buildDreamPrompt, clampToolOutput, MAX_TOOL_ROUNDS, parseDreamToolCall, redactSecrets, runDreamToolLoop } from "../src/memory-dream-tools.ts";
import type { MemoryDreamRecord, MemoryDreamTool, MemoryDreamToolLog } from "../src/memory-dream-types.ts";

const sha = (content: string): string => createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
const sid = "a".repeat(32);

function recordFixture(): MemoryDreamRecord {
  return {
    id: "d".repeat(32), parentSessionId: sid, root: "/workspace/demo", startDigest: "start", status: "ready",
    sources: [{ sessionId: sid, messages: [{ messageId: "m1", role: "user", content: "use pnpm" }] }],
    sourceSessionIds: [sid], baseKeyContent: "old key\n", baseKeyDigest: sha("old key\n"),
  } as unknown as MemoryDreamRecord;
}

const boom = (status: number, message: string): never => { throw new Error(`${status} ${message}`); };
const echoTool = (log: MemoryDreamToolLog[]): MemoryDreamTool => ({
  name: "read_project_key", description: "Re-read the current project KEY.md (read-only).",
  async invoke(_context, input) { const entry = { tool: "read_project_key", input, output: { content: "old key", digest: "ignored" } }; log.push(entry); return entry.output; },
});

describe("memory dream diff", () => {
  it("reports zero hunks for identical content and passes digests through", () => {
    const diff = dreamKeyDiff({ content: "a\nb\n", digest: "base-digest" }, { content: "a\nb\n", digest: "cand-digest" });
    assert.equal(diff.baseDigest, "base-digest");
    assert.equal(diff.candidateDigest, "cand-digest");
    assert.equal(diff.hunks.length, 0);
    assert.equal(diff.addedLines, 0);
    assert.equal(diff.removedLines, 0);
    assert.equal(diff.truncated, false);
  });

  it("computes the candidate digest when the caller has none", () => {
    const diff = dreamKeyDiff({ content: "a\n", digest: "base-digest" }, { content: "b\n", digest: "" });
    assert.equal(diff.candidateDigest, sha("b\n"));
  });

  it("renders a middle insertion as one hunk with three context lines", () => {
    const base = Array.from({ length: 10 }, (_, at) => `l${at}`);
    const candidate = [...base.slice(0, 4), "NEW", ...base.slice(4)];
    const diff = dreamKeyDiff({ content: `${base.join("\n")}\n`, digest: "b" }, { content: `${candidate.join("\n")}\n`, digest: "" });
    assert.equal(diff.oldLines, 10);
    assert.equal(diff.newLines, 11);
    assert.equal(diff.addedLines, 1);
    assert.equal(diff.removedLines, 0);
    assert.equal(diff.hunks.length, 1);
    const hunk = diff.hunks[0]!;
    assert.equal(hunk.oldLines, 0);
    assert.equal(hunk.newLines, 1);
    assert.equal(hunk.newStart, 5);
    assert.deepEqual(hunk.lines.slice(0, 4).map((line) => line.op), ["context", "context", "context", "add"]);
    assert.equal(hunk.lines.find((line) => line.op === "add")?.text, "NEW");
  });

  it("splits far-apart replacements into separate hunks", () => {
    const base = Array.from({ length: 20 }, (_, at) => `l${at}`);
    const candidate = base.map((line, at) => (at === 1 || at === 18 ? `X${at}` : line));
    const diff = dreamKeyDiff({ content: `${base.join("\n")}\n`, digest: "b" }, { content: `${candidate.join("\n")}\n`, digest: "" });
    assert.equal(diff.hunks.length, 2);
    assert.equal(diff.addedLines, 2);
    assert.equal(diff.removedLines, 2);
  });

  it("falls back to a whole-file diff past the DP budget and flags truncation", () => {
    const base = Array.from({ length: 3_000 }, (_, at) => `base-${at}`);
    const candidate = Array.from({ length: 3_000 }, (_, at) => `cand-${at}`);
    const diff = dreamKeyDiff({ content: `${base.join("\n")}\n`, digest: "b" }, { content: `${candidate.join("\n")}\n`, digest: "" });
    assert.equal(diff.oldLines, 3_000);
    assert.equal(diff.newLines, 3_000);
    assert.equal(diff.addedLines, 3_000);
    assert.equal(diff.removedLines, 3_000);
    assert.equal(diff.hunks.length, 1);
    assert.equal(diff.truncated, true);
  });

  it("caps the review diff at one hundred hunks", () => {
    const base = Array.from({ length: 960 }, (_, at) => `b${at}`);
    const candidate: string[] = [];
    base.forEach((line, at) => { candidate.push(line); if (at % 8 === 7) candidate.push(`N${at}`); });
    const diff = dreamKeyDiff({ content: `${base.join("\n")}\n`, digest: "b" }, { content: `${candidate.join("\n")}\n`, digest: "" });
    assert.equal(diff.hunks.length, 100);
    assert.equal(diff.truncated, true);
  });
});

describe("memory dream tool protocol", () => {
  it("accepts only the strict two-key tool call shape", () => {
    assert.deepEqual(parseDreamToolCall({ dreamTool: "read_project_key", input: {} }), { tool: "read_project_key", input: {} });
    assert.equal(parseDreamToolCall(null), null);
    assert.equal(parseDreamToolCall(["read_project_key"]), null);
    assert.equal(parseDreamToolCall({ dreamTool: "t", input: {}, extra: 1 }), null);
    assert.equal(parseDreamToolCall({ dreamTool: "t" }), null);
    assert.equal(parseDreamToolCall({ dreamTool: "  ", input: {} }), null);
    assert.equal(parseDreamToolCall({ dreamTool: "t", input: [] }), null);
    assert.equal(parseDreamToolCall({ dreamTool: "t", input: "text" }), null);
  });

  it("redacts private keys, bearer tokens and key-value secrets but keeps prose", () => {
    const redacted = redactSecrets([
      "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
      "token sk-proj-abcdefghijkl123 and Bearer abcdef123456789012",
      "api_key: supersecret",
      "use pnpm for builds",
    ].join("\n"));
    assert.doesNotMatch(redacted, /PRIVATE KEY-----\nabc/);
    assert.doesNotMatch(redacted, /sk-proj-|abcdef123456789|supersecret/);
    assert.match(redacted, /\[REDACTED PRIVATE KEY\]/);
    assert.match(redacted, /\[REDACTED TOKEN\]/);
    assert.match(redacted, /api_key: \[REDACTED\]/);
    assert.match(redacted, /use pnpm for builds/);
  });

  it("clamps oversized tool output by Unicode code points", () => {
    assert.deepEqual(clampToolOutput({ ok: true }), { ok: true });
    const ascii = clampToolOutput({ text: "x".repeat(9_000) }) as { truncated: boolean; preview: string };
    assert.equal(ascii.truncated, true);
    assert.equal(ascii.preview.length, 8_000);
    const emoji = clampToolOutput({ text: "\u{1F600}".repeat(9_000) }) as { truncated: boolean; preview: string };
    assert.equal(emoji.truncated, true);
    assert.equal(Array.from(emoji.preview).length, 8_000);
    assert.equal(Array.from(emoji.preview).includes("\u{FFFD}"), false);
  });

  it("builds an untrusted-data prompt with or without tools", () => {
    const record = recordFixture();
    const bare = buildDreamPrompt(record, [], []);
    assert.match(bare, /Use no tools\./);
    assert.match(bare, /untrusted JSON string/);
    assert.ok(bare.includes(JSON.stringify("old key\n")));
    const tooled = buildDreamPrompt(record, [echoTool([])], []);
    assert.match(tooled, /- read_project_key: /);
    assert.match(tooled, /"dreamTool"/);
    const logged = buildDreamPrompt(record, [echoTool([])], [{ tool: "read_project_key", input: { q: 1 }, output: { content: "old key" } }]);
    assert.match(logged, /"tool":\s*"read_project_key"/);
    assert.match(logged, /untrusted JSON data/);
  });
});

describe("memory dream tool loop", () => {
  it("returns the model answer directly when no tool is requested", async () => {
    const log: MemoryDreamToolLog[] = [], calls: string[] = [];
    const result = await runDreamToolLoop({
      record: recordFixture(), tools: [echoTool(log)], signal: AbortSignal.abort?.() ?? new AbortController().signal,
      synthesize: async (_session, prompt) => { calls.push(prompt); return { value: { content: "k\n" }, usage: "unknown" }; },
      onToolCall: () => { throw new Error("unexpected tool call"); },
      fail: boom,
    });
    assert.deepEqual((result.value as { content: string }).content, "k\n");
    assert.equal(calls.length, 1);
    assert.equal(log.length, 0);
  });

  it("executes one read-only tool round and feeds the result back into the prompt", async () => {
    const log: MemoryDreamToolLog[] = [], seen: MemoryDreamToolLog[] = [], prompts: string[] = [];
    let round = 0;
    const result = await runDreamToolLoop({
      record: recordFixture(), tools: [echoTool(log)], signal: new AbortController().signal,
      synthesize: async (_session, prompt) => {
        prompts.push(prompt);
        round += 1;
        return round === 1
          ? { value: { dreamTool: "read_project_key", input: { why: "verify" } }, usage: "unknown" }
          : { value: { content: "final\n" }, usage: "unknown" };
      },
      onToolCall: (entry) => seen.push(entry),
      fail: boom,
    });
    assert.deepEqual((result.value as { content: string }).content, "final\n");
    assert.equal(prompts.length, 2);
    assert.match(prompts[1]!, /"tool":\s*"read_project_key"/);
    assert.match(prompts[1]!, /old key/);
    assert.deepEqual(seen, [{ tool: "read_project_key", input: { why: "verify" }, output: { content: "old key", digest: "ignored" } }]);
    assert.deepEqual(log, seen);
  });

  it("fails the dream when the model never stops requesting tools", async () => {
    const log: MemoryDreamToolLog[] = [];
    let syntheses = 0;
    await assert.rejects(runDreamToolLoop({
      record: recordFixture(), tools: [echoTool(log)], signal: new AbortController().signal,
      synthesize: async () => { syntheses += 1; return { value: { dreamTool: "read_project_key", input: {} }, usage: "unknown" }; },
      onToolCall: () => {},
      fail: boom,
    }), /502 model exceeded the dream tool budget/);
    assert.equal(syntheses, MAX_TOOL_ROUNDS + 1);
    assert.equal(log.length, MAX_TOOL_ROUNDS);
  });

  it("fails the dream on unknown tools and on tool errors", async () => {
    await assert.rejects(runDreamToolLoop({
      record: recordFixture(), tools: [echoTool([])], signal: new AbortController().signal,
      synthesize: async () => ({ value: { dreamTool: "nope", input: {} }, usage: "unknown" }),
      onToolCall: () => {},
      fail: boom,
    }), /502 model requested an unknown dream tool/);
    await assert.rejects(runDreamToolLoop({
      record: recordFixture(),
      tools: [{ name: "boom", description: "always fails", invoke: async () => { throw new Error("io"); } }],
      signal: new AbortController().signal,
      synthesize: async () => ({ value: { dreamTool: "boom", input: {} }, usage: "unknown" }),
      onToolCall: () => {},
      fail: boom,
    }), /502 dream tool invocation failed/);
  });
});
