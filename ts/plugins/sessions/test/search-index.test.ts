import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { it } from "node:test";
import { isDict, normalizeError } from "@xueness/contracts";
import { SessionStore } from "@xueness/sessions";
import { createSessionsApi } from "../src/http-api.ts";
import { pythonUnavailableReason, runPythonAsync } from "../../../test-support/python-oracle.ts";
type Row = Record<string, any>;
const oraclePath = join(import.meta.dirname, "../../../test-support/python/http_feature_oracle.py");
it("matches Python HTTP index/search while leaving every journal and read watermark untouched", { skip: pythonUnavailableReason() ?? false }, async () => {
  const root = mkdtempSync(join(tmpdir(), "xueness-search-index-")), stateDir = join(root, "ts"), pyState = join(root, "python"); mkdirSync(stateDir);
  try {
    const store = new SessionStore(stateDir), first = await store.new("First task", root, { sessionId: "a".repeat(32) });
    (first.messages as Row[]).push({ role: "assistant", content: "Needle visible", tool_calls: [{ id: "write-1", function: { name: "write", arguments: '{"path":"changed.txt","content":"private"}' }, type: "function" }] }, { role: "tool", tool_call_id: "write-1", content: "private tool body" }, { role: "assistant", content: "Final answer" }); first.results = { "write-1": { ok: true } }; first.status = "completed"; first.pinned = true; await store.save(first);
    const second = await store.new("Second task", root, { sessionId: "b".repeat(32) }); second.archived_messages = [{ role: "assistant", content: "Hidden Needle", _message_id: "f".repeat(32) }, { role: "assistant", content: "Straße archived", _message_id: "e".repeat(32) }]; second.history_hidden_message_ids = ["f".repeat(32)]; second.status = "awaiting_user"; second.pending_question = "Private question"; await store.save(second);
    const third = await store.new("Outside Needle", join(root, "..", "outside-fixture"), { sessionId: "c".repeat(32) }); third.status = "failed"; await store.save(third);
    writeFileSync(join(stateDir, "d".repeat(32) + ".json"), "{invalid");
    for (const sid of [first.id, second.id, third.id]) utimesSync(store.pathFor(String(sid)), 1767225600, 1767225600);
    cpSync(stateDir, pyState, { recursive: true, preserveTimestamps: true });
    const paths = ["/api/sessions/index", "/api/sessions/index?bad=1", "/api/sessions/search?q=needle", "/api/sessions/search?q=STRASSE", "/api/sessions/search?q=private", "/api/sessions/search?q=needle&after=" + "b".repeat(32), "/api/sessions/search?q=", "/api/sessions/search?q=one&q=two", "/api/sessions/search?q=Needle&after=bad", "/api/sessions/search?q=Needle&bad=1"];
    const expected = JSON.parse(await runPythonAsync(`import runpy;runpy.run_path(${JSON.stringify(oraclePath)},run_name='__main__')`, JSON.stringify({ stateDir: pyState, workspace: root, requests: paths.map((path) => ({ method: "GET", path })) })));
    const api = createSessionsApi({ store, stateDir, webRuns: join(root, "web-runs"), projectDir: root, enabled: (id) => id !== "remote" }), actual: unknown[] = [], names = readdirSync(stateDir).sort(), before = new Map(names.filter((n) => n.endsWith(".json")).map((n) => [n, readFileSync(join(stateDir, n))]));
    for (const path of paths) { const url = new URL(path, "http://local"), query: Row = {}; for (const [k, v] of url.searchParams) (query[k] ??= []).push(v); const result = await api.dispatch("GET", url.pathname.split("/").filter(Boolean), query, {}); assert.ok(result); actual.push([result[0], result[0] >= 400 && isDict(result[1]) ? normalizeError(result[0], result[1]) : result[1]]); }
    assert.deepEqual(actual, expected); assert.deepEqual(readdirSync(stateDir).sort(), names); for (const [name, bytes] of before) assert.deepEqual(readFileSync(join(stateDir, name)), bytes);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
