import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { setLocale } from "../../i18n";
import { BrowserSettings, clearBrowserData, dialogTabWrapTarget, readBrowserProfilePresent } from "./BrowserSettings";

test("browser settings gates profile controls by the managed browser toggle", () => {
  const off = renderToStaticMarkup(<BrowserSettings enabled={false} onEnabledChange={async () => {}} />);
  assert.match(off, /data-testid="browser-settings"/);
  assert.match(off, /role="switch"/);
  assert.match(off, /aria-checked="false"/);
  assert.doesNotMatch(off, /<header\b/);
  assert.doesNotMatch(off, /<h4[^>]*>浏览器控制<\/h4>/);
  assert.equal((off.match(/<h4\b/g) ?? []).length, 1);
  assert.match(off, /data-testid="browser-profile-status"/);
  assert.doesNotMatch(off, /当前服务的浏览器资料/);
  assert.match(off, /data-testid="browser-clear-cache" disabled=""/);
  assert.match(off, /data-testid="browser-clear-all" disabled=""/);
  assert.match(off, /管理此服务的受管理浏览器资料；不会访问个人 Chrome 资料/);
  assert.match(off, /启用浏览器控制后，可选择本机 Chrome 资料/);
  assert.match(off, /导入 Chrome 浏览器资料/);
  assert.match(off, /data-testid="browser-import-profile" disabled="">选择资料…<\/button>/);
  assert.match(off, /xn-browser-settings__control-heading"><h5>启用浏览器控制<\/h5><button/);
  assert.doesNotMatch(off, /api\/browser\/data/);
  assert.doesNotMatch(off, /role="alertdialog"/);

  const on = renderToStaticMarkup(<BrowserSettings enabled onEnabledChange={async () => {}} />);
  assert.match(on, /aria-checked="true"/);
  assert.doesNotMatch(on, /data-testid="browser-clear-cache" disabled=""/);
  assert.doesNotMatch(on, /data-testid="browser-clear-all" disabled=""/);
});

test("browser data clients use the profile contract and require confirmation only for all data", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    calls.push({ url, method, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    const payload = url === "/api/csrf"
      ? { csrfToken: "test-token" }
      : url === "/api/browser/data" && method === "GET"
        ? { profilePresent: true }
        : { ok: true };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  try {
    assert.equal(await readBrowserProfilePresent(), true);
    await clearBrowserData("cache");
    await clearBrowserData("all");
    const writes = calls.filter((call) => call.url === "/api/browser/data" && call.method === "POST");
    assert.deepEqual(writes.map((call) => JSON.parse(call.body ?? "{}")), [
      { operation: "cache" },
      { operation: "all", confirmed: true },
    ]);
    assert.equal(calls[0].url, "/api/browser/data");
    assert.equal(calls[0].method, "GET");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("clear-all dialog keeps Tab and Shift+Tab inside and returns outside focus to its first control", () => {
  assert.equal(dialogTabWrapTarget(1, 3, false), null);
  assert.equal(dialogTabWrapTarget(2, 3, false), 0);
  assert.equal(dialogTabWrapTarget(0, 3, true), 2);
  assert.equal(dialogTabWrapTarget(-1, 3, false), 0);
  assert.equal(dialogTabWrapTarget(-1, 3, true), 2);
  assert.equal(dialogTabWrapTarget(0, 0, false), null);
});

test("browser settings display the supported web behavior in English", () => {
  try {
    setLocale("en");
    const html = renderToStaticMarkup(<BrowserSettings enabled={false} onEnabledChange={async () => {}} />);
    assert.match(html, /Browser control/);
    assert.match(html, /Import Chrome profile/);
    assert.match(html, /this service&#x27;s managed browser profile; personal Chrome data is not accessed/);
    assert.match(html, /Enable browser control to select a local Chrome profile/);
    assert.match(html, /Clear all browser data/);
    assert.doesNotMatch(html, /backend/);
  } finally {
    setLocale("zh");
  }
});
