import {test} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {SessionCommandClient, CommandDeliveryUnconfirmedError, RUN_COMMAND_TIMEOUT_MS} from './commandClient';
import {CommandReceiptRecovery, queryOriginalPaneReceipts, canAdmitSessionMutation, canAdmitSessionFollowup, sessionFollowupProof} from './CommandReceiptRecovery';
import {createSessionCommandClient} from '../../xuenessWorkbench';
import {CommandReceiptLedger} from './commandLedger';
const sid='a'.repeat(32);
function storage(){const values=new Map<string,string>();return {values,getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);}};}

test('only a matching authoritative running snapshot admits follow-ups; general mutations and other unknown writes stay blocked',async()=>{
 const saved=storage(),ledger=new CommandReceiptLedger('followup-helper',saved);await ledger.admit(sid,'run-id','run',{});
 const commands=new SessionCommandClient({receiptScope:'followup-helper',receiptStorage:saved,isEffective:()=>true,post:async()=>{throw new Error('read-only test');},get:async()=>({result:'unknown'})});
 const session={id:sid,status:'running',active_turn_id:'turn',active_run_command_id:'run-id'};
 const proof=sessionFollowupProof(session)!;
 assert.equal(canAdmitSessionMutation(commands,sid,()=>true),false);
 assert.equal(canAdmitSessionFollowup(commands,sid,undefined,()=>true),false);
 assert.equal(canAdmitSessionFollowup(commands,sid,proof,()=>true),true);
 assert.equal(canAdmitSessionFollowup(commands,sid,{...proof,runCommandId:'another-run'},()=>true),false);
 assert.equal(canAdmitSessionFollowup(commands,sid,proof,()=>false),false);
 assert.equal(sessionFollowupProof({...session,status:'completed'}),undefined);
 assert.equal(sessionFollowupProof({...session,active_run_command_id:null}),undefined);
 await ledger.admit(sid,'stop-id','stop',{expected_turn_id:'turn'});
 assert.equal(canAdmitSessionFollowup(commands,sid,proof,()=>true),false);
 saved.setItem('xueness.command-receipts.v1:followup-helper','broken');
 assert.equal(canAdmitSessionFollowup(commands,sid,proof,()=>true),false);commands.dispose();
});
test('reloaded pane exposes original send receipt and query-only recovery performs no new write',async()=>{
 const saved=storage();let writes=0;let queries=0;const scope='reload-ui-send';
 const first=new SessionCommandClient({receiptScope:scope,receiptStorage:saved,isEffective:()=>true,allowDirectFallback:false,
  post:async()=>{writes++;throw new TypeError('lost');},get:async()=>({result:'unknown'})});
 await assert.rejects(()=>first.submit(sid,'send',{text:'private prompt',prepared_token:'secret-token'},async()=>{throw new Error('no fallback');},'original-send'),CommandDeliveryUnconfirmedError);
 first.dispose();assert.equal([...saved.values.values()].join('').includes('private prompt'),false);assert.equal([...saved.values.values()].join('').includes('secret-token'),false);
 const recovered=new SessionCommandClient({receiptScope:scope,receiptStorage:saved,isEffective:()=>true,allowDirectFallback:false,
  post:async()=>{writes++;throw new Error('must not write');},get:async()=>{queries++;return {result:{commandId:'original-send',status:'accepted',result:{id:sid,status:'pending'}}};}});
 const html=renderToStaticMarkup(<CommandReceiptRecovery commands={recovered} enabled sessionId={sid}/>);
 assert.match(html,/command-receipt-recovery/);assert.equal(recovered.pendingCommands()[0].commandId,'original-send');
 await queryOriginalPaneReceipts(recovered,recovered.pendingCommands(),()=>true);
 assert.equal(writes,1);assert.equal(queries,1);assert.deepEqual(recovered.pendingCommands(),[]);recovered.dispose();
});
test('create recovery opens validated original session without creating or running again',async()=>{
 const saved=storage();const scope='reload-ui-create';let writes=0;
 const first=new SessionCommandClient({receiptScope:scope,receiptStorage:saved,isEffective:()=>true,allowDirectFallback:false,
  post:async()=>{writes++;throw new TypeError('lost');},get:async()=>({result:'unknown'})});
 await assert.rejects(()=>first.submitCreate({task:'private'},async()=>undefined,'original-create'),CommandDeliveryUnconfirmedError);first.dispose();
 const next=new SessionCommandClient({receiptScope:scope,receiptStorage:saved,isEffective:()=>true,post:async()=>{writes++;throw new Error('no writes');},
  get:async()=>({result:{commandId:'original-create',status:'accepted',result:{id:sid,status:'idle',root:'/workspace'}}})});
 assert.deepEqual(await queryOriginalPaneReceipts(next,next.pendingCommands(),()=>true),[sid]);assert.equal(writes,1);next.dispose();
});
test('lazy production handle exposes hydrated receipts synchronously before command module opens',async()=>{
 const saved=storage();const scope='lazy-reload-ui';
 const first=new SessionCommandClient({receiptScope:scope,receiptStorage:saved,isEffective:()=>true,allowDirectFallback:false,post:async()=>{throw new TypeError('lost');},get:async()=>({result:'unknown'})});
 await assert.rejects(()=>first.submit(sid,'run',{},async()=>undefined,'lazy-original'),CommandDeliveryUnconfirmedError);first.dispose();
 const old=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage');Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:saved});
 try{const next=createSessionCommandClient(()=>true,scope);assert.equal(next.pendingCommands()[0].commandId,'lazy-original');assert.equal(next.recoveryStorageError(),null);next.dispose();}
 finally{if(old)Object.defineProperty(globalThis,'sessionStorage',old);else Reflect.deleteProperty(globalThis,'sessionStorage');}
});

test('hydrated receipt gates only its own session and recovery stays read-only when disabled',async()=>{
 const saved=storage();const commands=new SessionCommandClient({receiptScope:'isolation-reload',receiptStorage:saved,isEffective:()=>true,
  allowDirectFallback:false,post:async()=>{throw new TypeError('lost');},get:async()=>({result:'unknown'})});
 await assert.rejects(()=>commands.submit(sid,'run',{},async()=>undefined,'isolated-run'),CommandDeliveryUnconfirmedError);
 assert.equal(canAdmitSessionMutation(commands,sid,()=>true),false);
 assert.equal(canAdmitSessionMutation(commands,'b'.repeat(32),()=>true),true);
 assert.deepEqual(await queryOriginalPaneReceipts(commands,commands.pendingCommands(),()=>false),[]);
 assert.equal(commands.pendingCommands().length,1);commands.dispose();
});

test('confirmed-result cleanup warning stays visible without disabling exact recovery query',async()=>{
 const saved=storage();let blockCleanup=false;let writes=0;let queries=0;
 const receiptStorage={getItem:saved.getItem,setItem:(key:string,value:string)=>{
  if(blockCleanup && JSON.parse(value).entries.length===0)throw new Error('temporary cleanup failure');
  saved.setItem(key,value);
 }};
 const commands=new SessionCommandClient({receiptScope:'cleanup-warning-ui',receiptStorage,isEffective:()=>true,allowDirectFallback:false,
  post:async(_path,body)=>{writes++;blockCleanup=true;return {commandId:(body as {commandId:string}).commandId,status:'accepted',result:{id:sid,status:'running'}};},
  get:async()=>{queries++;return {result:{commandId:'cleanup-original',status:'accepted',result:{id:sid,status:'running'}}};}});
 await commands.submit(sid,'run',{},async()=>undefined,'cleanup-original');
 assert.equal(commands.recoveryStorageError(),null);assert.match(commands.recoveryStorageWarning()??'',/cleanup failed/);
 assert.equal(canAdmitSessionMutation(commands,sid,()=>true),false);
 assert.equal(canAdmitSessionMutation(commands,'b'.repeat(32),()=>true),true);
 const html=renderToStaticMarkup(<CommandReceiptRecovery commands={commands} enabled sessionId={sid}/>);
 assert.match(html,/cleanup failed/);assert.match(html,/<button type="button">/);assert.doesNotMatch(html,/<button[^>]*disabled/);
 blockCleanup=false;
 await queryOriginalPaneReceipts(commands,commands.pendingCommands(),()=>true);
 assert.equal(queries,1);assert.equal(writes,1);assert.equal(commands.recoveryStorageWarning(),null);assert.deepEqual(commands.pendingCommands(),[]);
 commands.dispose();
});
test('a run this page still awaits is progress, not a lost receipt, and its request outlives the write deadline',async()=>{
 const saved=storage(),scope='inflight-run',delays:number[]=[],realSetTimeout=globalThis.setTimeout;
 let release:(value:unknown)=>void=()=>undefined;let posted=false;
 globalThis.setTimeout=((handler:(...args:unknown[])=>void,delay?:number,...args:unknown[])=>{delays.push(Number(delay)||0);return realSetTimeout(handler,delay,...args);}) as typeof setTimeout;
 const commands=new SessionCommandClient({receiptScope:scope,receiptStorage:saved,isEffective:()=>true,allowDirectFallback:false,
  post:()=>{posted=true;return new Promise(resolve=>{release=resolve;});},get:async()=>({result:'unknown'})});
 let running:Promise<unknown>;
 try{
  running=commands.submit(sid,'run',{},async()=>{throw new Error('no fallback');},'live-run');
  for(let tick=0;tick<50&&!posted;tick++)await new Promise(resolve=>realSetTimeout(resolve,1));
 }finally{globalThis.setTimeout=realSetTimeout;}
 assert.equal(posted,true);
 assert.ok(delays.filter(delay=>delay>=RUN_COMMAND_TIMEOUT_MS).length>=2,'run request and its bound follow the run, not 20 s');
 assert.equal(delays.includes(20000),false);
 assert.equal(commands.pendingCommands()[0]?.commandId,'live-run');assert.equal(commands.isInFlight(sid,'live-run'),true);
 assert.equal(renderToStaticMarkup(<CommandReceiptRecovery commands={commands} enabled sessionId={sid}/>),'');
 // The original follow-up fence is unchanged while the run is live.
 assert.equal(canAdmitSessionFollowup(commands,sid,{sessionId:sid,runCommandId:'live-run',expectedTurnId:'turn'},()=>true),true);
 assert.equal(canAdmitSessionMutation(commands,sid,()=>true),false);
 release({commandId:'live-run',status:'accepted',result:{id:sid,status:'completed'}});
 await running!;
 assert.equal(commands.isInFlight(sid,'live-run'),false);assert.deepEqual(commands.pendingCommands(),[]);
 assert.equal(canAdmitSessionMutation(commands,sid,()=>true),true);commands.dispose();
 const lazy=createSessionCommandClient(()=>true,'inflight-lazy');assert.equal(lazy.isInFlight(sid,'live-run'),false);lazy.dispose();
});
