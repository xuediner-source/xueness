import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import {
  filterSettingsSections,
  groupSettingsSections,
  XuenessSettingsView,
  type XuenessSettingsSection,
} from "./XuenessSettingsView";

const sections: XuenessSettingsSection[] = [
  { id: "general", label: "通用", description: "常用设置", group: "基础设置" },
  { id: "appearance", label: "外观", description: "主题与字体", group: "基础设置" },
  { id: "plugins", label: "插件", description: "已启用的插件", group: "Agent 能力" },
  { id: "workspace", label: "工作区", description: "工作区管理", group: "扩展与维护" },
];

test("settings navigation follows the three upstream groups and keeps Xueness routes separate", () => {
  const groups = groupSettingsSections(sections);
  assert.deepEqual(groups.map((group) => group.id), ["basics", "agentCapabilities", "extensions"]);
  assert.deepEqual(groups[0].sections.map((section) => section.id), ["general", "appearance"]);
  assert.deepEqual(groups[1].sections.map((section) => section.id), ["plugins"]);
  assert.deepEqual(groups[2].sections.map((section) => section.id), ["workspace"]);
});

test("settings shell marks the active route and hides the extension group until opened", () => {
  const html = renderToStaticMarkup(
    <XuenessSettingsView
      sections={sections}
      activeSection="plugins"
      onSelect={() => undefined}
      onBack={() => undefined}
    >
      <div>Plugin settings body</div>
    </XuenessSettingsView>,
  );
  assert.match(html, /data-testid="xn-settings-nav-general"/);
  assert.match(html, /<button[^>]*aria-current="page"[^>]*data-testid="xn-settings-nav-plugins"/);
  assert.match(html, /data-testid="xn-settings-back"/);
  assert.match(html, /aria-label="返回工作区"/);
  assert.match(html, /Plugin settings body/);
  assert.match(html, /<details class="xn-settings-view__extensions">/);
  assert.match(html, /data-testid="xn-settings-search"/);
  assert.match(html, /type="search"[^>]*aria-controls="xn-settings-nav-results"/);
  assert.doesNotMatch(html, /保存配置/);
});

test("settings search matches destination labels, descriptions, and ids case-insensitively", () => {
  assert.deepEqual(filterSettingsSections(sections, "外观").map(({ id }) => id), ["appearance"]);
  assert.deepEqual(filterSettingsSections(sections, "字体").map(({ id }) => id), ["appearance"]);
  assert.deepEqual(filterSettingsSections(sections, "WORKSPACE").map(({ id }) => id), ["workspace"]);
  assert.deepEqual(filterSettingsSections(sections, "   "), sections);
  assert.deepEqual(filterSettingsSections(sections, "nothing here"), []);
});

test("navigating to a Xueness-only section expands the extension navigation", () => {
  const html = renderToStaticMarkup(
    <XuenessSettingsView sections={sections} activeSection="workspace" onSelect={() => undefined} />,
  );
  assert.match(html, /<details class="xn-settings-view__extensions" open=""/);
  assert.match(html, /data-testid="xn-settings-nav-workspace"/);
});

test("loading and error states are announced and retry is offered only with a handler", () => {
  const loading = renderToStaticMarkup(
    <XuenessSettingsView sections={sections} activeSection="general" onSelect={() => undefined} loading />,
  );
  assert.match(loading, /aria-busy="true"/);
  assert.match(loading, /正在加载设置/);
  assert.doesNotMatch(loading, /xn-settings-section-content/);

  const failed = renderToStaticMarkup(
    <XuenessSettingsView
      sections={sections}
      activeSection="general"
      onSelect={() => undefined}
      error="Connection refused"
      onRetry={() => undefined}
    />,
  );
  assert.match(failed, /role="alert"/);
  assert.match(failed, /Connection refused/);
  assert.match(failed, />重试</);
});

test("saving is a compact status indicator instead of an unsupported global save bar", () => {
  const saving = renderToStaticMarkup(
    <XuenessSettingsView
      sections={sections}
      activeSection="general"
      onSelect={() => undefined}
      dirty
      saving
      onSave={() => undefined}
    />,
  );
  assert.match(saving, /role="status"[^>]*aria-live="polite"/);
  assert.match(saving, /正在保存/);
  assert.doesNotMatch(saving, /xn-settings-view__save-button|有未保存的更改|保存配置/);
});

test("the sidebar leads with the workspace card and the pane names the section", () => {
  const html = renderToStaticMarkup(
    <XuenessSettingsView
      sections={sections}
      activeSection="general"
      onSelect={() => undefined}
      account={{
        name: "xueness",
        path: "/home/box/projects/xueness",
        badges: [{ label: "main", title: "当前 Git 分支" }],
      }}
    >
      <div>General body</div>
    </XuenessSettingsView>,
  );
  assert.match(html, /data-testid="xn-settings-account"/);
  assert.match(html, /title="\/home\/box\/projects\/xueness">…\/projects\/xueness</);
  assert.match(html, /<span class="xn-settings-account__badge" title="当前 Git 分支">main<\/span>/);
  assert.match(html, /<h1>通用<\/h1><p class="xn-settings-view__description">常用设置<\/p>/);
  assert.ok(html.indexOf("xn-settings-account") < html.indexOf("xn-settings-view__search"));
});

test("the workspace card stays out of the shell when the host has no identity data", () => {
  const html = renderToStaticMarkup(
    <XuenessSettingsView sections={sections} activeSection="general" onSelect={() => undefined}>
      <div>General body</div>
    </XuenessSettingsView>,
  );
  assert.doesNotMatch(html, /xn-settings-account/);
  assert.match(html, /data-testid="xn-settings-search"/);
});
