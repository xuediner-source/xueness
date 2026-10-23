import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promotePaneQueuedMessage, type PaneGuidanceTransport } from './paneWorkflowActions';
import { SessionCommandClient, CommandDeliveryUnconfirmedError } from './commandClient';
import type { WorkbenchSession } from '../../xuenessWorkbench';
import { getRunChoices } from '../../xuenessBridge';
const sid = 'a'.repeat(32);
test('send-now waits for stopped worker and admits exactly one run with original reservation', async () => {
  let reads = 0; const writes: unknown[] = []; let live = true;
  const commands = new SessionCommandClient({ isEffective: () => live, allowDirectFallback: false,
    post: async (_path, body) => { writes.push(body); return {commandId:(body as {commandId:string}).commandId, status:'accepted', result:{id:sid,status:'running'}}; },
    get: async () => ({result:'unknown'}) });
  const guidance = {promote: async () => ({ok:true,value:{id:'queue',request_id:'reservation',delivery:'startNow',state:'reserved'}})} as unknown as PaneGuidanceTransport;
  await promotePaneQueuedMessage({sessionId:sid,queueId:'queue',expectedTurnId:'turn',expectedRevision:4, choices:getRunChoices(), commands,guidance,current:()=>live,
    readSession: async () => ({id:sid,status:++reads===1?'running':'paused',active_turn_id:reads===1?'turn':null}) as WorkbenchSession, sleep:async()=>undefined});
  assert.equal(reads,2); assert.equal(writes.length,1);
  assert.equal((writes[0] as {payload:{promotion_request_id:string}}).payload.promotion_request_id,'reservation');
  commands.dispose();
});
test('send-now never launches a run after pane rebind during reservation', async () => {
  let live = true; let writes = 0; let reads = 0;
  const commands = new SessionCommandClient({isEffective:()=>live,post:async()=>{writes++;return{};},get:async()=>({result:'unknown'})});
  const guidance = {promote:async()=>{live=false;return{ok:true,value:{id:'queue',request_id:'r',delivery:'startNow',state:'reserved'}};}} as unknown as PaneGuidanceTransport;
  await promotePaneQueuedMessage({sessionId:sid,queueId:'queue',expectedTurnId:'turn',choices:getRunChoices(),commands,guidance,current:()=>live,
    readSession:async()=>{reads++;return null;}});
  assert.equal(writes,0);assert.equal(reads,0);commands.dispose();
});
test('unknown run ACK after reservation is never submitted again', async () => {
  let writes=0;
  const commands=new SessionCommandClient({isEffective:()=>true,allowDirectFallback:false,post:async()=>{writes++;throw new TypeError('lost');},get:async()=>({result:'unknown'})});
  const guidance={promote:async()=>({ok:true,value:{id:'q',request_id:'r',delivery:'startNow',state:'reserved'}})} as unknown as PaneGuidanceTransport;
  await assert.rejects(()=>promotePaneQueuedMessage({sessionId:sid,queueId:'q',expectedTurnId:'turn',choices:getRunChoices(),commands,guidance,current:()=>true,
    readSession:async()=>({id:sid,status:'paused'}) as WorkbenchSession}),CommandDeliveryUnconfirmedError);
  assert.equal(writes,1);commands.dispose();
});
