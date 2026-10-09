import test from 'node:test';
import assert from 'node:assert/strict';
import {loadConversationSnapshot, updateConversationMessage} from '../../xuenessWorkbench';
import {XUENESS_EVENT_SCHEMA, XUENESS_EVENTS_SCHEMA, XUENESS_PROTOCOL_VERSION} from '../../xuenessEvents';

const id='a'.repeat(32), revision=`sha256:${'b'.repeat(64)}`;
function snapshot() {
  return {session:{id,status:'completed',queued_messages:[]},journal:{id,status:'completed',messages:[],message_revision:revision},
    timeline:{schema:XUENESS_EVENTS_SCHEMA,protocolVersion:XUENESS_PROTOCOL_VERSION,sessionId:id,status:'completed',mode:'build',steps:1,
      cursor:0,nextCursor:1,head:1,hasMore:false,events:[{schema:XUENESS_EVENT_SCHEMA,seq:1,sessionId:id,type:'session.status',status:'completed',mode:'build',steps:1}]}};
}
test('one snapshot owns all row, state and revision values', async () => {
  const previous=globalThis.fetch; const calls:string[]=[];
  globalThis.fetch=async(url)=>{calls.push(String(url));return new Response(JSON.stringify(snapshot()),{status:200});};
  try {
    const result=await loadConversationSnapshot(id);
    assert.equal(result.ok,true);
    if(result.ok)assert.equal(result.value.journal.message_revision,revision);
    assert.deepEqual(calls,[`/api/sessions/${id}/conversation`]);
  } finally {globalThis.fetch=previous;}
});
test('mixed sessions, incomplete pages, sequence gaps and status races fail closed', async () => {
  const previous=globalThis.fetch;
  for(const change of [
    (value:ReturnType<typeof snapshot>)=>value.session.id='c'.repeat(32),
    (value:ReturnType<typeof snapshot>)=>value.timeline.events[0].seq=2,
    (value:ReturnType<typeof snapshot>)=>value.timeline.hasMore=true,
    (value:ReturnType<typeof snapshot>)=>value.journal.status='running',
    (value:ReturnType<typeof snapshot>)=>value.journal.message_revision='invalid',
  ]) {
    const value=snapshot();change(value);
    globalThis.fetch=async()=>new Response(JSON.stringify(value),{status:200});
    try {assert.equal((await loadConversationSnapshot(id)).ok,false);} finally {globalThis.fetch=previous;}
  }
});
test('history mutation sends persisted message identity and a fresh CSRF token', async () => {
  const previous=globalThis.fetch; const calls:{url:string;init?:RequestInit}[]=[];
  globalThis.fetch=async(url,init)=>{calls.push({url:String(url),init});return new Response(JSON.stringify(String(url)==='/api/csrf'?{csrfToken:'fresh-token'}:{}),{status:200});};
  try {
    const result=await updateConversationMessage(id,{kind:'user',seq:999,turnId:'turn-2',text:'old',messageIndex:3,messageRevision:revision},{action:'edit',text:'new'});
    assert.equal(result.ok,true);
    assert.equal(calls.length,2);
    assert.equal(calls[1].init?.method,'PATCH');
    assert.deepEqual(JSON.parse(String(calls[1].init?.body)),{revision,messageIndex:3,action:'edit',text:'new'});
    assert.equal((calls[1].init?.headers as Record<string,string>)['X-CSRF-Token'],'fresh-token');
  } finally {globalThis.fetch=previous;}
});
test('a display-only row never gains edit or feedback authority', async () => {
  assert.equal((await updateConversationMessage(id,{kind:'assistant',seq:1,turnId:'t',text:'streaming'},{action:'feedback',feedback:'like'})).ok,false);
});
