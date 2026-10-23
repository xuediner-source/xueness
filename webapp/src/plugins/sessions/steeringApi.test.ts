import test from 'node:test';
import assert from 'node:assert/strict';
import { guideCurrentTurn, reserveQueuedMessageNow, withdrawGuidance } from './steeringApi';

for (const action of ['guide', 'promote', 'cancel'] as const) {
  test(`${action} cannot write after its captured pane disables during CSRF`, async () => {
    const original = globalThis.fetch;
    let live = true, writes = 0;
    globalThis.fetch = async path => {
      if (String(path) === '/api/csrf') {
        live = false;
        return new Response(JSON.stringify({ csrfToken: 'test' }));
      }
      writes++;
      throw new Error('Unexpected mutation');
    };
    try {
      if (action === 'cancel') await assert.rejects(withdrawGuidance('session', 'item', () => live), /no longer enabled/);
      else {
        const result = action === 'guide'
          ? await guideCurrentTurn('lost-session', 'turn', 'text', undefined, () => live)
          : await reserveQueuedMessageNow('session', 'item', 'turn', 3, () => live);
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.outcomeUnknown, undefined);
      }
      assert.equal(writes, 0);
    } finally { globalThis.fetch = original; }
  });
}

test('a lost original guidance response stays unknown when invalidation blocks replay', async () => {
  const original = globalThis.fetch;
  let live = true, writes = 0, csrfReads = 0;
  globalThis.fetch = async path => {
    if (String(path) === '/api/csrf') {
      csrfReads++;
      return new Response(JSON.stringify({ csrfToken: 'test' }));
    }
    writes++; live = false;
    throw new TypeError('Response lost');
  };
  try {
    const result = await guideCurrentTurn('lost-session', 'turn', 'text', undefined, () => live);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.outcomeUnknown, true);
    assert.equal(writes, 1); assert.equal(csrfReads, 1);
  } finally { globalThis.fetch = original; }
});

test('disabled guidance does not even start CSRF or promotion requests', async () => {
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('Unexpected request'); };
  try {
    const result = await reserveQueuedMessageNow('session', 'item', 'turn', 3, () => false);
    assert.equal(result.ok, false);
    assert.equal(requests, 0);
  } finally { globalThis.fetch = original; }
});

test('an eligible replay retains its request identity and has only one deduplicated effect', async () => {
  const original = globalThis.fetch;
  const seen = new Set<string>(); const requests: string[] = [];
  globalThis.fetch = async (path, init) => {
    if (String(path) === '/api/csrf') return new Response(JSON.stringify({ csrfToken: 'test' }));
    const body = JSON.parse(String(init?.body));
    requests.push(body.request_id);
    if (!seen.has(body.request_id)) { seen.add(body.request_id); throw new TypeError('Accepted but response lost'); }
    return new Response(JSON.stringify({ id: 'item', item: { id: 'item', text: body.text,
      delivery: 'guide', targetTurnId: body.expected_turn_id, status: 'queued', position: 0 } }));
  };
  try {
    assert.equal((await guideCurrentTurn('session', 'turn', 'text', undefined, () => true)).ok, true);
    assert.equal(requests.length, 2); assert.equal(seen.size, 1); assert.equal(requests[0], requests[1]);
  } finally { globalThis.fetch = original; }
});

import { reconcileLocalGuidance, hasUnconfirmedLocalGuidance } from './steeringApi';
test('unknown guidance retains original body, blocks fresh mutations, and clears only matching queried receipt', async()=>{
  const original=globalThis.fetch;const sid='ledger-send';let body:any;let writes=0;let reads=0;let valid=false;
  globalThis.fetch=async(path,init)=>{
    if(String(path)==='/api/csrf')return new Response(JSON.stringify({csrfToken:'test'}));
    if(String(path).endsWith('/steer-query')){
      reads++;const query=JSON.parse(String(init?.body));assert.deepEqual(query,{operation:'send',payload:body});
      return new Response(JSON.stringify({requestId:body.request_id,result:'accepted',receipt:{id:'item',item:{id:'item',text:valid?body.text:'wrong',delivery:'guide',targetTurnId:body.expected_turn_id,status:'queued',position:0}}}));
    }
    writes++;body=JSON.parse(String(init?.body));throw new TypeError('lost');
  };
  try{
    const first=await guideCurrentTurn(sid,'turn','original','prepared');assert.equal(first.ok,false);assert.equal(hasUnconfirmedLocalGuidance(sid),true);
    const count=writes;await guideCurrentTurn(sid,'turn','new text');await reserveQueuedMessageNow(sid,'queue','turn');assert.equal(writes,count);
    assert.equal(await reconcileLocalGuidance(sid),false);assert.equal(hasUnconfirmedLocalGuidance(sid),true);
    valid=true;assert.equal(await reconcileLocalGuidance(sid),true);assert.equal(hasUnconfirmedLocalGuidance(sid),false);assert.equal(writes,2);assert.equal(reads,2);
  }finally{globalThis.fetch=original;}
});

test('unknown cancellation recovers only authoritative exact cancelled item proof',async()=>{
  const original=globalThis.fetch;const sid='ledger-cancel';let writes=0;let confirmed=false;
  globalThis.fetch=async(path,init)=>{
    if(String(path)==='/api/csrf')return new Response(JSON.stringify({csrfToken:'test'}));
    if(String(path).endsWith('/steer-query')){assert.deepEqual(JSON.parse(String(init?.body)),{operation:'cancel',guidanceId:'guide'});return new Response(JSON.stringify({requestId:'guide',result:confirmed?'accepted':'unknown',receipt:{id:'guide',removed:true}}));}
    writes++;throw new TypeError('lost');
  };
  try{
    await assert.rejects(withdrawGuidance(sid,'guide'));assert.equal(writes,1);
    assert.equal(await reconcileLocalGuidance(sid),false);confirmed=true;assert.equal(await reconcileLocalGuidance(sid),true);assert.equal(writes,1);
  }finally{globalThis.fetch=original;}
});

test('promotion recovery requires original reservation identity and never reserves again',async()=>{
  const original=globalThis.fetch;const sid='ledger-promote';let body:any;let writes=0;let matching=false;
  globalThis.fetch=async(path,init)=>{
    if(String(path)==='/api/csrf')return new Response(JSON.stringify({csrfToken:'test'}));
    if(String(path).endsWith('/steer-query')){assert.deepEqual(JSON.parse(String(init?.body)),{operation:'promote',payload:body,queueId:'queue'});return new Response(JSON.stringify({requestId:matching?body.request_id:'different',result:'released'}));}
    writes++;body=JSON.parse(String(init?.body));throw new TypeError('lost');
  };
  try{
    await reserveQueuedMessageNow(sid,'queue','turn',3);assert.equal(await reconcileLocalGuidance(sid),false);
    matching=true;assert.equal(await reconcileLocalGuidance(sid),true);assert.equal(writes,2);
  }finally{globalThis.fetch=original;}
});

test('reconciliation rechecks captured scope after CSRF without losing retained unknown',async()=>{
  const original=globalThis.fetch;const sid='ledger-reconcile-scope';let live=true;let invalidate=false;let queryWrites=0;
  globalThis.fetch=async(path)=>{
    if(String(path)==='/api/csrf'){if(invalidate)live=false;return new Response(JSON.stringify({csrfToken:'test'}));}
    if(String(path).endsWith('/steer-query'))queryWrites++;
    throw new TypeError('lost');
  };
  try{
    await guideCurrentTurn(sid,'turn','text',undefined,()=>live);invalidate=true;
    await assert.rejects(reconcileLocalGuidance(sid,()=>live),/no longer enabled/);
    assert.equal(queryWrites,0);assert.equal(hasUnconfirmedLocalGuidance(sid),true);
  }finally{globalThis.fetch=original;}
});

test('late original reconciliation cannot clear a newer unknown guidance operation',async()=>{
  const original=globalThis.fetch;const sid='ledger-concurrent';let body:any;
  const queries:((response:Response)=>void)[]=[];let ready!:()=>void;const bothReady=new Promise<void>(r=>{ready=r;});
  globalThis.fetch=async(path,init)=>{
    if(String(path)==='/api/csrf')return new Response(JSON.stringify({csrfToken:'test'}));
    if(String(path).endsWith('/steer-query'))return new Promise<Response>(resolve=>{queries.push(resolve);if(queries.length===2)ready();});
    body=JSON.parse(String(init?.body));throw new TypeError('lost');
  };
  try{
    await guideCurrentTurn(sid,'turn','original');const old=body;
    const first=reconcileLocalGuidance(sid),second=reconcileLocalGuidance(sid);await bothReady;
    const response=()=>new Response(JSON.stringify({requestId:old.request_id,result:'accepted',receipt:{id:'item',item:{id:'item',text:old.text,delivery:'guide',targetTurnId:old.expected_turn_id,status:'queued',position:0}}}));
    queries[0](response());assert.equal(await first,true);
    await guideCurrentTurn(sid,'turn','new');assert.notEqual(body.request_id,old.request_id);
    queries[1](response());assert.equal(await second,false);assert.equal(hasUnconfirmedLocalGuidance(sid),true);
  }finally{globalThis.fetch=original;}
});
