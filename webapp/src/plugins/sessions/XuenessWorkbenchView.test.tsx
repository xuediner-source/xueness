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
  extractFilesFromClipboard,
  isFileDragEvent,
  MAX_PROMPT_HISTORY,
  appendPromptHistoryEntry,
  navigatePromptHistory,
  readPromptHistoryEntries,
  persistPromptHistoryEntries,
  readPersistedDraft,
  persistDraft,
  clearPersistedDraft,
  type StorageLike,
  parseDiffPreview,
  extractToolDiff,
  setPersistedDisclosure,
  approvalPreviewOpenState,
  evaluateApprovalsKeyDown,
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

test("WorkbenchHeader: 标题带项目文件夹名供 Codex 风格显示项目标记，无项目时不输出", () => {
  const base: WorkbenchSession = { id: "s", task: "检查构建", status: "completed", steps: 1, mode: "build", changed_files: [], pending: [], approved: { write: [], edit: [], exec: [], mcp: [] } };
  for (const root of ["/Users/me/code/xueness", "/Users/me/code/xueness/", "E:\\models\\apps\\xueness"]) {
    const html = renderToStaticMarkup(<WorkbenchHeader session={{ ...base, root }} />);
    assert.match(html, /<h2 class="xn-conv-header__title" data-project="xueness">检查构建<\/h2>/, root);
  }
  assert.doesNotMatch(renderToStaticMarkup(<WorkbenchHeader session={base} />), /data-project/);
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

  // 7. Non-IME Escape while in history browsing exits history and does NOT stop task
  let exitHistoryCalled = false;
  calls.length = 0;
  prevented = false;
  assert.equal(handleComposerEscapeAction(nonImeEvent, { ...baseState, running: true, hasHistory: true, onExitHistory: () => { exitHistoryCalled = true; } }), true);
  assert.equal(prevented, true);
  assert.equal(exitHistoryCalled, true);
  assert.deepEqual(calls, []);
});

test("extractFilesFromClipboard: extracts from files or items", () => {
  const dummyFile = { name: "test.png", size: 100, type: "image/png" } as unknown as File;

  // 1. files array present
  const withFiles = { files: [dummyFile], types: ["Files"] } as unknown as DataTransfer;
  assert.deepEqual(extractFilesFromClipboard(withFiles), [dummyFile]);

  // 2. items array present (fallback for clipboard screenshots)
  const withItems = {
    files: [],
    items: [{ kind: "file", getAsFile: () => dummyFile }],
    types: ["image/png"],
  } as unknown as DataTransfer;
  assert.deepEqual(extractFilesFromClipboard(withItems), [dummyFile]);

  // 3. empty / null
  assert.deepEqual(extractFilesFromClipboard(null), []);
  assert.deepEqual(extractFilesFromClipboard({ files: [], items: [] } as unknown as DataTransfer), []);
});

test("isFileDragEvent: identifies file dragging across formats", () => {
  assert.equal(isFileDragEvent({ types: ["Files"] } as unknown as DataTransfer), true);
  assert.equal(isFileDragEvent({ types: ["files"] } as unknown as DataTransfer), true);
  assert.equal(isFileDragEvent({ types: ["application/x-moz-file"] } as unknown as DataTransfer), true);
  assert.equal(isFileDragEvent({ types: ["text/plain"] } as unknown as DataTransfer), false);
  assert.equal(isFileDragEvent(null), false);
});

test("promptHistory: append and navigate prompt history (ZCode promptHistory parity)", () => {
  // 1. append ignores empty and whitespace
  let history = appendPromptHistoryEntry([], "");
  assert.deepEqual(history, []);
  history = appendPromptHistoryEntry(history, "   ");
  assert.deepEqual(history, []);

  // 2. append adds trimmed text
  history = appendPromptHistoryEntry(history, "first command");
  assert.deepEqual(history, ["first command"]);

  // 3. consecutive duplicate is ignored
  history = appendPromptHistoryEntry(history, "first command");
  assert.deepEqual(history, ["first command"]);

  // 4. distinct entry appends
  history = appendPromptHistoryEntry(history, "second command");
  assert.deepEqual(history, ["first command", "second command"]);

  // 5. non-consecutive duplicate is allowed
  history = appendPromptHistoryEntry(history, "first command");
  assert.deepEqual(history, ["first command", "second command", "first command"]);

  // 6. limit is enforced
  let full = Array.from({ length: 35 }, (_, i) => `item-${i}`);
  const limited = appendPromptHistoryEntry(full, "new-item", 30);
  assert.equal(limited.length, 30);
  assert.equal(limited.at(-1), "new-item");

  // 7. navigation up and down
  const entries = ["entry-1", "entry-2", "entry-3"];
  // Up from null (initial) -> last entry
  const up1 = navigatePromptHistory(entries, null, "up");
  assert.deepEqual(up1, { nextIndex: 2, nextValue: "entry-3", shouldHandle: true });

  // Up again -> previous entry
  const up2 = navigatePromptHistory(entries, 2, "up");
  assert.deepEqual(up2, { nextIndex: 1, nextValue: "entry-2", shouldHandle: true });

  // Up to top boundary -> clamp at 0
  const up3 = navigatePromptHistory(entries, 0, "up");
  assert.deepEqual(up3, { nextIndex: 0, nextValue: "entry-1", shouldHandle: true });

  // Down -> next entry
  const down1 = navigatePromptHistory(entries, 1, "down");
  assert.deepEqual(down1, { nextIndex: 2, nextValue: "entry-3", shouldHandle: true });

  // Down past newest -> nextIndex is null, nextValue is ""
  const down2 = navigatePromptHistory(entries, 2, "down");
  assert.deepEqual(down2, { nextIndex: null, nextValue: "", shouldHandle: true });

  // Empty entries -> shouldHandle is false
  const emptyNav = navigatePromptHistory([], null, "up");
  assert.equal(emptyNav.shouldHandle, false);
});

test("promptHistoryStorage: persists and reads prompt history isolated by workspace", () => {
  const store = new Map<string, string>();
  const mockStorage: StorageLike = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, val) => { store.set(key, val); },
  };

  persistPromptHistoryEntries("ws-a", ["prompt-a1", "prompt-a2"], mockStorage);
  persistPromptHistoryEntries("ws-b", ["prompt-b1"], mockStorage);

  assert.deepEqual(readPromptHistoryEntries("ws-a", mockStorage), ["prompt-a1", "prompt-a2"]);
  assert.deepEqual(readPromptHistoryEntries("ws-b", mockStorage), ["prompt-b1"]);
  assert.deepEqual(readPromptHistoryEntries("ws-c", mockStorage), []);
});

test("composerDraftStore: persists, reads, and clears per-session drafts (ZCode composerDraftStore parity)", () => {
  const store = new Map<string, string>();
  const mockStorage: StorageLike = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, val) => { store.set(key, val); },
    removeItem: (key) => { store.delete(key); },
  };

  const draftState: Pick<ComposerDraftState, "text" | "goal" | "selectedCapabilities" | "selectedContext"> = {
    text: "active draft message",
    goal: true,
    selectedCapabilities: ["office.composer_pdf"],
    selectedContext: { files: ["main.ts"], sessions: [], skills: [], plugins: [] },
  };

  // 1. Persist draft for session:1 in ws-1
  persistDraft("ws-1", "session:1", draftState, mockStorage);
  const read = readPersistedDraft("ws-1", "session:1", mockStorage);
  assert.equal(read?.text, "active draft message");
  assert.equal(read?.goal, true);
  assert.deepEqual(read?.selectedContext?.files, ["main.ts"]);

  // 2. Another session in ws-1 or ws-2 is isolated
  assert.equal(readPersistedDraft("ws-1", "session:2", mockStorage), null);
  assert.equal(readPersistedDraft("ws-2", "session:1", mockStorage), null);

  // 3. Clear draft for session:1
  clearPersistedDraft("ws-1", "session:1", mockStorage);
  assert.equal(readPersistedDraft("ws-1", "session:1", mockStorage), null);

  // 4. new-task draft is isolated between different workspaces
  persistDraft("ws-1", "new-task", { ...draftState, text: "task for repo A" }, mockStorage);
  persistDraft("ws-2", "new-task", { ...draftState, text: "task for repo B" }, mockStorage);
  assert.equal(readPersistedDraft("ws-1", "new-task", mockStorage)?.text, "task for repo A");
  assert.equal(readPersistedDraft("ws-2", "new-task", mockStorage)?.text, "task for repo B");
});

test("cursor-aware autocomplete and slash command normalization", () => {
  const commands = [
    { id: "/init", description: "初始化项目" },
    { id: "deploy", description: "发布部署" },
  ];
  const mentions = [
    { id: "src/main.ts", label: "main.ts", kind: "file" as const },
    { id: "src/utils.ts", label: "utils.ts", kind: "file" as const },
  ];

  // 1. Slash command with leading slash is normalized and matches "/in"
  const slashSuggestions = contextComposerSuggestions("/in", commands, mentions);
  assert.equal(slashSuggestions.length, 1);
  assert.equal(slashSuggestions[0].token, "init");
  assert.equal(slashSuggestions[0].kind, "command");

  // 2. Cursor in the middle of text: cursorOffset aware
  const midText = "请检查 /in 相关的配置";
  // cursor at index 7 (immediately after /in)
  const midSlash = contextComposerSuggestions(midText, commands, mentions, undefined, 7);
  assert.equal(midSlash.length, 1);
  assert.equal(midSlash[0].token, "init");

  // 3. Applying midText suggestion preserves following text
  const appliedMid = applyContextSuggestion(midText, midSlash[0], 7);
  assert.equal(appliedMid, "请检查 /init  相关的配置");

  // 4. Cursor in the middle for @-mention
  const midAtText = "查看 @util 的逻辑";
  // cursor at index 8 (immediately after @util)
  const midAt = contextComposerSuggestions(midAtText, commands, mentions, undefined, 8);
  assert.equal(midAt.length, 1);
  assert.equal(midAt[0].token, "src/utils.ts");
  const appliedAt = applyContextSuggestion(midAtText, midAt[0], 8);
  assert.equal(appliedAt, "查看  的逻辑");
});

test("@ mention strictly excludes skills, and $ mention only returns skills", () => {
  const mentions = [
    { id: "src/main.ts", label: "main.ts", kind: "file" as const },
    { id: "skill:review", label: "review", kind: "skill" as const },
    { id: "session:1", label: "task 1", kind: "session" as const },
  ];
  // 1. @ trigger matches file and session, but NEVER skill
  const atMatches = contextComposerSuggestions("@", [], mentions);
  assert.equal(atMatches.some((m) => m.kind === "skill"), false);
  assert.equal(atMatches.some((m) => m.kind === "file"), true);
  assert.equal(atMatches.some((m) => m.kind === "session"), true);

  // 2. @review must not match skill:review
  const atSkill = contextComposerSuggestions("@rev", [], mentions);
  assert.deepEqual(atSkill, []);

  // 3. $ trigger only matches skill
  const dollarMatches = contextComposerSuggestions("$rev", [], mentions);
  assert.equal(dollarMatches.length, 1);
  assert.equal(dollarMatches[0].kind, "skill");
  assert.equal(dollarMatches[0].token, "skill:review");
});

test("Composer button mutual exclusivity: exactly one primary action button rendered", () => {
  // Case A: Running with queue enabled and text -> only queue button, no regular send, no stop
  const queueHtml = renderToStaticMarkup(
    <Composer
      running={true}
      queueWhenRunning={true}
      defaultValue="queue this"
      onStop={() => {}}
    />,
  );
  assert.match(queueHtml, /composer-queue/);
  assert.doesNotMatch(queueHtml, /composer-stop/);
  assert.doesNotMatch(queueHtml, /aria-label="发送"/);
  assert.equal(queueHtml.match(/class="xn-composer__send/g)?.length, 1);

  // Case B: Running without queue -> stop button, no queue button, no send button
  const stopHtml = renderToStaticMarkup(
    <Composer
      running={true}
      queueWhenRunning={false}
      defaultValue="blocked content"
      onStop={() => {}}
    />,
  );
  assert.match(stopHtml, /composer-stop/);
  assert.doesNotMatch(stopHtml, /composer-queue/);
  assert.doesNotMatch(stopHtml, /aria-label="发送"/);
  assert.equal(stopHtml.match(/class="xn-composer__send/g)?.length, 1);

  // Case C: Idle -> send button only, no stop, no queue
  const sendHtml = renderToStaticMarkup(
    <Composer
      running={false}
      defaultValue="ready to send"
    />,
  );
  assert.match(sendHtml, /aria-label="发送"/);
  assert.doesNotMatch(sendHtml, /composer-stop/);
  assert.doesNotMatch(sendHtml, /composer-queue/);
  assert.equal(sendHtml.match(/class="xn-composer__send/g)?.length, 1);
});

test("Suggestion code prefix renders / for goal and workflow, not @", () => {
  const goalSuggestions = contextComposerSuggestions("/go", [], [], { canGoal: true, canWorkflow: true });
  assert.equal(goalSuggestions[0].kind, "goal");
  assert.equal(goalSuggestions[0].token, "goal");

  // In UI rendering, goal and workflow tokens display with "/" prefix
  const prefix = (kind: string) =>
    kind === "command" || kind === "goal" || kind === "workflow" ? "/" : kind === "skill" ? "$" : "@";
  assert.equal(prefix(goalSuggestions[0].kind), "/");

  const workflowSuggestions = contextComposerSuggestions("/work", [], [], { canGoal: true, canWorkflow: true });
  assert.equal(prefix(workflowSuggestions[0].kind), "/");
});

test("Approvals: renders batch approve button and shortcut badges when multiple pending items exist", () => {
  const pendingItems: PendingApproval[] = [
    {
      tool_call_id: "ap-batch-1",
      name: "exec",
      subject: '["git","status"]',
      preview: "执行 git status 命令",
    },
    {
      tool_call_id: "ap-batch-2",
      name: "write",
      subject: "test.txt",
      preview: "写入 test.txt 内容",
    },
  ];

  // Multiple items: shows batch button with count and keyboard hint badge
  const html = renderToStaticMarkup(
    <Approvals pending={pendingItems} onApprove={() => {}} onApproveAll={() => {}} />,
  );
  assert.match(html, /class="xn-approvals__batch-actions"/);
  assert.match(html, /全部批准 \(2\)/);
  assert.match(html, /class="xn-approval-kbd"/);
  assert.match(html, /class="xn-approval-shortcut"/);

  // Single item: does not show batch button
  const singleHtml = renderToStaticMarkup(
    <Approvals pending={[pendingItems[0]]} onApprove={() => {}} onApproveAll={() => {}} />,
  );
  assert.doesNotMatch(singleHtml, /class="xn-approvals__batch-actions"/);
  assert.doesNotMatch(singleHtml, /全部批准/);
});

test("parseDiffPreview: correctly parses unified diff format, lines and statistics", () => {
  const diffText = `--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,4 @@
 import React from 'react';
-const oldVal = 1;
+const newVal = 2;
+const addedVal = 3;
 export default {};`;

  const parsed = parseDiffPreview(diffText);
  assert.equal(parsed.isDiff, true);
  assert.equal(parsed.added, 2);
  assert.equal(parsed.removed, 1);
  assert.equal(parsed.lines.some(l => l.kind === "add" && l.text.includes("newVal")), true);
  assert.equal(parsed.lines.some(l => l.kind === "remove" && l.text.includes("oldVal")), true);
  assert.equal(parsed.lines.some(l => l.kind === "hunk"), true);

  const plainText = "This is just a regular sentence without diff markers.";
  const plainParsed = parseDiffPreview(plainText);
  assert.equal(plainParsed.isDiff, false);
});

test("approvalPreviewOpenState: stores toggle state per tool_call_id and obeys LRU bounds", () => {
  const callId = "test-call-state-id";
  try {
    assert.equal(approvalPreviewOpenState.get(callId), undefined);
    setPersistedDisclosure(approvalPreviewOpenState, callId, false);
    assert.equal(approvalPreviewOpenState.get(callId), false);
    setPersistedDisclosure(approvalPreviewOpenState, callId, true);
    assert.equal(approvalPreviewOpenState.get(callId), true);
  } finally {
    approvalPreviewOpenState.delete(callId);
  }

  // LRU bounding test
  const testMap = new Map<string, boolean>();
  for (let i = 0; i < 505; i++) {
    setPersistedDisclosure(testMap, `key-${i}`, true);
  }
  assert.equal(testMap.size, 500);
  assert.equal(testMap.has("key-0"), false);
  assert.equal(testMap.has("key-504"), true);
});

test("parseDiffPreview: correctly parses deletions starting with -- (SQL comments and code decrements)", () => {
  const sqlDiff = `--- a/query.sql
+++ b/query.sql
@@ -1,3 +1,3 @@
 SELECT 1;
--- old sql comment
+-- new sql comment
---x;
 SELECT 2;`;

  const parsed = parseDiffPreview(sqlDiff);
  assert.equal(parsed.isDiff, true);
  assert.equal(parsed.removed, 2);
  assert.equal(parsed.added, 1);
  const removedLines = parsed.lines.filter(l => l.kind === "remove");
  assert.equal(removedLines[0].text, "-- old sql comment");
  assert.equal(removedLines[1].text, "--x;");
});

test("parseDiffPreview: parses created file and deleted file unified diffs with /dev/null", () => {
  const createdDiff = `--- /dev/null
+++ b/created.txt
@@ -0,0 +1,2 @@
+line 1
+line 2`;

  const parsedCreated = parseDiffPreview(createdDiff);
  assert.equal(parsedCreated.isDiff, true);
  assert.equal(parsedCreated.added, 2);
  assert.equal(parsedCreated.removed, 0);

  const deletedDiff = `--- a/deleted.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-line 1
-line 2`;

  const parsedDeleted = parseDiffPreview(deletedDiff);
  assert.equal(parsedDeleted.isDiff, true);
  assert.equal(parsedDeleted.added, 0);
  assert.equal(parsedDeleted.removed, 2);
});

test("extractToolDiff: extracts diff from replace_file_content and write_to_file with intelligent line comparison", () => {
  // replace_file_content with TargetContent and ReplacementContent
  const replaceTool = {
    name: "replace_file_content",
    input: {
      TargetFile: "main.ts",
      TargetContent: "const a = 1;\nconst b = 2;\nreturn a + b;",
      ReplacementContent: "const a = 1;\nconst b = 20;\nreturn a + b;",
    },
  };

  const replaceDiff = extractToolDiff(replaceTool);
  assert.notEqual(replaceDiff, null);
  assert.equal(replaceDiff?.isDiff, true);
  assert.equal(replaceDiff?.added, 1);
  assert.equal(replaceDiff?.removed, 1);
  assert.equal(replaceDiff?.lines.some(l => l.kind === "context" && l.text === "const a = 1;"), true);
  assert.equal(replaceDiff?.lines.some(l => l.kind === "remove" && l.text === "const b = 2;"), true);
  assert.equal(replaceDiff?.lines.some(l => l.kind === "add" && l.text === "const b = 20;"), true);

  // write_to_file with CodeContent (new file additions)
  const writeTool = {
    name: "write_to_file",
    input: {
      TargetFile: "new_file.ts",
      CodeContent: "export const x = 100;\nexport const y = 200;",
    },
  };

  const writeDiff = extractToolDiff(writeTool);
  assert.notEqual(writeDiff, null);
  assert.equal(writeDiff?.isDiff, true);
  assert.equal(writeDiff?.added, 2);
  assert.equal(writeDiff?.removed, 0);

  // output containing unified diff
  const gitTool = {
    name: "exec",
    output: "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new",
  };
  const gitDiff = extractToolDiff(gitTool);
  assert.notEqual(gitDiff, null);
  assert.equal(gitDiff?.added, 1);
  assert.equal(gitDiff?.removed, 1);
});

test("Approvals keyboard handling: avoids hijacking buttons, text selection and browser tab keys", () => {
  const pendingItems: PendingApproval[] = [
    { tool_call_id: "ap-1", name: "write", subject: "a.ts", preview: "write a.ts" },
    { tool_call_id: "ap-2", name: "exec", subject: '["ls"]', preview: "exec ls" },
  ];

  // 1. Target inside a button / input / link -> ignores event
  const fakeButtonEvent = {
    key: "Enter",
    nativeEvent: { isComposing: false },
    target: { closest: (selector: string) => selector.includes("button") ? {} : null },
  };
  assert.equal(evaluateApprovalsKeyDown(fakeButtonEvent, { pending: pendingItems, activeIndex: 0 }), null);

  // 2. IME composing -> ignores event
  const composingEvent = {
    key: "Enter",
    nativeEvent: { isComposing: true },
  };
  assert.equal(evaluateApprovalsKeyDown(composingEvent, { pending: pendingItems, activeIndex: 0 }), null);

  // 3. Ctrl+A (Select All) -> should NOT trigger batch approve!
  const ctrlAEvent = {
    key: "a",
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    nativeEvent: { isComposing: false },
  };
  assert.equal(evaluateApprovalsKeyDown(ctrlAEvent, { pending: pendingItems, activeIndex: 0 }), null);

  // 4. Ctrl+1 (Browser Tab Switch) -> should NOT trigger item 1 approve!
  const ctrl1Event = {
    key: "1",
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    nativeEvent: { isComposing: false },
  };
  assert.equal(evaluateApprovalsKeyDown(ctrl1Event, { pending: pendingItems, activeIndex: 0 }), null);

  // 5. Plain 'a' -> triggers batch approve when items > 1
  const plainAEvent = {
    key: "a",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    nativeEvent: { isComposing: false },
  };
  assert.deepEqual(
    evaluateApprovalsKeyDown(plainAEvent, { pending: pendingItems, activeIndex: 0 }),
    { type: "approve-all" },
  );

  // 6. Plain 'a' on single pending item -> does NOT trigger batch approve
  assert.equal(
    evaluateApprovalsKeyDown(plainAEvent, { pending: [pendingItems[0]], activeIndex: 0 }),
    null,
  );

  // 7. Mod+Enter: platform aware (macOS metaKey vs Windows ctrlKey)
  const macModEnter = {
    key: "Enter",
    ctrlKey: false,
    metaKey: true,
    nativeEvent: { isComposing: false },
  };
  assert.deepEqual(
    evaluateApprovalsKeyDown(macModEnter, { pending: pendingItems, activeIndex: 0, platform: "darwin" }),
    { type: "approve-all" },
  );
  assert.equal(
    evaluateApprovalsKeyDown(macModEnter, { pending: pendingItems, activeIndex: 0, platform: "win32" }),
    null,
  );

  const winModEnter = {
    key: "Enter",
    ctrlKey: true,
    metaKey: false,
    nativeEvent: { isComposing: false },
  };
  assert.deepEqual(
    evaluateApprovalsKeyDown(winModEnter, { pending: pendingItems, activeIndex: 0, platform: "win32" }),
    { type: "approve-all" },
  );
  assert.equal(
    evaluateApprovalsKeyDown(winModEnter, { pending: pendingItems, activeIndex: 0, platform: "darwin" }),
    null,
  );

  // 8. Plain '1' -> triggers item 1 approve
  const plain1Event = {
    key: "1",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    nativeEvent: { isComposing: false },
  };
  assert.deepEqual(
    evaluateApprovalsKeyDown(plain1Event, { pending: pendingItems, activeIndex: 0 }),
    { type: "approve-item", index: 0, item: pendingItems[0] },
  );

  // 9. Plain '2' -> triggers item 2 approve
  const plain2Event = {
    key: "2",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    nativeEvent: { isComposing: false },
  };
  assert.deepEqual(
    evaluateApprovalsKeyDown(plain2Event, { pending: pendingItems, activeIndex: 0 }),
    { type: "approve-item", index: 1, item: pendingItems[1] },
  );

  // 10. Plain '9' -> out of range returns null
  const plain9Event = {
    key: "9",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    nativeEvent: { isComposing: false },
  };
  assert.equal(
    evaluateApprovalsKeyDown(plain9Event, { pending: pendingItems, activeIndex: 0 }),
    null,
  );

  // 11. Plain Enter on active item -> triggers active item approve
  const plainEnterEvent = {
    key: "Enter",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    nativeEvent: { isComposing: false },
  };
  assert.deepEqual(
    evaluateApprovalsKeyDown(plainEnterEvent, { pending: pendingItems, activeIndex: 1 }),
    { type: "approve-active", index: 1, item: pendingItems[1] },
  );

  // 12. ArrowDown / ArrowUp navigation
  assert.deepEqual(
    evaluateApprovalsKeyDown({ key: "ArrowDown" }, { pending: pendingItems, activeIndex: 0 }),
    { type: "next" },
  );
  assert.deepEqual(
    evaluateApprovalsKeyDown({ key: "ArrowUp" }, { pending: pendingItems, activeIndex: 0 }),
    { type: "prev" },
  );
});

test("parseDiffPreview and extractToolDiff: handles multi-file diffs and identical content correctly", () => {
  // Multi-file unified diff without diff --git
  const multiDiff = `--- a/file1.txt
+++ b/file1.txt
@@ -1,2 +1,2 @@
-old1
+new1
--- a/file2.txt
+++ b/file2.txt
@@ -1,2 +1,2 @@
-old2
+new2`;

  const parsed = parseDiffPreview(multiDiff);
  assert.equal(parsed.isDiff, true);
  assert.equal(parsed.added, 2);
  assert.equal(parsed.removed, 2);
  const hunks = parsed.lines.filter(l => l.kind === "hunk");
  assert.equal(hunks.length >= 4, true);

  // Identical content should return null / isDiff: false
  const identicalTool = {
    name: "replace_file_content",
    input: {
      TargetFile: "test.ts",
      TargetContent: "const x = 1;",
      ReplacementContent: "const x = 1;",
    },
  };
  assert.equal(extractToolDiff(identicalTool), null);

  // JSON string input should be parsed and diff extracted
  const jsonStringTool = {
    name: "edit",
    input: JSON.stringify({
      old_str: "hello",
      new_str: "world",
    }),
  };
  const jsonDiff = extractToolDiff(jsonStringTool);
  assert.notEqual(jsonDiff, null);
  assert.equal(jsonDiff?.added, 1);
  assert.equal(jsonDiff?.removed, 1);
});
