import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import type { XuenessPlugin } from "./xuenessApi";
import { FeatureUnavailable, filterPlugins, pluginState, XuenessPluginManager, XuenessPluginSettingsPanel } from "./XuenessPluginManager";
import { derivePluginAvailability } from "./xuenessPluginRegistry";
import { setLocale } from "./i18n";

const plugin = (id: string, values: Partial<XuenessPlugin> = {}): XuenessPlugin => ({
  id,
  name: id,
  description: `${id} plugin`,
  version: "1.0.0",
  apiVersion: "1",
  enabled: true,
  effective: true,
  dependencies: [],
  blockedBy: [],
  tools: [],
  commands: [],
  panels: [],
  resources: [],
  capabilities: [],
  ...values,
});

test("plugin availability follows effective catalog state and fails closed before load", () => {
  const pending = derivePluginAvailability([plugin("sessions")], false);
  assert.deepEqual(pending.panels, []);
  assert.deepEqual(pending.capabilityKinds, []);

  const available = derivePluginAvailability([
    plugin("sessions"),
    plugin("files", { effective: false, blockedBy: ["sessions"] }),
    plugin("mcp"),
    plugin("hooks", { enabled: false, effective: false }),
    plugin("subagents", { effective: false, blockedBy: ["files", "sessions"] }),
    plugin("future-plugin"),
  ], true);
  assert.deepEqual(available.panels, ["chat", "capabilities"]);
  assert.deepEqual(available.capabilityKinds, ["mcp"]);
  assert.equal(available.effectiveIds.has("future-plugin"), false);

  const expanded = derivePluginAvailability([
    plugin("automation"), plugin("extensions"), plugin("diagnostics"),
    plugin("browser", { enabled: false, effective: false }),
    plugin("remote", { enabled: false, effective: false }),
  ], true);
  assert.deepEqual(expanded.panels, ["automations", "marketplace", "diagnostics"]);
  assert.equal(expanded.effectiveIds.has("browser"), false);
  assert.equal(expanded.effectiveIds.has("remote"), false);
});

test("plugin manager reflects enabled/effective and blocked dependency states", () => {
  try {
    setLocale("en");
    const html = renderToStaticMarkup(
      <XuenessPluginManager
        plugins={[
          plugin("sessions"),
          plugin("subagents", { effective: false, blockedBy: ["files"] }),
        ]}
        loading={false}
        error=""
        onRefresh={async () => {}}
        onToggle={async () => {}}
      />,
    );
    assert.match(html, /Plugin manager/);
    assert.match(html, /Active/);
    assert.match(html, /Waiting for dependencies/);
    assert.match(html, /Dependencies are inactive: files/);
    assert.match(html, /type="checkbox"[^>]*checked=""/);
    const disabled = renderToStaticMarkup(
      <XuenessPluginManager
        plugins={[plugin("hooks", { enabled: false, effective: false })]}
        loading={false}
        error=""
        onRefresh={async () => {}}
        onToggle={async () => {}}
      />,
    );
    assert.match(disabled, /Disabled/);
    assert.doesNotMatch(disabled, /type="checkbox"[^>]*checked=""/);
  } finally {
    setLocale("zh");
  }
});

test("plugin catalog search and status filters use effective and dependency state", () => {
  const plugins = [
    plugin("sessions"),
    plugin("hooks", { enabled: false, effective: false }),
    plugin("subagents", { effective: false, blockedBy: ["files"], dependencies: ["files"] }),
    plugin("future-plugin", { effective: false }),
  ];

  try {
    setLocale("en");
    assert.deepEqual(plugins.map(pluginState), ["active", "disabled", "blocked", "unavailable"]);
    assert.deepEqual(filterPlugins(plugins, "active", "").map(({ id }) => id), ["sessions"]);
    assert.deepEqual(filterPlugins(plugins, "disabled", "").map(({ id }) => id), ["hooks"]);
    assert.deepEqual(filterPlugins(plugins, "blocked", "").map(({ id }) => id), ["subagents"]);
    assert.deepEqual(filterPlugins(plugins, "all", "FILES").map(({ id }) => id), ["subagents"]);
    assert.deepEqual(filterPlugins(plugins, "all", "conversation").map(({ id }) => id), ["sessions"]);
  } finally {
    setLocale("zh");
  }
});

test("plugin catalog searches bilingual feature metadata, tool names and command names", () => {
  const sessions = plugin("sessions", {
    features: [{ id: "sessions.fork", name: "历史分叉", nameEn: "History forking" }],
    tools: ["read_session_context"],
    commands: ["sessions fork"],
  });
  const providers = plugin("providers", {
    features: [{ id: "providers.lightweight", name: "轻量运行", nameEn: "Lightweight runtime" }],
    tools: ["tool_search"],
    commands: ["providers"],
  });
  const catalog = [sessions, providers];

  assert.deepEqual(filterPlugins(catalog, "all", "历史分叉").map(({ id }) => id), ["sessions"]);
  assert.deepEqual(filterPlugins(catalog, "all", "HISTORY FORKING").map(({ id }) => id), ["sessions"]);
  assert.deepEqual(filterPlugins(catalog, "all", "sessions.fork").map(({ id }) => id), ["sessions"]);
  assert.deepEqual(filterPlugins(catalog, "all", "tool_search").map(({ id }) => id), ["providers"]);
  assert.deepEqual(filterPlugins(catalog, "all", "providers").map(({ id }) => id), ["providers"]);

  try {
    setLocale("en");
    const english = renderToStaticMarkup(<XuenessPluginManager plugins={catalog} loading={false} error=""
      onRefresh={async () => {}} onToggle={async () => {}} />);
    assert.match(english, /data-testid="xn-plugin-details-sessions"/);
    assert.match(english, /Features &amp; interfaces \(3\)/);
    assert.match(english, /sessions\.fork/);
    assert.match(english, /read_session_context/);
    assert.match(english, /sessions fork/);

    setLocale("zh");
    const chinese = renderToStaticMarkup(<XuenessPluginManager plugins={catalog} loading={false} error=""
      onRefresh={async () => {}} onToggle={async () => {}} />);
    assert.match(chinese, /历史分叉/);
    assert.match(chinese, /轻量运行/);
  } finally {
    setLocale("zh");
  }
});

test("plugin manager exposes catalog errors and makes pending controls read-only", () => {
  try {
    setLocale("en");
    const failed = renderToStaticMarkup(
      <XuenessPluginManager plugins={[]} loading={false} error="network unavailable" onRefresh={async () => {}} onToggle={async () => {}} />,
    );
    assert.match(failed, /role="alert"/);
    assert.match(failed, /Could not load plugins: network unavailable/);
    assert.doesNotMatch(failed, /type="checkbox"/);

    const loading = renderToStaticMarkup(
      <XuenessPluginManager plugins={[plugin("sessions")]} loading error="" onRefresh={async () => {}} onToggle={async () => {}} />,
    );
    assert.match(loading, /type="checkbox"[^>]*disabled=""/);
  } finally {
    setLocale("zh");
  }
});

test("disabled feature fallback gives a direct route back to plugin controls", () => {
  try {
    setLocale("en");
    const html = renderToStaticMarkup(<FeatureUnavailable feature="Conversations" onManage={() => {}} />);
    assert.match(html, /role="status"/);
    assert.match(html, /Module unavailable: Conversations/);
    assert.match(html, /Open Plugin manager/);
  } finally {
    setLocale("zh");
  }
});

test("the primary Plugins page shows every bundled plugin rather than an empty resource list", () => {
  const bundleRoot = resolve(process.cwd(), "../xueness/bundled_plugins");
  const catalog: XuenessPlugin[] = readdirSync(bundleRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name !== "__pycache__")
    .map(entry => {
      const manifest = JSON.parse(readFileSync(resolve(bundleRoot, entry.name, "manifest.json"), "utf8"));
      return { ...manifest, enabled: manifest.defaultEnabled, effective: manifest.defaultEnabled, blockedBy: [] };
    });
  assert.equal(catalog.length, 26);
  const html = renderToStaticMarkup(<XuenessPluginSettingsPanel plugins={catalog} loading={false} error=""
    onRefresh={async () => {}} onToggle={async () => {}}
    resourceContent={<div>empty-resource-list-fixture</div>} />);
  assert.match(html, /已安装功能插件/);
  assert.match(html, /资源清单/);
  assert.equal((html.match(/data-testid="xn-installed-plugin-/gu) ?? []).length, catalog.length);
  assert.doesNotMatch(html, /empty-resource-list-fixture/);
  for (const item of catalog) assert.ok(html.includes(`data-testid="xn-installed-plugin-${item.id}"`));
});

test("installed plugin controls remain visible without the extensions resource plugin", () => {
  const html = renderToStaticMarkup(<XuenessPluginSettingsPanel
    plugins={[plugin("extensions", { enabled: false, effective: false }), plugin("sessions")]}
    loading={false} error="" onRefresh={async () => {}} onToggle={async () => {}} />);
  assert.match(html, /xn-installed-plugin-extensions/);
  assert.match(html, /xn-installed-plugin-sessions/);
  assert.doesNotMatch(html, /Browse extension marketplace|浏览扩展市场/);
  const container = readFileSync(resolve(process.cwd(), "src/XuenessWorkbenchContainer.tsx"), "utf8");
  assert.match(container, /if \(settingsSection === "plugins"\) return <XuenessPluginSettingsPanel/);
  assert.doesNotMatch(container, /subagents:"subagents",plugins:"extensions"/);
});
