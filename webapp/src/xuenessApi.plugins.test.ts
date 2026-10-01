import test from "node:test";
import assert from "node:assert/strict";
import { listPlugins, setPluginEnabled, installMarketplaceItem, createAutomation, runAutomation, approveAutomation, discoverProviderModels } from "./xuenessApi";

const response = (payload: unknown, status = 200): Response => new Response(JSON.stringify(payload), {
  status,
  headers: { "Content-Type": "application/json" },
});

test("listPlugins uses a same-origin uncached GET and returns the catalog", async () => {
  const original = globalThis.fetch;
  const catalog = { plugins: [{ id: "sessions", enabled: true, effective: true }] };
  try {
    globalThis.fetch = (async (input, init) => {
      assert.equal(String(input), "/api/plugins");
      assert.equal(init?.credentials, "same-origin");
      assert.equal(init?.cache, "no-store");
      return response(catalog);
    }) as typeof fetch;
    assert.deepEqual(await listPlugins(), catalog);
  } finally {
    globalThis.fetch = original;
  }
});

test("setPluginEnabled fetches CSRF then POSTs the requested state", async () => {
  const original = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  const catalog = { plugins: [{ id: "hooks", enabled: false, effective: false }] };
  try {
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === "/api/csrf") return response({ csrfToken: "token" });
      return response(catalog);
    }) as typeof fetch;
    assert.deepEqual(await setPluginEnabled("hooks", false), catalog);
    assert.deepEqual(calls.map((call) => call.url), ["/api/csrf", "/api/plugins/hooks"]);
    assert.equal(calls[1].init?.method, "POST");
    assert.equal(calls[1].init?.headers && (calls[1].init?.headers as Record<string, string>)["X-CSRF-Token"], "token");
    assert.deepEqual(JSON.parse(String(calls[1].init?.body)), { enabled: false });
  } finally {
    globalThis.fetch = original;
  }
});

test("listPlugins rejects malformed catalogs and reports HTTP errors", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async () => response({ plugins: null })) as typeof fetch;
    await assert.rejects(listPlugins(), /Invalid plugin catalog response/);
    globalThis.fetch = (async () => response({ error: "unavailable" }, 503)) as typeof fetch;
    await assert.rejects(listPlugins(), /unavailable/);
  } finally {
    globalThis.fetch = original;
  }
});

test("marketplace install sends the pinned digest and automation mutations use explicit contracts", async () => {
  const original = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  try {
    globalThis.fetch = (async (input, init) => {
      const url = String(input); calls.push({ url, init });
      if (url === "/api/csrf") return response({ csrfToken: "secure-token" });
      if (url.includes("marketplace")) return response({ marketplace: [] });
      if (url.endsWith("/run")) return response({ run: { id: "run-1", at: 0, status: "awaiting_approval", workflowId: "wf-1" } });
      if (url.endsWith("/approve")) return response({ automation: { id: "auto-1" } });
      return response({ automation: { id: "auto-1" } });
    }) as typeof fetch;
    await installMarketplaceItem("safe-plugin", "sha256:abcdef", false);
    await createAutomation({ name: "weekday", schedule: "0 9 * * 1-5", timezone: "Asia/Shanghai", enabled: true, workflow: { root: "/tmp/project", name: "review", nodes: [], concurrency: 2 } });
    await runAutomation("auto-1");
    await approveAutomation("auto-1", false);
    const posts = calls.filter(call => call.init?.method === "POST");
    assert.deepEqual(posts.map(call => [call.url, JSON.parse(String(call.init?.body))]), [
      ["/api/plugins/marketplace/safe-plugin/install", { sha256: "sha256:abcdef" }],
      ["/api/automations", { name: "weekday", schedule: "0 9 * * 1-5", timezone: "Asia/Shanghai", enabled: true, workflow: { root: "/tmp/project", name: "review", nodes: [], concurrency: 2 } }],
      ["/api/automations/auto-1/run", {}],
      ["/api/automations/auto-1/approve", { confirmed: true, allowReal: false }],
    ]);
    assert.equal(posts.every(call => (call.init?.headers as Record<string, string>)?.["X-CSRF-Token"] === "secure-token"), true);
  } finally { globalThis.fetch = original; }
});

test("provider model discovery POSTs only the saved ID with CSRF and returns only server-listed models", async () => {
  const original = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  const payload = {
    ok: true,
    provider: { id: "openai-saved", name: "Saved OpenAI", model: "configured-model", protocol: "openai" },
    models: [{ id: "server-model-a", created: 1760000000, ownedBy: "upstream" }, { id: "server-model-b" }],
  };
  try {
    globalThis.fetch = (async (input, init) => {
      const url = String(input); calls.push({ url, init });
      return url === "/api/csrf" ? response({ csrfToken: "discover-token" }) : response(payload);
    }) as typeof fetch;
    assert.deepEqual(await discoverProviderModels("openai-saved"), payload);
    assert.deepEqual(calls.map(call => call.url), ["/api/csrf", "/api/providers/discover"]);
    assert.equal(calls[1].init?.method, "POST");
    assert.equal((calls[1].init?.headers as Record<string, string>)?.["X-CSRF-Token"], "discover-token");
    assert.deepEqual(JSON.parse(String(calls[1].init?.body)), { id: "openai-saved" });
  } finally { globalThis.fetch = original; }
});

test("provider model discovery rejects malformed model entries and reports the server allow-real gate", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async input => String(input) === "/api/csrf"
      ? response({ csrfToken: "token" })
      : response({ ok: true, provider: { id: "p", name: "P", model: "m", protocol: "openai" }, models: [{ name: "guessed" }] })) as typeof fetch;
    await assert.rejects(discoverProviderModels("p"), /invalid model discovery response/);
    globalThis.fetch = (async input => String(input) === "/api/csrf"
      ? response({ csrfToken: "token" })
      : response({ error: "real model requests are disabled" }, 403)) as typeof fetch;
    await assert.rejects(discoverProviderModels("p"), /real model requests are disabled/);
  } finally { globalThis.fetch = original; }
});
