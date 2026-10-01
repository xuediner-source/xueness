import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { XuenessWorkspacePickerDialog } from "./XuenessWorkspacePickerDialog";
import { XuenessWorkspaceSettings } from "./XuenessWorkspaceSettings";

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

test("Adding a project uses the same folder picker without suggesting a new repository is created", () => {
  const html = render(<XuenessWorkspacePickerDialog open mode="project" onChoose={() => {}} onCancel={() => {}} />);
  assert.match(html, /添加项目/);
  assert.match(html, /选择一个文件夹，开始在其中工作/);
  assert.doesNotMatch(html, /git init|创建仓库|重启服务/);
});
