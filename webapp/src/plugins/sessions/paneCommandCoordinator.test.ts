import test from 'node:test';
import assert from 'node:assert/strict';
import { createPaneCommandCoordinator } from './paneCommandCoordinator';
import { SessionCommandClient, CommandDeliveryUnconfirmedError } from './commandClient';
const sid = 'a'.repeat(32);
const unused = async () => { throw new Error('No direct fallback'); };

test('shared pane proof permits one follow-up across an active run while blocking unrelated and concurrent writes',async()=>{
  let finishRun!:(value:unknown)=>void,finishQueue!:(value:unknown)=>void;const writes:string[]=[];
  const client=createPaneCommandCoordinator(new SessionCommandClient({isEffective:()=>true,allowDirectFallback:false,
    post:async(_path,value)=>{const body=value as {commandId:string;type:string};writes.push(body.type);
      return new Promise(resolve=>{if(body.type==='run')finishRun=resolve;else finishQueue=resolve;});},get:async()=>({result:'unknown'})}));
  const run=client.submit(sid,'run',{},unused,'origin');
  const proof={sessionId:sid,runCommandId:'origin',expectedTurnId:'turn'};
  const queue=client.submit(sid,'queue',{text:'next',expected_turn_id:'turn'},unused,'q',{proof,current:()=>true});
  await assert.rejects(client.submit(sid,'queue',{text:'double',expected_turn_id:'turn'},unused,'q2',{proof,current:()=>true}),/pending or unconfirmed/);
  await assert.rejects(client.submit(sid,'edit_message',{},unused,'edit'),/pending or unconfirmed/);
  finishQueue({commandId:'q',status:'accepted',result:{id:'item',item:{id:'item',text:'next',status:'queued',position:0}}});await queue;
  assert.deepEqual(client.pendingCommands(),[{sessionId:sid,commandId:'origin',type:'run'}]);
  finishRun({commandId:'origin',status:'accepted',result:{id:sid,status:'completed'}});await run;
  assert.deepEqual(writes,['run','queue']);client.dispose();
});

test('shared pane client blocks concurrent unrelated writes while allowing safe stop', async () => {
  let resolve!: (value: unknown) => void; const writes: string[] = [];
  const client = createPaneCommandCoordinator(new SessionCommandClient({ isEffective: () => true, allowDirectFallback: false,
    post: async (_path, value) => { const body = value as {commandId:string;type:string}; writes.push(body.type);
      if (body.type === 'send') return new Promise(r => { resolve = r; });
      return { commandId: body.commandId, status: 'accepted', result: { stopping: true } }; }, get: async () => ({result:'unknown'}) }));
  const send = client.submit(sid, 'send', {text:'x'}, unused, 'send');
  await assert.rejects(client.submit(sid, 'run', {}, unused), /pending or unconfirmed/);
  await client.submit(sid, 'stop', {expected_turn_id:'turn'}, unused);
  resolve({commandId:'send',status:'accepted',result:{id:sid,status:'ready'}}); await send;
  assert.deepEqual(writes,['send','stop']); client.dispose();
});

test('unknown send blocks another surface until exact validated read-only recovery', async () => {
  const writes: string[] = []; let receipt: unknown = 'unknown';
  const client = createPaneCommandCoordinator(new SessionCommandClient({isEffective:()=>true,allowDirectFallback:false,
    post:async(_path,value)=>{const body=value as {commandId:string;type:string};writes.push(body.type);
      if(body.commandId==='first')throw new TypeError('lost');return {commandId:body.commandId,status:'accepted',result:{id:sid,status:'ready'}};},
    get:async()=>({result:receipt})}));
  await assert.rejects(client.submit(sid,'send',{text:'x'},unused,'first'),CommandDeliveryUnconfirmedError);
  await assert.rejects(client.submit(sid,'run',{},unused),/pending or unconfirmed/);
  receipt={commandId:'first',status:'accepted',result:{id:'wrong',status:'ready'}};
  await client.query(sid,'first');
  await assert.rejects(client.submit(sid,'run',{},unused),/pending or unconfirmed/);
  receipt={commandId:'first',status:'failed',result:{id:sid,status:'ready'}};
  await client.query(sid,'first');
  await assert.rejects(client.submit(sid,'run',{},unused),/pending or unconfirmed/);
  receipt={commandId:'first',status:'accepted',result:{id:sid,status:'ready'}};
  await client.query(sid,'first'); await client.submit(sid,'run',{},unused);
  assert.deepEqual(writes,['send','run']);client.dispose();
});

test('malformed successful send is retained as unknown before caller starts a run', async () => {
  let writes=0;
  const client=createPaneCommandCoordinator(new SessionCommandClient({isEffective:()=>true,allowDirectFallback:false,
    post:async(_path,value)=>{writes++;return{commandId:(value as {commandId:string}).commandId,status:'accepted',result:{id:'wrong',status:'ready'}};},get:async()=>({result:'unknown'})}));
  await assert.rejects(client.submit(sid,'send',{text:'x'},unused),CommandDeliveryUnconfirmedError);
  await assert.rejects(client.submit(sid,'run',{},unused),/pending or unconfirmed/);assert.equal(writes,1);client.dispose();
});

test('confirmed sequential send/run has no self-contention; definitive rejection releases barrier', async()=>{
  let writes=0;
  const client=createPaneCommandCoordinator(new SessionCommandClient({isEffective:()=>true,allowDirectFallback:false,
    post:async(_path,value)=>{writes++;return{commandId:(value as {commandId:string}).commandId,status:writes===1?'rejected':'accepted',result:{id:sid,status:'ready'}};},get:async()=>({result:'unknown'})}));
  await assert.rejects(client.submit(sid,'send',{text:'x'},unused));
  await client.submit(sid,'send',{text:'x'},unused);await client.submit(sid,'run',{},unused);assert.equal(writes,3);client.dispose();
});

test('queue-specific validator controls cross-surface unknown recovery', async()=>{
  let id='';let receipt:unknown='unknown';let writes=0;
  const client=createPaneCommandCoordinator(new SessionCommandClient({isEffective:()=>true,allowDirectFallback:false,
    post:async(_path,value)=>{writes++;id=(value as {commandId:string}).commandId;throw new TypeError('lost');},get:async()=>({result:receipt})}));
  const validate=(value:unknown,commandId:string)=>{if((value as {removed?:boolean})?.removed!==true)throw new CommandDeliveryUnconfirmedError(commandId);};
  await assert.rejects(client.submitQueue(sid,'cancel_queue',{queueId:'q',expectedText:'x',expectedRevision:1},unused,validate),CommandDeliveryUnconfirmedError);
  await assert.rejects(client.submit(sid,'run',{},unused),/pending or unconfirmed/);
  receipt={commandId:id,status:'accepted',result:{removed:false}};await client.query(sid,id);
  await assert.rejects(client.submit(sid,'run',{},unused),/pending or unconfirmed/);
  receipt={commandId:id,status:'stale'};await client.query(sid,id);
  await assert.rejects(client.submit(sid,'run',{},unused),CommandDeliveryUnconfirmedError);assert.equal(writes,2);client.dispose();
});

import { createPaneMutationCoordinator, createPaneFollowupOperationGate } from './paneCommandCoordinator';

test('an active normal-turn lease admits one certified follow-up without releasing the original lease',async()=>{
 let live=true,finishRun!:(value:unknown)=>void;
 const commands=createPaneCommandCoordinator(new SessionCommandClient({isEffective:()=>live,allowDirectFallback:false,
   post:async()=>new Promise(resolve=>{finishRun=resolve;}),get:async()=>({result:'unknown'})}));
 const gate=createPaneFollowupOperationGate(commands,()=>live),releaseNormal=gate.acquire()!;
 assert.ok(releaseNormal);const run=commands.submit(sid,'run',{},unused,'original');
 const followup={proof:{sessionId:sid,runCommandId:'original',expectedTurnId:'turn'},current:()=>live};
 const releaseFollowup=gate.acquire(followup);assert.ok(releaseFollowup);assert.equal(gate.acquire(followup),null);assert.equal(gate.acquire(),null);
 releaseFollowup!();live=false;assert.equal(gate.acquire(followup),null);live=true;
 finishRun({commandId:'original',status:'accepted',result:{id:sid,status:'completed'}});await run;
 assert.equal(gate.acquire(),null,'normal turn retains its original operation lease');releaseNormal();
 const next=gate.acquire();assert.ok(next);next!();commands.dispose();
});
test('operation lease guards preparation and invalidation without a stale release clearing a new owner',()=>{
  let live=true;const coordinator=createPaneMutationCoordinator(()=>live);
  const first=coordinator.acquire()!;assert.ok(first);assert.equal(coordinator.acquire(),null);
  live=false;assert.equal(first.current(),false);first.release();assert.equal(coordinator.acquire(),null);
  live=true;const second=coordinator.acquire()!;first.release();assert.equal(second.current(),true);assert.equal(coordinator.isBusy(),true);
  second.release();assert.equal(coordinator.isBusy(),false);
});

test('fork result must identify another child of the captured source before barrier releases',async()=>{
  let receipt:unknown='unknown';
  const client=createPaneCommandCoordinator(new SessionCommandClient({isEffective:()=>true,allowDirectFallback:false,
    post:async(_path,value)=>({commandId:(value as {commandId:string}).commandId,status:'accepted',result:{sourceId:sid,session:{id:sid},boundary:{turn:1,preview:'x'},historyTruncated:false,truncationReason:null}}),get:async()=>({result:receipt})}));
  await assert.rejects(client.submit(sid,'fork',{},unused,'fork-id'),CommandDeliveryUnconfirmedError);
  await assert.rejects(client.submit(sid,'run',{},unused),/pending or unconfirmed/);
  receipt={commandId:'fork-id',status:'accepted',result:{sourceId:sid,session:{id:'b'.repeat(32)},boundary:{turn:1,preview:'x'},historyTruncated:false,truncationReason:null}};
  await client.query(sid,'fork-id');
  // Barrier is gone; the fake server's fork-shaped run receipt is independently rejected.
  await assert.rejects(client.submit(sid,'run',{},unused),CommandDeliveryUnconfirmedError);client.dispose();
});

import { paneCommandsBlocked, panePendingCommands } from './paneCommandCoordinator';
test('stable workspace/session ledger survives disposal, pane remount and wrong-target queries', async () => {
  const scope = 'coordinator-remount-workspace/session-a';
  let receipt: unknown = 'unknown'; const writes: string[] = []; const reads: string[] = [];
  const make = (key = scope) => createPaneCommandCoordinator(new SessionCommandClient({
    isEffective: () => true, allowDirectFallback: false, queryAttempts: 1,
    post: async (_path, body) => { writes.push((body as {type:string}).type); throw new TypeError('lost'); },
    get: async path => { reads.push(path); return { result: receipt }; },
  }), key);
  const first = make();
  await assert.rejects(first.submit(sid, 'send', {text:'original'}, unused, 'original-id'), CommandDeliveryUnconfirmedError);
  first.dispose();
  const remounted = make();
  assert.deepEqual(panePendingCommands(remounted), [{sessionId:sid, commandId:'original-id', type:'send'}]);
  assert.equal(paneCommandsBlocked(remounted), true);
  await assert.rejects(remounted.submit(sid, 'fork', {}, unused), /pending or unconfirmed/);
  receipt = {commandId:'original-id',status:'accepted',result:{id:sid,status:'ready'}};
  await remounted.query('b'.repeat(32), 'original-id');
  assert.equal(paneCommandsBlocked(remounted), true);
  receipt = {commandId:'other-id',status:'accepted',result:{id:sid,status:'ready'}};
  await assert.rejects(remounted.query(sid,'original-id'),CommandDeliveryUnconfirmedError);
  assert.equal(paneCommandsBlocked(remounted),true);
  const otherSession = make('coordinator-remount-workspace/session-b');
  const otherWorkspace = make('coordinator-remount-other-workspace/session-a');
  assert.equal(paneCommandsBlocked(otherSession),false); assert.equal(paneCommandsBlocked(otherWorkspace),false);
  receipt = {commandId:'original-id',status:'duplicate',originalStatus:'accepted',result:{id:sid,status:'ready'}};
  await remounted.query(sid,'original-id');
  assert.equal(paneCommandsBlocked(remounted),false); assert.deepEqual(panePendingCommands(remounted),[]);
  assert.deepEqual(writes,['send']); assert.ok(reads.at(-1)?.endsWith(`/${sid}/commands/original-id`));
  remounted.dispose(); otherSession.dispose(); otherWorkspace.dispose();
});

test('remount during admission remains fenced after cancellation until exact recovery', async () => {
  let started!: () => void; const sent = new Promise<void>(resolve => { started = resolve; });
  const scope = 'coordinator-in-flight-remount';
  const old = createPaneCommandCoordinator(new SessionCommandClient({isEffective:()=>true,allowDirectFallback:false,
    post:async()=>{started();return new Promise(()=>{});},get:async()=>({result:'unknown'})}),scope);
  const result=old.submit(sid,'send',{text:'x'},unused,'inflight');
  await sent;
  const next=createPaneCommandCoordinator(new SessionCommandClient({isEffective:()=>true,allowDirectFallback:false,
    post:async()=>{throw new Error('must not write');},get:async()=>({result:{commandId:'inflight',status:'rejected'}})}),scope);
  assert.equal(paneCommandsBlocked(next),true);
  await assert.rejects(next.submit(sid,'run',{},unused),/pending or unconfirmed/);
  old.dispose(); await assert.rejects(result,CommandDeliveryUnconfirmedError);
  assert.equal(paneCommandsBlocked(next),true);
  assert.equal(panePendingCommands(next)[0].commandId,'inflight');
  await next.query(sid,'inflight');assert.equal(paneCommandsBlocked(next),false);next.dispose();
});

test('create recovery uses original collection receipt and remains locked on failed or malformed results',async()=>{
  let receipt:unknown='unknown';
  const make=()=>createPaneCommandCoordinator(new SessionCommandClient({isEffective:()=>true,allowDirectFallback:false,queryAttempts:1,
    post:async()=>{throw new TypeError('lost');},get:async()=>({result:receipt})}),'coordinator-create-remount');
  const first=make();await assert.rejects(first.submitCreate({text:'x'},unused,'create-original'),CommandDeliveryUnconfirmedError);first.dispose();
  const next=make();
  for(const result of ['unknown',{commandId:'create-original',status:'failed'},
    {commandId:'create-original',status:'accepted',result:{id:'bad'}}]){
    receipt=result;await next.queryCreate('create-original');assert.equal(paneCommandsBlocked(next),true);
  }
  receipt={commandId:'create-original',status:'stale'};await next.query(sid,'create-original');assert.equal(paneCommandsBlocked(next),true);
  await next.queryCreate('create-original');assert.equal(paneCommandsBlocked(next),false);next.dispose();
});

test('remounted approval requires the original capability and decision; changed caller payload cannot unlock it',async()=>{
  let receipt:unknown='unknown';let originalId='';
  const make=()=>createPaneCommandCoordinator(new SessionCommandClient({isEffective:()=>true,allowDirectFallback:false,queryAttempts:1,
    post:async(_path,body)=>{originalId=(body as {commandId:string}).commandId;throw new TypeError('lost');},
    get:async()=>({result:receipt})}),'coordinator-approval-remount');
  const payload={tool_call_id:'tool-original',kind:'exec'};
  const first=make();await assert.rejects(first.submitApproval(sid,'approve',payload,unused),CommandDeliveryUnconfirmedError);
  payload.tool_call_id='tool-changed';first.dispose();const next=make();
  for(const result of [{approved:{tool_call_id:'tool-changed',kind:'exec'}},{rejected:{tool_call_id:'tool-original',kind:'exec'}},
    {approved:{tool_call_id:'tool-original',kind:'write'}}]){
    receipt={commandId:originalId,status:'accepted',result};await next.query(sid,originalId);assert.equal(paneCommandsBlocked(next),true);
  }
  receipt={commandId:originalId,status:'accepted',result:{approved:{tool_call_id:'tool-original',kind:'exec'}}};
  await next.query(sid,originalId);assert.equal(paneCommandsBlocked(next),false);next.dispose();
});

test('remounted edit and queue recovery validate original typed intent before clearing',async()=>{
  for(const type of ['edit','queue']){
    let receipt:unknown='unknown';let originalId='';
    const make=()=>createPaneCommandCoordinator(new SessionCommandClient({isEffective:()=>true,allowDirectFallback:false,queryAttempts:1,
      post:async(_path,body)=>{originalId=(body as {commandId:string}).commandId;throw new TypeError('lost');},
      get:async()=>({result:receipt})}),`coordinator-${type}-remount`);
    const first=make();
    const revision=`sha256:${'f'.repeat(64)}`;
    const validate=(result:unknown,id:string)=>{if((result as {id?:string;removed?:boolean})?.id!=='q-original'
      ||(result as {removed?:boolean}).removed!==true)throw new CommandDeliveryUnconfirmedError(id);};
    const submit=type==='edit'?first.submitEdit(sid,{revision,messageIndex:2,action:'edit',text:'new'},unused)
      :first.submitQueue(sid,'cancel_queue',{queueId:'q-original',expectedText:'x',expectedRevision:2},unused,validate);
    await assert.rejects(submit,CommandDeliveryUnconfirmedError);first.dispose();const next=make();
    receipt={commandId:originalId,status:'accepted',result:type==='edit'
      ?{id:sid,messageIndex:3,action:'edit',revision}:{id:'wrong-queue',removed:true}};
    await next.query(sid,originalId);assert.equal(paneCommandsBlocked(next),true);
    receipt={commandId:originalId,status:'accepted',result:type==='edit'
      ?{id:sid,messageIndex:2,action:'edit',revision}:{id:'q-original',removed:true}};
    await next.query(sid,originalId);assert.equal(paneCommandsBlocked(next),false);next.dispose();
  }
});

test('hydrated backend ledger blocks only its pane session rather than every pane',async()=>{
  const values=new Map<string,string>();const storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);}};
  const make=()=>new SessionCommandClient({receiptScope:'coordinator-durable-sessions',receiptStorage:storage,isEffective:()=>true,allowDirectFallback:false,queryAttempts:1,
    post:async()=>{throw new TypeError('lost');},get:async()=>({result:'unknown'})});
  const first=make();await assert.rejects(first.submit(sid,'run',{},unused,'original'),CommandDeliveryUnconfirmedError);first.dispose();
  const same=createPaneCommandCoordinator(make(),'durable-pane-a',sid);
  const other=createPaneCommandCoordinator(make(),'durable-pane-b','b'.repeat(32));
  assert.equal(paneCommandsBlocked(same),true);assert.equal(paneCommandsBlocked(other),false);
  assert.equal(panePendingCommands(same).length,1);assert.deepEqual(panePendingCommands(other),[]);
  same.dispose();other.dispose();
});
