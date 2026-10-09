import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { XuenessWorkspacePickerDialog, shouldDismissWorkspacePickerOnEscape } from "./XuenessWorkspacePickerDialog";
import { XuenessWorkspaceSettings, shouldNavigateOnWorkspaceEnter } from "./XuenessWorkspaceSettings";

const render = (node: React.ReactElement) => renderToStaticMarkup(node);

test("Workspace settings renders default-root controls without implying active-task mutation", () => {
  const html = render(<XuenessWorkspaceSettings currentRoot="/work/current" />);
  assert.match(html, /data-testid="workspace-settings"/);
  assert.match(html, /aria-label="完整路径"/);
  assert.match(html, /浏览此路径/);
  assert.match(html, /当前正在运行的任务/);
  assert.match(html, /保存为默认目录/);
  assert.doesNotMatch(html, /使用此文件夹/);
});

test("Workspace picker renders explicit choose/cancel controls and remote notice", () => {
  const html = render(
    <XuenessWorkspaceSettings
      picking
      remote
      onChoose={() => {}}
      onCancel={() => {}}
    />,
  );
  assert.match(html, /选择工作区/);
  assert.match(html, /使用此文件夹/);
  assert.match(html, /取消/);
  assert.match(html, /远程 SSH 工作区由连接选择器管理/);
});

test("Workspace picker dialog prioritizes the system picker and recent folders in a compact modal", () => {
  const html = render(<XuenessWorkspacePickerDialog
    open
    currentRoot="/work/current"
    onChoose={() => {}}
    onCancel={() => {}}
  />);
  assert.match(html, /data-testid="workspace-picker-backdrop"/);
  assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="([^"]+)"/);
  assert.match(html, /id="[^"]+"[^>]*data-workspace-picker-title="true"/);
  assert.match(html, /选择工作区/);
  assert.match(html, /在此电脑添加文件夹/);
  assert.match(html, /最近的文件夹/);
  assert.match(html, /浏览目录或新建文件夹/);
  assert.match(html, /aria-label="关闭"/);
  assert.doesNotMatch(html, /浏览批准的目录|保存为默认目录|workspace-root-input/);

  assert.equal(render(<XuenessWorkspacePickerDialog open={false} onChoose={() => {}} onCancel={() => {}} />), "");
});

test("Workspace picker Escape dismisses normally and leaves IME composition untouched", () => {
  assert.equal(shouldDismissWorkspacePickerOnEscape({ key: "Escape" }), true);
  assert.equal(shouldDismissWorkspacePickerOnEscape({ key: "Escape", isComposing: true }), false);
  assert.equal(shouldDismissWorkspacePickerOnEscape({ key: "Escape", nativeEvent: { isComposing: true } }), false);
  assert.equal(shouldDismissWorkspacePickerOnEscape({ key: "Escape", keyCode: 229 }), false);
  assert.equal(shouldDismissWorkspacePickerOnEscape({ key: "Escape", nativeEvent: { keyCode: 229 } }), false);
  assert.equal(shouldDismissWorkspacePickerOnEscape({ key: "Process" }), false);
  assert.equal(shouldDismissWorkspacePickerOnEscape({ key: "Dead" }), false);
  assert.equal(shouldDismissWorkspacePickerOnEscape({ key: "Escape", compositionActive: true }), false);
  assert.equal(shouldDismissWorkspacePickerOnEscape({ key: "Enter" }), false);
});

test("Adding a project uses the same folder picker without suggesting a new repository is created", () => {
  const html = render(<XuenessWorkspacePickerDialog open mode="project" onChoose={() => {}} onCancel={() => {}} />);
  assert.match(html, /添加项目/);
  assert.match(html, /选择一个文件夹，开始在其中工作/);
  assert.doesNotMatch(html, /git init|创建仓库|重启服务/);
});

test("Workspace root input Enter navigation and IME composition guards", () => {
  // 正常 Enter 在有效路径时允许导航
  assert.equal(shouldNavigateOnWorkspaceEnter({ key: "Enter" }, true), true);
  // 路径无效时不触发导航
  assert.equal(shouldNavigateOnWorkspaceEnter({ key: "Enter" }, false), false);
  // 非 Enter 键不触发
  assert.equal(shouldNavigateOnWorkspaceEnter({ key: "a" }, true), false);
  // IME 状态下绝不触发导航
  assert.equal(shouldNavigateOnWorkspaceEnter({ key: "Enter", isComposing: true }, true), false);
  assert.equal(shouldNavigateOnWorkspaceEnter({ key: "Enter", nativeEvent: { isComposing: true } }, true), false);
  assert.equal(shouldNavigateOnWorkspaceEnter({ key: "Enter", keyCode: 229 }, true), false);
  assert.equal(shouldNavigateOnWorkspaceEnter({ key: "Enter", nativeEvent: { keyCode: 229 } }, true), false);
  assert.equal(shouldNavigateOnWorkspaceEnter({ key: "Process" }, true), false);
  assert.equal(shouldNavigateOnWorkspaceEnter({ key: "Dead" }, true), false);
  assert.equal(shouldNavigateOnWorkspaceEnter({ key: "Enter", compositionActive: true }, true), false);
});
