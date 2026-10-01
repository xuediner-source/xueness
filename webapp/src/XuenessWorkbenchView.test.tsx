import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import {
  TaskList,
  Timeline,
  Approvals,
  Composer,
  WorkbenchHeader,
  heroGreeting,
  XuenessWorkbench,
  formatSubject,
  composerSuggestions,
  applySuggestion,
  contextComposerSuggestions,
  applyContextSuggestion,
  composerAttachmentBytes,
  COMPOSER_ATTACHMENT_LIMITS,
} from "./XuenessWorkbenchView";
import type {
  WorkbenchSession,
  SessionSummary,
  TimelineRow,
  PendingApproval,
} from "./xuenessWorkbench";

test("TaskList: renders title and highlights activeId", () => {
  const sessions: SessionSummary[] = [
    { id: "sess-1", task: "修复登录接口", status: "running" },
    { id: "sess-2", task: "优化主页样式", status: "completed" },
  ];

  // 1. active sess-1
  const htmlActive1 = renderToStaticMarkup(
    <TaskList sessions={sessions} activeId="sess-1" onSelect={() => {}} />,
  );
  assert.match(htmlActive1, /修复登录接口/);
  assert.match(htmlActive1, /优化主页样式/);
  assert.match(htmlActive1, /data-testid="task-item-sess-1"[^>]*aria-current="true"/);
  assert.doesNotMatch(htmlActive1, /data-testid="task-item-sess-2"[^>]*aria-current="true"/);

  // 2. empty list
  const htmlEmpty = renderToStaticMarkup(<TaskList sessions={[]} />);
  assert.match(htmlEmpty, /暂无任务/);
  assert.doesNotMatch(htmlEmpty, /<button/);
});

test("Timeline: tool statuses, errorCode, completion, pending_question, and empty state", () => {
  // Empty
  const htmlEmpty = renderToStaticMarkup(<Timeline rows={[]} />);
  assert.match(htmlEmpty, /暂无事件/);

  // Rows with all variants
  const rows: TimelineRow[] = [
    { kind: "user", seq: 1, turnId: "t1", text: "请帮我运行测试" },
    {
      kind: "tool",
      seq: 2,
      turnId: "t1",
      toolCallId: "call-1",
      name: "exec",
      subject: '["npm","test"]',
      status: "running",
      error: "",
      errorCode: "",
    },
    {
      kind: "tool",
      seq: 3,
      turnId: "t1",
      toolCallId: "call-2",
      name: "write",
      subject: "src/app.ts",
      status: "ok",
      error: "",
      errorCode: "",
    },
    {
      kind: "tool",
      seq: 4,
      turnId: "t1",
      toolCallId: "call-3",
      name: "edit",
      subject: "src/index.ts",
      status: "error",
      error: "文件只读或无写权限",
      errorCode: "EACCES",
    },
    {
      kind: "completion",
      seq: 5,
      verified: true,
      summary: "所有测试已成功通过",
    },
    {
      kind: "pending_question",
      seq: 6,
      question: "是否继续更新文档？",
    },
  ];

  const html = renderToStaticMarkup(<Timeline rows={rows} />);

  // User row
  assert.match(html, /请帮我运行测试/);

  // Tool running
  assert.match(html, /data-testid="timeline-row-tool-2"/);
  assert.match(html, /npm test/); // subject parsed
  assert.match(html, /RUNNING/i);

  // Tool ok
  assert.match(html, /data-testid="timeline-row-tool-3"/);
  assert.match(html, /src\/app\.ts/);
  assert.match(html, /OK/i);

  // Tool error with errorCode
  assert.match(html, /data-testid="timeline-row-tool-4"/);
  assert.match(html, /EACCES/);
  assert.match(html, /文件只读或无写权限/);
  assert.match(html, /ERROR/i);

  // Completion row with verified mark and summary
  assert.match(html, /data-testid="timeline-row-completion-5"/);
  assert.match(html, /所有测试已成功通过/);
  assert.match(html, /已验证/);

  // Pending question
  assert.match(html, /data-testid="timeline-row-question-6"/);
  assert.match(html, /等待回答/);
  assert.match(html, /是否继续更新文档？/);
});

test("Approvals: renders items and action button; empty or no items has NO buttons", () => {
  const pendingItems: PendingApproval[] = [
    {
      tool_call_id: "ap-1",
      name: "exec",
      subject: '["git","status"]',
      preview: "执行 git status 命令",
    },
    {
      tool_call_id: "ap-2",
      name: "write",
      subject: "test.txt",
      preview: "写入 test.txt 内容",
    },
  ];

  // With pending items: shows details, readable subject, button
  const htmlWith = renderToStaticMarkup(
    <Approvals pending={pendingItems} onApprove={() => {}} />,
  );
  assert.match(htmlWith, /需要审批的操作/);
  assert.match(htmlWith, /git status/);
  assert.match(htmlWith, /test\.txt/);
  assert.match(htmlWith, /执行 git status 命令/);
  assert.match(htmlWith, /批准并重试/);
  assert.match(htmlWith, /<button[^>]*>批准并重试<\/button>/);

  // Empty pending array: asserts NO buttons exist (anti-fake button)
  const htmlEmpty = renderToStaticMarkup(
    <Approvals pending={[]} onApprove={() => {}} />,
  );
  assert.match(htmlEmpty, /无待审批/);
  assert.doesNotMatch(htmlEmpty, /<button/);

  // Empty without onApprove: asserts NO buttons exist
  const htmlEmptyNoHandler = renderToStaticMarkup(<Approvals pending={[]} />);
  assert.doesNotMatch(htmlEmptyNoHandler, /<button/);

  // Pending without onApprove: no action button rendered
  const htmlNoHandler = renderToStaticMarkup(<Approvals pending={pendingItems} />);
  assert.doesNotMatch(htmlNoHandler, /批准并重试/);
});

test("formatSubject: formats JSON argv into readable text and keeps string paths", () => {
  assert.equal(formatSubject("exec", '["git","commit","-m","fix bug"]'), "git commit -m fix bug");
  assert.equal(formatSubject("exec", "invalid json"), "invalid json");
  assert.equal(formatSubject("write", "docs/README.md"), "docs/README.md");
});

test("Composer: renders textarea and circle send button; disabled attributes correctly set", () => {
  // Attribute order in React's output is not stable, so each assertion matches
  // one attribute inside the send-button tag instead of spanning two.
  const sendButton = (html: string): string =>
    html.match(/<button[^>]*aria-label="发送"[^>]*>/)?.[0] ?? "";

  // 1. Empty input -> send button is disabled
  const htmlEmpty = renderToStaticMarkup(<Composer onSend={() => {}} defaultValue="" />);
  assert.match(htmlEmpty, /class="xn-composer xn-composer--docked"/);
  const emptyButton = sendButton(htmlEmpty);
  assert.notEqual(emptyButton, "");
  assert.match(emptyButton, /disabled/);

  // 2. With text input -> button is enabled (no disabled attribute)
  const htmlFilled = renderToStaticMarkup(
    <Composer onSend={() => {}} defaultValue="hello world" />,
  );
  const filledButton = sendButton(htmlFilled);
  assert.notEqual(filledButton, "");
  assert.doesNotMatch(filledButton, /disabled/);

  // 3. Explicitly disabled prop -> button has disabled attribute
  const htmlDisabled = renderToStaticMarkup(
    <Composer onSend={() => {}} defaultValue="hello" disabled={true} />,
  );
  assert.match(sendButton(htmlDisabled), /disabled/);

  // 4. Hero variant + footer slot render their classes/content
  const htmlHero = renderToStaticMarkup(
    <Composer variant="hero" footer={<select aria-label="运行模式" />} />,
  );
  assert.match(htmlHero, /class="xn-composer xn-composer--hero"/);
  assert.match(htmlHero, /aria-label="运行模式"/);
});

test("Composer: hero workspace header stays in the input surface and keeps keyboard guidance linked", () => {
  const html = renderToStaticMarkup(
    <Composer
      variant="hero"
      topContent={<div data-testid="workspace-band">workspace selector</div>}
      onSend={() => {}}
    />,
  );
  const formStart = html.indexOf("<form");
  const workspaceHeader = html.indexOf('class="xn-composer__top-content"');
  const textarea = html.indexOf("<textarea");
  assert.ok(formStart >= 0 && workspaceHeader > formStart && textarea > workspaceHeader);
  assert.match(html, /aria-describedby="[^"]+-keyboard-help"/);
  assert.match(html, /Enter 发送 · Shift\+Enter 换行/);
  assert.equal((html.match(/aria-label="添加上下文或能力"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /aria-label="(?:\/|@|\$)"/);
});

test("heroGreeting follows the original six local-time intervals", () => {
  const greetingAt = (hour: number) => heroGreeting(new Date(2026, 8, 30, hour, 0, 0));
  assert.equal(greetingAt(4), "夜深啦，别忘了照顾好自己哦");
  assert.equal(greetingAt(5), "早上好呀，新的一天开始啦");
  assert.equal(greetingAt(9), "上午好呀，有什么想让我帮忙的吗");
  assert.equal(greetingAt(12), "中午好呀，要不要先休息一下");
  assert.equal(greetingAt(14), "下午好呀，接下来交给我吧");
  assert.equal(greetingAt(18), "晚上好呀，今天辛苦啦");
  assert.equal(greetingAt(23), "夜深啦，别忘了照顾好自己哦");
});

test("WorkbenchHeader: keeps the session title accessible and moves management into the overflow menu", () => {
  const session: WorkbenchSession = {
    id: "sess-abc",
    task: "重构时间线组件",
    status: "running",
    steps: 12,
    mode: "build",
    changed_files: ["src/a.ts", "src/b.ts", "src/c.ts"],
    pending: [],
    approved: { write: [], edit: [], exec: [], mcp: [] },
  };

  const html = renderToStaticMarkup(
    <WorkbenchHeader
      session={session}
      onRefresh={() => {}}
      onTogglePin={() => {}}
      onRename={() => {}}
      onDelete={() => {}}
    />,
  );
  assert.match(html, /重构时间线组件/);
  assert.match(html, /class="xn-conv-header__title"/);
  assert.doesNotMatch(html, /<span class="xn-badge[^>]*>running<\/span>/i);
  assert.doesNotMatch(html, /步数:|模式:|修改文件:/);
  assert.match(html, /aria-label="更多操作"/);
  assert.match(html, /aria-label="刷新历史"/);
  assert.match(html, /data-testid="xn-conv-pin"/);
  assert.match(html, /aria-label="重命名任务"/);
  assert.match(html, /aria-label="删除任务"/);
  assert.ok(html.indexOf("aria-label=\"刷新历史\"") > html.indexOf("aria-label=\"更多操作\""));

  // No session: renders nothing — the hero owns the empty state.
  const htmlEmpty = renderToStaticMarkup(<WorkbenchHeader session={null} />);
  assert.equal(htmlEmpty, "");
});

test("XuenessWorkbench: integrates subcomponents cleanly", () => {
  const sessions: SessionSummary[] = [
    { id: "s1", task: "集成测试任务", status: "running" },
  ];
  const activeSession: WorkbenchSession = {
    id: "s1",
    task: "集成测试任务",
    status: "running",
    steps: 3,
    mode: "build",
    changed_files: ["file1.txt"],
    pending: [
      {
        tool_call_id: "p1",
        name: "exec",
        subject: '["git","diff"]',
        preview: "查看当前 diff",
      },
    ],
    approved: { write: [], edit: [], exec: [], mcp: [] },
  };
  const timelineRows: TimelineRow[] = [
    { kind: "user", seq: 1, turnId: "t1", text: "启动检查" },
  ];

  const html = renderToStaticMarkup(
    <XuenessWorkbench
      sessions={sessions}
      activeSessionId="s1"
      activeSession={activeSession}
      timelineRows={timelineRows}
      onSelectSession={() => {}}
      onApprove={() => {}}
      onSend={() => {}}
      onRefresh={() => {}}
    />,
  );

  assert.match(html, /集成测试任务/);
  assert.match(html, /刷新/);
  assert.match(html, /git diff/);
  assert.match(html, /批准并重试/);
  assert.match(html, /启动检查/);
});

test("XuenessWorkbench shows persisted live assistant text and suppresses an identical completed row", () => {
  const activeSession: WorkbenchSession = {
    id: "s-live", task: "live", status: "running", steps: 1, mode: "build",
    changed_files: [], pending: [], approved: { write: [], edit: [], exec: [], mcp: [] },
    streaming: { id: "turn-live", text: "partial answer", status: "streaming" },
  };
  const live = renderToStaticMarkup(<XuenessWorkbench sessions={[]} activeSession={activeSession} timelineRows={[]} />);
  assert.match(live, /partial answer/);
  const finished = renderToStaticMarkup(<XuenessWorkbench sessions={[]} activeSession={activeSession} timelineRows={[{ kind: "assistant", seq: 5, turnId: "turn-live", text: "partial answer" }]} />);
  assert.equal((finished.match(/partial answer/g) ?? []).length, 1);
});

test("composerSuggestions: / 前缀匹配命令；@ 片段匹配文件；其余为空", () => {
  const commands = [
    { id: "deploy", description: "部署" },
    { id: "deploy-canary", description: "金丝雀" },
    { id: "review" },
  ];
  const files = ["src/app.ts", "src/ux/composer.ts", "README.md"];

  // "/" 开头（还没空格）→ 全部命令按前缀过滤
  const slash = composerSuggestions("/dep", commands, files);
  assert.deepEqual(slash.map((s) => s.token), ["deploy", "deploy-canary"]);
  assert.equal(slash[0].kind, "command");
  assert.equal(slash[0].description, "部署");

  // 完整的 "/deploy" 仍可补全（前缀相等）
  assert.equal(composerSuggestions("/deploy", commands, files).length, 2);

  // 已有空格 → 命令阶段结束
  assert.deepEqual(composerSuggestions("/deploy now", commands, files), []);

  // "@frag"（结尾，无空白）→ 文件按包含匹配
  const at = composerSuggestions("看一下 @composer", commands, files);
  assert.deepEqual(at.map((s) => s.token), ["src/ux/composer.ts"]);
  assert.equal(at[0].kind, "file");

  // "@src/" 路径片段
  const atDir = composerSuggestions("@src/", commands, files);
  assert.deepEqual(atDir.map((s) => s.token), ["src/app.ts", "src/ux/composer.ts"]);

  // 无触发符 → 空
  assert.deepEqual(composerSuggestions("普通文本", commands, files), []);
  // 上限 8 条
  const many = Array.from({ length: 20 }, (_, i) => ({ id: `cmd${i}` }));
  assert.equal(composerSuggestions("/", many, []).length, 8);
});

test("applySuggestion: 命令替换整个 /token；文件只替换结尾 @ 片段", () => {
  assert.equal(applySuggestion("/dep", { kind: "command", token: "deploy" }), "/deploy ");
  assert.equal(
    applySuggestion("先看 @compose", { kind: "file", token: "src/ux/composer.ts" }),
    "先看 @src/ux/composer.ts ",
  );
  assert.equal(
    applySuggestion("对比 @a.ts 和 @b", { kind: "file", token: "b.ts" }),
    "对比 @a.ts 和 @b.ts ",
  );
});

test("Composer: hero 与 docked 模式都渲染真实命令建议", () => {
  const docked = renderToStaticMarkup(
    <Composer
      defaultValue="/dep"
      commands={[{ id: "deploy", description: "部署" }]}
      onSend={() => {}}
    />,
  );
  assert.match(docked, /data-testid="composer-suggestions"/);
  assert.match(docked, /data-testid="composer-suggestion-command-deploy"/);
  assert.match(docked, /aria-selected="true"/);

  const hero = renderToStaticMarkup(
    <Composer
      variant="hero"
      defaultValue="/dep"
      commands={[{ id: "deploy" }]}
      onSend={() => {}}
    />,
  );
  assert.match(hero, /data-testid="composer-suggestions"/);
  assert.match(hero, /data-testid="composer-suggestion-command-deploy"/);
});

test("Composer: a running task keeps Stop available even when sending is disabled", () => {
  const html = renderToStaticMarkup(
    <Composer
      defaultValue="continue"
      disabled={true}
      running={true}
      stopping={false}
      onStop={() => {}}
      onSend={() => {}}
    />,
  );
  assert.match(html, /data-testid="composer-stop"/);
  assert.match(html, /aria-label="停止"/);
  assert.doesNotMatch(html, /aria-label="发送"/);
  assert.match(html, /disabled="" placeholder="输入消息或指令\.\.\."/);
});

test("Composer contexts: @ resolves files/plugins/sessions, $ resolves skills, goal/workflow remain real actions", () => {
  const mentions = [
    { id: "src/app.ts", label: "src/app.ts", kind: "file" as const },
    { id: "plugin:search", label: "Search plugin", kind: "plugin" as const },
    { id: "session-1", label: "Login fix", kind: "session" as const },
    { id: "skill:review", label: "Review", kind: "skill" as const },
  ];
  assert.deepEqual(contextComposerSuggestions("@sess", [], mentions).map((item) => item.kind), ["session"]);
  assert.equal(applyContextSuggestion("@sess", { kind: "session", token: "session-1", label: "Login fix" }), "");
  assert.deepEqual(contextComposerSuggestions("$rev", [], mentions).map((item) => item.kind), ["skill"]);
  assert.deepEqual(
    contextComposerSuggestions("/go", [], mentions, { canGoal: true, canWorkflow: true }).map((item) => item.kind),
    ["goal"],
  );
  assert.equal(contextComposerSuggestions("/", [], mentions, { canGoal: true, canWorkflow: true }).some((item) => item.kind === "workflow"), true);
});

test("Composer attachment payload sizing uses decoded base64 bytes and fixed limits", () => {
  assert.equal(composerAttachmentBytes("YQ=="), 1);
  assert.equal(composerAttachmentBytes("aGk="), 2);
  assert.deepEqual(COMPOSER_ATTACHMENT_LIMITS, {
    count: 4,
    eachBytes: 2 * 1024 * 1024,
    totalBytes: 4 * 1024 * 1024,
  });
});
