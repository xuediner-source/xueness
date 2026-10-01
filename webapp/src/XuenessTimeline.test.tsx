import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { TimelineStream, TaskTodos, groupTimelineRows } from "./XuenessTimeline";
import type { TimelineRow } from "./xuenessWorkbench";

test('reasoning disclosure is collapsed, plain text, and hidden by the preference',()=>{
  const rows:TimelineRow[]=[{kind:'assistant',seq:2,turnId:'turn-1',text:'public answer',reasoning:'<script>private thought</script>'}];
  const html=renderToStaticMarkup(<TimelineStream rows={rows} />);
  assert.match(html, /class="xn-reasoning"/);
  assert.doesNotMatch(html, /<details[^>]*open/);
  assert.match(html, /&lt;script&gt;private thought/);
  assert.doesNotMatch(renderToStaticMarkup(<TimelineStream rows={rows} messageStreamShowReasoning={false} />), /private thought/);
});

test("TimelineStream: renders empty state with default text and custom emptyText", () => {
  // 1. Default empty text
  const htmlDefault = renderToStaticMarkup(<TimelineStream rows={[]} />);
  assert.match(htmlDefault, /data-testid="timeline-stream-empty"/);
  assert.match(htmlDefault, /暂无事件/);

  // 2. Custom emptyText
  const htmlCustom = renderToStaticMarkup(
    <TimelineStream rows={[]} emptyText="当前会话没有任何历史记录" />
  );
  assert.match(htmlCustom, /data-testid="timeline-stream-empty"/);
  assert.match(htmlCustom, /当前会话没有任何历史记录/);
});

test("TimelineStream: renders all 3 roles (user, assistant, tool) and visually distinguishes user and assistant", () => {
  const rows: TimelineRow[] = [
    {
      kind: "user",
      seq: 1,
      turnId: "turn-1",
      text: "请帮我重构时间线组件",
    },
    {
      kind: "assistant",
      seq: 2,
      turnId: "turn-1",
      text: "没问题，我已经为你制定好计划。",
    },
    {
      kind: "tool",
      seq: 3,
      turnId: "turn-1",
      toolCallId: "call-1",
      name: "write",
      subject: "webapp/src/XuenessTimeline.tsx",
      status: "ok",
      error: "",
      errorCode: "",
    },
  ];

  const html = renderToStaticMarkup(<TimelineStream rows={rows} />);

  // User item presence and role identification
  assert.match(html, /data-testid="timeline-item-user-1"/);
  assert.match(html, /data-role="user"/);
  assert.match(html, /请帮我重构时间线组件/);

  // Assistant item presence and role identification
  assert.match(html, /data-testid="timeline-item-assistant-2"/);
  assert.match(html, /data-role="assistant"/);
  assert.match(html, /没问题，我已经为你制定好计划。/);
  assert.match(html, /class="xn-md"/);

  // Tool item presence and role identification
  assert.match(html, /data-testid="timeline-item-tool-3"/);
  assert.match(html, /data-role="tool"/);
  assert.match(html, /<span class="xn-msg__tool-name[^\"]*">write<\/span>/);
  assert.match(html, /webapp\/src\/XuenessTimeline\.tsx/);

  // Visual distinction between user and assistant
  assert.match(html, /xn-timeline-item--user/);
  assert.match(html, /xn-timeline-item--assistant/);
  assert.match(html, /xn-msg--user/);
  assert.match(html, /xn-msg__bubble/);
  assert.match(html, /xn-msg--assistant/);
});

test("TimelineStream: tool row errorCode and error message are visible when status is error", () => {
  const rows: TimelineRow[] = [
    {
      kind: "tool",
      seq: 10,
      turnId: "turn-2",
      toolCallId: "call-err-1",
      name: "exec",
      subject: '["npm", "run", "build"]',
      status: "error",
      error: "Command failed with exit code 1",
      errorCode: "ENOENT",
    },
  ];

  const html = renderToStaticMarkup(<TimelineStream rows={rows} />);

  // Tool role and status
  assert.match(html, /data-testid="timeline-item-tool-10"/);
  assert.match(html, /data-tool-status="error"/);

  // Formatted subject
  assert.match(html, /npm run build/);

  // ErrorCode and error message visible
  assert.match(html, /\[ENOENT\]/);
  assert.match(html, /Command failed with exit code 1/);
  assert.match(html, /错误码: ENOENT/);
  assert.match(html, /xn-timeline-item--error/);
  assert.match(html, /xn-msg__tool-error/);
});

test("TimelineStream: assistant Markdown fence uses the themed code content and copy action", () => {
  const markdownText = "以下是示例代码：\n```ts\nconst greeting = 'hello';\nconsole.log(greeting);\n```\n请查收。";
  const rows: TimelineRow[] = [
    {
      kind: "assistant",
      seq: 5,
      turnId: "turn-3",
      text: markdownText,
    },
  ];

  const html = renderToStaticMarkup(<TimelineStream rows={rows} />);

  // Assistant row rendered
  assert.match(html, /data-testid="timeline-item-assistant-5"/);

  // Code element rendered by SimpleMarkdown
  assert.match(html, /class="xn-md__code-fence" data-language="typescript"/);
  assert.match(html, /data-testid="primitive-code"[^>]*data-language="typescript"/);
  assert.match(html, /aria-label="复制代码"/);
  assert.match(html, /const greeting = &#x27;hello&#x27;;/);
  assert.match(html, /console\.log\(greeting\);/);
});

test("TimelineStream: running tool does not invent duration and escapes untrusted output", () => {
  const html = renderToStaticMarkup(<TimelineStream rows={[{
    kind: "tool", seq: 12, turnId: "t", toolCallId: "c", name: "exec",
    subject: "<script>bad</script>", status: "running", error: "", errorCode: "",
  }]} />);
  assert.match(html, /data-tool-status="running"/);
  assert.match(html, /xn-timeline-item--running/);
  assert.match(html, /data-tone="warn"/);
  assert.doesNotMatch(html, /xn-card-duration/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("TimelineStream: tool cards show hydrated read, write, edit, exec and MCP payloads", () => {
  const rows: TimelineRow[] = [
    { kind: "tool", seq: 1, turnId: "t", toolCallId: "read", name: "read", subject: "", status: "ok", error: "", errorCode: "", input: { file_path: "src/app.ts" }, output: "export const ready = true;" },
    { kind: "tool", seq: 2, turnId: "t", toolCallId: "write", name: "write", subject: "", status: "ok", error: "", errorCode: "", input: { path: "README.md", content: "Updated" }, output: { written: true } },
    { kind: "tool", seq: 3, turnId: "t", toolCallId: "edit", name: "edit", subject: "", status: "ok", error: "", errorCode: "", input: { file_path: "src/app.ts", old_string: "false", new_string: "true" }, output: "1 replacement" },
    { kind: "tool", seq: 4, turnId: "t", toolCallId: "exec", name: "exec", subject: "", status: "ok", error: "", errorCode: "", input: { command: "npm test" }, output: { content: [{ type: "text", text: "Tests passed" }] } },
    { kind: "tool", seq: 5, turnId: "t", toolCallId: "mcp", name: "mcp", subject: "", status: "ok", error: "", errorCode: "", input: { server: "search", tool: "lookup", query: "xueness" }, output: { content: [{ type: "text", text: "Found 2 results" }] } },
  ];
  const html = renderToStaticMarkup(<TimelineStream rows={rows} />);
  assert.match(html, /xn-toolcall--read/);
  assert.match(html, /src\/app\.ts/);
  assert.match(html, /export const ready = true;/);
  assert.match(html, /xn-toolcall--write/);
  assert.match(html, /README\.md/);
  assert.match(html, /Updated/);
  assert.match(html, /xn-toolcall--edit/);
  assert.match(html, /new_string/);
  assert.match(html, /xn-toolcall--exec/);
  assert.match(html, /npm test/);
  assert.match(html, /Tests passed/);
  assert.match(html, /xn-toolcall--mcp/);
  assert.match(html, /Search · Lookup/);
  assert.match(html, /Found 2 results/);
  assert.match(html, /aria-label="展开工具详情"/);
  assert.doesNotMatch(html, /xn-card-duration/);
});

test("TimelineStream: renders completion and pending_question rows", () => {
  const rows: TimelineRow[] = [
    {
      kind: "completion",
      seq: 20,
      verified: true,
      summary: "所有验收项均已绿灯通过",
    },
    {
      kind: "pending_question",
      seq: 21,
      question: "需要现在部署到预发环境吗？",
    },
  ];

  const html = renderToStaticMarkup(<TimelineStream rows={rows} />);

  // Completion row
  assert.match(html, /data-testid="timeline-item-completion-20"/);
  assert.match(html, /任务完成 \(已验证\)/);
  assert.match(html, /所有验收项均已绿灯通过/);
  assert.match(html, /xn-msg--completion/);

  // Pending question row
  assert.match(html, /data-testid="timeline-item-question-21"/);
  assert.match(html, /等待回答/);
  assert.match(html, /需要现在部署到预发环境吗？/);
  assert.match(html, /xn-msg--question/);
});


test("tool grouping respects messages, categories, and disabled preferences", () => {
  const tool = (seq: number, name: string): TimelineRow => ({kind:"tool", seq, turnId:"t", toolCallId:String(seq), name, subject:"sample", status:"ok", error:"", errorCode:""});
  const rows: TimelineRow[] = [tool(1,"read"), tool(2,"grep"), {kind:"assistant",seq:3,turnId:"t",text:"next"}, tool(4,"write"),tool(5,"edit"),tool(6,"exec")];
  const grouped = groupTimelineRows(rows, {explore:true,changes:true});
  assert.deepEqual(grouped.map(row=>row.kind),["tool-group","assistant","tool-group","tool"]);
  assert.deepEqual(groupTimelineRows(rows).map(row=>row.kind === "tool-group" ? null : row.seq),[1,2,3,4,5,6]);
  const html = renderToStaticMarkup(<TimelineStream rows={rows} grouping={{explore:true}} collapseTools={false} />);
  assert.match(html,/探索工作区/);
  assert.match(html,/<details[^>]*open=""/);
  assert.match(html,/timeline-item-tool-2/);
});

test("task todos show actual counts and statuses, escape text and ignore malformed entries", () => {
  const html = renderToStaticMarkup(<TaskTodos todos={[{id:"1",text:"<script>todo</script>",status:"done"},{id:"2",text:"active",status:"in_progress"},null,{text:"bad"}]} />);
  assert.match(html,/1\/2/);
  assert.match(html,/data-status="in_progress"/);
  assert.match(html,/&lt;script&gt;/);
  assert.doesNotMatch(html,/<script>/);
  assert.equal(renderToStaticMarkup(<TaskTodos todos={[null,{}]} />),"");
});
