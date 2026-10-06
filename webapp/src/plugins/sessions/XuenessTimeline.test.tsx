import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { TimelineStream, TaskTodos, groupTimelineRows, assistantTextForDisplay, StreamingCommitGate, STREAM_COMMIT_INTERVAL_MS, FoldablePayloadTextView, TOOL_PAYLOAD_FOLD_THRESHOLD } from "./XuenessTimeline";
import { unwrapProtocolEnvelopeText, isDuplicateCompletionAnswer, completionPresentation } from "./completionPresentation";
import type { TimelineRow } from "../../xuenessWorkbench";

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
      subject: "webapp/src/plugins/sessions/XuenessTimeline.tsx",
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
  assert.match(html, /webapp\/src\/plugins\/sessions\/XuenessTimeline\.tsx/);

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
  // 工具折叠控件的名称必须来自内容：aria-label 会整体覆盖它，N 个工具就变成 N 个同名控件
  assert.doesNotMatch(html, /<summary[^>]*aria-label=/);
  assert.match(html, /<summary class="xn-msg__tool-line xn-toolcall__summary">/);
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
  assert.match(html, /运行结束 · 工具成功证据通过/);
  assert.match(html, /所有验收项均已绿灯通过/);
  assert.match(html, /xn-msg--completion/);

  // Pending question row
  assert.match(html, /data-testid="timeline-item-question-21"/);
  assert.match(html, /等待回答/);
  assert.match(html, /需要现在部署到预发环境吗？/);
  assert.match(html, /xn-msg--question/);
});

test('ended unverified runs show a static warning while actual tools retain their running state', () => {
  const html = renderToStaticMarkup(<TimelineStream rows={[{ kind: 'completion', seq: 1, verified: false, summary: 'Evidence was insufficient' }]} />);
  assert.match(html, /运行结束 · 工具证据未通过验证/);
  assert.match(html, /data-status="review"/);
  assert.doesNotMatch(html, /xn-spin|PENDING|工具证据待审核/i);
  const running = renderToStaticMarkup(<TimelineStream rows={[{ kind: 'tool', seq: 2, turnId: 't', toolCallId: 'c', name: 'exec', subject: 'echo test', status: 'running', error: '', errorCode: '' }]} />);
  assert.match(running, /data-status="running"/);
  assert.match(running, /运行中/);
});

test('the local JSON protocol failure has an explicit terminal error and translated explanation', () => {
  const html = renderToStaticMarkup(<TimelineStream rows={[{ kind: 'completion', seq: 1, verified: false, summary: 'The local model could not follow the configured JSON tool protocol within the configured response limit.' }]} />);
  assert.match(html, /运行结束 · 模型工具协议失败/);
  assert.match(html, /本轮已停止/);
  assert.match(html, /data-status="error"/);
  assert.doesNotMatch(html, /xn-spin|PENDING|could not follow/i);
});

test('local JSON answer streams decode escapes incrementally and keep ordinary JSON visible', () => {
  assert.equal(assistantTextForDisplay('{"summary":"Hello\\n\\u4e2d work', true, undefined, true), 'Hello\n中 work');
  assert.equal(assistantTextForDisplay('```json\n{"summary":"Hello\\nmore', true, undefined, true), 'Hello\nmore');
  assert.equal(assistantTextForDisplay('```json', true, undefined, true), '');
  assert.equal(assistantTextForDisplay('{"summary":', true, undefined, true), '');
  assert.equal(assistantTextForDisplay('{"summary":"still loading', true, undefined, false), '{"summary":"still loading');
  assert.equal(assistantTextForDisplay('{"items":[1,2]}', true, undefined, true), '{"items":[1,2]}');
});

test('unknown local tool-calling metadata holds back only a recognized protocol prefix until mode resolves', () => {
  const protocolPrefix = '{"summary":"Hello\\nworld';
  assert.equal(assistantTextForDisplay(protocolPrefix, true, undefined, false, true), '');
  assert.equal(assistantTextForDisplay('{"tool":"read","arguments":{', true, undefined, false, true), '');
  // Once the session confirms native calls, legitimate JSON remains visible.
  assert.equal(assistantTextForDisplay(protocolPrefix, true, undefined, false, false), protocolPrefix);
  const html = renderToStaticMarkup(<TimelineStream rows={[{
    kind: 'assistant', seq: 7, turnId: 'turn-1', text: protocolPrefix, streaming: true,
  }]} protocolModePending />);
  assert.match(html, /正在生成回复/);
  assert.doesNotMatch(html, /summary|Hello/);
});

test('only the known local tool envelope is hidden while streaming; user-facing JSON is retained', () => {
  assert.equal(assistantTextForDisplay('{"tool":"read","arguments":{"path":"a.ts"}}', true, undefined, true), '');
  assert.equal(assistantTextForDisplay('{"tool":"result","detail":"visible JSON"}', true, undefined, true), '{"tool":"result","detail":"visible JSON"}');
});

test('terminal completion does not repeat the assistant answer or claim evidence for ordinary chat', () => {
  const answer = 'Hello, the change is ready.';
  const html = renderToStaticMarkup(<TimelineStream rows={[
    { kind: 'user', seq: 1, turnId: 'turn-1', text: 'Please make the change.' },
    { kind: 'assistant', seq: 2, turnId: 'turn-1', text: answer },
    { kind: 'completion', seq: 3, turnId: 'turn-1', verified: false, status: 'not_applicable', toolExecutionStatus: 'not_applicable', summary: answer },
  ]} />);
  assert.equal(html.split(answer).length - 1, 1);
  assert.match(html, /运行结束/);
  assert.match(html, /data-status="ok"/);
  assert.doesNotMatch(html, /工具证据未通过验证/);
  assert.doesNotMatch(html, /查看完成详情/);
});

test('unverified completion stays under review when tool execution was not applicable', () => {
  const html = renderToStaticMarkup(<TimelineStream rows={[{
    kind: 'completion', seq: 1, turnId: 'turn-1', verified: false,
    status: 'unverified', toolExecutionStatus: 'not_applicable', deliveryStatus: 'not_assessed',
    summary: 'A required tool was not run.',
  }]} />);
  assert.match(html, /运行结束 · 工具证据未通过验证/);
  assert.match(html, /data-status="review"/);
  assert.doesNotMatch(html, /运行结束 · 已完成|data-status="ok"/);
  const contradictory = renderToStaticMarkup(<TimelineStream rows={[{
    kind: 'completion', seq: 2, turnId: 'turn-2', verified: false,
    status: 'not_applicable', toolExecutionStatus: 'failed', deliveryStatus: 'not_assessed',
    summary: 'A real tool failure remains visible.',
  }]} />);
  assert.match(contradictory, /data-status="review"/);
  assert.match(contradictory, /工具证据未通过验证/);
});

test('completion de-duplication is scoped to its own turn when answers repeat later', () => {
  const repeated = 'Same answer text';
  const html = renderToStaticMarkup(<TimelineStream rows={[
    { kind: 'user', seq: 1, turnId: 'turn-1', text: 'first question' },
    { kind: 'assistant', seq: 2, turnId: 'turn-1', text: repeated },
    { kind: 'completion', seq: 3, turnId: 'turn-1', verified: false, status: 'not_applicable', summary: repeated },
    { kind: 'user', seq: 4, turnId: 'turn-2', text: 'second question' },
    { kind: 'assistant', seq: 5, turnId: 'turn-2', text: repeated },
    { kind: 'completion', seq: 6, turnId: 'turn-2', verified: false, status: 'not_applicable', summary: repeated },
  ]} />);
  assert.equal(html.split(repeated).length - 1, 2);
  assert.match(html, /timeline-item-completion-3/);
  assert.match(html, /timeline-item-completion-6/);
});

test('historical protocol envelopes unwrap only when the terminal answer confirms the summary', () => {
  const matching = renderToStaticMarkup(<TimelineStream rows={[
    { kind: 'assistant', seq: 1, turnId: 'turn-1', text: '{"summary":"Public answer\\nwith Markdown","evidence":[]}' },
    { kind: 'completion', seq: 2, turnId: 'turn-1', verified: true, status: 'verified', toolExecutionStatus: 'succeeded', summary: 'Public answer\nwith Markdown' },
  ]} />);
  assert.match(matching, /Public answer/);
  assert.doesNotMatch(matching, /&quot;summary&quot;|evidence/);

  const unrelated = assistantTextForDisplay('{"summary":"user JSON","evidence":[]}', false, 'a different summary');
  assert.equal(unrelated, '{"summary":"user JSON","evidence":[]}');
});

test('an active run with no first delta still announces generation and grouped tools start collapsed', () => {
  const empty = renderToStaticMarkup(<TimelineStream rows={[]} streamingPending />);
  assert.match(empty, /data-testid="timeline-stream-loading"/);
  assert.match(empty, /role="status"/);
  assert.match(empty, /正在生成回复/);
  const grouped = renderToStaticMarkup(<TimelineStream rows={[
    { kind: 'tool', seq: 1, turnId: 'turn-1', toolCallId: 'a', name: 'read', subject: 'a.ts', status: 'ok', error: '', errorCode: '' },
    { kind: 'tool', seq: 2, turnId: 'turn-1', toolCallId: 'b', name: 'grep', subject: 'needle', status: 'ok', error: '', errorCode: '' },
  ]} grouping={{ explore: true }} />);
  assert.match(grouped, /class="xn-tool-group"/);
  assert.doesNotMatch(grouped, /class="xn-tool-group"[^>]*open/);
});

test('an existing assistant row is marked live when the latest stream snapshot repeats its text', () => {
  const html = renderToStaticMarkup(<TimelineStream rows={[{
    kind: 'assistant', seq: 2, turnId: 'turn-1', text: 'first delta', streaming: true,
  }]} streamingPending />);
  assert.doesNotMatch(html, /data-testid="timeline-stream-loading"/);
  assert.match(html, /first delta/);
});

test('cancelled tools use a neutral terminal state rather than a failure badge', () => {
  const html = renderToStaticMarkup(<TimelineStream rows={[{
    kind: 'tool', seq: 1, turnId: 'turn-1', toolCallId: 'cancelled', name: 'exec', subject: 'long command',
    status: 'error', error: 'Run cancelled by the user', errorCode: 'xueness.error.cancelled',
  }]} />);
  assert.match(html, /data-tool-status="cancelled"/);
  assert.match(html, /data-tone="neutral"/);
  assert.doesNotMatch(html, /xn-timeline-item--error/);
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
test("truncated completion summary does not duplicate in completion details and unwraps protocol envelope", () => {
  const longAnswer = "这是一段非常详尽的长篇代码分析报告，包含了多个模块的架构设计、错误处理流程以及性能优化的关键点。在此基础上我们进一步阐述了具体的实现细节和测试验证方案。";
  const truncatedSummary = longAnswer.slice(0, 20) + "...";
  const html = renderToStaticMarkup(<TimelineStream jsonToolProtocol rows={[
    { kind: "assistant", seq: 1, turnId: "turn-1", text: JSON.stringify({ answer: longAnswer, evidence: [] }) },
    { kind: "completion", seq: 2, turnId: "turn-1", verified: true, status: "verified", toolExecutionStatus: "succeeded", summary: truncatedSummary },
  ]} />);
  assert.match(html, /架构设计/);
  assert.doesNotMatch(html, /&quot;answer&quot;|evidence/);
  assert.doesNotMatch(html, /查看完成详情/);

  // Test truncated JSON envelope in summary
  const truncatedJsonSummary = '{"answer": "' + longAnswer.slice(0, 25) + '...';
  const htmlWithJsonSummary = renderToStaticMarkup(<TimelineStream jsonToolProtocol rows={[
    { kind: "assistant", seq: 1, turnId: "turn-1", text: longAnswer },
    { kind: "completion", seq: 2, turnId: "turn-1", verified: true, status: "verified", toolExecutionStatus: "succeeded", summary: truncatedJsonSummary },
  ]} />);
  assert.doesNotMatch(htmlWithJsonSummary, /查看完成详情/);
  assert.doesNotMatch(htmlWithJsonSummary, /\{&quot;answer&quot;/);
});

test("completion summary repeating body and supplementing error details is not hidden by de-duplication", () => {
  const bodyText = "代码已修改完成，测试脚本已创建。";
  const summaryWithError = "代码已修改完成，测试脚本已创建。\n运行测试失败：npm test exited with code 1\nAssertionError: expected true but got false";

  assert.equal(isDuplicateCompletionAnswer(summaryWithError, bodyText), false);

  const html = renderToStaticMarkup(<TimelineStream rows={[
    { kind: "assistant", seq: 1, turnId: "turn-1", text: bodyText },
    { kind: "completion", seq: 2, turnId: "turn-1", verified: false, status: "unverified", toolExecutionStatus: "failed", summary: summaryWithError },
  ]} />);

  assert.match(html, /查看完成详情/);
  assert.match(html, /运行测试失败/);
  assert.match(html, /AssertionError/);
});

test("ordinary JSON completion summary preserves all fields and is not stripped by protocol unwrapping", () => {
  const ordinaryJson = JSON.stringify({
    answer: "42",
    explanation: "The answer to life the universe and everything",
    confidence: 0.99,
    sources: ["deep-thought"]
  }, null, 2);

  assert.equal(unwrapProtocolEnvelopeText(ordinaryJson), ordinaryJson);

  const presentation = completionPresentation({
    verified: true,
    summary: ordinaryJson,
    status: "not_applicable",
    toolExecutionStatus: "not_applicable"
  });

  assert.equal(presentation.summary, ordinaryJson);
  assert.match(presentation.summary, /explanation/);
  assert.match(presentation.summary, /confidence/);
  assert.match(presentation.summary, /deep-thought/);

  // Strict protocol envelope with evidence array is unwrapped
  const protocolEnvelope = JSON.stringify({
    answer: "Protocol answer",
    evidence: []
  });
  assert.equal(unwrapProtocolEnvelopeText(protocolEnvelope), "Protocol answer");
});



test("assistant protocol envelope unwraps when completion summary supplements error details and detailsOpen is true on failure", () => {

  const assistantEnvelope = '{"summary":"代码已修改完成，测试脚本已创建。","evidence":[]}';

  const summaryWithError = "代码已修改完成，测试脚本已创建。\n运行测试失败：npm test exited with code 1\nAssertionError: expected true but got false";



  const unwrapped = assistantTextForDisplay(assistantEnvelope, false, summaryWithError, true);
  assert.equal(unwrapped, "代码已修改完成，测试脚本已创建。");

  // In non-protocol mode (jsonToolProtocol = false), ordinary JSON is kept intact
  const nonProtocol = assistantTextForDisplay(assistantEnvelope, false, summaryWithError, false);
  assert.equal(nonProtocol, assistantEnvelope);



  const presentation = completionPresentation({

    verified: false,

    summary: summaryWithError,

    status: "unverified",

    toolExecutionStatus: "failed",

    deliveryStatus: "failed",

  });

  assert.equal(presentation.detailsOpen, true);



  const html = renderToStaticMarkup(<TimelineStream jsonToolProtocol rows={[
    { kind: "assistant", seq: 1, turnId: "turn-1", text: assistantEnvelope },
    { kind: "completion", seq: 2, turnId: "turn-1", verified: false, status: "unverified", toolExecutionStatus: "failed", deliveryStatus: "failed", summary: summaryWithError },
  ]} />);



  assert.doesNotMatch(html, /&quot;summary&quot;/);

  assert.doesNotMatch(html, /evidence/);

  assert.match(html, /代码已修改完成，测试脚本已创建。/);

  assert.match(html, /<details class="xn-completion-details" open=""/);

  assert.match(html, /运行测试失败/);

});



test("truncated ordinary JSON with multiple fields is not unwrapped as protocol envelope", () => {

  const truncatedOrdinary = '{"answer": "42", "reasoning": "multi-field calculation in progress...';

  assert.equal(unwrapProtocolEnvelopeText(truncatedOrdinary), truncatedOrdinary);



  const truncatedProtocolWithEvidence = '{"answer": "Finished work", "evidence": [{"tool_call_id": "call-1"';
  assert.equal(unwrapProtocolEnvelopeText(truncatedProtocolWithEvidence, true), "Finished work");
  assert.equal(unwrapProtocolEnvelopeText(truncatedProtocolWithEvidence, false), truncatedProtocolWithEvidence);
});

test("non-protocol mode ordinary JSON with prefix match is never unwrapped", () => {
  // Truncated ordinary JSON without closing quote in non-protocol mode
  const incompleteOrdinary = '{"summary": "Annual project review with C:\\\\models\\\\apps in progress...';
  assert.equal(unwrapProtocolEnvelopeText(incompleteOrdinary, false), incompleteOrdinary);
  assert.equal(assistantTextForDisplay(incompleteOrdinary, false, undefined, false), incompleteOrdinary);

  const incompleteOrdinaryAnswer = '{"answer": "Preliminary calculations for Q3...';
  assert.equal(unwrapProtocolEnvelopeText(incompleteOrdinaryAnswer, false), incompleteOrdinaryAnswer);
  assert.equal(assistantTextForDisplay(incompleteOrdinaryAnswer, false, undefined, false), incompleteOrdinaryAnswer);

  // SSR scenario: assistant text is ordinary JSON with answer & evidence:[],
  // completion summary is a prefix-extended warning, jsonToolProtocol = false.
  const ssrOrdinaryJson = '{"answer":"The API returned 200.","evidence":[]}';
  const ssrSummary = "The API returned 200. Warning: response was not persisted.";
  assert.equal(
    assistantTextForDisplay(ssrOrdinaryJson, false, ssrSummary, false),
    ssrOrdinaryJson
  );
});

test("truncated JSON does not drop fields after evidence and rejects non-protocol shapes", () => {
  // Field after evidence array
  const jsonWithFieldsAfterEvidence = '{"answer": "Finished work", "evidence": [], "next_task": "deployment", "reviewer": "qa"';
  assert.equal(unwrapProtocolEnvelopeText(jsonWithFieldsAfterEvidence, true), jsonWithFieldsAfterEvidence);
  assert.equal(unwrapProtocolEnvelopeText(jsonWithFieldsAfterEvidence, false), jsonWithFieldsAfterEvidence);

  // Truncated JSON with metadata object after evidence
  const truncatedWithMetadata = '{"answer":"A","evidence":[],"metadata":{"source":"';
  assert.equal(unwrapProtocolEnvelopeText(truncatedWithMetadata, true), truncatedWithMetadata);
  assert.equal(unwrapProtocolEnvelopeText(truncatedWithMetadata, false), truncatedWithMetadata);

  // Truncated during key name after evidence
  const truncatedDuringKeyAfterEvidence = '{"answer":"A","evidence":[],"meta';
  assert.equal(unwrapProtocolEnvelopeText(truncatedDuringKeyAfterEvidence, true), truncatedDuringKeyAfterEvidence);
  assert.equal(unwrapProtocolEnvelopeText(truncatedDuringKeyAfterEvidence, false), truncatedDuringKeyAfterEvidence);

  // Evidence is not an array
  const invalidEvidenceShape = '{"summary": "Test run completed", "evidence": "no-evidence-available", "extra": 1}';
  assert.equal(unwrapProtocolEnvelopeText(invalidEvidenceShape, true), invalidEvidenceShape);
  assert.equal(unwrapProtocolEnvelopeText(invalidEvidenceShape, false), invalidEvidenceShape);
});

test("terminal protocol summaries preserve an unfinished extra key after the answer", () => {
  for (const summary of ['{"answer":"42","meta', '{"summary":"42","meta']) {
    assert.equal(unwrapProtocolEnvelopeText(summary, true), summary);
    assert.equal(completionPresentation({ verified: false, status: 'unverified', summary }, true).summary, summary);
  }
});

test("Windows paths with backslash escapes are correctly preserved without corrupting \\n, \\t, \\r or \\b", () => {
  // Escaped Windows path in protocol envelope
  const envelopeWithWindowsPath = '{"answer": "Modified C:\\\\new_directory\\\\test.txt and C:\\\\tools\\\\bin", "evidence": []}';
  assert.equal(unwrapProtocolEnvelopeText(envelopeWithWindowsPath, true), "Modified C:\\new_directory\\test.txt and C:\\tools\\bin");

  // Truncated protocol envelope with literal path C:\new (wire format C:\\new)
  const truncatedWithNew = '{"answer": "Modified C:\\\\new", "evidence": [{"id": 1';
  assert.equal(unwrapProtocolEnvelopeText(truncatedWithNew, true), "Modified C:\\new");

  // Truncated protocol envelope with Windows path and evidence array
  const truncatedWindowsEnvelope = '{"answer": "Processing C:\\\\models\\\\apps\\\\data.json", "evidence": [{"id": 1}';
  assert.equal(unwrapProtocolEnvelopeText(truncatedWindowsEnvelope, true), "Processing C:\\models\\apps\\data.json");

  // Single-backslash unescaped Windows path in protocol envelope (tolerates non-standard JSON escape \\m, \\a)
  const singleBackslashEnvelope = '{"answer": "Checking C:\\models\\apps\\config.json", "evidence": []}';
  assert.equal(unwrapProtocolEnvelopeText(singleBackslashEnvelope, true), "Checking C:\\models\\apps\\config.json");

  // Streaming assistant text with Windows path under jsonToolProtocol
  assert.equal(
    assistantTextForDisplay('{"answer": "Writing to C:\\\\new_folder\\\\test.txt', true, undefined, true),
    "Writing to C:\\new_folder\\test.txt"
  );
  assert.equal(
    assistantTextForDisplay('{"answer": "Accessing C:\\models\\apps', true, undefined, true),
    "Accessing C:\\models\\apps"
  );
});

function buildLongTimelineRows(turns: number): TimelineRow[] {
  const rows: TimelineRow[] = [];
  for (let index = 0; index < turns; index += 1) {
    rows.push({ kind: "user", seq: index * 2 + 1, turnId: `turn-${index}`, text: `第 ${index + 1} 条用户消息` });
    rows.push({ kind: "assistant", seq: index * 2 + 2, turnId: `turn-${index}`, text: `第 ${index + 1} 条助手回复` });
  }
  return rows;
}

function countRenderedTimelineItems(html: string): number {
  return (html.match(/class="xn-timeline-item /g) ?? []).length;
}

test("virtualize: 短会话仍完整渲染且不出现窗口垫片", () => {
  const html = renderToStaticMarkup(<TimelineStream rows={buildLongTimelineRows(20)} virtualize />);
  assert.equal(countRenderedTimelineItems(html), 40);
  assert.match(html, /data-testid="timeline-item-user-1"/);
  assert.match(html, /data-testid="timeline-item-assistant-40"/);
  assert.doesNotMatch(html, /timeline-window-top-spacer/);
  assert.doesNotMatch(html, /timeline-window-bottom-spacer/);
  assert.doesNotMatch(html, /data-window-index/);
});

test("virtualize: 长会话只渲染头部窗口并以后部垫片补齐高度", () => {
  const html = renderToStaticMarkup(<TimelineStream rows={buildLongTimelineRows(60)} virtualize />);
  const rendered = countRenderedTimelineItems(html);
  assert.ok(rendered > 0 && rendered < 120, `长会话应只渲染部分节点，实际 ${rendered}`);
  assert.ok(html.includes('data-testid="timeline-item-user-1"'), "首条用户消息应渲染");
  assert.ok(!html.includes('data-testid="timeline-item-user-119"'), "尾部消息不应渲染");
  assert.doesNotMatch(html, /timeline-window-top-spacer/);
  assert.match(html, /data-testid="timeline-window-bottom-spacer" style="height:\d+px"/);
  assert.match(html, /data-window-index="0"/);
  assert.match(html, /data-window-index="31"/);
  assert.doesNotMatch(html, /data-window-index="32"/);
});

test("virtualize: 从尾部打开的长会话渲染末尾窗口并以顶部垫片补齐", () => {
  const html = renderToStaticMarkup(<TimelineStream rows={buildLongTimelineRows(60)} virtualize virtualizeFromTail />);
  const rendered = countRenderedTimelineItems(html);
  assert.ok(rendered > 0 && rendered < 120, `长会话应只渲染部分节点，实际 ${rendered}`);
  assert.ok(!html.includes('data-testid="timeline-item-user-1"'), "头部消息不应渲染");
  assert.ok(html.includes('data-testid="timeline-item-assistant-120"'), "最后一条应渲染");
  // 窗口 [88, 120)：首条渲染的用户消息为 seq 89，垫片按估计高度补齐前 88 个条目。
  assert.ok(html.includes('data-testid="timeline-item-user-89"'), "窗口内首条用户消息应渲染");
  assert.ok(!html.includes('data-testid="timeline-item-user-87"'), "窗口前一条不应渲染");
  assert.match(html, /data-testid="timeline-window-top-spacer" style="height:12320px"/);
  assert.doesNotMatch(html, /timeline-window-bottom-spacer/);
});

test("未启用 virtualize 的长会话保持完整渲染", () => {
  const html = renderToStaticMarkup(<TimelineStream rows={buildLongTimelineRows(60)} />);
  assert.equal(countRenderedTimelineItems(html), 120);
  assert.doesNotMatch(html, /timeline-window-top-spacer|timeline-window-bottom-spacer/);
  assert.doesNotMatch(html, /data-window-index/);
});

test("StreamingCommitGate: 流式文本按间隔量化提交，间隔内仅保留待提交，到期放行", () => {
  const gate = new StreamingCommitGate();
  assert.equal(STREAM_COMMIT_INTERVAL_MS > 0, true);
  // 首次推送立即提交（首个增量必须尽快上屏）。
  assert.equal(gate.push("第一段", 0), "第一段");
  // 间隔内的后续推送被扣住，不触发重渲染。
  assert.equal(gate.push("第一段第二", 40), null);
  assert.equal(gate.push("第一段第二三", 120), null);
  // 到期时间 = 上次提交 + 间隔，供调用方安排兜底提交。
  assert.equal(gate.dueAt(), STREAM_COMMIT_INTERVAL_MS);
  // 间隔一到即放行最新文本。
  assert.equal(gate.push("第一段第二三终", STREAM_COMMIT_INTERVAL_MS), "第一段第二三终");
  // 放行后无待提交。
  assert.equal(gate.dueAt(), Number.POSITIVE_INFINITY);
});

test("StreamingCommitGate: 自定义间隔与慢流（超过间隔的稀疏推送）始终立即提交", () => {
  const gate = new StreamingCommitGate(500);
  assert.equal(gate.push("a", 0), "a");
  assert.equal(gate.push("ab", 499), null);
  assert.equal(gate.dueAt(), 500);
  assert.equal(gate.push("abc", 500), "abc");
  // 1s 会话轮询节奏下（远大于默认间隔）不会被扣住，行为与旧渲染一致。
  const polled = new StreamingCommitGate();
  assert.equal(polled.push("tick-1", 0), "tick-1");
  assert.equal(polled.push("tick-2", 1000), "tick-2");
  assert.equal(polled.push("tick-3", 2500), "tick-3");
});

test("TimelineStream: 流式助手消息代码块推迟高亮（after-stream），结束后改为进入可视区再高亮", () => {
  const text = "说明\n\n```ts\nconst ready = true;\n```\n";
  const streamingHtml = renderToStaticMarkup(
    <TimelineStream rows={[{ kind: "assistant", seq: 9, turnId: "t9", text, streaming: true }]} />,
  );
  assert.match(streamingHtml, /data-highlight="after-stream"/);
  const settledHtml = renderToStaticMarkup(
    <TimelineStream rows={[{ kind: "assistant", seq: 9, turnId: "t9", text, streaming: false }]} />,
  );
  assert.match(settledHtml, /data-highlight="on-visible"/);
  assert.doesNotMatch(settledHtml, /data-highlight="after-stream"/);
});

test("ToolTimelineCard: 短工具输出保持单个 pre，无折叠控件", () => {
  const html = renderToStaticMarkup(
    <TimelineStream rows={[{ kind: "tool", seq: 4, turnId: "t", toolCallId: "c", name: "read", subject: "", status: "ok", error: "", errorCode: "", input: { file_path: "a.ts" }, output: "简短输出" }]} />,
  );
  assert.match(html, /<pre class="xn-toolcall__body">简短输出<\/pre>/);
  assert.doesNotMatch(html, /xn-toolcall__fold-toggle/);
});

test("ToolTimelineCard: 超长工具输出默认折叠为预览，全文不入 DOM，按钮按需展开", () => {
  const longOutput = `${"x".repeat(300)}\n${"y".repeat(300)}\n${"z".repeat(300)}\n${"tail-marker-9".repeat(80)}`;
  const rows: TimelineRow[] = [
    { kind: "tool", seq: 5, turnId: "t", toolCallId: "c", name: "exec", subject: "", status: "ok", error: "", errorCode: "", input: { command: "npm test" }, output: longOutput },
  ];
  assert.equal(longOutput.length > TOOL_PAYLOAD_FOLD_THRESHOLD, true);
  const html = renderToStaticMarkup(<TimelineStream rows={rows} />);
  assert.match(html, /data-testid="xn-toolcall-fold-body" data-folded="true"/);
  assert.doesNotMatch(html, /tail-marker-9/); // 超出预览的尾部内容不进 DOM
  assert.match(html, /<button[^>]*xn-toolcall__fold-toggle[^>]*aria-expanded="false"/);
  assert.match(html, new RegExp(`展开全部（${longOutput.length} 字符）`));
  // 展开视图由受控组件承载：全文可见并可收起
  const expandedHtml = renderToStaticMarkup(
    <FoldablePayloadTextView text={longOutput} expanded={true} onToggle={() => {}} />,
  );
  assert.match(expandedHtml, /tail-marker-9/);
  assert.match(expandedHtml, /data-folded="false"/);
  assert.match(expandedHtml, /<button[^>]*xn-toolcall__fold-toggle[^>]*aria-expanded="true"/);
  assert.match(expandedHtml, />收起<\/button>/);
  const expandedOriginal = renderToStaticMarkup(
    <FoldablePayloadTextView text={longOutput} expanded={false} onToggle={() => {}} />,
  );
  assert.doesNotMatch(expandedOriginal, /tail-marker-9/);
});
