/**
 * Capabilities data layer tests: `/api/resources` listing + enable toggle,
 * routed through `xuenessApi` with `globalThis.fetch` stubbed (same mock style
 * as xuenessWorkspace.test.ts). Failures must surface as `{ok:false,error}`.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  loadCapabilitySection,
  toggleCapabilityItem,
  formatCapabilityTime,
  summarizeExtra,
  validateCapabilityId,
  createCapabilityItem,
  deleteCapabilityItem,
  CAPABILITY_FIELD_SPECS,
  CAPABILITY_KINDS,
  parsePluginManifestImport,
  validatePluginManifestDraft,
} from "./xuenessCapabilities";

type Call = { url: string; method: string; body: unknown; headers: Record<string, unknown> };

type StubResult = { status: number; body?: unknown } | "network-error";

function stubFetch(handler: (url: string, method: string, body: unknown) => StubResult): Call[] {
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
    const headers = (init?.headers ?? {}) as Record<string, unknown>;
    calls.push({ url, method, body, headers });
    const result = handler(url, method, body);
    if (result === "network-error") throw new Error("network down");
    return new Response(JSON.stringify(result.body ?? ""), {
      status: result.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

function restoreFetch(original: typeof fetch) {
  globalThis.fetch = original;
}

test("loadCapabilitySection: normal payload parsed, extra extracted, body dropped, sorted by id", async () => {
  const original = globalThis.fetch;
  const calls = stubFetch((url) => {
    assert.equal(url, "/api/resources/hooks");
    return {
      status: 200,
      body: {
        items: [
          { id: "z-hook", event: "post_tool", command: "echo hi", enabled: true, createdAt: "t0", updatedAt: "t1" },
          { id: "a-hook", event: "pre_tool", command: "echo lo", body: "very long body text" },
          "not-an-object",
          { noId: true },
        ],
        capability: { userScopeAvailable: true },
      },
    };
  });
  try {
    const res = await loadCapabilitySection("hooks");
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.deepEqual(res.value.items.map((i) => i.id), ["a-hook", "z-hook"]);
    const first = res.value.items[0];
    assert.equal(first.event, "pre_tool");
    assert.equal(first.command, "echo lo");
    assert.equal(first.enabled, undefined);
    assert.equal("body" in (first.extra ?? {}), false);
    assert.equal(res.value.userScopeAvailable, true);
    assert.equal(calls.length, 1);
  } finally {
    restoreFetch(original);
  }
});

test("loadCapabilitySection: HTTP error becomes {ok:false,error}", async () => {
  const original = globalThis.fetch;
  stubFetch(() => ({ status: 500, body: { error: "boom" } }));
  try {
    const res = await loadCapabilitySection("mcp");
    assert.deepEqual(res, { ok: false, error: "boom" });
  } finally {
    restoreFetch(original);
  }
});

test("loadCapabilitySection: userScopeAvailable=false preserved", async () => {
  const original = globalThis.fetch;
  stubFetch(() => ({
    status: 200,
    body: { items: [], capability: { userScopeAvailable: false, userScopeReason: "read-only" } },
  }));
  try {
    const res = await loadCapabilitySection("skills");
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.value.userScopeAvailable, false);
    assert.equal(res.value.userScopeReason, "read-only");
  } finally {
    restoreFetch(original);
  }
});

test("toggleCapabilityItem: PATCH sends CSRF header and {enabled} body, returns item", async () => {
  const original = globalThis.fetch;
  const calls = stubFetch((url, method, body) => {
    if (url === "/api/csrf") return { status: 200, body: { csrfToken: "tok-1" } };
    assert.equal(url, "/api/resources/skills/my-skill");
    assert.equal(method, "PATCH");
    assert.deepEqual(body, { enabled: true });
    return { status: 200, body: { item: { id: "my-skill", enabled: true, updatedAt: "t2" } } };
  });
  try {
    const res = await toggleCapabilityItem("skills", "my-skill", true);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.value.enabled, true);
    const patchCall = calls.find((c) => c.method === "PATCH");
    assert.ok(patchCall);
    assert.equal(patchCall.headers["X-CSRF-Token"], "tok-1");
  } finally {
    restoreFetch(original);
  }
});

test("toggleCapabilityItem: HTTP failure becomes {ok:false,error}", async () => {
  const original = globalThis.fetch;
  stubFetch((url) =>
    url === "/api/csrf" ? { status: 200, body: { csrfToken: "t" } } : { status: 400, body: { error: "bad id" } },
  );
  try {
    const res = await toggleCapabilityItem("mcp", "srv", false);
    assert.deepEqual(res, { ok: false, error: "bad id" });
  } finally {
    restoreFetch(original);
  }
});

test("toggleCapabilityItem: unknown kind or blank id rejects with TypeError (programming error)", async () => {
  // An async function converts a synchronous throw into a rejected promise.
  await assert.rejects(() => toggleCapabilityItem("nope" as never, "x", true), TypeError);
  await assert.rejects(() => toggleCapabilityItem("mcp", "  ", true), TypeError);
  assert.deepEqual([...CAPABILITY_KINDS], ["mcp", "skills", "commands", "hooks", "subagents", "plugins"]);
});

test("formatCapabilityTime: renders local yyyy-mm-dd hh:mm; invalid/absent -> empty", () => {
  const formatted = formatCapabilityTime("2026-09-28T08:30:00Z");
  assert.match(formatted, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(formatCapabilityTime(undefined), "");
  assert.equal(formatCapabilityTime("not-a-date"), "");
});

test("summarizeExtra: bounded JSON, empty when absent, empty object -> empty", () => {
  assert.equal(summarizeExtra(undefined), "");
  assert.equal(summarizeExtra({}), "");
  const long = { config: "x".repeat(200) };
  const rendered = summarizeExtra(long);
  assert.ok(rendered.length <= 121);
  assert.ok(rendered.endsWith("…"));
  assert.equal(summarizeExtra({ url: "http://x" }), '{"url":"http://x"}');
});

/* -- Batch10: create / delete / id validation / field specs -- */

test("validateCapabilityId: legal ids return empty string, illegal ones a Chinese message", () => {
  for (const good of ["a", "my-skill", "My_Skill.2", "0", "-_."]) {
    assert.equal(validateCapabilityId(good), "", `expected "${good}" to be legal`);
  }
  // 空
  assert.notEqual(validateCapabilityId(""), "");
  assert.notEqual(validateCapabilityId("   "), "");
  // 超长（65 chars）
  assert.notEqual(validateCapabilityId("a".repeat(65)), "");
  assert.equal(validateCapabilityId("a".repeat(64)), "");
  // 坏字符
  assert.notEqual(validateCapabilityId("bad id"), "");
  assert.notEqual(validateCapabilityId("bad/slash"), "");
  assert.notEqual(validateCapabilityId("bad:colon"), "");
  // 点号
  assert.notEqual(validateCapabilityId("."), "");
  assert.notEqual(validateCapabilityId(".."), "");
  assert.notEqual(validateCapabilityId("x..y"), "");
});

test("createCapabilityItem: POSTs CSRF+body, returns item", async () => {
  const original = globalThis.fetch;
  const calls = stubFetch((url, method, body) => {
    if (url === "/api/csrf") return { status: 200, body: { csrfToken: "tok-c" } };
    assert.equal(url, "/api/resources/skills");
    assert.equal(method, "POST");
    assert.deepEqual(body, { id: "new-skill", description: "d", body: "b", enabled: true });
    return { status: 200, body: { item: { id: "new-skill", description: "d", enabled: true } } };
  });
  try {
    const res = await createCapabilityItem("skills", {
      id: "new-skill",
      description: "d",
      body: "b",
      enabled: true,
    });
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.value.id, "new-skill");
    assert.equal(res.value.description, "d");
    const postCall = calls.find((c) => c.method === "POST");
    assert.ok(postCall);
    assert.equal(postCall.headers["X-CSRF-Token"], "tok-c");
  } finally {
    restoreFetch(original);
  }
});

test("createCapabilityItem: HTTP error becomes {ok:false,error}; blank id or bad kind throws TypeError", async () => {
  const original = globalThis.fetch;
  stubFetch((url) =>
    url === "/api/csrf" ? { status: 200, body: { csrfToken: "t" } } : { status: 400, body: { error: "invalid id" } },
  );
  try {
    const res = await createCapabilityItem("commands", { id: "bad/id", enabled: true });
    assert.deepEqual(res, { ok: false, error: "invalid id" });
    await assert.rejects(() => createCapabilityItem("skills", { id: "  " }), TypeError);
    await assert.rejects(() => createCapabilityItem("nope" as never, { id: "x" }), TypeError);
  } finally {
    restoreFetch(original);
  }
});

test("deleteCapabilityItem: DELETEs with CSRF header; HTTP error becomes Result error; blank id/bad kind throws", async () => {
  const original = globalThis.fetch;
  const calls = stubFetch((url, method) => {
    if (url === "/api/csrf") return { status: 200, body: { csrfToken: "tok-d" } };
    assert.equal(url, "/api/resources/hooks/notify");
    assert.equal(method, "DELETE");
    return { status: 200, body: { ok: true, id: "notify" } };
  });
  try {
    const res = await deleteCapabilityItem("hooks", "notify");
    assert.deepEqual(res, { ok: true, value: undefined });
    const deleteCall = calls.find((c) => c.method === "DELETE");
    assert.ok(deleteCall);
    assert.equal(deleteCall.headers["X-CSRF-Token"], "tok-d");
  } finally {
    restoreFetch(original);
  }

  stubFetch((url) =>
    url === "/api/csrf" ? { status: 200, body: { csrfToken: "t" } } : { status: 404, body: { error: "missing" } },
  );
  try {
    const res = await deleteCapabilityItem("mcp", "gone");
    assert.deepEqual(res, { ok: false, error: "missing" });
    await assert.rejects(() => deleteCapabilityItem("mcp", " "), TypeError);
    await assert.rejects(() => deleteCapabilityItem("nope" as never, "x"), TypeError);
  } finally {
    restoreFetch(original);
  }
});

test("CAPABILITY_FIELD_SPECS: every kind has specs, id excluded, enabled boolean present, hooks mirror HOOK_EVENTS", () => {
  for (const kind of CAPABILITY_KINDS) {
    const specs = CAPABILITY_FIELD_SPECS[kind];
    assert.ok(specs.length >= 2, `${kind} should have at least description+enabled`);
    assert.equal(specs.some((s) => s.key === "id"), false, "id is dialog-owned, not a spec");
    const enabled = specs.find((s) => s.key === "enabled");
    assert.ok(enabled);
    assert.equal(enabled.kind, "boolean");
  }
  // skills: description + body
  const skills = Object.fromEntries(CAPABILITY_FIELD_SPECS.skills.map((s) => [s.key, s]));
  assert.equal(skills.description.kind, "text");
  assert.equal(skills.description.required, true);
  assert.equal(skills.body.kind, "textarea");
  // hooks: event placeholder carries the backend enum
  const hooks = Object.fromEntries(CAPABILITY_FIELD_SPECS.hooks.map((s) => [s.key, s]));
  assert.equal(hooks.event.required, true);
  for (const event of [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "PostToolUseFailure",
    "Stop",
  ]) {
    assert.ok(hooks.event.placeholder?.includes(event), `placeholder should mention ${event}`);
  }
});

test("plugin manifest validation/import: accepts data-only builtin manifests and always imports them disabled", () => {
  const parsed = parsePluginManifestImport(JSON.stringify({
    id: "mcp-tools",
    name: "MCP tools",
    description: "Trusted adapter manifest",
    version: "1.2.3",
    apiVersion: 1,
    builtin: "mcp",
    capabilities: ["network", "network"],
    enabled: true,
  }));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.id, "mcp-tools");
  assert.deepEqual(parsed.value.fields, {
    name: "MCP tools",
    description: "Trusted adapter manifest",
    version: "1.2.3",
    apiVersion: 1,
    builtin: "mcp",
    capabilities: ["network"],
    enabled: false,
  });
  assert.equal(validatePluginManifestDraft("bad/id", parsed.value.fields), "ID 只能包含字母、数字、点、下划线和连字符");
});

test("plugin manifest import: rejects executable or unsupported fields, unknown builtins, invalid versions and oversized JSON", () => {
  const valid = { id: "safe", version: "1.0.0", apiVersion: 1, builtin: "skills", capabilities: [] };
  assert.equal(parsePluginManifestImport(JSON.stringify({ ...valid, entrypoint: "evil.js" })).ok, false);
  assert.equal(parsePluginManifestImport(JSON.stringify({ ...valid, command: "python evil.py" })).ok, false);
  assert.equal(parsePluginManifestImport(JSON.stringify({ ...valid, builtin: "external-plugin" })).ok, false);
  assert.equal(parsePluginManifestImport(JSON.stringify({ ...valid, apiVersion: true })).ok, false);
  assert.equal(parsePluginManifestImport(JSON.stringify({ ...valid, version: "latest" })).ok, false);
  assert.equal(parsePluginManifestImport(JSON.stringify({ ...valid, name: 1 })).ok, false);
  assert.equal(parsePluginManifestImport(JSON.stringify({ ...valid, capabilities: ["filesystem-read"] })).ok, false);
  assert.equal(parsePluginManifestImport("x".repeat(256 * 1024 + 1)).ok, false);
});

test("imported plugin manifest creates a real disabled /api/resources/plugins resource", async () => {
  const original = globalThis.fetch;
  const calls = stubFetch((url, method, body) => {
    if (url === "/api/csrf") return { status: 200, body: { csrfToken: "plugin-import-token" } };
    assert.equal(url, "/api/resources/plugins");
    assert.equal(method, "POST");
    assert.deepEqual(body, {
      id: "trusted-skills",
      name: "Trusted skills",
      description: "A data-only adapter manifest",
      version: "1.0.0",
      apiVersion: 1,
      builtin: "skills",
      capabilities: [],
      enabled: false,
      createOnly: true,
    });
    const savedItem = { ...(body as Record<string, unknown>) };
    delete savedItem.createOnly;
    return { status: 200, body: { item: { ...savedItem, id: "trusted-skills" } } };
  });
  try {
    const parsed = parsePluginManifestImport(JSON.stringify({
      id: "trusted-skills",
      name: "Trusted skills",
      description: "A data-only adapter manifest",
      version: "1.0.0",
      apiVersion: 1,
      builtin: "skills",
      capabilities: [],
      enabled: true,
    }));
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const saved = await createCapabilityItem("plugins", { id: parsed.value.id, ...parsed.value.fields, createOnly: true });
    assert.equal(saved.ok, true);
    if (saved.ok) assert.equal(saved.value.enabled, false);
    const post = calls.find(call => call.method === "POST");
    assert.ok(post);
    assert.equal(post.headers["X-CSRF-Token"], "plugin-import-token");
  } finally {
    restoreFetch(original);
  }
});
