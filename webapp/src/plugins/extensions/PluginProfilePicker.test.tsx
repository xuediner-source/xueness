import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import type { PluginProfileApplyResult, PluginProfileRow } from "../../xuenessApi";
import {
  LIGHTWEIGHT_TIER,
  PluginProfileList,
  PluginProfilePicker,
  lightweightTierHint,
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

test("the lightweight hint only offers the tier while another one is selected", () => {
  assert.equal(lightweightTierHint(rows, "standard")?.name, LIGHTWEIGHT_TIER);
  assert.equal(lightweightTierHint(rows, LIGHTWEIGHT_TIER), null);
  assert.equal(lightweightTierHint(rows.filter(row => row.name !== LIGHTWEIGHT_TIER), null), null);
});

test("profile rows render one affordance each and keep the selected tier inert", () => {
  const disabledCount = (markup: string) => (markup.match(/disabled=""/g) ?? []).length;
  const html = renderToStaticMarkup(<PluginProfileList profiles={rows} active="standard" busy={null} onApply={() => {}} />);
  assert.match(html, /minimal/);
  assert.match(html, /lightweight/);
  assert.match(html, /继承 minimal/);
  assert.match(html, /切换到 lightweight/);
  assert.match(html, /未提供说明。/);
  assert.equal((html.match(/切换到此档位/g) ?? []).length, 2);
  assert.equal((html.match(/当前档位/g) ?? []).length, 1);
  assert.equal(disabledCount(html), 1);
  const loading = renderToStaticMarkup(<PluginProfileList profiles={rows} active="standard" busy={null} disabled onApply={() => {}} />);
  assert.equal(disabledCount(loading), 4);
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
