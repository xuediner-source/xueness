/**
 * CapabilityDialog tests (SSR markup): open/close gating, create vs edit
 * shapes (typed id + live error vs readonly id + prefilled fields), per-kind
 * field rendering, and the disabled logic — asserted through the disabled
 * attribute only (no synthetic typing is possible in static markup).
 */
import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { XuenessCapabilityDialog } from "./XuenessCapabilityDialog";
import type { CapabilityItem } from "./xuenessCapabilities";

function item(partial: Partial<CapabilityItem> & { id: string }): CapabilityItem {
  return partial;
}

const SKILL_ITEM = item({
  id: "deploy-runbook",
  enabled: true,
  description: "How to deploy the service step by step",
  extra: { body: "1. build 2. ship" },
});

test("closed dialog renders nothing", () => {
  const html = renderToStaticMarkup(
    <XuenessCapabilityDialog open={false} mode="create" kind="skills" />,
  );
  assert.equal(html, "");
});

test("create mode: id box + specs fields + actions; live id error keeps submit disabled", () => {
  const html = renderToStaticMarkup(
    <XuenessCapabilityDialog open mode="create" kind="skills" onCancel={() => {}} onSubmit={() => {}} />,
  );
  assert.match(html, /data-testid="xn-cap-dialog"/);
  assert.match(html, /data-testid="xn-cap-dialog-breadcrumb"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /新建技能/);
  // id is a live input, invalid while empty -> error + disabled submit
  assert.match(html, /data-testid="xn-cap-dialog-id"/);
  assert.match(html, /ID 不能为空/);
  // spec fields: description text, body textarea (6 rows), enabled checkbox
  assert.match(html, /data-testid="xn-cap-dialog-field-description"/);
  assert.match(html, /data-testid="xn-cap-dialog-field-body"/);
  assert.match(html, /data-testid="xn-cap-dialog-field-enabled"/);
  assert.match(html, /<textarea[^>]*rows="6"/);
  assert.match(html, /type="checkbox"/);
  const submit = html.match(/<button[^>]*data-testid="xn-cap-dialog-submit"[^>]*>/)?.[0] ?? "";
  assert.match(submit, /disabled/);
  assert.match(html, /data-testid="xn-cap-dialog-cancel"/);
  assert.match(html, /role="alert"/);
});

test("create mode: hooks kind renders event field with the backend enum in the placeholder", () => {
  const html = renderToStaticMarkup(
    <XuenessCapabilityDialog open mode="create" kind="hooks" onCancel={() => {}} onSubmit={() => {}} />,
  );
  assert.match(html, /新建Hooks/);
  assert.match(html, /data-testid="xn-cap-dialog-field-event"/);
  assert.match(html, /SessionStart/);
  assert.match(html, /PostToolUseFailure/);
});

test("plugin manifest editor exposes the supported data fields and warns that it cannot load external code", () => {
  const html = renderToStaticMarkup(
    <XuenessCapabilityDialog open mode="create" kind="plugins" onCancel={() => {}} onSubmit={() => {}} />,
  );
  assert.match(html, /data-testid="xn-cap-dialog-field-version"/);
  assert.match(html, /data-testid="xn-cap-dialog-field-apiVersion"/);
  assert.match(html, /data-testid="xn-cap-dialog-field-builtin"/);
  assert.match(html, /data-testid="xn-cap-dialog-field-capabilities"/);
  assert.match(html, /Xueness 内置能力/);
  assert.match(html, /不会安装或执行外部代码/);
  assert.match(html, /data-testid="xn-cap-dialog-field-enabled"/);
  const enabled = html.match(/<input[^>]*data-testid="xn-cap-dialog-field-enabled"[^>]*>/)?.[0] ?? "";
  assert.doesNotMatch(enabled, /checked/); // imported/new manifests start inert
  const submit = html.match(/<button[^>]*data-testid="xn-cap-dialog-submit"[^>]*>/)?.[0] ?? "";
  assert.match(submit, /disabled/);
});

test("plugin manifest with an executable field is marked rejected and cannot be saved", () => {
  const html = renderToStaticMarkup(
    <XuenessCapabilityDialog
      open
      mode="edit"
      kind="plugins"
      initial={item({ id: "bad-plugin", command: "python injected.py", enabled: true })}
      onCancel={() => {}}
      onSubmit={() => {}}
    />,
  );
  assert.match(html, /data-testid="xn-plugin-manifest-blocked"/);
  assert.match(html, /不能编辑或启用/);
  const submit = html.match(/<button[^>]*data-testid="xn-cap-dialog-submit"[^>]*>/)?.[0] ?? "";
  assert.match(submit, /disabled/);
});

test("edit mode: id readonly, initial values prefilled (top-level and extra), submit disabled without changes", () => {
  const html = renderToStaticMarkup(
    <XuenessCapabilityDialog open mode="edit" kind="skills" initial={SKILL_ITEM} onCancel={() => {}} onSubmit={() => {}} />,
  );
  assert.match(html, /编辑 deploy-runbook/);
  const idInput = html.match(/<input[^>]*data-testid="xn-cap-dialog-id"[^>]*>/)?.[0] ?? "";
  assert.notEqual(idInput, "");
  assert.match(idInput, /readonly/i); // React 19 SSR emits `readOnly=""`
  assert.match(idInput, /value="deploy-runbook"/);
  // top-level description and extra.body both round-trip into the fields
  assert.match(html, /value="How to deploy the service step by step"/);
  assert.match(html, /1\. build 2\. ship/);
  assert.match(html, /checked=""/); // enabled: true round-trips
  const submit = html.match(/<button[^>]*data-testid="xn-cap-dialog-submit"[^>]*>/)?.[0] ?? "";
  assert.match(submit, /disabled/); // nothing changed yet
  assert.doesNotMatch(html, /ID 不能为空/); // no id error in edit mode
});

test("edit mode: cleared required field still disables submit (required check in both modes)", () => {
  const html = renderToStaticMarkup(
    <XuenessCapabilityDialog
      open
      mode="edit"
      kind="skills"
      initial={item({ id: "bare", enabled: false })}
      onCancel={() => {}}
      onSubmit={() => {}}
    />,
  );
  const submit = html.match(/<button[^>]*data-testid="xn-cap-dialog-submit"[^>]*>/)?.[0] ?? "";
  assert.match(submit, /disabled/); // required description missing
});

test("edit mode: error prop renders as alert; busy disables both buttons", () => {
  const html = renderToStaticMarkup(
    <XuenessCapabilityDialog
      open
      mode="edit"
      kind="skills"
      initial={SKILL_ITEM}
      busy
      error="保存失败"
      onCancel={() => {}}
      onSubmit={() => {}}
    />,
  );
  assert.match(html, /role="alert"/);
  assert.match(html, /保存失败/);
  for (const testid of ["xn-cap-dialog-submit", "xn-cap-dialog-cancel"]) {
    const button = html.match(new RegExp(`<button[^>]*data-testid="${testid}"[^>]*>`))?.[0] ?? "";
    assert.match(button, /disabled/);
  }
});
