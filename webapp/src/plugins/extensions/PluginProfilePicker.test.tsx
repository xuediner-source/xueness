import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import type { PluginProfileApplyResult, PluginProfileRow } from "../../xuenessApi";
import { setLocale } from "../../i18n";
import {
  LIGHTWEIGHT_TIER,
  PluginProfileList,
  PluginProfilePicker,
  profileChangeSummary,
} from "./PluginProfilePicker";

const rows: PluginProfileRow[] = [
  { name: "minimal", source: "built-in", extends: [], description: "只保留核心能力。", descriptionEn: "Core only.",
    enabled: ["sessions", "files"], disabled: ["browser"], active: false },
  { name: LIGHTWEIGHT_TIER, source: "built-in", extends: ["minimal"], description: "本地轻量档位。", descriptionEn: "Local tier.",
    enabled: ["sessions", "files", "git"], disabled: ["browser"], active: false },
  { name: "standard", source: "built-in", extends: [], description: "", descriptionEn: "",
    enabled: ["sessions"], disabled: [], active: true },
];

test("profile rows render one affordance each and keep the selected tier inert", () => {
  const disabledCount = (markup: string) => (markup.match(/disabled=""/g) ?? []).length;
  const html = renderToStaticMarkup(<PluginProfileList profiles={rows} active="standard" busy={null} onApply={() => {}} />);
  assert.match(html, /精简/);
  assert.match(html, /本地轻量/);
  assert.match(html, /完整功能/);
  assert.match(html, /本地模型推荐/);
  assert.equal((html.match(/<button/g) ?? []).length, 3);
  assert.equal((html.match(/使用此档位/g) ?? []).length, 2);
  assert.equal((html.match(/当前档位/g) ?? []).length, 1);
  assert.equal(disabledCount(html), 1);
  const loading = renderToStaticMarkup(<PluginProfileList profiles={rows} active="standard" busy={null} disabled onApply={() => {}} />);
  assert.equal(disabledCount(loading), 3);
  const busy = renderToStaticMarkup(<PluginProfileList profiles={rows} active="standard" busy="minimal" onApply={() => {}} />);
  assert.equal(disabledCount(busy), 3);
});

test("the profile selection uses the current response and custom descriptions follow the locale", () => {
  const html = renderToStaticMarkup(<PluginProfileList profiles={rows} active="minimal" busy={null} onApply={() => {}} />);
  assert.match(html, /class="xn-plugin-profiles__card is-current" data-profile="minimal"/);
  assert.doesNotMatch(html, /is-current" data-profile="standard"/);
  try {
    setLocale("en");
    const custom = { ...rows[0], name: "custom", source: "custom", description: "自定义说明", descriptionEn: "Custom description" };
    const english = renderToStaticMarkup(<PluginProfileList profiles={[custom, ...rows]} active={null} busy={null} onApply={() => {}} />);
    assert.match(english, /Custom description/);
    assert.match(english, /Local lightweight/);
    assert.doesNotMatch(english, /自定义说明|本地轻量|使用此档位/);
  } finally {
    setLocale("zh");
  }
});

test("an applied profile reports only how many switches moved", () => {
  const result = (changes: number, dryRun: boolean): PluginProfileApplyResult => ({
    ok: true, dryRun, profile: LIGHTWEIGHT_TIER, changes: Array.from({ length: changes }, () => ({
      id: "git", enabled: true, wasEnabled: false, effective: true, wasEffective: false,
    })), blocked: [], warnings: [],
  });
  assert.equal(profileChangeSummary(result(0, false)), "已切换 0 个插件开关");
  assert.equal(profileChangeSummary(result(3, true)), "预演：将切换 3 个插件开关");
});

test("the picker shows nothing and loads nothing while the owning plugin is off", () => {
  assert.equal(renderToStaticMarkup(<PluginProfilePicker enabled={false} />), "");
  assert.match(renderToStaticMarkup(<PluginProfilePicker enabled />), /插件组合档位/);
});
