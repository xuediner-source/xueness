import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { ZCodeConversation, buildConversationTurns, evaluateUserMessageEditKey, zcodeConversationDisclosures } from './ZCodeConversation';
import type { TimelineRow } from '../../xuenessWorkbench';

const revision = `sha256:${'a'.repeat(64)}`;
const rows: TimelineRow[] = [
  {kind:'user',seq:0,turnId:'turn-1',text:'检查文件',messageIndex:1,messageRevision:revision},
  {kind:'assistant',seq:1,turnId:'turn-1',text:'我先读取文件。',reasoning:'检查范围',messageIndex:2},
  {kind:'tool',seq:2,turnId:'turn-1',toolCallId:'read-a',name:'read',subject:'a.txt',status:'ok',error:'',errorCode:'',input:{path:'a.txt'},output:'real file contents'},
  {kind:'assistant',seq:3,turnId:'turn-1',text:'结果已整理。',messageIndex:4,messageRevision:revision,feedback:'like'},
  {kind:'completion',seq:4,turnId:'turn-1',verified:true,status:'verified',summary:'结果已整理。'},
];
test('turn identities survive tool result updates and later user turns', () => {
  const initial=buildConversationTurns(rows);
  const updated=buildConversationTurns([...rows,{kind:'user',seq:5,turnId:'turn-2',text:'继续'}]);
  assert.equal(updated[0].key,initial[0].key);
  assert.deepEqual(initial[0].rows,rows);
  assert.equal(updated[1].userSeq,5);
});
test('completed work is folded but the final answer has a borderless shared surface', () => {
  const html=renderToStaticMarkup(<ZCodeConversation rows={rows} />);
  assert.match(html,/<details class="xn-zc-work">/);
  assert.match(html,/class="xn-zc-final"/);
  assert.match(html,/结果已整理/);
  assert.doesNotMatch(html,/class="xn-msg/);
  assert.doesNotMatch(html,/class="xn-lightweight-msg/);
  assert.equal((html.match(/data-window-index=/gu)||[]).length,1);
});
test('success is quiet, approvals and terminal failures are explicit without spinners', () => {
  const completed=renderToStaticMarkup(<ZCodeConversation rows={rows} />);
  assert.doesNotMatch(completed,/xn-zc-tool-state/);
  const failedRows=rows.map(row=>row.kind==='tool'?{...row,status:'error' as const,error:'write blocked'}:row);
  const failed=renderToStaticMarkup(<ZCodeConversation rows={failedRows} />);
  assert.match(failed,/<details class="xn-zc-work" open="">/);
  assert.match(failed,/role="alert">write blocked/);
  assert.doesNotMatch(failed,/loader|spin|PENDING/iu);
  const pending=renderToStaticMarkup(<ZCodeConversation rows={failedRows} pendingToolIds={new Set(['read-a'])} />);
  assert.match(pending,/等待批准/);
});

test('tool renderer dependencies fail closed while effective plugins get specialized cards', () => {
  const toolRows: TimelineRow[] = [
    { kind: 'tool', seq: 1, turnId: 'turn-renderers', toolCallId: 'read-1', name: 'read', subject: 'a.ts', status: 'ok', error: '', errorCode: '', input: { path: 'a.ts' }, output: 'secret read output' },
    { kind: 'tool', seq: 2, turnId: 'turn-renderers', toolCallId: 'edit-1', name: 'edit', subject: 'a.ts', status: 'ok', error: '', errorCode: '', input: { old_str: 'one', new_str: 'two' }, output: 'secret edit output' },
    { kind: 'tool', seq: 3, turnId: 'turn-renderers', toolCallId: 'exec-1', name: 'exec', subject: 'printf ok', status: 'ok', error: '', errorCode: '', input: { command: 'printf ok' }, output: 'secret terminal output' },
  ];
  const safe = renderToStaticMarkup(<ZCodeConversation rows={toolRows} collapseTools={false} effectivePluginIds={new Set(['sessions'])} />);
  assert.equal((safe.match(/data-tool-renderer="fallback"/gu) || []).length, 3);
  assert.doesNotMatch(safe, /secret (?:read|edit|terminal) output/);

  const specialized = renderToStaticMarkup(<ZCodeConversation rows={toolRows} collapseTools={false} effectivePluginIds={new Set(['sessions', 'files', 'shell'])} />);
  assert.match(specialized, /data-tool-renderer="read"/);
  assert.match(specialized, /data-tool-renderer="edit"/);
  assert.match(specialized, /data-tool-renderer="exec"/);
  assert.match(specialized, /secret terminal output/);
});

test('specialized tool payloads stay bounded in the rendered document', () => {
  const tail = 'TAIL_SENTINEL_SHOULD_NOT_RENDER';
  const rows: TimelineRow[] = [{
    kind: 'tool', seq: 1, turnId: 'turn-bound', toolCallId: 'exec-bound', name: 'exec', subject: 'cat large.log',
    status: 'ok', error: '', errorCode: '', input: { command: 'cat large.log' }, output: { stdout: `${'x'.repeat(50_000)}${tail}` },
  }];
  const html = renderToStaticMarkup(<ZCodeConversation rows={rows} collapseTools={false} effectivePluginIds={new Set(['sessions', 'shell'])} />);
  assert.match(html, /\[输出已截断\]/);
  assert.doesNotMatch(html, new RegExp(tail));
});

test('edit previews cap large file diffs while retaining the truncation marker', () => {
  const rows: TimelineRow[] = [{
    kind: 'tool', seq: 1, turnId: 'turn-diff-bound', toolCallId: 'edit-bound', name: 'edit', subject: 'large.txt',
    status: 'ok', error: '', errorCode: '', input: {
      old_str: Array.from({ length: 400 }, (_, index) => `old-${index}`).join('\n'),
      new_str: Array.from({ length: 400 }, (_, index) => `new-${index}`).join('\n'),
    }, output: '',
  }];
  const html = renderToStaticMarkup(<ZCodeConversation rows={rows} collapseTools={false} effectivePluginIds={new Set(['sessions', 'files'])} />);
  assert.match(html, /class="xn-zc-tool-truncated"/);
  assert.ok((html.match(/class="xn-diff-line /gu) || []).length <= 240);
});
test('live work stays open and only the active turn has a loading state', () => {
  const active=[...rows,{kind:'user' as const,seq:5,turnId:'turn-2',text:'second turn'}];
  const html=renderToStaticMarkup(<ZCodeConversation rows={active} streamingPending activityPhase="connecting" />);
  assert.equal((html.match(/data-testid="timeline-stream-loading"/gu)||[]).length,1);
  assert.match(html,/<details class="xn-zc-work">/);
});
test('normal chat hides protocol envelopes and duplicate completion cards', () => {
  const chat:TimelineRow[]=[{kind:'assistant',seq:2,turnId:'turn-1',text:'{"summary":"你好！","evidence":[]}'},
    {kind:'completion',seq:3,turnId:'turn-1',verified:false,status:'not_applicable',toolExecutionStatus:'not_applicable',summary:'你好！'}];
  const html=renderToStaticMarkup(<ZCodeConversation rows={chat} jsonToolProtocol />);
  assert.match(html,/你好！/);
  assert.doesNotMatch(html,/summary|evidence|timeline-item-completion/);
});
test('feedback, editing and fork controls only appear when backed by capabilities', () => {
  const html=renderToStaticMarkup(<ZCodeConversation rows={rows} effectivePluginIds={new Set(['sessions'])} onFork={()=>{}} onEdit={async()=>true} onFeedback={async()=>{}} />);
  assert.match(html,/aria-label="编辑消息"/);
  assert.match(html,/aria-label="有帮助"[^>]*aria-pressed="true"/);
  assert.match(html,/aria-label="分叉会话"/);
  assert.doesNotMatch(html,/重试运行/);
  const readonly=renderToStaticMarkup(<ZCodeConversation rows={rows} />);
  assert.doesNotMatch(readonly,/aria-label="编辑消息"|aria-label="有帮助"|aria-label="分叉会话"/);
  const disabled=renderToStaticMarkup(<ZCodeConversation rows={rows} effectivePluginIds={new Set()} onEdit={async()=>true} />);
  assert.doesNotMatch(disabled,/aria-label="编辑消息"|message-edit-composer/);
});
test('reasoning preferences and unsafe Markdown remain respected', () => {
  const html=renderToStaticMarkup(<ZCodeConversation rows={rows} showReasoning={false} />);
  assert.doesNotMatch(html,/检查范围/);
  const unsafe=renderToStaticMarkup(<ZCodeConversation rows={[{kind:'assistant',seq:1,turnId:'t',text:'[click](javascript:alert(1)) <script>bad</script>'}]} />);
  assert.doesNotMatch(unsafe,/href="javascript:|<script>/);
});

test('reasoning is a separate collapsible row with latest summary and completed duration', () => {
  const html = renderToStaticMarkup(<ZCodeConversation rows={[{
    kind: 'user', seq: 1, turnId: 'turn-reasoning', text: 'question',
  }, {
    kind: 'assistant', seq: 2, turnId: 'turn-reasoning', text: 'answer', reasoning: 'first thought\nlatest thought',
    startedAt: 1_000, endedAt: 3_200,
  }]} />);
  assert.match(html, /data-testid="timeline-item-reasoning-2"/);
  assert.match(html, /思考了 2 秒/);
  assert.match(html, /latest thought/);
  assert.match(html, /class="xn-zc-reasoning"/);
});

test('evaluateUserMessageEditKey: handles Escape and Mod+Enter with IME and platform awareness', () => {
  // Ordinary Escape cancels edit unless saving
  assert.equal(evaluateUserMessageEditKey({ key: 'Escape' }), 'cancel');
  assert.equal(evaluateUserMessageEditKey({ key: 'Escape' }, { saving: true }), null);

  // Darwin (macOS): ⌘ (metaKey) saves; Ctrl does not
  assert.equal(evaluateUserMessageEditKey({ key: 'Enter', metaKey: true }, { platform: 'darwin' }), 'save');
  assert.equal(evaluateUserMessageEditKey({ key: 'Enter', ctrlKey: true }, { platform: 'darwin' }), null);

  // Win32 (Windows): Ctrl saves; ⌘ (metaKey) does not
  assert.equal(evaluateUserMessageEditKey({ key: 'Enter', ctrlKey: true }, { platform: 'win32' }), 'save');
  assert.equal(evaluateUserMessageEditKey({ key: 'Enter', metaKey: true }, { platform: 'win32' }), null);

  // Plain Enter or Alt+Enter does not save
  assert.equal(evaluateUserMessageEditKey({ key: 'Enter' }), null);
  assert.equal(evaluateUserMessageEditKey({ key: 'Enter', metaKey: true, altKey: true }, { platform: 'darwin' }), null);
  assert.equal(evaluateUserMessageEditKey({ key: 'Enter', ctrlKey: true, shiftKey: true }, { platform: 'win32' }), null);

  // IME composition states must block both Escape and Enter
  assert.equal(evaluateUserMessageEditKey({ key: 'Escape', isComposing: true }), null);
  assert.equal(evaluateUserMessageEditKey({ key: 'Escape', nativeEvent: { isComposing: true } }), null);
  assert.equal(evaluateUserMessageEditKey({ key: 'Escape', keyCode: 229 }), null);
  assert.equal(evaluateUserMessageEditKey({ key: 'Escape', nativeEvent: { keyCode: 229 } }), null);
  assert.equal(evaluateUserMessageEditKey({ key: 'Process' }), null);
  assert.equal(evaluateUserMessageEditKey({ key: 'Dead' }), null);
  assert.equal(evaluateUserMessageEditKey({ key: 'Escape', compositionActive: true }), null);

  assert.equal(evaluateUserMessageEditKey({ key: 'Enter', metaKey: true, isComposing: true }, { platform: 'darwin' }), null);
  assert.equal(evaluateUserMessageEditKey({ key: 'Enter', ctrlKey: true, nativeEvent: { isComposing: true } }, { platform: 'win32' }), null);
  assert.equal(evaluateUserMessageEditKey({ key: 'Enter', ctrlKey: true, keyCode: 229 }, { platform: 'win32' }), null);
  assert.equal(evaluateUserMessageEditKey({ key: 'Enter', ctrlKey: true, nativeEvent: { keyCode: 229 } }, { platform: 'win32' }), null);
  assert.equal(evaluateUserMessageEditKey({ key: 'Enter', ctrlKey: true, compositionActive: true }, { platform: 'win32' }), null);
  assert.equal(evaluateUserMessageEditKey({ key: 'Process', ctrlKey: true }, { platform: 'win32' }), null);
});

test('write and edit tools render diff count statistics and unified diff preview', () => {
  const diffRows: TimelineRow[] = [
    {
      kind: 'tool',
      seq: 1,
      turnId: 'turn-diff',
      toolCallId: 'edit-1',
      name: 'edit',
      subject: 'src/app.ts',
      status: 'ok',
      error: '',
      errorCode: '',
      input: {
        old_str: 'const a = 1;',
        new_str: 'const a = 2;\nconst b = 3;',
      },
      output: 'ok',
    },
  ];

  const html = renderToStaticMarkup(<ZCodeConversation rows={diffRows} collapseTools={false} />);
  assert.match(html, /class="xn-zc-diff-count"/);
  assert.match(html, /\+2/);
  assert.match(html, /-1/);
  assert.match(html, /class="xn-unified-diff"/);
});

test('failed tool renders retry button when onRetry is provided', () => {
  const failedRows: TimelineRow[] = [
    {
      kind: 'tool',
      seq: 2,
      turnId: 'turn-retry',
      toolCallId: 'exec-fail',
      name: 'exec',
      subject: 'npm test',
      status: 'error',
      error: 'process exit 1',
      errorCode: 'ECMD',
    },
  ];

  const withRetryHtml = renderToStaticMarkup(<ZCodeConversation rows={failedRows} onRetry={() => {}} />);
  assert.match(withRetryHtml, /data-testid="tool-retry-2"/);
  assert.match(withRetryHtml, /class="xn-zc-retry-btn"/);
  assert.match(withRetryHtml, /重试/);

  const withoutRetryHtml = renderToStaticMarkup(<ZCodeConversation rows={failedRows} />);
  assert.doesNotMatch(withoutRetryHtml, /data-testid="tool-retry-2"/);
  assert.doesNotMatch(withoutRetryHtml, /class="xn-zc-retry-btn"/);
});

test('zcodeConversationDisclosures stores disclosure states across turns and re-renders with session scoping', () => {
  const toolRows: TimelineRow[] = [
    {
      kind: 'tool',
      seq: 10,
      turnId: 'turn-1',
      toolCallId: 'tool-call-10',
      name: 'replace_file_content',
      subject: 'src/main.ts',
      status: 'ok',
      error: '',
      errorCode: '',
      input: {
        TargetFile: 'src/main.ts',
        TargetContent: 'const a = 1;',
        ReplacementContent: 'const a = 2;',
      },
    },
  ];

  // 1. Tool diff renders for replace_file_content
  const html = renderToStaticMarkup(<ZCodeConversation rows={toolRows} />);
  assert.match(html, /class="xn-zc-diff-count"/);
  assert.match(html, /class="xn-diff-added">/);

  // 2. Default state: not open
  assert.doesNotMatch(html, /class="xn-zc-tool-body"/);

  // 3. When disclosure is persisted as open:
  zcodeConversationDisclosures.set('tool:tool-call-10', true);
  try {
    const openHtml = renderToStaticMarkup(<ZCodeConversation rows={toolRows} />);
    assert.match(openHtml, /class="xn-zc-tool-body"/);
    assert.match(openHtml, /class="xn-zc-tool-diff"/);
  } finally {
    zcodeConversationDisclosures.delete('tool:tool-call-10');
  }

  // 4. Session scoping isolation
  const sess1Key = 'sess-1:reasoning:1';
  const sess2Key = 'sess-2:reasoning:1';
  zcodeConversationDisclosures.set(sess1Key, true);
  try {
    assert.equal(zcodeConversationDisclosures.get(sess1Key), true);
    assert.equal(zcodeConversationDisclosures.get(sess2Key), undefined);
  } finally {
    zcodeConversationDisclosures.delete(sess1Key);
  }
});

test('compaction boundary renders once at the top of the first live turn', () => {
  // 归档行保留压缩前的轮次身份（真实快照里是 turn-1），与任务行（turn-2）不同轮。
  const archived: TimelineRow[] = [
    { kind: 'assistant', seq: 1, turnId: 'turn-1', text: '被压缩掉的回答' },
    { kind: 'tool', seq: 2, turnId: 'turn-1', toolCallId: 'call-c', name: 'exec', subject: 'pwd', status: 'ok', error: '', errorCode: '' },
  ];
  const merged: TimelineRow[] = [...archived,
    { kind: 'user', seq: 3, turnId: 'turn-2', text: '原始任务', messageIndex: 2, messageRevision: revision },
    { kind: 'assistant', seq: 4, turnId: 'turn-2', text: '仍在上下文中的回答', messageIndex: 3 },
    { kind: 'completion', seq: 5, turnId: 'turn-2', verified: true, status: 'verified', summary: '仍在上下文中的回答' }];
  const marker = { boundarySeq: 3, removed: 2, masked: 1 };
  const html = renderToStaticMarkup(<ZCodeConversation rows={merged} compactionMarker={marker} />);
  // 分隔行只出现一次，位于归档内容之后、仍在上下文中的任务消息之前。
  assert.equal((html.match(/data-testid="timeline-compaction-boundary"/gu) || []).length, 1);
  assert.match(html, /已压缩 2 条较早消息，另有 1 条旧输出已掩码/);
  assert.match(html, /role="note"/);
  const archivedAt = html.indexOf('被压缩掉的回答');
  const boundaryAt = html.indexOf('timeline-compaction-boundary');
  // 从边界之后找任务气泡，避开顶部历史导航条 aria-label 里的同名文本。
  const liveAt = html.indexOf('原始任务', boundaryAt);
  assert.ok(archivedAt >= 0 && archivedAt < boundaryAt && liveAt > boundaryAt);
  // 没有压缩记录时不渲染分隔行；边界行不在当前行集（虚拟窗口/陈旧标记）时也不出现。
  assert.doesNotMatch(renderToStaticMarkup(<ZCodeConversation rows={merged} />), /timeline-compaction-boundary/);
  assert.doesNotMatch(renderToStaticMarkup(<ZCodeConversation rows={rows}
    compactionMarker={{ boundarySeq: 999, removed: 2, masked: 0 }} />), /timeline-compaction-boundary/);
});

test('interrupted reasoning displays data-state="interrupted", duration or stopped label, and preserves summary', () => {
  // With duration
  const withDurationRows: TimelineRow[] = [
    { kind: 'user', seq: 1, turnId: 'turn-int-1', text: 'question' },
    {
      kind: 'assistant', seq: 2, turnId: 'turn-int-1', text: 'interrupted partial text',
      reasoning: 'thought line 1\nstopped thinking here',
      interrupted: true, startedAt: 1_000, endedAt: 4_200,
    },
  ];
  const withDurHtml = renderToStaticMarkup(<ZCodeConversation rows={withDurationRows} />);
  assert.match(withDurHtml, /data-state="interrupted"/);
  assert.match(withDurHtml, /思考了 3 秒/);
  assert.match(withDurHtml, /stopped thinking here/);

  // Without duration (e.g., immediate stop before timing measured)
  const withoutDurationRows: TimelineRow[] = [
    { kind: 'user', seq: 1, turnId: 'turn-int-2', text: 'question' },
    {
      kind: 'assistant', seq: 2, turnId: 'turn-int-2', text: 'aborted',
      reasoning: 'immediate stop',
      interrupted: true,
    },
  ];
  const withoutDurHtml = renderToStaticMarkup(<ZCodeConversation rows={withoutDurationRows} />);
  assert.match(withoutDurHtml, /data-state="interrupted"/);
  assert.match(withoutDurHtml, /思考已停止/);
  assert.match(withoutDurHtml, /immediate stop/);
});

test('a restored interrupted answer stays in its stopped work segment after a later turn', () => {
  const restored: TimelineRow[] = [
    { kind: 'user', seq: 1, turnId: 'turn-1', text: 'first question' },
    { kind: 'assistant', seq: 2, turnId: 'turn-1', streamId: 'd'.repeat(32),
      text: 'partial answer from the stopped run', interrupted: true },
    { kind: 'user', seq: 3, turnId: 'turn-2', text: 'follow-up question' },
    { kind: 'assistant', seq: 4, turnId: 'turn-2', text: 'completed follow-up answer' },
  ];
  const html = renderToStaticMarkup(<ZCodeConversation rows={restored} />);
  assert.match(html, /已停止/);
  assert.match(html, /partial answer from the stopped run/);
  const finalAt = html.indexOf('class="xn-zc-final"');
  assert.ok(finalAt >= 0);
  assert.doesNotMatch(html.slice(finalAt), /partial answer from the stopped run/);
  assert.match(html.slice(finalAt), /completed follow-up answer/);
});

test('reasoning rows are gated by effectivePluginIds when provided', () => {
  const rowsWithReasoning: TimelineRow[] = [
    { kind: 'user', seq: 1, turnId: 'turn-gate', text: 'prompt' },
    {
      kind: 'assistant', seq: 2, turnId: 'turn-gate', text: 'final answer',
      reasoning: 'internal thought to be hidden',
    },
  ];

  // Sessions enabled: reasoning renders
  const enabledHtml = renderToStaticMarkup(
    <ZCodeConversation rows={rowsWithReasoning} effectivePluginIds={new Set(['sessions'])} />,
  );
  assert.match(enabledHtml, /class="xn-zc-reasoning"/);
  assert.match(enabledHtml, /internal thought to be hidden/);

  // Sessions disabled: reasoning hidden
  const disabledHtml = renderToStaticMarkup(
    <ZCodeConversation rows={rowsWithReasoning} effectivePluginIds={new Set(['files'])} />,
  );
  assert.doesNotMatch(disabledHtml, /class="xn-zc-reasoning"/);
  assert.doesNotMatch(disabledHtml, /internal thought to be hidden/);
  assert.match(disabledHtml, /final answer/);
});

test('multi-segment reasoning across work rows retains distinct collapsible cards and summaries', () => {
  const multiSegmentRows: TimelineRow[] = [
    { kind: 'user', seq: 1, turnId: 'turn-multi', text: 'multi-step task' },
    {
      kind: 'assistant', seq: 2, turnId: 'turn-multi', text: '',
      reasoning: 'Step 1: finding candidates', startedAt: 1000, endedAt: 2500,
    },
    {
      kind: 'tool', seq: 3, turnId: 'turn-multi', toolCallId: 'find-1', name: 'read',
      subject: 'src/config.ts', status: 'ok', error: '', errorCode: '',
    },
    {
      kind: 'assistant', seq: 4, turnId: 'turn-multi', text: '',
      reasoning: 'Step 2: evaluating options', startedAt: 3000, endedAt: 5100,
    },
    {
      kind: 'tool', seq: 5, turnId: 'turn-multi', toolCallId: 'edit-1', name: 'edit',
      subject: 'src/config.ts', status: 'ok', error: '', errorCode: '',
    },
    {
      kind: 'assistant', seq: 6, turnId: 'turn-multi', text: 'All changes done.',
      reasoning: 'Step 3: preparing final summary', startedAt: 6000, endedAt: 7500,
    },
    {
      kind: 'completion', seq: 7, turnId: 'turn-multi', verified: true,
      status: 'verified', summary: 'All changes done.',
    },
  ];

  const html = renderToStaticMarkup(<ZCodeConversation rows={multiSegmentRows} streamingPending collapseTools={false} />);
  // All three reasoning segments must be rendered with their separate testids and summaries
  assert.match(html, /data-testid="timeline-item-reasoning-2"/);
  assert.match(html, /data-testid="timeline-item-reasoning-4"/);
  assert.match(html, /data-testid="timeline-item-reasoning-6"/);
  assert.match(html, /Step 1: finding candidates/);
  assert.match(html, /Step 2: evaluating options/);
  assert.match(html, /Step 3: preparing final summary/);
});

test('interrupted reasoning after tool is preserved and earlier narration is not treated as final', () => {
  const rows: TimelineRow[] = [
    { kind: 'user', seq: 1, turnId: 'turn-int-work', text: 'run task' },
    {
      kind: 'assistant', seq: 2, turnId: 'turn-int-work', text: 'Starting step 1',
      reasoning: 'Plan for step 1', startedAt: 1000, endedAt: 2000,
    },
    {
      kind: 'tool', seq: 3, turnId: 'turn-int-work', toolCallId: 'call-1', name: 'read',
      subject: 'file.txt', status: 'ok', error: '', errorCode: '',
    },
    {
      kind: 'assistant', seq: 4, turnId: 'turn-int-work', text: '',
      reasoning: 'Interrupted while analyzing file.txt',
      interrupted: true, startedAt: 3000, endedAt: 4500,
    },
  ];

  const html = renderToStaticMarkup(<ZCodeConversation rows={rows} collapseTools={false} />);
  // The interrupted reasoning must be rendered with data-state="interrupted" and its text
  assert.match(html, /data-testid="timeline-item-reasoning-4"/);
  assert.match(html, /data-state="interrupted"/);
  assert.match(html, /Interrupted while analyzing file\.txt/);
  // Earlier step 1 narration must NOT be rendered in xn-zc-final
  assert.doesNotMatch(html, /class="xn-zc-final"/);
});


test('work footer reports wall elapsed time and rejects reversed or missing boundary timestamps', () => {
  const assistant = (seq: number, startedAt?: number, endedAt?: number): TimelineRow => ({kind:'assistant',seq,turnId:'elapsed-turn',text:`part ${seq}`,startedAt,endedAt});
  const render = (rows: TimelineRow[]) => renderToStaticMarkup(<ZCodeConversation rows={rows} />);
  assert.match(render([assistant(1,1000,2000),assistant(2,3000,5000)]), /经过 4 秒/);
  assert.doesNotMatch(render([assistant(1,6000,7000),assistant(2,3000,5000)]), /经过|Worked for/);
  assert.doesNotMatch(render([assistant(1,1000,2000),assistant(2,3000)]), /经过|Worked for/);
  assert.doesNotMatch(render([assistant(1,undefined,2000),assistant(2,3000,5000)]), /经过|Worked for/);
});

test('authoritative work facts render active time, distinct segments and gated fallback without tool changes', () => {
  const rows: TimelineRow[] = [{kind:'user', seq:0, turnId:'turn-1', text:'task'},
    {kind:'tool', seq:1, turnId:'turn-1', toolCallId:'c', name:'list', subject:'.', status:'ok', error:'', errorCode:''}];
  const workActivity = [{id:'a',turn_id:'turn-1',state:'continued',active_ms:2000},
    {id:'b',turn_id:'turn-1',state:'stopped',active_ms:3000}];
  const html = renderToStaticMarkup(<ZCodeConversation rows={rows} workActivity={workActivity} effectivePluginIds={new Set(['sessions'])} />);
  assert.match(html, /已停止/);
  assert.match(html, /活跃 5 秒/);
  assert.match(html, /2.*段工作/);
  const disabled = renderToStaticMarkup(<ZCodeConversation rows={rows} workActivity={workActivity} effectivePluginIds={new Set()} />);
  assert.doesNotMatch(disabled, /活跃|段工作/);
  const unknown = renderToStaticMarkup(<ZCodeConversation rows={rows} workActivity={[{...workActivity[0],state:'unknown',active_ms:null}]} effectivePluginIds={new Set(['sessions'])} />);
  assert.match(unknown, /工作状态未知/);
  assert.doesNotMatch(unknown, /活跃|经过/);
});
