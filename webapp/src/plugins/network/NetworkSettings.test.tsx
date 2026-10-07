import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import {
  NetworkSettings,
  clearSavedNetworkKey,
  clearSavedSearchModelKey,
  diagnoseNetwork,
  readNetworkSettings,
  saveNetworkSettings,
} from "./NetworkSettings";

test("disabled network settings show no controls and the guarded reader makes no request", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls += 1; throw new Error("unexpected request"); }) as typeof fetch;
  try {
    const html = renderToStaticMarkup(<NetworkSettings enabled={false} />);
    assert.match(html, /network-settings/);
    assert.match(html, /网络工具已关闭/);
    assert.doesNotMatch(html, /<input/);
    assert.equal(await readNetworkSettings(false), null);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("network settings load only through the local API and never accept a key in responses", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, method: init?.method ?? "GET", ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    const payload = url === "/api/network/settings"
      ? { settings: { searchEndpoint: "https://search.example/search", imageSearchEndpoint: "", dohEndpoint: "", searchMode: "service",
          searchModelEndpoint: "https://models.example/v1/chat/completions", searchModel: "model-x",
          hasSearchKey: true, hasSavedSearchKey: true, hasEnvironmentSearchKey: false, searchKeySource: "saved",
          hasSearchModelKey: true, hasSavedSearchModelKey: true } }
      : { csrfToken: "local-test" };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    const values = await readNetworkSettings(true);
    assert.equal(values?.searchEndpoint, "https://search.example/search");
    assert.equal(values?.imageSearchEndpoint, "");
    assert.equal(values?.hasSearchKey, true);
    assert.equal(JSON.stringify(values).includes("apiKey"), false);
    assert.deepEqual(calls, [{ url: "/api/network/settings", method: "GET" }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("save leaves a blank secret out, clear is explicit, and diagnostics run only on explicit calls", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    calls.push({ url, method, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    const payload = url === "/api/csrf" ? { csrfToken: "local-test" }
      : url === "/api/network/diagnostics" ? { ok: true, operation: "dns", dnsSource: "system" }
      : { settings: { searchEndpoint: "https://search.example/search", imageSearchEndpoint: "https://images.example/v1/images/search", dohEndpoint: "", searchMode: "service",
            searchModelEndpoint: "https://models.example/v1/chat/completions", searchModel: "model-x",
            hasSearchKey: false, hasSavedSearchKey: false, hasEnvironmentSearchKey: false, searchKeySource: "none",
            hasSearchModelKey: false, hasSavedSearchModelKey: false } };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    await saveNetworkSettings({ searchEndpoint: "https://search.example/search", imageSearchEndpoint: "https://images.example/v1/images/search", dohEndpoint: "", searchMode: "service",
      searchModelEndpoint: "https://models.example/v1/chat/completions", searchModel: "model-x", searchKey: "" });
    await diagnoseNetwork("dns");
    await clearSavedNetworkKey();
    await clearSavedSearchModelKey();
    const writes = calls.filter(call => call.method === "POST" && call.url !== "/api/csrf");
    assert.deepEqual(writes.map(call => [call.url, JSON.parse(call.body ?? "{}")]), [
      ["/api/network/settings", { searchEndpoint: "https://search.example/search", imageSearchEndpoint: "https://images.example/v1/images/search", dohEndpoint: "", searchMode: "service",
        searchModelEndpoint: "https://models.example/v1/chat/completions", searchModel: "model-x" }],
      ["/api/network/diagnostics", { operation: "dns" }],
      ["/api/network/settings", { clearSearchKey: true }],
      ["/api/network/settings", { clearSearchModelKey: true }],
    ]);
    assert.equal(calls.some(call => call.url.includes("search.example")), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("enabled settings stay local while loading, and disabled settings have a no-request empty state", () => {
  const zh = renderToStaticMarkup(<NetworkSettings enabled={true} />);
  assert.match(zh, /正在读取网络工具设置/);
  assert.doesNotMatch(zh, /api\/network\/diagnostics/);
  const off = renderToStaticMarkup(<NetworkSettings enabled={false} />);
  assert.match(off, /网络工具已关闭/);
  assert.doesNotMatch(off, /<form|<input|<button/);
});
