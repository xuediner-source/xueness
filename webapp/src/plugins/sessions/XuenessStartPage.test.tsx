/**
 * 空会话起始页（sessions.start_page）的前端回归。
 *
 * 全部走 renderToStaticMarkup：断言最近会话按更新时间排序且最多 5 条、
 * 动作块只渲染容器提供的能力、没有数据时不渲染占位组件。
 */
import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { Folder, MessageCirclePlus, Sparkles } from "lucide-react";

import { XuenessStartPage, recentSessionSummaries, type StartPageAction } from "./XuenessStartPage";
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

test("起始页：左侧渲染动作块，只显示容器传入的已有能力", () => {
  const html = renderToStaticMarkup(
    <XuenessStartPage actions={actions} sessions={[]} onSelectSession={() => undefined} />,
  );
  assert.match(html, /data-testid="xn-start-page"/);
  assert.match(html, /data-testid="start-action-open-workspace"/);
  assert.match(html, /打开工作区/);
  assert.match(html, /data-testid="start-action-new-session"/);
  assert.match(html, /新建会话/);
  assert.doesNotMatch(html, /start-action-skills-commands/);
  // 没有会话时右侧明确显示空态。
  assert.match(html, /最近会话/);
  assert.match(html, /暂无最近会话/);
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
