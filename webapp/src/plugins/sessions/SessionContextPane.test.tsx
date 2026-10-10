import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { sessionContextSources, SessionContextPane } from './SessionContextPane';
import type { TimelineRow, WorkbenchSession } from '../../xuenessWorkbench';

const tool = (patch: Partial<Extract<TimelineRow, {kind:'tool'}>>): TimelineRow => ({
  kind:'tool', seq:1, turnId:'turn', toolCallId:'tool', name:'web_search', subject:'search', status:'ok', error:'', errorCode:'', ...patch,
});
test('context sources use successful tool records and reject prose, failed calls and unsafe links', () => {
  const rows: TimelineRow[] = [
    {kind:'assistant',seq:0,turnId:'turn',text:'https://invented.example'},
    tool({status:'error',output:{url:'https://failed.example'}}),
    tool({output:{results:[{title:'官方设定',url:'https://example.com/lore'},{url:'javascript:alert(1)'},{url:'https://user:secret@example.com/'}]}}),
    tool({name:'web_fetch',input:{url:'https://example.com/lore'},output:{url:'https://example.com/lore'}}),
    tool({name:'read',input:{path:'docs/guide.md'}}),
  ];
  assert.deepEqual(sessionContextSources(rows),[
    {kind:'url',value:'https://example.com/lore',label:'官方设定'},
    {kind:'file',value:'docs/guide.md',label:'guide.md'},
  ]);
  assert.equal(sessionContextSources(rows,false).some(item=>item.kind==='file'),false);
});
test('context evidence traversal is bounded and tolerates cyclic tool output', () => {
  const cyclic: Record<string,unknown>={url:'https://example.com'};cyclic.self=cyclic;
  assert.equal(sessionContextSources([tool({output:cyclic})]).length,1);
  assert.ok(sessionContextSources([tool({output:Array.from({length:1000},(_,i)=>({url:`https://example.com/${i}`}))})]).length<=200);
});
test('context pane escapes source names and omits file controls when files plugin is disabled', () => {
  const session={id:'id',changed_files:['result.md']} as WorkbenchSession;
  const html=renderToStaticMarkup(<SessionContextPane session={session} rows={[tool({output:{url:'https://example.com',title:'<script>alert(1)</script>'}})]}
    filesEnabled={false} onOpenFile={()=>undefined} onClose={()=>undefined} />);
  assert.doesNotMatch(html,/<script>/u);
  assert.match(html,/&lt;script&gt;/u);
  assert.doesNotMatch(html,/result\.md/u);
  assert.match(html,/noreferrer/u);
});
