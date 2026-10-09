import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import {
  Shell,
  SidebarActions,
  TimelineCard,
  SimpleMarkdown,
  copyTextToClipboard,
  shouldCloseNarrowSidebarOnEscape,
  cachedMarkdownElements,
  MARKDOWN_ELEMENT_CACHE_LIMIT,
} from "./XuenessShell";

test("Shell drawer Escape closes normally, while composition or a handled nested Escape stays local", () => {
  assert.equal(shouldCloseNarrowSidebarOnEscape({ key: "Escape" }), true);
  assert.equal(shouldCloseNarrowSidebarOnEscape({ key: "Escape", isComposing: true }), false);
  assert.equal(shouldCloseNarrowSidebarOnEscape({ key: "Escape", nativeEvent: { isComposing: true } }), false);
  assert.equal(shouldCloseNarrowSidebarOnEscape({ key: "Escape", keyCode: 229 }), false);
  assert.equal(shouldCloseNarrowSidebarOnEscape({ key: "Escape", nativeEvent: { keyCode: 229 } }), false);
  assert.equal(shouldCloseNarrowSidebarOnEscape({ key: "Process" }), false);
  assert.equal(shouldCloseNarrowSidebarOnEscape({ key: "Dead" }), false);
  assert.equal(shouldCloseNarrowSidebarOnEscape({ key: "Escape", compositionActive: true }), false);
  assert.equal(shouldCloseNarrowSidebarOnEscape({ key: "Escape", defaultPrevented: true }), false);
  assert.equal(shouldCloseNarrowSidebarOnEscape({ key: "Enter" }), false);
});

test("Shell: 侧栏导航/主区圆角面板渲染，含返回前进、底部品牌槽", () => {
  const html = renderToStaticMarkup(
    <Shell
      sidebar={<div data-testid="test-sidebar-content">任务列表</div>}
      sidebarFooter={<div data-testid="test-sidebar-footer">Xueness</div>}
    >
      <div data-testid="test-main-content">主区域内容</div>
    </Shell>
  );

  assert.match(html, /data-testid="xn-shell"/);
  assert.match(html, /data-testid="xn-shell-sidebar"/);
  assert.match(html, /任务列表/);
  assert.match(html, /data-testid="xn-shell-sidebar-footer"/);
  assert.match(html, /Xueness/);
  assert.match(html, /data-testid="xn-shell-main"/);
  assert.match(html, /data-testid="xn-shell-panel"/);
  assert.match(html, /data-testid="xn-shell-history-back"[^>]*disabled=""/);
  assert.match(html, /data-testid="xn-shell-history-forward"[^>]*disabled=""/);
  assert.match(html, /主区域内容/);
  // 不再有顶部品牌栏与全局状态栏
  assert.doesNotMatch(html, /data-testid="xn-shell-header"/);
  assert.doesNotMatch(html, /data-testid="xn-shell-status"/);
  // Contains mobile toggle button when sidebar is present
  assert.match(html, /data-testid="xn-shell-sidebar-toggle"/);
  assert.match(html, /aria-controls="xn-shell-sidebar"/);
  assert.match(html, /id="xn-shell-sidebar"/);
  assert.match(html, /data-sidebar-open="false"/);
});

test("Shell: 已连接的任务历史按钮遵循可用状态", () => {
  const html = renderToStaticMarkup(
    <Shell
      sidebar={<div>任务列表</div>}
      canGoBack
      canGoForward={false}
      onGoBack={() => {}}
      onGoForward={() => {}}
    >
      内容
    </Shell>,
  );
  const back = html.match(/<button[^>]*data-testid="xn-shell-history-back"[^>]*>/)?.[0] ?? "";
  const forward = html.match(/<button[^>]*data-testid="xn-shell-history-forward"[^>]*>/)?.[0] ?? "";
  assert.doesNotMatch(back, /disabled/);
  assert.match(forward, /disabled=""/);
});

test("Shell: 无 sidebar 时不出 aside 与切换按钮", () => {
  const html = renderToStaticMarkup(
    <Shell sidebar={null}>
      <div>纯主区</div>
    </Shell>
  );

  assert.doesNotMatch(html, /data-testid="xn-shell-sidebar"/);
  assert.doesNotMatch(html, /<aside/);
  assert.doesNotMatch(html, /data-testid="xn-shell-sidebar-toggle"/);
  assert.match(html, /纯主区/);
});

test("Shell: 桌面标题栏占独立顶行，Web 默认布局不受影响", () => {
  const web = renderToStaticMarkup(<Shell sidebar={null}>内容</Shell>);
  assert.doesNotMatch(web, /xn-shell-layout--desktop-titlebar/);
  assert.doesNotMatch(web, /xn-shell-titlebar-host/);

  const desktop = renderToStaticMarkup(<Shell sidebar={<div>任务</div>} titlebar={<div>桌面标题栏</div>}>内容</Shell>);
  assert.match(desktop, /xn-shell-layout--desktop-titlebar/);
  assert.match(desktop, /data-testid="xn-shell-titlebar-host"/);
  assert.match(desktop, /桌面标题栏/);
  assert.doesNotMatch(desktop, /xn-shell-sidebar__head/);
  assert.doesNotMatch(desktop, /data-testid="xn-shell-sidebar-toggle"/);
});

test("SidebarActions: 图标 + 文案 + 快捷键，可点击", () => {
  const html = renderToStaticMarkup(
    <SidebarActions
      platform="MacIntel"
      actions={[
        { id: "new-task", icon: "⊕", label: "新建任务", shortcut: "Mod+N", onClick: () => {} },
        { id: "search", icon: "⌕", label: "搜索" },
      ]}
    />
  );

  assert.match(html, /data-testid="xn-sidebar-action-new-task"/);
  assert.match(html, /新建任务/);
  assert.match(html, /⌘N/);
  assert.match(html, /data-testid="xn-sidebar-action-search"/);
  assert.match(html, /搜索/);
  const buttons = html.match(/<button/g) ?? [];
  assert.equal(buttons.length, 2);
});

test("SidebarActions: Mod 快捷键在 Windows 使用 Ctrl 标签", () => {
  const html = renderToStaticMarkup(<SidebarActions platform="Win32" actions={[
    { id: "new-task", icon: "⊕", label: "新建任务", shortcut: "Mod+N" },
    { id: "search", icon: "⌕", label: "搜索", shortcut: "Mod+K" },
  ]} />);
  assert.match(html, /<kbd class="xn-sidebar-action__shortcut">Ctrl\+N<\/kbd>/);
  assert.match(html, /<kbd class="xn-sidebar-action__shortcut">Ctrl\+K<\/kbd>/);
  assert.doesNotMatch(html, /⌘/);
});

test("SidebarActions: Meta 快捷键在 Windows 显示 Win，在 Mac 显示 ⌘", () => {
  const winHtml = renderToStaticMarkup(<SidebarActions platform="Win32" actions={[
    { id: "new-task", icon: "⊕", label: "新建任务", shortcut: "Meta+N" },
  ]} />);
  assert.match(winHtml, /<kbd class="xn-sidebar-action__shortcut">Win\+N<\/kbd>/);

  const macHtml = renderToStaticMarkup(<SidebarActions platform="MacIntel" actions={[
    { id: "new-task", icon: "⊕", label: "新建任务", shortcut: "Meta+N" },
  ]} />);
  assert.match(macHtml, /<kbd class="xn-sidebar-action__shortcut">⌘N<\/kbd>/);
});

test("TimelineCard: user 是右对齐气泡、assistant 是素文、tool 是单行卡", () => {
  // user: bubble, no role label header
  const userHtml = renderToStaticMarkup(
    <TimelineCard role="user" body="用户提问" seq={1} />
  );
  assert.match(userHtml, /data-testid="xn-timeline-card"/);
  assert.match(userHtml, /xn-msg--user/);
  assert.match(userHtml, /data-role="user"/);
  assert.match(userHtml, /xn-msg__bubble/);
  assert.match(userHtml, /用户提问/);
  assert.match(userHtml, /data-testid="xn-copy-user-1"/);
  assert.match(userHtml, /aria-label="复制消息"/);
  assert.doesNotMatch(userHtml, /xn-msg__tool-line/);

  // assistant: borderless prose with markdown
  const asstHtml = renderToStaticMarkup(
    <TimelineCard role="assistant" body="**完成任务**" markdown seq={2} />
  );
  assert.match(asstHtml, /xn-msg--assistant/);
  assert.match(asstHtml, /data-role="assistant"/);
  assert.match(asstHtml, /<strong class="xn-md__bold">完成任务<\/strong>/);
  assert.match(asstHtml, /data-testid="xn-copy-assistant-2"/);

  // tool: single line with name/subject/status
  const toolHtml = renderToStaticMarkup(
    <TimelineCard role="tool" name="write" subject="hello.txt" status="ok" body="" seq={3} />
  );
  assert.match(toolHtml, /xn-msg--tool/);
  assert.match(toolHtml, /data-role="tool"/);
  assert.match(toolHtml, /data-status="ok"/);
  assert.match(toolHtml, /<span class="xn-msg__tool-name">write<\/span>/);
  assert.match(toolHtml, /hello\.txt/);
  assert.match(toolHtml, /data-tone="ok"/);

  // tool error: error body visible with mono block
  const toolErrorHtml = renderToStaticMarkup(
    <TimelineCard
      role="tool"
      name="exec"
      subject="npm test"
      status="error"
      body="[ENOENT] command failed with exit code 1"
      meta="错误码: ENOENT"
    />
  );
  assert.match(toolErrorHtml, /data-tone="error"/);
  assert.match(toolErrorHtml, /xn-msg__tool-error/);
  assert.match(toolErrorHtml, /command failed with exit code 1/);
  assert.match(toolErrorHtml, /错误码: ENOENT/);

  // status tones
  assert.match(
    renderToStaticMarkup(<TimelineCard role="tool" status="pending" body="" />),
    /data-tone="warn"/,
  );
  assert.match(
    renderToStaticMarkup(<TimelineCard role="tool" status="custom_status" body="" />),
    /data-tone="neutral"/,
  );
});

test("TimelineCard: completion/question 有专属卡形态；duration 仅在有效时出现", () => {
  const completion = renderToStaticMarkup(
    <TimelineCard
      role="completion"
      title="运行结束 · 工具成功证据通过"
      status="ok"
      body="全部通过"
      seq={20}
    />
  );
  assert.match(completion, /xn-msg--completion/);
  assert.match(completion, /data-role="completion"/);
  assert.match(completion, /运行结束 · 工具成功证据通过/);
  assert.match(completion, /全部通过/);

  const question = renderToStaticMarkup(
    <TimelineCard role="question" title="等待回答" body="需要现在部署吗？" />
  );
  assert.match(question, /xn-msg--question/);
  assert.match(question, /等待回答/);
  assert.match(question, /需要现在部署吗？/);

  const running = renderToStaticMarkup(
    <TimelineCard role="tool" status="running" name="exec" body="" durationMs={1250} />
  );
  assert.match(running, /data-status="running"/);
  assert.match(running, /data-tone="warn"/);
  assert.match(running, /data-testid="xn-card-duration">1\.3 s/);

  const noTiming = renderToStaticMarkup(<TimelineCard role="tool" body="" durationMs={-1} />);
  assert.doesNotMatch(noTiming, /xn-card-duration/);
});

test('a terminal completion never inherits the busy spinner from legacy pending or missing statuses', () => {
  for (const status of [undefined, 'pending', 'review', 'error', 'ok']) {
    const html = renderToStaticMarkup(<TimelineCard role="completion" status={status} body="Ended" />);
    assert.doesNotMatch(html, /xn-spin|PENDING/i);
  }
});

test("SimpleMarkdown: GFM headings, nested lists, tables, quotes, tasks and code fences render", () => {
  const md = [
    "# 标题",
    "",
    "段落一，包含 `inline code`、**bold text**、*italic* 和 ~~删除线~~。",
    "",
    "> 引用内容",
    "",
    "1. 有序项",
    "2. 第二项",
    "   - 嵌套项",
    "",
    "| 名称 | 状态 |",
    "| --- | --- |",
    "| alpha | ready |",
    "",
    "- [x] 已完成",
    "- [ ] 待处理",
    "",
    "```typescript",
    "const x = 1;",
    "console.log(x);",
    "```",
    "",
    "[安全链接](https://example.com)",
  ].join("\n");

  const html = renderToStaticMarkup(<SimpleMarkdown text={md} />);

  assert.match(html, /<h1 class="xn-md__heading xn-md__heading--1">标题<\/h1>/);
  assert.match(html, /<code class="xn-md__inline-code">inline code<\/code>/);
  assert.match(html, /<strong class="xn-md__bold">bold text<\/strong>/);
  assert.match(html, /<em class="xn-md__italic">italic<\/em>/);
  assert.match(html, /<del class="xn-md__strike">删除线<\/del>/);
  assert.match(html, /<blockquote class="xn-md__blockquote">/);
  assert.match(html, /<ol class="xn-md__list xn-md__list--ordered">/);
  assert.match(html, /<ul class="xn-md__list xn-md__list--unordered">/);
  assert.match(html, /xn-md__list-item task-list-item/);
  assert.match(html, /type="checkbox" disabled="" checked=""/);
  assert.match(html, /class="xn-md__table"/);
  assert.match(html, /data-language="typescript"/);
  assert.match(html, /data-testid="xn-copy-code-/);
  assert.match(html, /const x = 1;/);
  assert.match(html, /href="https:\/\/example\.com"/);
});

test("SimpleMarkdown: raw HTML is skipped and dangerous URL schemes never become links", () => {
  const malicious = [
    "<script>alert('xss')</script>",
    '<img src="x" onerror="alert(1)" />',
    "普通文本包含 <script> 和 `alert(<script>)` 以及 **<b>粗体标签</b>**",
    "[恶意链接](javascript:alert(1))",
    "[数据链接](data:text/html,unsafe)",
  ].join("\n");

  const html = renderToStaticMarkup(<SimpleMarkdown text={malicious} />);

  // Absolute safety requirement: React string children are encoded, so no actual HTML elements are inserted
  assert.doesNotMatch(html, /<script>/i);
  assert.doesNotMatch(html, /<\/script>/i);
  assert.doesNotMatch(html, /<img\s/i);
  assert.doesNotMatch(html, /<b>粗体标签<\/b>/i);
  assert.doesNotMatch(html, /href="(?:javascript|data):/i);
});

test("message/code clipboard helper reports unavailable, successful and rejected writes", async () => {
  const copied: string[] = [];
  assert.equal(await copyTextToClipboard("原始消息", { writeText: async text => { copied.push(text); } }), true);
  assert.deepEqual(copied, ["原始消息"]);
  assert.equal(await copyTextToClipboard("无剪贴板", undefined), false);
  assert.equal(await copyTextToClipboard("拒绝访问", { writeText: async () => { throw new Error("denied"); } }), false);
});

test("全部组件最小输入不抛", () => {
  assert.doesNotThrow(() => {
    renderToStaticMarkup(<Shell sidebar={null}>内容</Shell>);
  });

  assert.doesNotThrow(() => {
    renderToStaticMarkup(<SidebarActions actions={[]} />);
  });

  assert.doesNotThrow(() => {
    renderToStaticMarkup(<TimelineCard role="" body="" />);
  });

  assert.doesNotThrow(() => {
    renderToStaticMarkup(<SimpleMarkdown text="" />);
  });
});

test("SimpleMarkdown: identical content reuses the cached element tree (memo hit)", () => {
  const text = "# 缓存命中\n\n同一段 markdown 只解析一次。";
  const first = cachedMarkdownElements(text);
  const second = cachedMarkdownElements(text);
  assert.equal(second, first);
  // Different content must never share a cached tree.
  const other = cachedMarkdownElements("# 另一段内容");
  assert.notEqual(other, first);
  // Cached trees still render the full expected markup.
  const html = renderToStaticMarkup(<SimpleMarkdown text={text} />);
  assert.match(html, /class="xn-md"/);
  assert.match(html, /<h1 class="xn-md__heading xn-md__heading--1">缓存命中<\/h1>/);
});

test("SimpleMarkdown: content cache is LRU-bounded and re-parses evicted entries", () => {
  const evicted = cachedMarkdownElements("将被挤出的旧条目");
  let survivor: React.JSX.Element | undefined;
  for (let i = 0; i < MARKDOWN_ELEMENT_CACHE_LIMIT + 10; i++) {
    const entry = cachedMarkdownElements(`洪流条目 ${i}`);
    if (i === MARKDOWN_ELEMENT_CACHE_LIMIT) survivor = entry;
  }
  // The oldest entry was evicted: it parses again into a fresh tree.
  assert.notEqual(cachedMarkdownElements("将被挤出的旧条目"), evicted);
  // Recent entries stay cached and return the very same tree.
  assert.notEqual(survivor, undefined, "survivor must be captured");
  assert.equal(cachedMarkdownElements(`洪流条目 ${MARKDOWN_ELEMENT_CACHE_LIMIT}`), survivor);
});

test("SimpleMarkdown: 默认上下文代码块立即高亮（immediate），cacheParseResults=false 不写内容缓存", () => {
  const html = renderToStaticMarkup(<SimpleMarkdown text={"```json\n{\"ok\": true}\n```"} />);
  assert.match(html, /data-highlight="immediate"/);
  const bypassedFirst = cachedMarkdownElements("绕过缓存的段落", false);
  const bypassedAgain = cachedMarkdownElements("绕过缓存的段落", false);
  assert.notEqual(bypassedAgain, bypassedFirst);
  const hot = cachedMarkdownElements("绕过缓存的段落");
  assert.equal(cachedMarkdownElements("绕过缓存的段落"), hot);
});
