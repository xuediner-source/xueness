import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { conversationMarkers, ConversationMarkers } from './conversationMarkers';
import type { TimelineRow } from '../../xuenessWorkbench';
const rows: TimelineRow[] = [{kind:'user',seq:1,turnId:'turn-1',text:'hello',messageId:'msg:1'}, {kind:'assistant',seq:2,turnId:'turn-1',text:'done',messageId:'msg:2'}];
const fork = {id:'fact:fork',kind:'fork',message_id:'msg:2',placement:'work_tail'};
const context = {id:'fact:context',kind:'context',message_id:'msg:1',placement:'before_user',label:'report.txt',context_kind:'files'};
test('automatic model input formats do not create a chip on every new conversation', () => {
  const facts = ['image', 'pdf', 'video', 'office.pdf_authoring'].map((label, index) => ({ ...context, id: `fact:cap:${index}`, context_kind: 'capabilities', label }));
  assert.deepEqual(conversationMarkers(facts, rows, 'before_user', true).map(item => item.label), ['office.pdf_authoring']);
});
test('replay and pagination retain identity without duplicate or misplaced markers', () => {
  assert.equal(conversationMarkers([fork,fork],rows,'work_tail',true).length,1);
  assert.deepEqual(conversationMarkers([fork],rows.slice(0,1),'work_tail',true),[]);
  assert.deepEqual(conversationMarkers([fork],rows,'before_user',true),[]);
  assert.deepEqual(conversationMarkers([context],rows,'work_tail',true),[]);
});
test('disabled sessions have no fact UI or effects', () => {
  assert.equal(renderToStaticMarkup(<ConversationMarkers facts={[context]} rows={rows} placement="before_user" enabled={false} />),'');
});
test('context chips are plain sanitized text, not file fetch links', () => {
  const html = renderToStaticMarkup(<ConversationMarkers facts={[context]} rows={rows} placement="before_user" enabled />);
  assert.match(html,/report.txt/);
  assert.doesNotMatch(html,/href|src|button/);
  for (const label of ['https://private','/private/file','token\nsecret']) {
    assert.deepEqual(conversationMarkers([{...context,label}],rows,'before_user',true),[]);
  }
});
test('checkpoint marker states provenance without workspace restoration claim', () => {
  const html = renderToStaticMarkup(<ConversationMarkers facts={[{...fork,kind:'checkpoint_source'}]} rows={rows} placement="work_tail" enabled />);
  assert.match(html,/checkpoint|检查点/);
  assert.doesNotMatch(html,/restored|已恢复/);
});
test('malformed model facts and unknown legacy metadata are omitted', () => {
  assert.deepEqual(conversationMarkers([{...fork,kind:'model',label:'new'}, {...fork,kind:'retry'}, {...context,message_id:[]}],rows,'work_tail',true),[]);
});
