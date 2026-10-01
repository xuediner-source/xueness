import test from "node:test";
import assert from "node:assert/strict";
import {
  canUseRuntimeProfile,
  effectiveRuntimeProfile,
  loadComposerCatalog,
  prepareComposer,
  runtimeProfileFromSession,
  runtimeProfileSelection,
  type ComposerInput,
  type ComposerModel,
} from "./xuenessComposer";
import { createSession, sendTurn } from "./xuenessWorkbench";

test("runtime profile toggle follows provider defaults and refuses Standard for JSON tools", () => {
  const lightweight: ComposerModel = {
    id: "local", name: "Local", model: "model-local", configured: true, protocol: "openai",
    capabilities: [], reasoningLevels: [], runtimeProfile: "lightweight", toolCalling: "json",
  };
  assert.equal(effectiveRuntimeProfile(lightweight), "lightweight");
  assert.equal(effectiveRuntimeProfile(lightweight, "standard"), "standard");
  assert.equal(runtimeProfileSelection("lightweight"), "lightweight");
  assert.equal(runtimeProfileSelection("standard"), "standard");
  assert.equal(canUseRuntimeProfile(lightweight, "standard"), false);
  assert.equal(canUseRuntimeProfile(lightweight, "lightweight"), true);
  assert.equal(runtimeProfileFromSession("lightweight"), "lightweight");
  assert.equal(runtimeProfileFromSession("legacy-or-invalid"), undefined);
});

test("composer catalog rejects failures instead of presenting an empty ready model list", async () => {
  const previous = globalThis.fetch;
  let requested = "";
  globalThis.fetch = (async (url: string) => {
    requested = String(url);
    return { ok: false, status: 403, json: async () => ({ error: "sessions disabled" }) } as Response;
  }) as typeof fetch;
  try {
    await assert.rejects(loadComposerCatalog("/path with spaces", "id"), /sessions disabled/);
    assert.equal(requested, "/api/composer?root=%2Fpath+with+spaces&session_id=id");
  } finally { globalThis.fetch = previous; }
});

test("validated composer context travels as a one-use token, and creation becomes visible before a model run finishes", async () => {
  const previous = globalThis.fetch;
  const calls: { path: string; body: Record<string, unknown> | undefined }[] = [];
  const draft: ComposerInput = { attachments: [], files: ["sample.txt"], sessions: [], skills: [], plugins: [], goal: true };
  globalThis.fetch = (async (url: string, options?: RequestInit) => {
    const path = String(url);
    calls.push({ path, body: options?.body ? JSON.parse(String(options.body)) : undefined });
    const payload = path === "/api/csrf" ? { csrfToken: "qa-csrf" }
      : path === "/api/composer/prepare" ? { token: "one-use", text: "prepared text", root: "/qa", metadata: {}, goal: true }
      : path === "/api/sessions" ? { id: "new-task" } : {};
    return { ok: true, json: async () => payload } as Response;
  }) as typeof fetch;
  try {
    const prepared = await prepareComposer("inspect", draft, { root: "/qa", provider_id: "qa-model", reasoning_effort: "max" });
    let seenBeforeRun = false;
    const created = await createSession("inspect", { provider: "real", mode: "plan", goal: true }, {
      root: prepared.root, prepared_token: prepared.token,
    }, id => { seenBeforeRun = id === "new-task" && !calls.some(call => call.path.endsWith("/run")); });
    assert.equal(created.ok, true);
    assert.equal(seenBeforeRun, true);
    assert.deepEqual(calls.find(call => call.path === "/api/sessions")?.body, {
      task: "inspect", root: "/qa", prepared_token: "one-use",
    });
    assert.equal(calls.find(call => call.path.endsWith("/run"))?.body?.steps, 20);
    assert.equal(calls.find(call => call.path === "/api/composer/prepare")?.body?.reasoning_effort, "max");
    calls.length = 0;
    const sent = await sendTurn("new-task", "next", { provider: "real", mode: "build" }, "second-use");
    assert.equal(sent.ok, true);
    assert.deepEqual(calls.find(call => call.path.endsWith("/messages"))?.body, { text: "next", prepared_token: "second-use" });
    assert.equal(calls.some(call => JSON.stringify(call.body)?.includes("prepared text")), false);
  } finally { globalThis.fetch = previous; }
});

test("a saved turn is reported as accepted when only the following run fails", async () => {
  const previous = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = (async (url: string) => {
    const path = String(url); paths.push(path);
    const failure = path.endsWith("/run");
    const payload = path === "/api/csrf" ? { csrfToken: "qa" }
      : path === "/api/sessions" ? { id: "saved-task" }
      : failure ? { error: "model unavailable" } : {};
    return { ok: !failure, json: async () => payload } as Response;
  }) as typeof fetch;
  try {
    assert.deepEqual(await sendTurn("saved-task", "persist this once"), {
      ok: false, error: "model unavailable", accepted: true,
    });
    assert.equal(paths.filter(path => path.endsWith("/messages")).length, 1);
    assert.deepEqual(await createSession("persist task once"), {
      ok: false, error: "model unavailable", accepted: true, id: "saved-task",
    });
  } finally { globalThis.fetch = previous; }
});
