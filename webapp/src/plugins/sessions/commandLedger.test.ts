import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionCommandClient, CommandDeliveryUnconfirmedError } from './commandClient';
import { CommandReceiptLedger } from './commandLedger';
import type { FollowupProof } from './commandLedger';
const sid='a'.repeat(32), other='b'.repeat(32);
const unused=async()=>{throw new Error('No fallback');};

test('authoritative active-run proof admits one queue during a deferred run and retains the original receipt',async()=>{
  const storage=memory();const posts:string[]=[];let start!:()=>void,finishRun!:(value:unknown)=>void,finishQueue!:(value:unknown)=>void;
  const started=new Promise<void>(resolve=>{start=resolve;});let enabled=true,current=true;
  const proof:FollowupProof={sessionId:sid,runCommandId:'original-run',expectedTurnId:'observed-turn'};
  const client=new SessionCommandClient({receiptScope:'live-followup',receiptStorage:storage,isEffective:()=>enabled,
    post:async(_path,value)=>{const body=value as {commandId:string;type:string;payload:Record<string,unknown>};posts.push(body.type);
      if(body.type==='run'){start();return new Promise(resolve=>{finishRun=resolve;});}
      assert.equal(body.payload.expected_turn_id,'observed-turn');return new Promise(resolve=>{finishQueue=resolve;});},get:async()=>({result:'unknown'})});
  const run=client.submit(sid,'run',{},unused,'original-run');await started;
  await assert.rejects(client.submit(sid,'queue',{text:'wrong',expected_turn_id:'observed-turn'},unused,'wrong',{proof:{...proof,runCommandId:'different'},current:()=>true}),/pending or unconfirmed/);
  const queued=client.submit(sid,'queue',{text:'next',expected_turn_id:'observed-turn'},unused,'queue',{proof,current:()=>current});
  while(!finishQueue)await new Promise(resolve=>setTimeout(resolve,0));
  await assert.rejects(client.submit(sid,'queue',{text:'double',expected_turn_id:'observed-turn'},unused,'double',{proof,current:()=>true}),/pending or unconfirmed/);
  await assert.rejects(client.submit(sid,'send',{text:'replace'},unused,'send'),/pending or unconfirmed/);
  // A turn settling after admission cannot invalidate a successfully issued queue ACK.
  current=false;finishQueue({commandId:'queue',status:'accepted',result:{id:'q',item:{id:'q',text:'next',status:'queued',position:0}}});await queued;
  assert.deepEqual(client.pendingCommands(),[{sessionId:sid,commandId:'original-run',type:'run'}]);
  finishRun({commandId:'original-run',status:'accepted',result:{id:sid,status:'completed'}});await run;
  assert.deepEqual(posts,['run','queue']);assert.deepEqual(client.pendingCommands(),[]);client.dispose();
});

test('reload unknown run requires matching proof; hash-time rebind and disable never dispatch a follow-up',async()=>{
  const storage=memory();let writes=0;
  const ledger=new CommandReceiptLedger('reload-followup',storage);await ledger.admit(sid,'unknown-run','run',{});
  const proof={sessionId:sid,runCommandId:'unknown-run',expectedTurnId:'turn'};
  let current=true,enabled=true;
  const client=new SessionCommandClient({receiptScope:'reload-followup',receiptStorage:storage,isEffective:()=>enabled,
    post:async(_path,value)=>{writes++;const body=value as {commandId:string;payload:{text:string}};return {commandId:body.commandId,status:'accepted',result:{id:'q',item:{id:'q',text:body.payload.text,status:'queued',position:0}}};},get:async()=>({result:'unknown'})});
  assert.equal(await client.query(sid,'unknown-run'),'unknown');
  const rebind=client.submit(sid,'queue',{text:'retained',expected_turn_id:'turn'},unused,'not-sent',{proof,current:()=>current});current=false;
  await assert.rejects(rebind,/cancelled|current|unavailable/i);assert.equal(writes,0);
  current=true;const disabled=client.submit(sid,'queue',{text:'retained',expected_turn_id:'turn'},unused,'disabled',{proof,current:()=>current});enabled=false;
  await assert.rejects(disabled);assert.equal(writes,0);enabled=true;
  await client.submit(sid,'queue',{text:'new follow-up',expected_turn_id:'turn'},unused,'new-queue',{proof,current:()=>true});
  assert.equal(writes,1);assert.deepEqual(client.pendingCommands(),[{sessionId:sid,commandId:'unknown-run',type:'run'}]);
  client.dispose();
});
function memory(){const values=new Map<string,string>();return {values,getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{values.set(k,v);}};}

test('a waiting tool answer can settle during its original run without retiring that run receipt',async()=>{
  const storage=memory(),ledger=new CommandReceiptLedger('live-approval',storage);
  await ledger.admit(sid,'original-run','run',{});
  const client=new SessionCommandClient({receiptScope:'live-approval',receiptStorage:storage,isEffective:()=>true,
    post:async(_path,value)=>{const body=value as {commandId:string;payload:{kind:string;tool_call_id:string}};
      return {commandId:body.commandId,status:'accepted',result:{approved:body.payload,resumed:true}};},get:unused});
  const result=await client.submitApproval(sid,'approve',{kind:'write',tool_call_id:'waiting-write'},unused);
  assert.equal((result.result as {resumed:boolean}).resumed,true);
  assert.deepEqual(client.pendingCommands(),[{sessionId:sid,commandId:'original-run',type:'run'}]);
  await assert.rejects(client.submit(sid,'send',{text:'unrelated'},unused),/pending or unconfirmed/);
  await ledger.admit(sid,'unknown-answer','reject',{kind:'write',tool_call_id:'another-call'});
  await assert.rejects(ledger.admit(sid,'new-answer','approve',{kind:'write',tool_call_id:'third-call'}),/pending or unconfirmed/);
  client.dispose();
});

test('fresh client reload retains original send and query-only fence without storing prompt or token',async()=>{
  const storage=memory();let receipt:unknown='unknown';let posts=0;
  const make=(scope='backend-one')=>new SessionCommandClient({receiptScope:scope,receiptStorage:storage,isEffective:()=>true,allowDirectFallback:false,queryAttempts:1,
    post:async()=>{posts++;throw new TypeError('lost');},get:async()=>({result:receipt})});
  const first=make();await assert.rejects(first.submit(sid,'send',{text:'SECRET_PROMPT',prepared_token:'SECRET_TOKEN',attachments:[{data:'SECRET_MEDIA'}]},unused,'original'),CommandDeliveryUnconfirmedError);first.dispose();
  const next=make();assert.deepEqual(next.pendingCommands(),[{sessionId:sid,commandId:'original',type:'send'}]);
  assert.doesNotMatch([...storage.values.values()].join(''),/SECRET_/);
  await assert.rejects(next.submit(sid,'run',{},unused),/pending or unconfirmed/);assert.equal(posts,1);
  assert.deepEqual(make('other-backend').pendingCommands(),[]);
  receipt={commandId:'original',status:'accepted',result:{id:sid,status:'ready'}};
  await next.query(other,'original');assert.equal(next.pendingCommands().length,1);
  receipt={commandId:'original',status:'failed',result:{id:sid,status:'ready'}};
  await next.query(sid,'original');assert.equal(next.pendingCommands().length,1);
  receipt={commandId:'original',status:'accepted',result:{id:other,status:'ready'}};
  await next.query(sid,'original');assert.equal(next.pendingCommands().length,1);
  receipt={commandId:'original',status:'duplicate',originalStatus:'accepted',result:{id:sid,status:'ready'}};
  await next.query(sid,'original');assert.deepEqual(next.pendingCommands(),[]);assert.equal(posts,1);next.dispose();
});

test('receipt is persisted before POST and reload during flight cannot admit a second write',async()=>{
  const storage=memory();let started!:()=>void;const sent=new Promise<void>(resolve=>{started=resolve;});
  const first=new SessionCommandClient({receiptScope:'flight',receiptStorage:storage,isEffective:()=>true,allowDirectFallback:false,
    post:async()=>{assert.equal(new CommandReceiptLedger('flight',storage).pending()[0].commandId,'flight-id');started();return new Promise(()=>{});},get:async()=>({result:'unknown'})});
  const submitting=first.submit(sid,'run',{},unused,'flight-id');await sent;
  const next=new SessionCommandClient({receiptScope:'flight',receiptStorage:storage,isEffective:()=>true,allowDirectFallback:false,
    post:async()=>{throw new Error('Must not write');},get:async()=>({result:{commandId:'flight-id',status:'rejected'}})});
  await assert.rejects(next.submit(sid,'run',{},unused),/pending or unconfirmed/);
  first.dispose();await assert.rejects(submitting,CommandDeliveryUnconfirmedError);
  await next.query(sid,'flight-id');assert.deepEqual(next.pendingCommands(),[]);next.dispose();
});

test('accepted send then unknown run remains recoverable after composer admission has cleared',async()=>{
  const storage=memory();let posts=0;
  const options={receiptScope:'send-run',receiptStorage:storage,isEffective:()=>true,allowDirectFallback:false,queryAttempts:1,
    post:async(_path:string,body:unknown)=>{posts++;const b=body as {commandId:string;type:string};if(b.type==='run')throw new TypeError('lost');return {commandId:b.commandId,status:'accepted',result:{id:sid,status:'ready'}};},get:async()=>({result:'unknown'})};
  const first=new SessionCommandClient(options);await first.submit(sid,'send',{text:'hello'},unused,'send');
  await assert.rejects(first.submit(sid,'run',{},unused,'run'),CommandDeliveryUnconfirmedError);first.dispose();
  const next=new SessionCommandClient(options);assert.deepEqual(next.pendingCommands(),[{sessionId:sid,commandId:'run',type:'run'}]);
  await assert.rejects(next.submit(sid,'send',{text:'again'},unused),/pending or unconfirmed/);assert.equal(posts,2);next.dispose();
});

test('read-only recovery retires a stored terminal run failure and permits a later explicit message',async()=>{
  const storage=memory();let posts=0,queries=0;
  const first=new SessionCommandClient({receiptScope:'failed-run-recovery',receiptStorage:storage,isEffective:()=>true,
    allowDirectFallback:false,queryAttempts:1,post:async()=>{posts++;throw new TypeError('ACK lost');},
    get:async()=>{queries++;return {result:'unknown'};}});
  await assert.rejects(first.submit(sid,'run',{},unused,'failed-run'),CommandDeliveryUnconfirmedError);
  assert.deepEqual(first.pendingCommands(),[{sessionId:sid,commandId:'failed-run',type:'run'}]);
  first.dispose();

  const next=new SessionCommandClient({receiptScope:'failed-run-recovery',receiptStorage:storage,isEffective:()=>true,
    allowDirectFallback:false,post:async(_path,body)=>{posts++;const b=body as {commandId:string};return {commandId:b.commandId,status:'accepted',result:{id:sid,status:'ready'}};},
    get:async()=>{queries++;return {result:{commandId:'failed-run',status:'failed',reasonCode:'provider_rate_limited',message:'Rate limit reached',result:{error:'provider_error'}}};}});
  const ack=await next.query(sid,'failed-run');
  assert.equal(ack!=='unknown'&&ack.status,'failed');
  assert.deepEqual(next.pendingCommands(),[],'the exact terminal run receipt is retired locally');
  assert.equal(posts,1,'recovery queried the original ID and did not repeat its write');
  assert.equal(queries,2);
  assert.deepEqual(await next.submit(sid,'send',{text:'new message'},unused,'new-send'),{id:sid,status:'ready'});
  assert.equal(posts,2,'a later explicit message can enter the same session');
  next.dispose();
});

test('queue hash and approval/edit descriptors validate hydrated original intent without payload bytes',async()=>{
  for(const [type,payload,wrong,right] of [
    ['queue',{text:'PRIVATE_QUEUE',prepared_token:'PRIVATE_TOKEN'},{id:'q',item:{id:'q',text:'wrong',status:'queued',position:0}},{id:'q',item:{id:'q',text:'PRIVATE_QUEUE',status:'queued',position:0}}],
    ['approve',{tool_call_id:'tool',kind:'exec',subject:'PRIVATE_SUBJECT'},{rejected:{tool_call_id:'tool',kind:'exec'}},{approved:{tool_call_id:'tool',kind:'exec'}}],
    ['edit_message',{messageIndex:3,text:'PRIVATE_EDIT',revision:'old'},{id:sid,messageIndex:4,action:'edit',revision:`sha256:${'f'.repeat(64)}`},{id:sid,messageIndex:3,action:'edit',revision:`sha256:${'f'.repeat(64)}`}],
  ] as const){
    const storage=memory();let receipt:unknown='unknown';
    const make=()=>new SessionCommandClient({receiptScope:type,receiptStorage:storage,isEffective:()=>true,allowDirectFallback:false,queryAttempts:1,
      post:async()=>{throw new TypeError('lost');},get:async()=>({result:receipt})});
    const first=make();await assert.rejects(first.submit(sid,type,payload,unused,'original'),CommandDeliveryUnconfirmedError);first.dispose();
    assert.doesNotMatch([...storage.values.values()].join(''),/PRIVATE_/);
    const next=make();receipt={commandId:'original',status:'accepted',result:wrong};await next.query(sid,'original');assert.equal(next.pendingCommands().length,1);
    receipt={commandId:'original',status:'accepted',result:right};await next.query(sid,'original');assert.deepEqual(next.pendingCommands(),[]);next.dispose();
  }
});

test('corrupt, unavailable, silently dropped or quota-failed storage prevents POST with a recoverable error',async()=>{
  for(const storage of [
    {getItem:()=>'{bad',setItem:()=>{}},
    {getItem:()=>{throw new Error('blocked');},setItem:()=>{}},
    {getItem:()=>null,setItem:()=>{throw new Error('quota');}},
    {getItem:()=>null,setItem:()=>{}},
    {getItem:()=>JSON.stringify({version:1,entries:[{sessionId:sid,commandId:'x',type:'run',descriptor:{text:'must not trust'}}]}),setItem:()=>{}},
  ]){
    let posts=0;const client=new SessionCommandClient({receiptScope:'invalid',receiptStorage:storage,isEffective:()=>true,
      post:async()=>{posts++;return{};},get:async()=>({result:'unknown'})});
    await assert.rejects(client.submit(sid,'run',{},unused),/storage is unavailable or invalid/);assert.equal(posts,0);client.dispose();
  }
});

test('other sessions remain writable, safe stop is allowed, and not-sent proof removes only its own entry',async()=>{
  const storage=memory();const ledger=new CommandReceiptLedger('scope',storage);await ledger.admit(sid,'unknown','run',{});
  const client=new SessionCommandClient({receiptScope:'scope',receiptStorage:storage,isEffective:()=>true,
    post:async(_path,body)=>{const b=body as {commandId:string;type:string};if(b.type==='send')throw Object.assign(new Error('preflight'),{requestNotSent:true});return{commandId:b.commandId,status:'accepted',result:b.type==='stop'?{stopping:true}:{id:other,status:'ready'}};},get:async()=>({result:'unknown'})});
  await client.submit(sid,'stop',{expected_turn_id:'turn'},unused,'stop');await client.submit(other,'run',{},unused,'other-run');
  await assert.rejects(client.submit(other,'send',{text:'x'},unused,'unsent'),/preflight/);
  assert.deepEqual(client.pendingCommands(),[{sessionId:sid,commandId:'unknown',type:'run'}]);client.dispose();
});

test('disabled command transport never falls back around a hydrated unresolved command',async()=>{
  const storage=memory();await new CommandReceiptLedger('disabled',storage).admit(sid,'original','send',{});
  let direct=0,posts=0;
  const client=new SessionCommandClient({receiptScope:'disabled',receiptStorage:storage,isEffective:()=>false,
    post:async()=>{posts++;return{};},get:async()=>({result:'unknown'})});
  await assert.rejects(client.submit(sid,'send',{text:'retry'},async()=>{direct++;return{};}),/original command is unconfirmed/);
  assert.equal(direct,0);assert.equal(posts,0);assert.equal(client.pendingCommands()[0].commandId,'original');client.dispose();
});

test('capacity refuses before transport and never evicts an unresolved command',async()=>{
  const storage=memory();const ledger=new CommandReceiptLedger('capacity',storage);
  for(let i=0;i<128;i++)await ledger.admit(`session-${i}`,`original-${i}`,'run',{});
  let posts=0;const client=new SessionCommandClient({receiptScope:'capacity',receiptStorage:storage,isEffective:()=>true,
    post:async()=>{posts++;return{};},get:async()=>({result:'unknown'})});
  await assert.rejects(client.submit('new-session','run',{},unused),/storage is full/);
  assert.equal(posts,0);assert.equal(client.pendingCommands().length,128);assert.equal(client.pendingCommands()[0].commandId,'original-0');client.dispose();
});

test('exact unexpired withdrawal escrow clears a reloaded durable fence while mismatched proofs cannot',async()=>{
  const storage=memory();const ledger=new CommandReceiptLedger('withdrawal',storage);
  await ledger.admit(sid,'withdrawal-id','withdraw_queue',{queueId:'q',expectedText:'PRIVATE_WITHDRAWAL',expectedRevision:4});
  assert.doesNotMatch([...storage.values.values()].join(''),/PRIVATE_WITHDRAWAL/);
  const client=new SessionCommandClient({receiptScope:'withdrawal',receiptStorage:storage,isEffective:()=>true,
    post:async()=>{throw new Error('No POST');},get:async()=>({result:'unknown'})});
  const proof={id:'withdrawal-id',sessionId:sid,root:'/workspace',queueId:'q',text:'PRIVATE_WITHDRAWAL',expectedRevision:4,hasContext:false,createdAt:Date.now()-1000,expiresAt:Date.now()+60000};
  for(const wrong of [{...proof,text:'different'},{...proof,expectedRevision:5},{...proof,queueId:'other'},
    {...proof,root:'/other'},{...proof,sessionId:other},{...proof,expiresAt:Date.now()-1}]){
    assert.equal(await client.confirmQueueWithdrawalAsync(sid,'/workspace',wrong),false);assert.equal(client.pendingCommands().length,1);
  }
  assert.equal(await client.confirmQueueWithdrawalAsync(sid,'/workspace',proof),true);assert.deepEqual(client.pendingCommands(),[]);client.dispose();
});

test('turn-fenced safety stop survives corrupt or full storage without dropping unknown commands',async()=>{
  for(const mode of ['corrupt','full']){
    const storage=memory();
    if(mode==='corrupt')storage.setItem('xueness.command-receipts.v1:safety','{invalid');
    else{const ledger=new CommandReceiptLedger('safety',storage);for(let i=0;i<128;i++)await ledger.admit(`session-${i}`,`id-${i}`,'run',{});}
    const before=[...storage.values.values()];let posts=0;
    const client=new SessionCommandClient({receiptScope:'safety',receiptStorage:storage,isEffective:()=>true,
      post:async(_path,body)=>{posts++;const b=body as {commandId:string;type:string;payload:{expected_turn_id:string}};
        assert.equal(b.type,'stop');assert.equal(b.payload.expected_turn_id,'expected-turn');return{commandId:b.commandId,status:'accepted',result:{stopping:true}};},get:async()=>({result:'unknown'})});
    await client.submit(sid,'stop',{expected_turn_id:'expected-turn'},unused);
    assert.equal(posts,1);assert.deepEqual([...storage.values.values()],before);
    await assert.rejects(client.submit(sid,'run',{},unused),/storage/);
    await assert.rejects(client.submit(sid,'stop',{},unused),/storage/);
    await assert.rejects(client.submit(sid,'stop',{expected_turn_id:'   '},unused),/storage/);
    await assert.rejects(client.submit(sid,'stop',{expected_turn_id:'x'.repeat(129)},unused),/storage/);
    assert.equal(posts,1);client.dispose();
  }
});

test('failed durable removal keeps a known accepted result confirmed while retaining its recovery fence',async()=>{
  const backing=memory();let writes=0,posts=0;
  const storage={getItem:backing.getItem,setItem:(key:string,value:string)=>{writes++;if(writes===2)throw new Error('transient quota');backing.setItem(key,value);}};
  const client=new SessionCommandClient({receiptScope:'retirement',receiptStorage:storage,isEffective:()=>true,
    post:async(_path,body)=>{posts++;return{commandId:(body as {commandId:string}).commandId,status:'accepted',result:{id:sid,status:'ready'}};},
    get:async()=>({result:{commandId:'original',status:'accepted',result:{id:sid,status:'ready'}}})});
  await client.submit(sid,'send',{text:'x'},unused,'original');
  assert.match(client.recoveryStorageWarning()??'',/result is confirmed/);
  assert.equal(client.recoveryStorageError(),null);
  assert.equal(client.pendingCommands()[0].commandId,'original');assert.equal(writes,2);
  await assert.rejects(client.submit(sid,'send',{text:'x'},unused),/pending or unconfirmed/);assert.equal(posts,1);
  await client.query(sid,'original');assert.deepEqual(client.pendingCommands(),[]);client.dispose();
});

test('cancel or timeout during queue hashing cannot leave an unsent durable receipt behind',async()=>{
  const original=crypto.subtle.digest.bind(crypto.subtle);
  for(const mode of ['cancel','timeout']){
    let release!:()=>void;let started!:()=>void;
    const hashing=new Promise<void>(resolve=>{started=resolve;});
    const gate=new Promise<void>(resolve=>{release=resolve;});
    Object.defineProperty(crypto.subtle,'digest',{configurable:true,value:async(...args:Parameters<SubtleCrypto['digest']>)=>{started();await gate;return original(...args);}});
    const storage=memory();let posts=0;
    const options={receiptScope:`hash-${mode}`,receiptStorage:storage,isEffective:()=>true,timeoutMs:10,
      post:async(_path:string,body:unknown)=>{posts++;return{commandId:(body as {commandId:string}).commandId,status:'accepted',result:{id:sid,status:'ready'}};},get:async()=>({result:'unknown'})};
    const client=new SessionCommandClient(options);
    try{
      const pending=client.submit(sid,'queue',{text:'hash me'},unused,'unsent');
      const rejected=assert.rejects(pending,CommandDeliveryUnconfirmedError);
      await hashing;if(mode==='cancel')client.cancelPending();
      await rejected;assert.equal(posts,0);release();
      await new Promise(resolve=>setTimeout(resolve,20));
      assert.equal(posts,0);assert.deepEqual(client.pendingCommands(),[]);
      const reloaded=new SessionCommandClient(options);await reloaded.submit(sid,'run',{},unused,'fresh');
      assert.equal(posts,1);reloaded.dispose();
    }finally{release();Object.defineProperty(crypto.subtle,'digest',{configurable:true,value:original});client.dispose();}
  }
});

test('committed receipt with failed admission read-back retires only its own proven-unsent identity',async()=>{
  for(const persistent of [false,true]){
    const backing=memory();await new CommandReceiptLedger('readback',backing).admit(other,'other-original','run',{});
    let verify=false,broken=false,posts=0;
    const storage={getItem:(key:string)=>{if(verify||broken){verify=false;if(persistent)broken=true;throw new Error('readback failed');}return backing.getItem(key);},
      setItem:(key:string,value:string)=>{backing.setItem(key,value);if(JSON.parse(value).entries.some((entry:{commandId:string})=>entry.commandId==='never-sent'))verify=true;}};
    const client=new SessionCommandClient({receiptScope:'readback',receiptStorage:storage,isEffective:()=>true,
      post:async(_path,body)=>{posts++;return{commandId:(body as {commandId:string}).commandId,status:'accepted',result:{id:sid,status:'ready'}};},get:async()=>({result:'unknown'})});
    await assert.rejects(client.submit(sid,'run',{},unused,'never-sent'),/storage/);assert.equal(posts,0);
    if(persistent){assert.match(client.recoveryStorageError()??'',/storage/);broken=false;}
    assert.deepEqual(client.pendingCommands(),[{sessionId:other,commandId:'other-original',type:'run'}]);
    await client.submit(sid,'run',{},unused,'fresh');assert.equal(posts,1);client.dispose();
  }
});

test('same-scope safe-stop ID collision cannot corrupt the durable namespace or erase an older command',async()=>{
  const storage=memory();const ledger=new CommandReceiptLedger('stop-collision',storage);
  await ledger.admit(sid,'run-original','run',{});
  await ledger.admit(sid,'stop-original','stop',{expected_turn_id:'turn'});
  const before=[...storage.values.values()];let posts=0;
  const client=new SessionCommandClient({receiptScope:'stop-collision',receiptStorage:storage,isEffective:()=>true,
    post:async()=>{posts++;return{};},get:async()=>({result:'unknown'})});
  await assert.rejects(client.submit(sid,'stop',{expected_turn_id:'turn'},unused,'stop-original'),/pending or unconfirmed/);
  assert.equal(posts,0);assert.deepEqual([...storage.values.values()],before);
  assert.deepEqual(client.pendingCommands().map(entry=>entry.commandId),['run-original','stop-original']);
  assert.equal(client.recoveryStorageError(),null);client.dispose();
});

test('committed retirement followed by read-back failure reports the validated result as confirmed',async()=>{
  const backing=memory();let writes=0,failRead=false,posts=0;
  const storage={getItem:(key:string)=>{if(failRead){failRead=false;throw new Error('read-back failed');}return backing.getItem(key);},
    setItem:(key:string,value:string)=>{writes++;backing.setItem(key,value);if(writes===2)failRead=true;}};
  const options={receiptScope:'retirement-readback',receiptStorage:storage,isEffective:()=>true,
    post:async(_path:string,body:unknown)=>{posts++;return{commandId:(body as {commandId:string}).commandId,status:'accepted',result:{id:sid,status:'ready'}};},
    get:async()=>({result:{commandId:'original',status:'accepted',result:{id:sid,status:'ready'}}})};
  const first=new SessionCommandClient(options);
  const accepted=await first.submit(sid,'send',{text:'x'},unused,'original');
  assert.deepEqual(accepted,{id:sid,status:'ready'});first.dispose();
  const next=new SessionCommandClient(options);assert.deepEqual(next.pendingCommands(),[]);
  assert.equal(posts,1);next.dispose();
});

test('cancel or timeout during typed ACK hashing cannot retire a sent receipt after reporting unknown',async()=>{
  const original=crypto.subtle.digest.bind(crypto.subtle);
  for(const mode of ['cancel','timeout']){
    let count=0,release!:()=>void,started!:()=>void;
    const validating=new Promise<void>(resolve=>{started=resolve;});const gate=new Promise<void>(resolve=>{release=resolve;});
    Object.defineProperty(crypto.subtle,'digest',{configurable:true,value:async(...args:Parameters<SubtleCrypto['digest']>)=>{if(++count===2){started();await gate;}return original(...args);}});
    const storage=memory();let posts=0;
    const client=new SessionCommandClient({receiptScope:`settle-${mode}`,receiptStorage:storage,isEffective:()=>true,timeoutMs:20,
      post:async(_path,body)=>{posts++;return{commandId:(body as {commandId:string}).commandId,status:'accepted',result:{id:'q',item:{id:'q',text:'queue text',status:'queued',position:0}}};},get:async()=>({result:'unknown'})});
    try{
      const pending=client.submit(sid,'queue',{text:'queue text'},unused,'original');const rejected=assert.rejects(pending,CommandDeliveryUnconfirmedError);
      await validating;if(mode==='cancel')client.cancelPending();await rejected;
      release();await new Promise(resolve=>setTimeout(resolve,20));
      assert.equal(posts,1);assert.equal(client.pendingCommands()[0].commandId,'original');
    }finally{release();Object.defineProperty(crypto.subtle,'digest',{configurable:true,value:original});client.dispose();}
  }
});

test('safety-stop dispatch revokes stale unsent cleanup ownership after a partial admission write',async()=>{
  const backing=memory();let readBroken=false,posts=0;
  const storage={getItem:(key:string)=>{if(readBroken)throw new Error('temporary read failure');return backing.getItem(key);},
    setItem:(key:string,value:string)=>{backing.setItem(key,value);readBroken=true;}};
  const client=new SessionCommandClient({receiptScope:'stop-partial',receiptStorage:storage,isEffective:()=>true,
    post:async(_path,body)=>{posts++;readBroken=false;return{commandId:(body as {commandId:string}).commandId,status:'failed'};},get:async()=>({result:'unknown'})});
  await assert.rejects(client.submit(sid,'stop',{expected_turn_id:'turn'},unused,'stop-original'),CommandDeliveryUnconfirmedError);
  assert.equal(posts,1);assert.equal(client.pendingCommands()[0].commandId,'stop-original');
  assert.equal(client.pendingCommands()[0].commandId,'stop-original');client.dispose();
});
