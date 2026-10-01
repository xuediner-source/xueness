/**
 * Slice-2 data layer tests: settings wrapper, capability fail-closed reads, and
 * journal-derived file changes.
 *
 * Every network call is stubbed on `globalThis.fetch`. The point of these tests
 * is the *shape of the contract*: a failure must surface as `{ok:false}` (never a
 * throw, never a silent success), a capability only turns on for a literal
 * `true`, and the journal projection must never invent a change or leak a body.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  loadWorkbenchSettings,
  saveWorkbenchSettings,
  readAgentCapabilities,
  capabilityPatch,
} from "./xuenessSettings";
import { loadJournal, deriveFileChanges } from "./xuenessWorkbench";

type Call = { url: string; method: string; body: unknown };

/** Install a fetch stub that records calls and replies via `handler`. */
function stubFetch(
  handler: (url: string, method: string, body: unknown) => { status: number; body?: unknown } | "network-error",
): Call[] {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown = undefined;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url, method, body });
    const result = handler(url, method, body);
    if (result === "network-error") throw new Error("network down");
    return new Response(result.body === undefined ? "" : JSON.stringify(result.body), {
      status: result.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

function restoreFetch(original: typeof fetch) {
  globalThis.fetch = original;
}

const DEFAULTS = { theme: "dark", allowMcp: false };

test("settings: loadWorkbenchSettings returns ok with merged values", async () => {
  const original = globalThis.fetch;
  try {
    stubFetch((url) => {
      if (url === "/api/settings") return { status: 200, body: { settings: { appearance: { theme: "light" } } } };
      return { status: 404, body: { error: "not found" } };
    });
    const res = await loadWorkbenchSettings(DEFAULTS);
    assert.equal(res.ok, true);
    if (res.ok) {
      // defaults survive, server value wins
      assert.equal(res.value.theme, "light");
      assert.equal(res.value.allowMcp, false);
    }
  } finally {
    restoreFetch(original);
  }
});

test("settings: loadWorkbenchSettings reports failure without throwing", async () => {
  const original = globalThis.fetch;
  try {
    stubFetch(() => ({ status: 500, body: { error: "boom" } }));
    const res = await loadWorkbenchSettings(DEFAULTS);
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.error, /boom/);
  } finally {
    restoreFetch(original);
  }
});

test("settings: saveWorkbenchSettings merges patch into stored section", async () => {
  const original = globalThis.fetch;
  try {
    // Stateful stub: POST actually persists, so the read-back check is exercised
    // against a server that really stored the value.
    const stored: Record<string, Record<string, unknown>> = {
      agent: { allowMcp: true, allowHooks: false },
    };
    const calls = stubFetch((url, method, body) => {
      if (url === "/api/settings" && method === "GET") return { status: 200, body: { settings: stored } };
      if (url === "/api/csrf") return { status: 200, body: { csrfToken: "tok" } };
      if (url.startsWith("/api/settings/") && method === "POST") {
        const section = url.split("/").pop() as string;
        const values = (body as { values: Record<string, unknown> }).values;
        stored[section] = values;
        return { status: 200, body: { section, values } };
      }
      return { status: 404, body: { error: "not found" } };
    });
    const res = await saveWorkbenchSettings(DEFAULTS, { allowSubagents: true });
    assert.equal(res.ok, true);

    const post = calls.find((c) => c.method === "POST" && c.url === "/api/settings/agent");
    assert.ok(post, "expected POST to the agent section");
    const values = (post!.body as { values: Record<string, unknown> }).values;
    // Pre-existing key kept, new key added — not a whole-section clobber.
    assert.equal(values.allowHooks, false);
    assert.equal(values.allowSubagents, true);
    if (res.ok) assert.equal(res.value.theme, "dark");
  } finally {
    restoreFetch(original);
  }
});

test("settings: saveWorkbenchSettings reports failure without throwing", async () => {
  const original = globalThis.fetch;
  try {
    // persistSettingsPatch swallows transport errors internally, so a naive
    // wrapper would report success here. The read-back check must catch that the
    // patched key never landed.
    stubFetch((url, method) => {
      if (url === "/api/settings" && method === "GET") return { status: 200, body: { settings: {} } };
      if (url === "/api/csrf") return { status: 200, body: { csrfToken: "tok" } };
      return { status: 500, body: { error: "save failed" } };
    });
    const res = await saveWorkbenchSettings(DEFAULTS, { allowMcp: true });
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.error, /save failed/);
  } finally {
    restoreFetch(original);
  }
});

test("settings: verifies bindings by value across JSON readback and preserves unknown keys", async () => {
  const original = globalThis.fetch;
  const stored: Record<string, Record<string, unknown>> = { shortcuts: { future: "keep" } };
  try {
    stubFetch((url, method, body) => {
      if (url === "/api/settings") return { status: 200, body: { settings: stored } };
      if (url === "/api/csrf") return { status: 200, body: { csrfToken: "tok" } };
      if (url === "/api/settings/shortcuts" && method === "POST") {
        stored.shortcuts = (body as { values: Record<string, unknown> }).values;
        return { status: 200, body: { section: "shortcuts", values: stored.shortcuts } };
      }
      return { status: 404 };
    });
    const result = await saveWorkbenchSettings(DEFAULTS, { bindings: { "new-session": "Mod+N", "command-palette": "Mod+P" } });
    assert.equal(result.ok, true);
    assert.equal(stored.shortcuts.future, "keep");
  } finally { restoreFetch(original); }
});

test("settings: a default equal to a dropped write is not evidence of persistence", async () => {
  const original = globalThis.fetch;
  try {
    stubFetch(url => url === "/api/settings" ? { status: 200, body: { settings: {} } }
      : url === "/api/csrf" ? { status: 200, body: { csrfToken: "tok" } } : { status: 200, body: { values: {} } });
    const result = await saveWorkbenchSettings({ allowMcp: false }, { allowMcp: false });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /did not take effect/);
  } finally { restoreFetch(original); }
});

test("settings: a failed initial read does not overwrite a section", async () => {
  const original = globalThis.fetch;
  try {
    const calls = stubFetch(() => "network-error");
    const result = await saveWorkbenchSettings(DEFAULTS, { theme: "light" });
    assert.equal(result.ok, false);
    assert.equal(calls.some(call => call.method === "POST"), false);
  } finally { restoreFetch(original); }
});

test("settings: readAgentCapabilities is fail-closed for every non-true value", () => {
  const cases: [unknown, boolean][] = [
    [true, true],
    [false, false],
    ["true", false],
    [1, false],
    [undefined, false],
    [null, false],
    [{}, false],
  ];
  for (const [input, expected] of cases) {
    const caps = readAgentCapabilities({ allowMcp: input, allowSubagents: input, allowHooks: input });
    assert.equal(caps.allowMcp, expected, `allowMcp for ${JSON.stringify(input)}`);
    assert.equal(caps.allowSubagents, expected, `allowSubagents for ${JSON.stringify(input)}`);
    assert.equal(caps.allowHooks, expected, `allowHooks for ${JSON.stringify(input)}`);
  }
});

test("settings: readAgentCapabilities treats a missing key as off", () => {
  const caps = readAgentCapabilities({});
  assert.deepEqual(caps, { allowMcp: false, allowSubagents: false, allowHooks: false });
});

test("settings: capabilityPatch coerces to booleans", () => {
  assert.deepEqual(
    capabilityPatch({ allowMcp: true, allowSubagents: false, allowHooks: true }),
    { allowMcp: true, allowSubagents: false, allowHooks: true },
  );
});

test("journal: loadJournal returns ok and reports failure", async () => {
  const original = globalThis.fetch;
  try {
    stubFetch((url) => {
      if (url === "/api/sessions/abc/journal") return { status: 200, body: { id: "abc", messages: [] } };
      return { status: 404, body: { error: "session not found" } };
    });
    const ok = await loadJournal("abc");
    assert.equal(ok.ok, true);
    const missing = await loadJournal("def");
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.match(missing.error, /session not found/);
  } finally {
    restoreFetch(original);
  }
});

test("journal: deriveFileChanges reads write and edit, ok from results", () => {
  const journal = {
    messages: [
      {
        role: "assistant",
        tool_calls: [
          { id: "c1", function: { name: "write", arguments: JSON.stringify({ path: "a.txt", content: "hello" }) } },
          { id: "c2", function: { name: "edit", arguments: JSON.stringify({ path: "b.txt", old: "x", new: "y" }) } },
          { id: "c3", function: { name: "read", arguments: JSON.stringify({ path: "ignored.txt" }) } },
        ],
      },
    ],
    results: { c1: { ok: true }, c2: { ok: false } },
  };
  const set = deriveFileChanges(journal);
  assert.equal(set.source, "session-journal");
  assert.equal(set.changes.length, 2);
  assert.deepEqual(set.changes[0], { path: "a.txt", kind: "write", ok: true, content: "hello" });
  assert.deepEqual(set.changes[1], { path: "b.txt", kind: "edit", ok: false, old: "x", new: "y" });
});

test("journal: deriveFileChanges marks ok=false when results are missing", () => {
  const journal = {
    messages: [
      { role: "assistant", tool_calls: [{ id: "c1", function: { name: "write", arguments: JSON.stringify({ path: "a.txt", content: "x" }) } }] },
    ],
  };
  const set = deriveFileChanges(journal);
  assert.equal(set.changes[0].ok, false);
});

test("journal: deriveFileChanges skips malformed arguments instead of throwing", () => {
  const journal = {
    messages: [
      {
        role: "assistant",
        tool_calls: [
          { id: "bad", function: { name: "write", arguments: "{not json" } },
          { id: "nopath", function: { name: "write", arguments: JSON.stringify({ content: "x" }) } },
          { id: "good", function: { name: "write", arguments: JSON.stringify({ path: "ok.txt", content: "y" }) } },
        ],
      },
      "not-an-object",
      { role: "assistant", tool_calls: "not-an-array" },
    ],
    results: { good: { ok: true } },
  };
  const set = deriveFileChanges(journal);
  assert.equal(set.changes.length, 1);
  assert.equal(set.changes[0].path, "ok.txt");
});

test("journal: deriveFileChanges clips long text to 4000 chars", () => {
  const long = "z".repeat(9000);
  const journal = {
    messages: [
      { role: "assistant", tool_calls: [{ id: "c1", function: { name: "write", arguments: JSON.stringify({ path: "big.txt", content: long }) } }] },
      { role: "assistant", tool_calls: [{ id: "c2", function: { name: "edit", arguments: JSON.stringify({ path: "big2.txt", old: long, new: long }) } }] },
    ],
    results: { c1: { ok: true }, c2: { ok: true } },
  };
  const set = deriveFileChanges(journal);
  assert.equal((set.changes[0].content as string).length, 4000);
  assert.equal((set.changes[1].old as string).length, 4000);
  assert.equal((set.changes[1].new as string).length, 4000);
});

test("journal: deriveFileChanges preserves journal order", () => {
  const journal = {
    messages: [
      { role: "assistant", tool_calls: [{ id: "a", function: { name: "write", arguments: JSON.stringify({ path: "1.txt", content: "" }) } }] },
      { role: "assistant", tool_calls: [{ id: "b", function: { name: "edit", arguments: JSON.stringify({ path: "2.txt", old: "p", new: "q" }) } }] },
      { role: "assistant", tool_calls: [{ id: "c", function: { name: "write", arguments: JSON.stringify({ path: "3.txt", content: "" }) } }] },
    ],
    results: { a: { ok: true }, b: { ok: true }, c: { ok: true } },
  };
  assert.deepEqual(
    deriveFileChanges(journal).changes.map((c) => c.path),
    ["1.txt", "2.txt", "3.txt"],
  );
});

test("journal: deriveFileChanges tolerates a non-object journal", () => {
  assert.deepEqual(deriveFileChanges(null), { changes: [], source: "session-journal" });
  assert.deepEqual(deriveFileChanges("nope"), { changes: [], source: "session-journal" });
});
