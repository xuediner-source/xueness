import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import type { MarketplaceItem } from "../../xuenessApi";
import {
  MarketplaceCard,
  marketplaceDisplayCopy,
  MarketplaceDetail,
  XuenessMarketplace,
  filterMarketplaceItems,
  restoreMarketplaceDialogFocus,
  shouldDismissMarketplaceDialogOnBackdrop,
  shouldDismissMarketplaceDialogOnEscape,
  trapMarketplaceDialogTab,
} from "./index";

const items: MarketplaceItem[] = [
  {
    id: "safe-skill",
    name: "Trusted skills",
    description: "A data-only skills adapter",
    version: "1.1.0",
    sha256: "sha256:feedface",
    installedVersion: "1.0.0",
    manifest: { id: "safe-skill", version: "1.1.0", apiVersion: 1, enabled: false, builtin: "skills", capabilities: ["filesystem-write"], entrypoint: "never-show-this" },
    source: "bundled",
  },
  {
    id: "safe-hooks",
    name: "Trusted hooks",
    description: "A data-only hook adapter",
    version: "1.0.0",
    sha256: "sha256:cafebabe",
    installedVersion: null,
    manifest: { id: "safe-hooks", version: "1.0.0", apiVersion: 1, enabled: false, builtin: "hooks", capabilities: [] },
    source: "https://catalog.example.test/plugins.json",
  },
];

test('bundled marketplace copy is readable and searchable without relabeling external catalogs', () => {
  const local = { ...items[0]!, id: 'xueness-skills', manifest: { ...items[0]!.manifest, builtin: 'skills' } };
  assert.equal(marketplaceDisplayCopy(local).name, '技能');
  assert.equal(filterMarketplaceItems([local], 'all', '操作指南').length, 1);
  const external = { ...local, source: 'https://catalog.example.test' };
  assert.equal(marketplaceDisplayCopy(external).name, external.name);
});

test("marketplace filters use only returned items and match source, id, description, adapter, and capability", () => {
  assert.deepEqual(filterMarketplaceItems(items, "all", "catalog.example.test").map(item => item.id), ["safe-hooks"]);
  assert.deepEqual(filterMarketplaceItems(items, "all", "filesystem-write").map(item => item.id), ["safe-skill"]);
  assert.deepEqual(filterMarketplaceItems(items, "all", "safe-skill").map(item => item.id), ["safe-skill"]);
  assert.deepEqual(filterMarketplaceItems(items, "installed", "").map(item => item.id), ["safe-skill"]);
  assert.deepEqual(filterMarketplaceItems(items, "installed", "hooks"), []);
});

test("marketplace cards show real source and keep the installed update affordance", () => {
  const html = renderToStaticMarkup(<MarketplaceCard item={items[0]!} busy={false} onOpen={() => {}} onAction={() => {}} />);
  assert.match(html, /Trusted skills/);
  assert.match(html, /bundled/);
  assert.match(html, /已安装/);
  assert.match(html, /更新/);
  assert.match(html, /xn-marketplace__badge is-version/);
  assert.match(html, /xn-marketplace__badge is-update/);
  assert.match(html, /xn-marketplace__action is-primary/);
  assert.match(html, /marketplace-card-detail/);

  const catalogBehindInstall = { ...items[0]!, installedVersion: "2.0.0" };
  const current = renderToStaticMarkup(<MarketplaceCard item={catalogBehindInstall} busy={false} onOpen={() => {}} onAction={() => {}} />);
  assert.match(current, />已安装<\/button>/);
  assert.doesNotMatch(current, /更新/);
});

test("marketplace loading and header use the recovered installed structure", () => {
  const html = renderToStaticMarkup(<XuenessMarketplace />);
  assert.match(html, /xn-marketplace__title/);
  assert.match(html, /xn-marketplace__header-actions/);
  assert.match(html, /xn-marketplace__empty-icon/);
  assert.match(html, /正在加载市场清单/);
});

test("marketplace detail shows allowlisted manifest fields and never renders arbitrary manifest values", () => {
  const html = renderToStaticMarkup(<MarketplaceDetail item={items[0]!} busy={false} onBack={() => {}} onAction={() => {}} />);
  assert.match(html, /safe-skill/);
  assert.match(html, /skills/);
  assert.match(html, /filesystem-write/);
  assert.match(html, /sha256:feedface/);
  assert.match(html, /xn-marketplace__badge is-version/);
  assert.match(html, /xn-marketplace__badge is-update/);
  assert.doesNotMatch(html, /never-show-this/);
  assert.match(html, /默认停用|安装仅写入数据清单/);
});

test("marketplace confirmation traps Tab at both boundaries and focuses the dialog if it has no controls", () => {
  const calls: string[] = [];
  const first = { isConnected: true, focus: () => calls.push("first") };
  const last = { isConnected: true, focus: () => calls.push("last") };
  const dialog = { isConnected: true, focus: () => calls.push("dialog") };
  const forward = { key: "Tab", shiftKey: false, preventDefault: () => calls.push("prevent") };
  const backward = { key: "Tab", shiftKey: true, preventDefault: () => calls.push("prevent") };

  trapMarketplaceDialogTab(forward, last, [first, last], dialog);
  trapMarketplaceDialogTab(backward, first, [first, last], dialog);
  trapMarketplaceDialogTab(forward, null, [], dialog);
  assert.deepEqual(calls, ["prevent", "first", "prevent", "last", "prevent", "dialog"]);
});

test("marketplace confirmation handles Escape, backdrop dismissal, and opener focus restoration", () => {
  assert.equal(shouldDismissMarketplaceDialogOnEscape({ key: "Escape" }, false), true);
  assert.equal(shouldDismissMarketplaceDialogOnEscape({ key: "Escape", isComposing: true }, false), false);
  assert.equal(shouldDismissMarketplaceDialogOnEscape({ key: "Escape" }, true), false);
  const backdrop = {};
  assert.equal(shouldDismissMarketplaceDialogOnBackdrop(backdrop, backdrop, false), true);
  assert.equal(shouldDismissMarketplaceDialogOnBackdrop({}, backdrop, false), false);
  assert.equal(shouldDismissMarketplaceDialogOnBackdrop(backdrop, backdrop, true), false);

  const calls: string[] = [];
  const opener = { isConnected: true, focus: () => calls.push("opener") };
  const fallback = { isConnected: true, focus: () => calls.push("fallback") };
  restoreMarketplaceDialogFocus(opener, fallback);
  restoreMarketplaceDialogFocus({ ...opener, isConnected: false }, fallback);
  assert.deepEqual(calls, ["opener", "fallback"]);
});
