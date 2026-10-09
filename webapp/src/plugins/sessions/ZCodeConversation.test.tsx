import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { ZCodeConversation, buildConversationTurns } from './ZCodeConversation';
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
