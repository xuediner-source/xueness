/**
 * Git panel view tests (SSR markup): three sections, the clean state, the
 * honest not-a-repo empty state, the truncation marker, and the
 * anti-fake-control rule — no refresh handler means no button at all.
 */
import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { XuenessGitView, isNotRepoError } from "./XuenessGitView";
import type { GitCommit, GitDiff, GitStatus } from "../../xuenessGit";

const STATUS: GitStatus = {
  branch: "main",
  entries: [
    { code: " M", path: "hello.txt" },
    { code: "??", path: "notes.txt" },
    { code: "D ", path: "gone.txt" },
  ],
  clean: false,
};

const DIFF: GitDiff = {
  stat: " hello.txt | 2 +-\n",
  patch: "diff --git a/hello.txt b/hello.txt\n@@ -1 +1,2 @@\n+changed\n",
  truncated: false,
};

const LOG: GitCommit[] = [
  {
    hash: "a".repeat(40),
    short: "aaaaaaa",
    author: "Test",
    date: "2026-09-28T10:00:00+08:00",
    subject: "initial commit",
  },
];

test("XuenessGitView renders the three sections with real data plus the refresh button", () => {
  const html = renderToStaticMarkup(
    <XuenessGitView status={STATUS} diff={DIFF} log={LOG} onRefresh={() => {}} />,
  );
  assert.match(html, /data-testid="git-view"/);
  assert.match(html, /data-testid="git-status"/);
  assert.match(html, /data-testid="git-branch"/);
  assert.match(html, /main/);
  assert.match(html, /hello\.txt/);
  assert.match(html, /notes\.txt/);
  assert.match(html, /data-testid="git-diff"/);
  assert.match(html, /diff --git a\/hello\.txt b\/hello\.txt/);
  assert.match(html, /data-testid="git-log"/);
  assert.match(html, /initial commit/);
  assert.match(html, /aaaaaaa/);
  assert.match(html, /Test/);
  assert.match(html, /data-testid="git-refresh"/);
  assert.match(html, /刷新/);
});

test("clean state shows 工作区干净 and no change rows", () => {
  const html = renderToStaticMarkup(
    <XuenessGitView
      status={{ branch: "main", entries: [], clean: true }}
      diff={{ stat: "", patch: "", truncated: false }}
      log={LOG}
    />,
  );
  assert.match(html, /工作区干净/);
  assert.doesNotMatch(html, /xn-git__row/);
  assert.match(html, /无改动/);
});

test("not-a-repo error collapses the panel into one honest empty state", () => {
  const html = renderToStaticMarkup(
    <XuenessGitView status={null} diff={null} log={null} diffError="该工作区不是 git 仓库" />,
  );
  assert.match(html, /data-testid="git-empty"/);
  assert.match(html, /该工作区不是 git 仓库/);
  // The three fake-ready sections must be gone entirely.
  assert.doesNotMatch(html, /data-testid="git-status"/);
  assert.doesNotMatch(html, /data-testid="git-diff"/);
  assert.doesNotMatch(html, /data-testid="git-log"/);
});

test("truncated diff carries the 补丁过长 marker", () => {
  const html = renderToStaticMarkup(
    <XuenessGitView status={null} diff={{ ...DIFF, truncated: true }} log={null} />,
  );
  assert.match(html, /补丁过长，已截断/);
});

test("no onRefresh -> no refresh button (anti-fake-control); other errors render as alerts", () => {
  const html = renderToStaticMarkup(
    <XuenessGitView
      status={STATUS}
      diff={DIFF}
      log={LOG}
      statusError="session not found"
      logError="git 命令失败"
    />,
  );
  assert.doesNotMatch(html, /<button/);
  assert.doesNotMatch(html, /data-testid="git-refresh"/);
  const alerts = html.match(/role="alert"/g) ?? [];
  assert.equal(alerts.length, 2);
  assert.match(html, /session not found/);
  assert.match(html, /git 命令失败/);
});

test("loading sections show 加载中 and nothing is invented for absent data", () => {
  const html = renderToStaticMarkup(
    <XuenessGitView status={null} diff={null} log={null} statusLoading diffLoading logLoading />,
  );
  const loading = html.match(/加载中/g) ?? [];
  assert.equal(loading.length, 3);
  // Sections exist but stay empty of fabricated content.
  assert.match(html, /data-testid="git-status"/);
  assert.doesNotMatch(html, /工作区干净/);
  assert.doesNotMatch(html, /暂无提交/);
});

test("isNotRepoError matches only the backend not-a-repo message", () => {
  assert.equal(isNotRepoError("该工作区不是 git 仓库"), true);
  assert.equal(isNotRepoError("HTTP 500"), false);
  assert.equal(isNotRepoError(undefined), false);
});
