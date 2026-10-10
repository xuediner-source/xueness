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
  const html=renderToStaticMarkup(<ZCodeConversation rows={rows} onFork={()=>{}} onEdit={async()=>true} onFeedback={async()=>{}} />);
  assert.match(html,/aria-label="编辑消息"/);
  assert.match(html,/aria-label="有帮助"[^>]*aria-pressed="true"/);
  assert.match(html,/aria-label="分叉会话"/);
  assert.doesNotMatch(html,/重试运行/);
  const readonly=renderToStaticMarkup(<ZCodeConversation rows={rows} />);
  assert.doesNotMatch(readonly,/aria-label="编辑消息"|aria-label="有帮助"|aria-label="分叉会话"/);
});
test('reasoning preferences and unsafe Markdown remain respected', () => {
  const html=renderToStaticMarkup(<ZCodeConversation rows={rows} showReasoning={false} />);
  assert.doesNotMatch(html,/检查范围/);
  const unsafe=renderToStaticMarkup(<ZCodeConversation rows={[{kind:'assistant',seq:1,turnId:'t',text:'[click](javascript:alert(1)) <script>bad</script>'}]} />);
  assert.doesNotMatch(unsafe,/href="javascript:|<script>/);
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

test('zcodeConversationDisclosures stores disclosure states across turns and re-renders', () => {
  const key = 'test:disclosure:key';
  try {
    assert.equal(zcodeConversationDisclosures.get(key), undefined);
    zcodeConversationDisclosures.set(key, true);
    assert.equal(zcodeConversationDisclosures.get(key), true);
    zcodeConversationDisclosures.set(key, false);
    assert.equal(zcodeConversationDisclosures.get(key), false);
  } finally {
    zcodeConversationDisclosures.delete(key);
  }
});
