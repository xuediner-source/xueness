import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { RemoteConnectionStateLabel } from "./sessionsRemoteConnectionState";

import { SidebarNav, nextSidebarCursorIndex, sidebarNavItemPropsEqual } from "./SidebarNav";

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

test("SidebarNav: sessions-index attention sidecars render only when present", () => {
  const html = renderToStaticMarkup(
    <SidebarNav
      items={[
        {
          id: "pending",
          label: "等待确认",
          active: false,
          pendingInteraction: "需要用户输入",
          changeSummary: { added: 2, removed: 1 },
        },
        {
          id: "unread",
          label: "后台完成",
          active: false,
          unread: true,
          changeSummary: { files: 3 },
        },
        { id: "quiet", label: "普通会话", active: false },
      ]}
      onSelect={() => {}}
    />,
  );

  const pending = html.match(/<button[^>]*data-testid="xn-sidebar-item-pending"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? "";
  const unread = html.match(/<button[^>]*data-testid="xn-sidebar-item-unread"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? "";
  const quiet = html.match(/<button[^>]*data-testid="xn-sidebar-item-quiet"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? "";

  assert.match(pending, /data-pending-interaction="true"/);
  assert.match(pending, /data-pending-interaction-label="true"/);
  assert.match(pending, /需要用户输入/);
  assert.match(pending, /data-change-summary="true"[^>]*>\+2 -1<\/span>/);
  assert.doesNotMatch(pending, /data-unread-indicator="true"/);

  assert.match(unread, /data-unread-indicator="true"/);
  assert.match(unread, /data-change-summary="true"[^>]*>3 个文件<\/span>/);
  assert.doesNotMatch(unread, /data-pending-interaction="true"/);

  assert.doesNotMatch(quiet, /data-pending-interaction|data-unread-indicator|data-change-summary/);
});

test("SidebarNav: 键盘光标移动夹取边界，Home/End 跳到首尾", () => {
  assert.equal(nextSidebarCursorIndex("ArrowDown", 0, 3), 1);
  assert.equal(nextSidebarCursorIndex("ArrowDown", 2, 3), 2, "到底后停留");
  assert.equal(nextSidebarCursorIndex("ArrowUp", 0, 3), 0, "到顶后停留");
  assert.equal(nextSidebarCursorIndex("ArrowUp", 2, 3), 1);
  assert.equal(nextSidebarCursorIndex("ArrowDown", -1, 3), 0, "无光标时下键落在首行");
  assert.equal(nextSidebarCursorIndex("ArrowUp", -1, 3), 2, "无光标时上键落在末行");
  assert.equal(nextSidebarCursorIndex("Home", 1, 3), 0);
  assert.equal(nextSidebarCursorIndex("End", 1, 3), 2);
  assert.equal(nextSidebarCursorIndex("Enter", 1, 3), null);
  assert.equal(nextSidebarCursorIndex("ArrowDown", 0, 0), null);
});

test("SidebarNav: 有 onSelect 时渲染为 listbox，当前行 aria-selected，光标经 aria-activedescendant 暴露", () => {
  const items = [
    { id: "task-1", label: "任务一", active: true },
    { id: "task-2", label: "任务二", active: false },
    { id: "task-3", label: "任务三", active: false },
  ];
  const html = renderToStaticMarkup(<SidebarNav items={items} onSelect={() => {}} />);

  assert.match(html, /<ul[^>]*role="listbox"/);
  assert.match(html, /<ul[^>]*tabindex="0"/);
  assert.match(html, /<ul[^>]*aria-label="任务列表"/);
  const listOpen = html.slice(html.indexOf("<ul"), html.indexOf(">", html.indexOf("<ul")) + 1);
  assert.match(listOpen, /aria-activedescendant="[^"]+"/, "初始光标应指向当前选中行");

  const activeOption = html.match(/<button[^>]*data-testid="xn-sidebar-item-task-1"[^>]*>/)?.[0] ?? "";
  assert.match(activeOption, /role="option"/);
  assert.match(activeOption, /aria-selected="true"/);
  assert.match(activeOption, /aria-posinset="1"/);
  assert.match(activeOption, /aria-setsize="3"/);
  assert.match(activeOption, /aria-current="true"/);
  assert.match(activeOption, /tabindex="-1"/, "listbox 模式下选项不再是 tab 停靠点");
  assert.match(activeOption, /data-cursor="true"/, "光标初始停在当前选中行上");
  const inactiveOption = html.match(/<button[^>]*data-testid="xn-sidebar-item-task-2"[^>]*>/)?.[0] ?? "";
  assert.match(inactiveOption, /aria-selected="false"/);
  assert.doesNotMatch(inactiveOption, /data-cursor="true"/);

  assert.match(html, /<li[^>]*role="none"/);
  assert.doesNotMatch(html, /<li[^>]*role="option"/, "选项角色在行按钮上，li 为 presentation");
});

test("SidebarNav: 无 onSelect 时不启用 listbox", () => {
  const html = renderToStaticMarkup(
    <SidebarNav items={[{ id: "task-1", label: "任务一", active: true }]} />,
  );
  assert.doesNotMatch(html, /role="listbox"/);
  assert.doesNotMatch(html, /aria-activedescendant/);
  assert.match(html, /<div class="xn-shell-nav__link/);
});

test("SidebarNav: 行属性比较器按值命中 memo——外层重渲染不重渲染未变化的行", () => {
  const stable = () => {};
  const base = {
    item: { id: "task-1", label: "任务一", active: true, status: "running", pinned: false, timeLabel: "2 分钟前" },
    optionId: "nav-task-1",
    optionPosition: 1,
    optionSetSize: 4,
    listbox: true,
    cursor: false,
    onSelect: stable,
    onRename: stable,
    onDelete: stable,
    onActivated: stable,
  };
  // 对象身份不同但字段一致：切换选中会话引发的外层重渲染应命中 memo。
  assert.equal(sidebarNavItemPropsEqual(base, { ...base, item: { ...base.item } }), true);
  // 只有 active 翻转的两行需要重渲染。
  assert.equal(sidebarNavItemPropsEqual(base, { ...base, item: { ...base.item, active: false } }), false);
  // 时间标签随时间刷新、光标移动、选项 id 或处理器身份变化都要重渲染。
  assert.equal(sidebarNavItemPropsEqual(base, { ...base, item: { ...base.item, timeLabel: "3 分钟前" } }), false);
  assert.equal(sidebarNavItemPropsEqual(base, { ...base, cursor: true }), false);
  assert.equal(sidebarNavItemPropsEqual(base, { ...base, optionId: "nav-task-2" }), false);
  assert.equal(sidebarNavItemPropsEqual(base, { ...base, optionPosition: 2 }), false);
  assert.equal(sidebarNavItemPropsEqual(base, { ...base, onSelect: () => {} }), false);
  assert.equal(sidebarNavItemPropsEqual(base, { ...base, onDelete: undefined }), false);
});

test("SidebarNav: 空输入不抛", () => {
  assert.doesNotThrow(() => {
    renderToStaticMarkup(<SidebarNav items={[]} />);
  });
});

test('SidebarNav remote configuration changes invalidate memo and render an unknown connection state without reconnect guesses', () => {
  const remote = { connectionId: 'lab', configuration: 'configured' as const, connectionState: 'unknown' as const };
  const base = { item: { id: 'remote', label: 'Remote task', active: false, remote },
    optionId: 'remote-option', optionPosition: 1, optionSetSize: 1, listbox: true, cursor: false };
  assert.equal(sidebarNavItemPropsEqual(base, { ...base, item: { ...base.item, remote: { ...remote } } }), true);
  assert.equal(sidebarNavItemPropsEqual(base, { ...base, item: { ...base.item, remote: { ...remote, configuration: 'missing' } } }), false);
  assert.equal(sidebarNavItemPropsEqual(base, { ...base, item: { ...base.item, remote: undefined } }), false);
  for (const onSelect of [undefined, () => {}]) {
    const html = renderToStaticMarkup(<SidebarNav items={[base.item]} onSelect={onSelect} />);
    assert.match(html, /data-remote-summary="configured"/);
    assert.match(html, /lab · 远程配置已保存 · 连接状态未知/);
    assert.match(html, /data-connection-state="unknown"/);
    assert.doesNotMatch(html, /已连接|正在重连|reconnecting/);
  }
});

test('SidebarNav marks a recorded remote phase without putting its label in the static shell', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/plugins/sessions/SidebarNav.tsx'), 'utf8');
  assert.match(source, /import\(\s*['"]\.\/sessionsRemoteConnectionState['"]\s*\)/);
  assert.doesNotMatch(source, /from\s+['"]\.\/sessionsRemoteConnectionState['"]/);
  const remote = { connectionId: 'lab', configuration: 'configured' as const, connectionState: 'reconnecting' as const };
  const unknown = { ...remote, connectionState: 'unknown' as const };
  const base = { item: { id: 'remote', label: 'Remote task', active: false, remote },
    optionId: 'remote-option', optionPosition: 1, optionSetSize: 1, listbox: true, cursor: false };
  assert.equal(sidebarNavItemPropsEqual(base, { ...base, item: { ...base.item, remote: unknown } }), false);
  const html = renderToStaticMarkup(<SidebarNav items={[base.item]} onSelect={() => {}} />);
  const badge = html.match(/<span class="xn-sidebar-remote-summary"[^>]*>[\s\S]*?<\/span>/)?.[0] ?? '';
  assert.match(badge, /data-remote-summary="configured"/);
  assert.match(badge, /data-connection-state="reconnecting"/);
  assert.match(badge, /title="lab · 远程配置已保存"/);
  assert.match(badge, />远程</);
  assert.doesNotMatch(badge, /连接状态未知|正在重连|<button/);
  for (const [state, label] of [
    ['pending', '正在连接'], ['reconnecting', '正在重连'], ['connected', '已连接'], ['disconnected', '已断开'],
  ] as const) {
    const phase = renderToStaticMarkup(<RemoteConnectionStateLabel state={state} />);
    assert.match(phase, new RegExp(`data-connection-state="${state}"`));
    assert.match(phase, new RegExp(label));
    assert.doesNotMatch(phase, /<button|ssh|重试/);
  }
});

test("SidebarNav: 上千条会话只挂载部分行，垫片补齐剩余高度；短列表完整渲染", () => {
  const many = Array.from({ length: 400 }, (_, index) => ({
    id: `task-${index + 1}`,
    label: `任务 ${index + 1}`,
    active: index === 0,
    status: "completed",
  }));
  const html = renderToStaticMarkup(<SidebarNav items={many} onSelect={() => {}} />);
  const rowCount = (html.match(/data-testid="xn-sidebar-item-/g) ?? []).length;
  assert.ok(rowCount > 0, "窗口内应至少挂载一行");
  assert.ok(rowCount < 400, `长列表应只挂载部分行，实际 ${rowCount}`);
  assert.match(html, /data-testid="xn-sidebar-item-task-1"/, "窗口应从第一行开始");
  assert.match(html, /class="xn-shell-nav__list"[^>]*style="padding-top:0px;padding-bottom:\d+px"/, "未挂载行应由底部垫片补齐");

  const shortHtml = renderToStaticMarkup(
    <SidebarNav
      items={[
        { id: "task-1", label: "任务一", active: false },
        { id: "task-2", label: "任务二", active: true },
      ]}
      onSelect={() => {}}
    />,
  );
  assert.equal((shortHtml.match(/data-testid="xn-sidebar-item-/g) ?? []).length, 2, "短列表应完整渲染");
  assert.doesNotMatch(shortHtml, /padding-top/, "短列表不应引入垫片样式");
});
