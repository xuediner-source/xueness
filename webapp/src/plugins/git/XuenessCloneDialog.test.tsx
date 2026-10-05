/**
 * 克隆仓库对话框（git.clone）的前端回归。
 *
 * 全部走 renderToStaticMarkup：断言表单元素与提示齐全、未勾选确认时提交按钮禁用、
 * 关闭时整体不渲染；目标目录建议值是纯函数，便于与后端的 suggested_name 对齐。
 */
import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import {
  XuenessCloneDialog,
  canSubmitClone,
  cloneDestination,
  joinWorkspacePath,
  repositoryNameFromUrl,
} from "./XuenessCloneDialog";

// -- 纯函数 -------------------------------------------------------------------

test("repositoryNameFromUrl: 取仓库名作为默认目录名，拒绝含空白或非法字符的地址", () => {
  assert.equal(repositoryNameFromUrl("https://github.com/acme/widgets.git"), "widgets");
  assert.equal(repositoryNameFromUrl("git@github.com:acme/widgets.git"), "widgets");
  assert.equal(repositoryNameFromUrl("ssh://git@github.com/acme/widgets"), "widgets");
  assert.equal(repositoryNameFromUrl("https://github.com/acme/widgets/"), "widgets");
  assert.equal(repositoryNameFromUrl("https://example.invalid/a/b?x=1"), "b");
  assert.equal(repositoryNameFromUrl("https://example.invalid/a b"), "");
  assert.equal(repositoryNameFromUrl(""), "");
  // 建议值读不出合法目录名时留空，由使用者自己填；服务端还会独立校验两者。
  assert.equal(repositoryNameFromUrl("git@host:-bad"), "");
});

test("cloneDestination 与 joinWorkspacePath 沿用上级目录自身的分隔符风格", () => {
  assert.equal(joinWorkspacePath("/w/repos", "widgets"), "/w/repos/widgets");
  assert.equal(joinWorkspacePath("/w/repos/", "widgets"), "/w/repos/widgets");
  assert.equal(joinWorkspacePath("C:\\repos", "widgets"), "C:\\repos\\widgets");
  assert.equal(cloneDestination("/w/repos", "https://github.com/acme/widgets.git"), "/w/repos/widgets");
  // 没有已知上级目录或地址还读不出名字时不猜路径。
  assert.equal(cloneDestination(null, "https://github.com/acme/widgets.git"), "");
  assert.equal(cloneDestination("/w/repos", "not a url"), "");
});

test("canSubmitClone: 需要地址、目录、明确确认且不在请求中", () => {
  const ready = { url: "https://github.com/acme/widgets.git", dest: "/w/repos/widgets", confirmed: true, busy: false };
  assert.equal(canSubmitClone(ready), true);
  assert.equal(canSubmitClone({ ...ready, confirmed: false }), false);
  assert.equal(canSubmitClone({ ...ready, busy: true }), false);
  assert.equal(canSubmitClone({ ...ready, url: "  " }), false);
  assert.equal(canSubmitClone({ ...ready, dest: "" }), false);
});

// -- 组件 ---------------------------------------------------------------------

test("克隆对话框渲染地址、目录、确认与错误位，取消按钮存在", () => {
  const html = renderToStaticMarkup(
    <XuenessCloneDialog open defaultParent="/w/repos" onCancel={() => undefined} onCloned={() => undefined} />,
  );
  assert.match(html, /data-testid="clone-dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /data-testid="clone-url"/);
  assert.match(html, /data-testid="clone-dest"/);
  assert.match(html, /data-testid="clone-pick-directory"/);
  assert.match(html, /data-testid="clone-confirm"/);
  assert.match(html, /data-testid="clone-submit"/);
  assert.match(html, /克隆仓库/);
  assert.match(html, /支持 https:\/\/、ssh:\/\/ 与 git@host:path 形式/);
  // 初始状态没有确认、也没有内容，提交按钮必须是禁用态。
  assert.match(html, /data-testid="clone-submit"[^>]*disabled/);
  assert.doesNotMatch(html, /data-testid="clone-error"/);
});

test("克隆对话框在 open=false 时整体不渲染，不留下隐藏的表单", () => {
  assert.equal(
    renderToStaticMarkup(
      <XuenessCloneDialog open={false} onCancel={() => undefined} onCloned={() => undefined} />,
    ),
    "",
  );
});
