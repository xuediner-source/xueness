/**
 * CapabilitiesPanel tests (SSR markup): six sections, kind-specific detail
 * lines, and the anti-fake-control rule — a switch exists only when an
 * onToggle handler was passed.
 */
import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { CapabilitiesPanel, CapabilitySection } from "./XuenessCapabilitiesPanel";
import type { CapabilityItem } from "./xuenessCapabilities";

function item(partial: Partial<CapabilityItem> & { id: string }): CapabilityItem {
  return partial;
}

const HOOK_ITEM = item({
  id: "notify",
  enabled: true,
  event: "post_tool",
  command: "python3 notify.py --id {id}",
  updatedAt: "2026-09-28T10:00:00Z",
});

const SKILL_ITEM = item({
  id: "deploy-runbook",
  enabled: false,
  description: "How to deploy the service step by step",
});

test("CapabilitiesPanel: renders the six real resource groups with search and scope", () => {
  const html = renderToStaticMarkup(
    <CapabilitiesPanel
      sections={(["mcp", "skills", "commands", "hooks", "subagents", "plugins"] as const).map((kind) => ({
        kind,
        label: kind,
        items: [],
      }))}
    />,
  );
  assert.match(html, /data-testid="xn-cap-panel"/);
  for (const kind of ["mcp", "skills", "commands", "hooks", "subagents", "plugins"]) {
    assert.match(html, new RegExp(`data-testid="xn-cap-section-${kind}"`));
    assert.match(html, new RegExp(`data-testid="xn-cap-empty-${kind}"`));
    assert.match(html, new RegExp(`data-testid="xn-cap-count-${kind}"`));
  }
  assert.match(html, /data-testid="xn-cap-search"/);
  assert.match(html, /data-testid="xn-cap-scope">用户级资源<\/span>/);
  assert.match(html, /暂无配置/);
});

test("CapabilitySection: hooks item shows event+command; no onToggle -> badge, no switch (anti-fake-control)", () => {
  const html = renderToStaticMarkup(
    <CapabilitySection kind="hooks" label="Hooks" items={[HOOK_ITEM]} />,
  );
  assert.match(html, /data-testid="xn-cap-item-hooks-notify"/);
  assert.match(html, /post_tool · python3 notify\.py --id \{id\}/);
  assert.doesNotMatch(html, /role="switch"/);
  assert.match(html, /已启用/);
  assert.match(html, /class="xn-resource-item__icon"/);
});

test("CapabilitySection: with onToggle -> real switch with aria-checked and testid; disabled while busy", () => {
  const html = renderToStaticMarkup(
    <CapabilitySection
      kind="skills"
      label="技能"
      items={[SKILL_ITEM]}
      onToggle={() => {}}
    />,
  );
  const toggle = html.match(/<button[^>]*data-testid="xn-cap-toggle-skills-deploy-runbook"[^>]*>/)?.[0] ?? "";
  assert.notEqual(toggle, "");
  assert.match(toggle, /role="switch"/);
  assert.match(toggle, /aria-checked="false"/);
  assert.doesNotMatch(toggle, /disabled/);

  const busy = renderToStaticMarkup(
    <CapabilitySection
      kind="skills"
      label="技能"
      items={[SKILL_ITEM]}
      busyId="deploy-runbook"
      onToggle={() => {}}
    />,
  );
  const busyToggle = busy.match(/<button[^>]*data-testid="xn-cap-toggle-skills-deploy-runbook"[^>]*>/)?.[0] ?? "";
  assert.match(busyToggle, /disabled/);
});

test("CapabilitySection: error/loading states render without leaking arbitrary config", () => {
  const withError = renderToStaticMarkup(
    <CapabilitySection kind="mcp" label="MCP" items={[]} error={"boom"} />,
  );
  assert.match(withError, /role="alert"/);
  assert.match(withError, /boom/);

  const loading = renderToStaticMarkup(
    <CapabilitySection kind="mcp" label="MCP" items={[]} loading />,
  );
  assert.match(loading, /加载中/);

  const longExtra = item({
    id: "srv",
    extra: { config: "x".repeat(200) },
  });
  const clipped = renderToStaticMarkup(
    <CapabilitySection kind="mcp" label="MCP" items={[longExtra]} />,
  );
  assert.match(clipped, /xn-resource-item__name/);
  assert.ok(!clipped.includes("x".repeat(200)));
  assert.doesNotMatch(clipped, /\{"config"/);
});

test("CapabilitySection: userScopeAvailable=false adds the honest hint", () => {
  const html = renderToStaticMarkup(
    <CapabilitySection
      kind="plugins"
      label="插件"
      items={[]}
      userScopeAvailable={false}
      userScopeReason="read-only workspace"
    />,
  );
  assert.match(html, /用户级资源目录不可用/);
  assert.match(html, /read-only workspace/);
});

/* -- Batch10: create / edit / delete affordances -- */

test("CapabilitySection: no handlers -> no create/edit/delete controls (anti-fake-control)", () => {
  const html = renderToStaticMarkup(
    <CapabilitySection kind="skills" label="技能" items={[SKILL_ITEM]} />,
  );
  assert.doesNotMatch(html, /xn-cap-create-skills/);
  assert.doesNotMatch(html, /xn-cap-edit-skills-deploy-runbook/);
  assert.doesNotMatch(html, /xn-cap-delete-skills-deploy-runbook/);
  assert.doesNotMatch(html, /✎/);
  assert.doesNotMatch(html, /🗑/);
});

test("CapabilitySection: with handlers -> new resource row, row editor, and delete control", () => {
  const html = renderToStaticMarkup(
    <CapabilitySection
      kind="skills"
      label="技能"
      items={[SKILL_ITEM]}
      onCreate={() => {}}
      onEdit={() => {}}
      onDelete={() => {}}
    />,
  );
  assert.match(html, /data-testid="xn-cap-create-skills"/);
  assert.match(html, /data-testid="xn-cap-edit-skills-deploy-runbook"/);
  assert.match(html, /data-testid="xn-cap-delete-skills-deploy-runbook"/);
  assert.match(html, /aria-label="编辑 deploy-runbook"/);
  assert.match(html, /aria-label="删除 deploy-runbook"/);
  assert.match(html, /class="xn-resource-item__icon"/);
});

test("CapabilitySection: edit/delete coexist with the toggle when all handlers are passed", () => {
  const html = renderToStaticMarkup(
    <CapabilitySection
      kind="skills"
      label="技能"
      items={[SKILL_ITEM]}
      onToggle={() => {}}
      onEdit={() => {}}
      onDelete={() => {}}
    />,
  );
  // existing toggle keeps working alongside the new actions
  assert.match(html, /data-testid="xn-cap-toggle-skills-deploy-runbook"/);
  assert.match(html, /data-testid="xn-cap-edit-skills-deploy-runbook"/);
  assert.match(html, /data-testid="xn-cap-delete-skills-deploy-runbook"/);
});

test("CapabilitySection: busyId disables that row's edit/delete buttons; idle row stays enabled", () => {
  const html = renderToStaticMarkup(
    <CapabilitySection
      kind="hooks"
      label="Hooks"
      items={[HOOK_ITEM]}
      busyId="notify"
      onEdit={() => {}}
      onDelete={() => {}}
    />,
  );
  const edit = html.match(/<button[^>]*data-testid="xn-cap-edit-hooks-notify"[^>]*>/)?.[0] ?? "";
  const del = html.match(/<button[^>]*data-testid="xn-cap-delete-hooks-notify"[^>]*>/)?.[0] ?? "";
  assert.notEqual(edit, "");
  assert.notEqual(del, "");
  assert.match(edit, /disabled/);
  assert.match(del, /disabled/);

  const idle = renderToStaticMarkup(
    <CapabilitySection kind="hooks" label="Hooks" items={[HOOK_ITEM]} onEdit={() => {}} />,
  );
  const idleEdit = idle.match(/<button[^>]*data-testid="xn-cap-edit-hooks-notify"[^>]*>/)?.[0] ?? "";
  assert.doesNotMatch(idleEdit, /disabled/);
});

test("CapabilityPanel rows show safe name and description and keep unknown fields hidden", () => {
  const privateItem = item({
    id: "remote-tool",
    enabled: true,
    description: "Runs project analysis",
    extra: { name: "Project analyst", apiKey: "must-not-render", privateConfig: { token: "secret" } },
  });
  const html = renderToStaticMarkup(
    <CapabilitiesPanel sections={[
      { kind: "subagents", label: "Subagents", items: [privateItem], onEdit: () => {}, onToggle: () => {} },
    ]} />,
  );
  assert.match(html, /Project analyst/);
  assert.match(html, /Runs project analysis/);
  assert.match(html, /role="switch"/);
  assert.ok(!html.includes("must-not-render"));
  assert.ok(!html.includes("secret"));
});

test("plugin resources show manifest status and safety copy without claiming runtime-loaded plugins", () => {
  const html = renderToStaticMarkup(
    <CapabilitiesPanel sections={[
      {
        kind: "plugins",
        label: "插件",
        items: [item({
          id: "mcp-tools",
          enabled: true,
          description: "A trusted builtin adapter manifest",
          extra: { name: "MCP tools", builtin: "mcp", version: "1.0.0" },
        })],
        onToggle: () => {},
      },
    ]} />,
  );
  assert.match(html, /data-testid="xn-cap-item-plugins-mcp-tools"/);
  assert.match(html, /清单已启用/);
  assert.match(html, /Xueness 内置能力校验/);
  assert.match(html, /不代表外部插件代码已安装或加载/);
  assert.match(html, /aria-label="禁用插件清单 MCP tools"/);
  assert.doesNotMatch(html, /核心模块/);
});

test("plugin import control is exposed only when the real resource import handler exists", () => {
  const sections = [{ kind: "plugins" as const, label: "插件", items: [] }];
  const noHandler = renderToStaticMarkup(<CapabilitiesPanel sections={sections} />);
  assert.doesNotMatch(noHandler, /xn-plugin-controls/);
  const withHandler = renderToStaticMarkup(<CapabilitiesPanel
    sections={sections}
    onImportPlugin={() => {}}
    onBrowsePlugins={() => {}}
    onRefreshPlugins={() => {}}
  />);
  assert.match(withHandler, /data-testid="xn-plugin-refresh"/);
  assert.match(withHandler, /data-testid="xn-plugin-browse"/);
  assert.match(withHandler, /data-testid="xn-plugin-import-file"/);
  assert.match(withHandler, /data-testid="xn-plugin-import"/);
  assert.match(withHandler, /搜索插件/);
  assert.match(withHandler, /data-testid="xn-cap-scope">用户</);
});

test("plugin rows do not reveal forbidden executable fields and cannot enable a rejected manifest", () => {
  const html = renderToStaticMarkup(
    <CapabilitySection
      kind="plugins"
      label="插件"
      items={[item({ id: "bad-plugin", command: "python /private/path/secret.py", enabled: false })]}
      onToggle={() => {}}
    />,
  );
  assert.match(html, /清单字段被拒绝/);
  assert.match(html, /清单含有被拒绝的可执行字段/);
  assert.doesNotMatch(html, /secret\.py/);
  const toggle = html.match(/<button[^>]*data-testid="xn-cap-toggle-plugins-bad-plugin"[^>]*>/)?.[0] ?? "";
  assert.match(toggle, /disabled/);
});
