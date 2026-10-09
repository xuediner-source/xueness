import React from "react";
import { displayBinding } from "../../xuenessShortcutDisplay";
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
  isImeCompositionKey,
  composerEnterIntent,
  handleComposerEscapeAction,
  clearSubmittedComposerDraft,
  restoreSubmittedComposerDraft,
  type ComposerDraftState,
} from "./XuenessWorkbenchView";
import type {
  WorkbenchSession,
  SessionSummary,
  TimelineRow,
  PendingApproval,
} from "../../xuenessWorkbench";

test('rejected optimistic submissions restore full drafts without touching new edits or another session', () => {
  const original: ComposerDraftState = { text: '  keep whitespace\n', attachments: [{ name: 'a.txt', data: 'YQ==', mimeType: 'text/plain' }],
    goal: true, selectedCapabilities: ['office.composer_pdf'], selectedContext: { files: ['a.txt'], sessions: [], skills: [], plugins: [] },
    submissionError: '', attachmentError: '', revision: 4 };
  const other = { ...original, text: 'other session' };
  const cleared = clearSubmittedComposerDraft(new Map([['a', original], ['b', other]]), 'a', 4);
  assert.equal(cleared.get('a')?.text, '');
  const restored = restoreSubmittedComposerDraft(cleared, 'a', 5, original, 'rejected');
  assert.equal(restored.get('a')?.text, original.text);
  assert.deepEqual(restored.get('a')?.attachments, original.attachments);
  assert.deepEqual(restored.get('a')?.selectedCapabilities, original.selectedCapabilities);
  assert.equal(restored.get('a')?.submissionError, 'rejected');
  assert.equal(restored.get('b'), other);
  const edited = new Map(cleared).set('a', { ...cleared.get('a')!, text: 'new follow-up', revision: 6 });
  assert.equal(restoreSubmittedComposerDraft(edited, 'a', 5, original), edited);
});

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

  // Completion means tool evidence passed, not that delivery checks passed.
  assert.match(html, /data-testid="timeline-row-completion-5"/);
  assert.match(html, /所有测试已成功通过/);
  assert.match(html, /工具成功证据通过/);
  assert.doesNotMatch(html, /任务完成|已验证/);

  // Pending question
  assert.match(html, /data-testid="timeline-row-question-6"/);
  assert.match(html, /等待回答/);
  assert.match(html, /是否继续更新文档？/);
});

test('approval resume preserves granted state and disables repeat clicks while running', () => {
  const pending: PendingApproval[] = [{ tool_call_id: 'exact', name: 'exec', subject: '["git","status"]', preview: 'git status', granted: true }];
  const ready = renderToStaticMarkup(<Approvals pending={pending} onApprove={() => {}} />);
  assert.match(ready, /已批准，等待执行/);
  assert.match(ready, /继续执行/);
  assert.doesNotMatch(ready, /批准并重试/);
  const busy = renderToStaticMarkup(<Approvals pending={pending} busy onApprove={() => {}} />);
  assert.match(busy, /disabled=""/);
  assert.match(busy, /正在继续…/);
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
  // 样式挂钩：审批卡片与条目有稳定类名，润饰样式不依赖 aria-label 文案。
  assert.match(htmlWith, /class="xn-approvals"[^>]*aria-label|aria-label="[^"]*"[^>]*class="xn-approvals"/);
  assert.equal(htmlWith.match(/class="xn-approval-item"/g)?.length, 2);

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
  // 带空格的参数要加引号，否则与 ["git","commit","-m","fix","bug"] 无法区分
  assert.equal(formatSubject("exec", '["git","commit","-m","fix bug"]'), 'git commit -m "fix bug"');
  assert.equal(formatSubject("exec", '["git","commit","-m","fix","bug"]'), "git commit -m fix bug");
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

test("Composer: Mod+Enter keyboard help uses the host platform label instead of a mixed ⌘/Ctrl hint", () => {
  const html = renderToStaticMarkup(<Composer variant="hero" sendShortcut="mod-enter" onSend={() => {}} />);
  assert.doesNotMatch(html, /⌘\/Ctrl/);
  const expected = displayBinding("Mod+Enter");
  assert.ok(html.includes(`${expected} 发送 · Enter 换行`), html);
  assert.equal(displayBinding("Mod+Enter", "MacIntel"), "⌘Enter");
  assert.equal(displayBinding("Mod+Enter", "Win32"), "Ctrl+Enter");
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

test("Composer: running with a draft shows the queue action instead of Stop (mutually exclusive)", () => {
  const html = renderToStaticMarkup(<Composer
    defaultValue="follow-up"
    running
    queueWhenRunning
    onStop={() => {}}
    onSend={() => true}
  />);
  assert.match(html, /data-testid="composer-queue"/);
  assert.doesNotMatch(html, /data-testid="composer-stop"/);
  assert.match(html, /Enter 排队 · Shift\+Enter 换行/);
});

test("Composer: running with an empty draft shows Stop exclusively in the send slot", () => {
  const html = renderToStaticMarkup(<Composer
    running
    queueWhenRunning
    onStop={() => {}}
    onSend={() => true}
  />);
  assert.match(html, /data-testid="composer-stop"/);
  assert.doesNotMatch(html, /data-testid="composer-queue"/);
  assert.match(html, /aria-label="停止"/);
  assert.match(html, /aria-keyshortcuts="Escape"/);
  assert.match(html, /title="停止当前任务 \(Esc\)"/);
});

test("Composer: stop button uses a square glyph (not the X close glyph)", () => {
  const html = renderToStaticMarkup(<Composer
    running
    onStop={() => {}}
    onSend={() => true}
  />);
  const stopButton = html.match(/<button[^>]*data-testid="composer-stop"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? "";
  assert.match(stopButton, /<rect[^>]*x="7"[^>]*>/);
  assert.doesNotMatch(stopButton, /M6 6l12 12M18 6 6 18/);
});

test("Composer: an old submission clears only its unchanged session draft", () => {
  const draft = (text: string, revision: number): ComposerDraftState => ({
    text,
    attachments: [],
    goal: false,
    selectedContext: { files: [], sessions: [], skills: [], plugins: [] },
    submissionError: "",
    attachmentError: "",
    revision,
  });
  const sessionA = draft("submitted text", 4);
  const sessionB = draft("new session draft", 2);
  const drafts = new Map([["session:a", sessionA], ["session:b", sessionB]]);

  const afterOldSubmission = clearSubmittedComposerDraft(drafts, "session:a", 4);
  assert.equal(afterOldSubmission.get("session:a")?.text, "");
  assert.equal(afterOldSubmission.get("session:a")?.revision, 5);
  assert.strictEqual(afterOldSubmission.get("session:b"), sessionB);

  const editedSessionA = new Map(afterOldSubmission);
  editedSessionA.set("session:a", draft("follow-up typed while running", 6));
  assert.strictEqual(clearSubmittedComposerDraft(editedSessionA, "session:a", 5), editedSessionA);
  assert.equal(editedSessionA.get("session:a")?.text, "follow-up typed while running");
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
  // The container only offers the goal action while the planning plugin is effective.
  assert.deepEqual(contextComposerSuggestions("/go", [], mentions, { canGoal: false, canWorkflow: true }), []);
  // /compact belongs to sessions: offered only while that plugin is effective.
  assert.deepEqual(contextComposerSuggestions("/comp", [], mentions, { canGoal: true, canWorkflow: true, canCompact: true })
    .map((item) => item.token), ["compact"]);
  assert.deepEqual(contextComposerSuggestions("/comp", [], mentions, { canGoal: true, canWorkflow: true }), []);
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

test("Composer IME guard: detects active composition or keyCode 229", () => {
  assert.equal(isImeCompositionKey({ nativeEvent: { isComposing: true } }), true);
  assert.equal(isImeCompositionKey({ isComposing: true }), true);
  assert.equal(isImeCompositionKey({ keyCode: 229 }), true);
  assert.equal(isImeCompositionKey({ nativeEvent: { keyCode: 229 } }), true);
  assert.equal(isImeCompositionKey({ key: "Process" }), true);
  assert.equal(isImeCompositionKey({ key: "Dead" }), true);
  assert.equal(isImeCompositionKey({ compositionActive: true }), true);
  assert.equal(isImeCompositionKey({ nativeEvent: { isComposing: false }, keyCode: 27 }), false);
  assert.equal(isImeCompositionKey({}), false);
});

test("Composer Enter policy preserves multiline input and blocks IME submission", () => {
  assert.equal(composerEnterIntent({ key: "Enter", shiftKey: true }, "enter", false), null);
  assert.equal(composerEnterIntent({ key: "Enter", keyCode: 229 }, "enter", false), null);
  assert.equal(composerEnterIntent({ key: "Enter", nativeEvent: { isComposing: true } }, "mod-enter", false), null);
  assert.equal(composerEnterIntent({ key: "Process" }, "enter", false), null);
  assert.equal(composerEnterIntent({ key: "Enter", compositionActive: true }, "enter", false), null);
  assert.equal(composerEnterIntent({ key: "Enter" }, "enter", false), "send");
  assert.equal(composerEnterIntent({ key: "Enter" }, "mod-enter", false), null);
  assert.equal(composerEnterIntent({ key: "Enter", ctrlKey: true }, "mod-enter", false, "win32"), "send");
  assert.equal(composerEnterIntent({ key: "Enter", metaKey: true }, "mod-enter", false, "win32"), null);
  assert.equal(composerEnterIntent({ key: "Enter", metaKey: true }, "mod-enter", false, "darwin"), "send");
  assert.equal(composerEnterIntent({ key: "Enter", ctrlKey: true }, "mod-enter", false, "darwin"), null);
  assert.equal(composerEnterIntent({ key: "Enter" }, "mod-enter", true), "accept-suggestion");
});

test("Composer Escape handling: ignores IME composition and retains onStop for non-IME Escape", () => {
  const calls: string[] = [];
  const baseState = {
    hasSuggestions: false,
    onDismissSuggestions: () => calls.push("dismiss-suggest"),
    plusOpen: false,
    onClosePlus: () => calls.push("close-plus"),
    running: false,
    stopping: false,
    onStop: () => calls.push("stop"),
  };

  // 1. IME composing Escape does NOT trigger any action or prevent default
  let prevented = false;
  const imeEvent = { key: "Escape", nativeEvent: { isComposing: true }, preventDefault: () => { prevented = true; } };
  assert.equal(handleComposerEscapeAction(imeEvent, { ...baseState, running: true }), false);
  assert.equal(prevented, false);
  assert.equal(calls.length, 0);

  // 2. keyCode 229 Escape does NOT trigger any action or prevent default
  const ime229Event = { key: "Escape", keyCode: 229, preventDefault: () => { prevented = true; } };
  assert.equal(handleComposerEscapeAction(ime229Event, { ...baseState, running: true }), false);
  assert.equal(prevented, false);
  assert.equal(calls.length, 0);

  // 3. Non-IME Escape with suggestions dismisses suggestions, does NOT stop task
  const nonImeEvent = { key: "Escape", preventDefault: () => { prevented = true; } };
  assert.equal(handleComposerEscapeAction(nonImeEvent, { ...baseState, hasSuggestions: true, running: true }), true);
  assert.equal(prevented, true);
  assert.deepEqual(calls, ["dismiss-suggest"]);

  // 4. Non-IME Escape with plusOpen closes plus menu, does NOT stop task
  calls.length = 0;
  prevented = false;
  assert.equal(handleComposerEscapeAction(nonImeEvent, { ...baseState, plusOpen: true, running: true }), true);
  assert.equal(prevented, true);
  assert.deepEqual(calls, ["close-plus"]);

  // 5. Non-IME Escape while task is running triggers onStop
  calls.length = 0;
  prevented = false;
  assert.equal(handleComposerEscapeAction(nonImeEvent, { ...baseState, running: true }), true);
  assert.equal(prevented, true);
  assert.deepEqual(calls, ["stop"]);

  // 6. Non-IME Escape while task is already stopping does NOT re-trigger onStop
  calls.length = 0;
  prevented = false;
  assert.equal(handleComposerEscapeAction(nonImeEvent, { ...baseState, running: true, stopping: true }), true);
  assert.equal(prevented, true);
  assert.deepEqual(calls, []);
});
