import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationWorkSegments as project, conversationActiveDuration as duration, conversationWorkLabel as label } from './conversationWorkSegments';

test('stable turn identity prevents pagination and previous-turn mixing', () => {
  const facts = [{id:'a',turn_id:'turn-1',state:'completed',active_ms:5000}, {id:'b',turn_id:'turn-2',state:'completed',active_ms:2000}];
  assert.equal(duration(project(facts,'turn-2')),2000);
  assert.deepEqual(project(facts,undefined),[]);
  assert.deepEqual(project(JSON.parse(JSON.stringify(facts)),'turn-2'),project(facts,'turn-2'));
});
test('authoritative segments sum active intervals including tool-only work, without waits', () => {
  const rows = project([{id:'a',turn_id:'t',state:'waiting_approval',active_ms:2000},
    {id:'b',turn_id:'t',state:'continued',active_ms:3000},
    {id:'c',turn_id:'t',state:'completed',active_ms:1000}], 't');
  assert.equal(duration(rows),6000);
  assert.equal(label(rows,'en','6s'),'Completed · Active 6s');
});
test('open, crash, invalid, zero and missing durations never become 1s', () => {
  for (const state of ['running','unknown','completed']) {
    for (const active_ms of [null, undefined, 0, -1, NaN, Infinity]) {
      const rows = project([{id:'a',turn_id:'t',state,active_ms}], 't');
      assert.equal(duration(rows),undefined);
      assert.doesNotMatch(label(rows,'en',null)!, /Active|1s/);
    }
  }
});
test('states are facts, no successful prose override or prior tool-error guess', () => {
  for (const [state, expected] of [['stopped','Stopped'],['failed','Failed'],['waiting_user','Waiting for your answer'],['waiting_approval','Waiting for approval']]) {
    assert.equal(label(project([{id:'a',turn_id:'t',state,active_ms:1000}],'t'),'en',null),expected);
  }
});
test('projection bounds metadata and rejects duplicate segments', () => {
  const row = {id:'a',turn_id:'t',state:'completed',active_ms:1000};
  assert.equal(project([row,row],'t').length,1);
  assert.equal(project(Array.from({length:300},(_,i)=>({...row,id:String(i)})),'t').length,256);
});
test('bounded history with missing earlier segments cannot claim a complete active total', () => {
  assert.equal(duration(project([{id:'a',turn_id:'t',state:'completed',active_ms:2000,prefix_missing:true}], 't')),undefined);
});
