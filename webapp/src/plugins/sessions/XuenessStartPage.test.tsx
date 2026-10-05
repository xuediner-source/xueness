/**
 * 空会话起始页（sessions.start_page）的前端回归。
 *
 * 全部走 renderToStaticMarkup：断言最近会话按更新时间排序且最多 5 条、最近项目
 * 按最后使用时间排序且最多 5 条、快捷动作只渲染容器提供的能力（git/remote 禁用时
 * 克隆与 SSH 块不出现），没有数据时不渲染占位组件。
 */
import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { Folder, GitBranch, MessageCirclePlus, Server, Sparkles } from "lucide-react";

import {
  XuenessStartPage,
  abbreviatedWorkspacePath,
  recentSessionSummaries,
  recentStartPageProjects,
  startPageProjectName,
  type StartPageAction,
  type StartPageProject,
} from "./XuenessStartPage";
import type { SessionSummary } from "../../xuenessWorkbench";

const session = (id: string, updatedAt?: string): SessionSummary => ({
  id,
  task: `任务 ${id}`,
  status: "completed",
  ...(updatedAt ? { updatedAt } : {}),
});

// -- 纯函数 -------------------------------------------------------------------

test("recentSessionSummaries: 按 updatedAt 降序、最多 5 条，缺失时间排在最后且保持原顺序", () => {
  const sessions = [
    session("a", "2026-10-05T10:00:00Z"),
    session("b", "2026-10-05T11:00:00Z"),
    session("c"),
    session("d", "2026-10-05T09:00:00Z"),
    session("e", "2026-10-05T12:00:00Z"),
    session("f", "2026-10-05T08:00:00Z"),
    session("g", "2026-10-05T07:00:00Z"),
  ];
  assert.deepEqual(
    recentSessionSummaries(sessions, 5).map((item) => item.id),
    ["e", "b", "a", "d", "f"],
  );
  assert.equal(recentSessionSummaries([], 5).length, 0);
  assert.equal(recentSessionSummaries(undefined, 5).length, 0);
  // 不足 5 条时全部保留。
  assert.equal(recentSessionSummaries([session("only")], 5).length, 1);
});

// -- 组件 ---------------------------------------------------------------------

const actions: StartPageAction[] = [
  { id: "open-workspace", label: "打开工作区", description: "选择一个文件夹。", Icon: Folder, onSelect: () => undefined },
  { id: "new-session", label: "新建会话", Icon: MessageCirclePlus, onSelect: () => undefined },
];

test("起始页空历史时只渲染居中的快捷动作，并保留动作说明的可访问名称", () => {
  const html = renderToStaticMarkup(
    <XuenessStartPage actions={actions} sessions={[]} onSelectSession={() => undefined} />,
  );
  assert.match(html, /data-testid="xn-start-page"/);
  assert.match(html, /data-testid="start-action-open-workspace"/);
  assert.match(html, /打开工作区/);
  assert.match(html, /aria-label="打开工作区\. 选择一个文件夹。"/);
  assert.match(html, /title="选择一个文件夹。"/);
  assert.match(html, /data-testid="start-action-new-session"/);
  assert.match(html, /新建会话/);
  assert.doesNotMatch(html, /start-action-skills-commands/);
  assert.doesNotMatch(html, /xn-start-page__side|最近项目|最近会话|暂无最近/);
});

test("起始页：最近会话最多渲染 5 条，每条都是可点击的打开按钮", () => {
  const sessions = [
    session("s1", "2026-10-05T10:00:00Z"),
    session("s2", "2026-10-05T11:00:00Z"),
    session("s3", "2026-10-05T12:00:00Z"),
    session("s4", "2026-10-05T13:00:00Z"),
    session("s5", "2026-10-05T14:00:00Z"),
    session("s6", "2026-10-05T15:00:00Z"),
  ];
  const html = renderToStaticMarkup(
    <XuenessStartPage actions={actions} sessions={sessions} onSelectSession={() => undefined} />,
  );
  const items = html.match(/xn-start-page__recent-item/g) ?? [];
  assert.equal(items.length, 5);
  for (const id of ["s6", "s5", "s4", "s3", "s2"]) {
    assert.match(html, new RegExp(`data-testid="start-recent-${id}"`));
  }
  assert.doesNotMatch(html, /start-recent-s1/);
  assert.match(html, /class="xn-start-page__side" data-group-count="1"/);
  assert.doesNotMatch(html, /xn-start-page-projects|最近项目/);
  // 状态与时间来自会话数据。
  assert.match(html, /已完成/);
  assert.match(html, /<time dateTime="2026-10-05T15:00:00Z"/);
});

test("起始页：模板/技能动作块只在容器提供时出现；没有任何内容时组件整体不渲染", () => {
  const withCapabilities = renderToStaticMarkup(
    <XuenessStartPage
      actions={[...actions, { id: "skills-commands", label: "从模板或技能开始", Icon: Sparkles, onSelect: () => undefined }]}
      sessions={[]}
      onSelectSession={() => undefined}
    />,
  );
  assert.match(withCapabilities, /start-action-skills-commands/);
  assert.match(withCapabilities, /从模板或技能开始/);

  assert.equal(
    renderToStaticMarkup(<XuenessStartPage actions={[]} sessions={[]} onSelectSession={() => undefined} />),
    "",
  );
});

// -- 最近项目 -----------------------------------------------------------------

const project = (path: string, lastUsed?: string): StartPageProject => ({
  path,
  label: path.split("/").filter(Boolean).pop() ?? path,
  ...(lastUsed ? { lastUsed } : {}),
});

test("recentStartPageProjects: 按 lastUsed 降序、最多 5 条，无时间戳按登记顺序排在最后且去重", () => {
  const projects = [
    project("/w/alpha", "2026-10-01T10:00:00Z"),
    project("/w/beta", "2026-10-05T10:00:00Z"),
    project("/w/gamma"),
    project("/w/delta", "2026-10-03T10:00:00Z"),
    project("/w/epsilon", "2026-10-04T10:00:00Z"),
    project("/w/zeta", "2026-10-02T10:00:00Z"),
    project("/w/eta"),
    project("/w/beta", "2026-10-09T10:00:00Z"),
  ];
  assert.deepEqual(
    recentStartPageProjects(projects, 5).map((item) => item.path),
    ["/w/beta", "/w/epsilon", "/w/delta", "/w/zeta", "/w/alpha"],
  );
  // 数字时间戳同样可用；空输入不渲染卡片数据。
  assert.deepEqual(recentStartPageProjects([{ path: "/a" }, { path: "/b", lastUsed: 10 }], 5).map((i) => i.path), ["/b", "/a"]);
  assert.equal(recentStartPageProjects([], 5).length, 0);
  assert.equal(recentStartPageProjects(null, 5).length, 0);
});

test("项目名与缩写路径：名称取标签，路径只保留末尾层级", () => {
  assert.equal(startPageProjectName({ path: "/workspace/repos/xueness", label: "Xueness" }), "Xueness");
  assert.equal(startPageProjectName({ path: "/workspace/repos/xueness" }), "xueness");
  assert.equal(abbreviatedWorkspacePath("/home/dev/projects/api"), "/…/projects/api");
  assert.equal(abbreviatedWorkspacePath("/api"), "/api");
  assert.equal(abbreviatedWorkspacePath("C:\\repos\\team\\api"), "…/team/api");
});

test("起始页：右侧渲染最近项目卡片，最多 5 条且每条可点击切换工作区", () => {
  const projects = [
    project("/w/one", "2026-10-01T10:00:00Z"),
    project("/w/two", "2026-10-02T10:00:00Z"),
    project("/w/three", "2026-10-03T10:00:00Z"),
    project("/w/four", "2026-10-04T10:00:00Z"),
    project("/w/five", "2026-10-05T10:00:00Z"),
    project("/w/six", "2026-10-06T10:00:00Z"),
  ];
  const html = renderToStaticMarkup(
    <XuenessStartPage
      actions={[]}
      projects={projects}
      sessions={[session("recent", "2026-10-06T10:00:00Z")]}
      onSelectSession={() => undefined}
      onSelectProject={() => undefined}
    />,
  );
  assert.match(html, /data-testid="xn-start-page-projects"/);
  assert.match(html, /最近项目/);
  const items = html.match(/data-testid="start-project-/g) ?? [];
  assert.equal(items.length, 5);
  for (const path of ["/w/six", "/w/five", "/w/four", "/w/three", "/w/two"]) {
    assert.match(html, new RegExp(`data-testid="start-project-${path}"`));
  }
  assert.doesNotMatch(html, /start-project-\/w\/one/);
  // 卡片里显示缩写路径（两段以内原样显示），完整路径留在 title 上。
  assert.match(html, /title="\/w\/six"/);
  assert.match(html, /xn-start-page__project-path">\/w\/six</);
  // 两个有内容的分组在桌面端以 balanced columns 布局。
  assert.match(html, /class="xn-start-page__side" data-group-count="2"/);
  assert.match(html, /data-testid="start-recent-recent"/);
  assert.match(html, /data-testid="xn-start-page-recent"/);
});

test("起始页：没有任何历史时不渲染项目或会话分组，也不显示空态占位", () => {
  const withoutProjects = renderToStaticMarkup(
    <XuenessStartPage actions={actions} sessions={[]} onSelectSession={() => undefined} />,
  );
  assert.doesNotMatch(withoutProjects, /xn-start-page-projects/);

  const emptyProjects = renderToStaticMarkup(
    <XuenessStartPage actions={[]} projects={[]} sessions={[]} onSelectSession={() => undefined} />,
  );
  assert.equal(emptyProjects, "");

  const noSessions = renderToStaticMarkup(
    <XuenessStartPage actions={actions} projects={[]} sessions={[]} onSelectSession={() => undefined} />,
  );
  assert.doesNotMatch(noSessions, /xn-start-page__side|xn-start-page-projects|xn-start-page-recent|暂无最近/);
});

test("起始页：三个动作块由容器按插件生效状态给出；git/remote 未生效时对应块不出现", () => {
  const qoderActions: StartPageAction[] = [
    { id: "open-project", label: "打开项目", Icon: Folder, onSelect: () => undefined },
    { id: "clone-repository", label: "克隆仓库", Icon: GitBranch, onSelect: () => undefined },
    { id: "connect-ssh", label: "通过 SSH 连接", Icon: Server, onSelect: () => undefined },
  ];
  const all = renderToStaticMarkup(
    <XuenessStartPage actions={qoderActions} sessions={[]} onSelectSession={() => undefined} />,
  );
  for (const id of ["open-project", "clone-repository", "connect-ssh"]) {
    assert.match(all, new RegExp(`data-testid="start-action-${id}"`));
  }
  assert.match(all, /打开项目/);
  assert.match(all, /克隆仓库/);
  assert.match(all, /通过 SSH 连接/);

  // git 与 remote 插件被禁用：容器只传打开项目，另外两个块与克隆对话框都不出现。
  const disabled = renderToStaticMarkup(
    <XuenessStartPage actions={[qoderActions[0]]} projects={[]} sessions={[]} onSelectSession={() => undefined} />,
  );
  assert.match(disabled, /start-action-open-project/);
  assert.doesNotMatch(disabled, /start-action-clone-repository/);
  assert.doesNotMatch(disabled, /start-action-connect-ssh/);
  assert.doesNotMatch(disabled, /clone-dialog/);
});
