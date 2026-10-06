import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { SidebarNav } from "./SidebarNav";

test("SidebarNav: active 项有 aria-current 与 data-active，完成项不再显示状态徽标", () => {
  const items = [
    { id: "task-1", label: "任务一", active: true, status: "running", timeLabel: "2 分钟前" },
    { id: "task-2", label: "任务二", active: false, status: "completed" },
  ];

  const html = renderToStaticMarkup(
    <SidebarNav items={items} onSelect={() => {}} width={280} />
  );

  assert.match(html, /data-testid="xn-sidebar-nav"/);
  assert.match(html, /style="width:280px"/);
  // task-1 is active. Assert the attributes independently: React orders
  // aria-current before data-testid in the output, so a single regex spanning
  // both is coupled to attribute order rather than to behaviour.
  const activeItem = html.match(/<button[^>]*data-testid="xn-sidebar-item-task-1"[^>]*>/)?.[0] ?? "";
  assert.match(activeItem, /aria-current="true"/);
  assert.match(activeItem, /data-active="true"/);
  assert.match(html, /xn-shell-nav__link--active/);
  assert.match(html, /data-status="running"/);
  const completedButton = html.match(/<button[^>]*data-testid="xn-sidebar-item-task-2"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? "";
  assert.doesNotMatch(completedButton, /xn-sidebar-status|data-status=/);
  assert.match(html, /<time class="xn-shell-nav__time">2 分钟前<\/time>/);

  // task-2 is inactive
  assert.match(html, /data-testid="xn-sidebar-item-task-2"/);
  assert.doesNotMatch(html, /data-testid="xn-sidebar-item-task-2"[^>]*aria-current="true"/);
  assert.doesNotMatch(html, /data-testid="xn-sidebar-item-task-2"[^>]*data-active="true"/);
});

test("SidebarNav: 提供 onRename/onDelete 时每项有对应操作按钮；无 onSelect 时不渲染 <button>", () => {
  const items = [
    { id: "task-1", label: "任务一", active: true },
    { id: "task-2", label: "任务二", active: false },
  ];

  const htmlWithActions = renderToStaticMarkup(
    <SidebarNav items={items} onSelect={() => {}} onRename={() => {}} onDelete={() => {}} />
  );
  assert.match(htmlWithActions, /data-testid="xn-sidebar-rename-task-1"/);
  assert.match(htmlWithActions, /data-testid="xn-sidebar-delete-task-1"/);
  assert.match(htmlWithActions, /aria-label="重命名任务"/);
  assert.match(htmlWithActions, /aria-label="删除任务"/);

  const htmlNoHandlers = renderToStaticMarkup(<SidebarNav items={items} />);
  assert.doesNotMatch(htmlNoHandlers, /data-testid="xn-sidebar-rename-task-1"/);
  assert.doesNotMatch(htmlNoHandlers, /<button/);
  assert.match(htmlNoHandlers, /<div class="xn-shell-nav__link/);
  assert.match(htmlNoHandlers, /任务一/);
});

test("SidebarNav: pinned 项在「已置顶」标题后、非置顶项前，并带置顶图标", () => {
  const items = [
    { id: "task-1", label: "普通任务", active: false, status: "completed", pinned: false },
    { id: "task-2", label: "置顶任务", active: false, status: "running", pinned: true },
  ];

  const html = renderToStaticMarkup(<SidebarNav items={items} onSelect={() => {}} />);

  // The group label renders once, before the pinned item, which in turn
  // precedes the unpinned one.
  const groupIndex = html.indexOf("已置顶");
  const pinnedIndex = html.indexOf('data-testid="xn-sidebar-item-task-2"');
  const normalIndex = html.indexOf('data-testid="xn-sidebar-item-task-1"');
  assert.ok(groupIndex >= 0, "「已置顶」标题未渲染");
  assert.ok(pinnedIndex >= 0 && normalIndex >= 0);
  assert.ok(groupIndex < pinnedIndex, "置顶项必须出现在「已置顶」标题之后");
  assert.ok(pinnedIndex < normalIndex, "置顶项必须排在非置顶项之前");
  assert.match(html, /class="xn-shell-nav__group">已置顶<\/div>/);
  // Pin replaces the status glyph in the fixed leading slot.
  const pinnedButton =
    html.match(/<button[^>]*data-testid="xn-sidebar-item-task-2"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? "";
  assert.match(pinnedButton, /class="xn-shell-nav__leading" aria-hidden="true"><svg/);
  assert.doesNotMatch(pinnedButton, /xn-sidebar-status|xn-sidebar-pin/);
  assert.match(pinnedButton, /置顶任务/);
});

test("SidebarNav: 无 pinned 项时不渲染「已置顶」标题与 pin 图标", () => {
  const html = renderToStaticMarkup(
    <SidebarNav
      items={[
        { id: "task-1", label: "任务一", active: true },
        { id: "task-2", label: "任务二", active: false, pinned: false },
      ]}
    />,
  );
  assert.doesNotMatch(html, /xn-shell-nav__group/);
  assert.doesNotMatch(html, /已置顶/);
  assert.doesNotMatch(html, /xn-sidebar-pin/);
  // Single-list output is unchanged: both items keep their testids in order.
  const first = html.indexOf('data-testid="xn-sidebar-item-task-1"');
  const second = html.indexOf('data-testid="xn-sidebar-item-task-2"');
  assert.ok(first >= 0 && first < second);
});

test("SidebarNav: 空输入不抛", () => {
  assert.doesNotThrow(() => {
    renderToStaticMarkup(<SidebarNav items={[]} />);
  });
});
