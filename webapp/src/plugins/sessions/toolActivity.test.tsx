import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { toolActivityRows, TOOL_INPUT_PREVIEW_LIMIT } from './toolActivity';
import { ZCodeConversation } from './ZCodeConversation';
import type { TimelineRow } from '../../xuenessWorkbench';
const rows: TimelineRow[] = [{kind:'user',seq:1,turnId:'t',text:'Read'}];
const fact = {id:'s:0',stream_id:'s',turn_id:'t',name:'read',phase:'input_streaming',input_chars:9,partial_input:'{"path":"',truncated:false};
const options = {running:true,currentTurnId:'t',currentStreamId:'s',effectivePluginIds:new Set(['sessions','files','shell'])};
const tool = (value: unknown, opts = options) => toolActivityRows(rows,value,opts).find(row=>row.kind==='tool');
test('partial JSON remains opaque, bounded input text with stable index identity',()=>{
  const first=tool([fact]); const late=tool([{...fact,call_id:'provider-1'}]);
  assert.equal(first?.toolCallId,late?.toolCallId);
  assert.equal(first?.input,undefined);
  assert.equal(first?.inputActivity?.partialInput,fact.partial_input);
  assert.equal(tool([{...fact,partial_input:'x'.repeat(5000)}])?.inputActivity?.partialInput.length,TOOL_INPUT_PREVIEW_LIMIT);
  assert.equal(tool([{...fact,partial_input:'x'.repeat(5000)}])?.inputActivity?.truncated,true);
});
test('repeated updates coalesce and final journal rows override projections',()=>{
  const identities=new Map<string,string>();
  const opts={...options,identities};
  assert.equal(toolActivityRows(rows,[fact,{...fact,input_chars:12}],opts).length,2);
  toolActivityRows(rows,[{...fact,call_id:'provider-1'}],opts);
  const final:TimelineRow={kind:'tool',seq:2,turnId:'t',toolCallId:'provider-1',name:'read',subject:'a',status:'ok',error:'',errorCode:''};
  const projected=toolActivityRows([...rows,final],[{...fact,call_id:'provider-1'}],opts);
  assert.equal(projected.length,2);
  assert.equal(projected[1].kind==='tool'&&projected[1].toolActivityId,'s:0');
  const completed=toolActivityRows([...rows,final],undefined,{...opts,running:false});
  assert.equal(completed[1].kind==='tool'&&completed[1].toolActivityId,'s:0');
});
test('stopped, stale generation, stale turn, disabled sessions and malformed facts disappear',()=>{
  assert.equal(tool([fact],{...options,running:false}),undefined);
  assert.equal(tool([{...fact,stream_id:'old',id:'old:0'}]),undefined);
  assert.equal(tool([{...fact,turn_id:'old'}]),undefined);
  assert.equal(tool([fact],{...options,effectivePluginIds:new Set(['files'])}),undefined);
  assert.equal(tool([{...fact,input_chars:NaN}]),undefined);
});
test('private, unknown, and dependency-disabled tools never project raw input',()=>{
  for(const name of ['task','browser_fill','workflow_run','unknown','write','read_fake']) {
    assert.equal(tool([{...fact,name,partial_input:'SECRET'}])?.inputActivity?.partialInput,'');
  }
  assert.equal(tool([fact],{...options,effectivePluginIds:new Set(['sessions'])})?.inputActivity?.partialInput,'');
});
test('real input phase renders with count and bounded text, no fabricated percentage',()=>{
  const html=renderToStaticMarkup(<ZCodeConversation rows={rows} toolActivity={[fact]} streamingPending collapseTools={false} {...options}/>);
  assert.match(html,/data-tool-phase="input_streaming"/);
  assert.match(html,/9/);
  assert.match(html,/&quot;path&quot;/);
  assert.doesNotMatch(html,/\d+%/);
  const privateHtml=renderToStaticMarkup(<ZCodeConversation rows={rows} toolActivity={[{...fact,name:'task',partial_input:'SECRET'}]} streamingPending collapseTools={false} {...options}/>);
  assert.doesNotMatch(privateHtml,/SECRET/);
});
