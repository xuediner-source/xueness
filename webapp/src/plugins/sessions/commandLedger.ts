// sessions.command_ack: reference-only receipts survive same-tab page reloads.
import { CommandDeliveryUnconfirmedError, validateCreateCommandResult, validateEditCommandResult, validateSendCommandResult } from './commandReceipt';
import type { SessionCommandAck } from './commandClient';
export type CommandReceiptStorage = Pick<Storage, 'getItem' | 'setItem'>;
export type PendingCommandReference = { sessionId: string | null; commandId: string; type: string };
export type FollowupProof = { sessionId: string; runCommandId: string; expectedTurnId: string };
export type FollowupAdmission = { proof: FollowupProof; current: () => boolean };
export function validFollowupProof(proof: FollowupProof): boolean {
  return [proof.sessionId, proof.runCommandId, proof.expectedTurnId].every(value => typeof value === 'string'
    && value.length > 0 && value.length <= 128 && value.trim() === value);
}
/** A running snapshot can certify only the exact original run, never another write. */
export function matchesFollowupPending(entries: readonly PendingCommandReference[], proof: FollowupProof): boolean {
  if (!validFollowupProof(proof)) return false;
  const pending = entries.filter(entry => entry.sessionId === proof.sessionId);
  return pending.length === 0 || (pending.length === 1 && pending[0].type === 'run' && pending[0].commandId === proof.runCommandId);
}
type Descriptor = { messageIndex?: number; toolCallId?: string; kind?: string; decision?: string; queueId?: string; textHash?: string; expectedRevision?: number; ids?: string[] };
type Entry = PendingCommandReference & { descriptor: Descriptor };
const types = ['send','run','create_session','stop','fork','queue','edit_message','approve','approval','reject','edit_queue','cancel_queue','withdraw_queue','reorder_queue'];
const unavailable = () => Object.assign(new Error('Command recovery storage is unavailable or invalid. Restore this tab’s session storage before sending or confirming commands.'), {requestNotSent:true,receiptStorageBlocked:true});
const record = (v: unknown): Record<string, unknown> | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string,unknown> : null;
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 4096;
const keys = (v: Record<string,unknown>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));
async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2,'0')).join('');
}
function validDescriptor(type: string, d: Record<string,unknown>): boolean {
  if(type==='edit_message') return keys(d,['messageIndex']) && Number.isInteger(d.messageIndex) && Number(d.messageIndex)>=0;
  if(['approve','approval','reject'].includes(type)) return keys(d,['toolCallId','kind','decision']) && text(d.toolCallId) && text(d.kind) && ['approve','reject'].includes(String(d.decision));
  if(type==='queue') return keys(d,['textHash']) && typeof d.textHash==='string' && /^[a-f0-9]{64}$/.test(d.textHash);
  if(type==='edit_queue') return keys(d,['queueId','textHash']) && text(d.queueId) && typeof d.textHash==='string' && /^[a-f0-9]{64}$/.test(d.textHash);
  if(type==='cancel_queue') return keys(d,['queueId']) && text(d.queueId);
  if(type==='withdraw_queue') return keys(d,['queueId','textHash','expectedRevision']) && text(d.queueId)
    && typeof d.textHash==='string' && /^[a-f0-9]{64}$/.test(d.textHash) && Number.isSafeInteger(d.expectedRevision) && Number(d.expectedRevision)>=0;
  if(type==='reorder_queue') return keys(d,['ids']) && Array.isArray(d.ids) && d.ids.length<=1024 && d.ids.every(text);
  return keys(d,[]);
}
async function descriptor(type: string, p: Record<string,unknown>): Promise<Descriptor> {
  let d: Descriptor = {};
  if(type==='edit_message') d={messageIndex:p.messageIndex as number};
  if(['approve','approval','reject'].includes(type)) d={toolCallId:p.tool_call_id as string,kind:p.kind as string,decision:type==='reject'?'reject':String(p.decision??'approve')};
  if(type==='queue'||type==='edit_queue') d={...(type==='edit_queue'?{queueId:p.queueId as string}:{}),textHash:await hash(typeof p.text==='string'?p.text.trim():'')};
  if(type==='cancel_queue') d={queueId:p.queueId as string};
  if(type==='withdraw_queue') d={queueId:p.queueId as string,expectedRevision:p.expectedRevision as number,textHash:await hash(typeof p.expectedText==='string'?p.expectedText:'')};
  if(type==='reorder_queue') d={ids:Array.isArray(p.ids)?[...p.ids] as string[]:undefined};
  if(!validDescriptor(type,d as Record<string,unknown>)) throw Object.assign(new Error('Command recovery identity is invalid; no command was sent'),{requestNotSent:true});
  return d;
}
async function validate(entry: Entry, value: unknown): Promise<void> {
  const {type,sessionId:sid,commandId:id,descriptor:d}=entry;
  if(type==='create_session'){validateCreateCommandResult(value,id);return;}
  if(type==='send'||type==='run'){validateSendCommandResult(sid!,value,id);return;}
  if(type==='edit_message'){validateEditCommandResult(sid!,d.messageIndex!,value,id);return;}
  const r=record(value), item=record(r?.item);
  if(type==='stop' && typeof r?.stopping==='boolean' && (r.id===undefined||r.id===sid))return;
  if(type==='fork') { const child=record(r?.session),boundary=record(r?.boundary);
    if(r?.sourceId===sid && typeof child?.id==='string' && /^[a-f0-9]{32}$/.test(child.id) && child.id!==sid
      && Number.isInteger(boundary?.turn) && Number(boundary?.turn)>=0 && typeof boundary?.preview==='string'
      && typeof r.historyTruncated==='boolean' && (r.truncationReason===null||typeof r.truncationReason==='string'))return;
  }
  if(type==='queue' && text(r?.id) && item?.id===r?.id && typeof item.text==='string' && await hash(item.text)===d.textHash
    && ['queued','paused'].includes(String(item.status)) && Number.isInteger(item.position) && Number(item.position)>=0)return;
  if(type==='edit_queue' && r?.id===d.queueId && item?.id===d.queueId && typeof item?.text==='string' && await hash(item.text)===d.textHash)return;
  if((type==='cancel_queue'||type==='withdraw_queue') && r?.id===d.queueId && r?.removed===true && (type!=='withdraw_queue'||r.recoveryId===id))return;
  if(type==='reorder_queue' && Array.isArray(r?.ids) && JSON.stringify(r.ids)===JSON.stringify(d.ids))return;
  if(['approve','approval','reject'].includes(type)) { const field=d.decision==='reject'?'rejected':'approved', inner=record(r?.[field]);
    if(inner?.tool_call_id===d.toolCallId && inner?.kind===d.kind && r?.[field==='approved'?'rejected':'approved']===undefined)return;
  }
  throw new CommandDeliveryUnconfirmedError(id);
}
export class CommandReceiptLedger {
  private readonly key: string;
  private readonly cleanupWarnings = new Map<string, string>();
  private readonly knownUnsent = new Map<string, {sessionId:string|null; commandId:string}>();
  constructor(scope: string, private readonly injected?: CommandReceiptStorage) { this.key=`xueness.command-receipts.v1:${encodeURIComponent(scope)}`; }
  private storage(): CommandReceiptStorage { try { const storage=this.injected??globalThis.sessionStorage; if(storage)return storage; }catch{} throw unavailable(); }
  private read(): Entry[] {
    try {
      const raw=this.storage().getItem(this.key); if(raw===null)return [];
      if(raw.length>262144)throw unavailable();
      const root=record(JSON.parse(raw));
      if(!root || !keys(root,['version','entries']) || root.version!==1 || !Array.isArray(root.entries)||root.entries.length>128)throw unavailable();
      const seen=new Set<string>();
      for(const value of root.entries){const e=record(value),d=record(e?.descriptor);
        if(!e||!keys(e,['sessionId','commandId','type','descriptor'])||!text(e.commandId)||!(e.sessionId===null||text(e.sessionId))
          ||typeof e.type!=='string'||!types.includes(e.type)||!d||!validDescriptor(e.type,d)
          ||(e.type==='create_session')!==(e.sessionId===null)||seen.has(JSON.stringify([e.sessionId,e.commandId])))throw unavailable();
        seen.add(JSON.stringify([e.sessionId,e.commandId]));
      }
      return root.entries as Entry[];
    }catch{throw unavailable();}
  }
  private write(entries: Entry[]): void {try { const value=JSON.stringify({version:1,entries});if(value.length>262144)throw unavailable();this.storage().setItem(this.key,value);if(this.storage().getItem(this.key)!==value)throw unavailable(); }catch{throw unavailable();} }
  private recoverUnsent(): void {
    if(!this.knownUnsent.size)return;
    const entries=this.read();
    const retained=entries.filter(e=>!this.knownUnsent.has(JSON.stringify([e.sessionId,e.commandId])));
    if(retained.length!==entries.length)this.write(retained);
    this.knownUnsent.clear();
  }
  pending(): PendingCommandReference[] {this.recoverUnsent();return this.read().map(({sessionId,commandId,type})=>({sessionId,commandId,type}));}
  async admit(sessionId:string|null,commandId:string,type:string,payload:Record<string,unknown>,canAdmit:()=>boolean=()=>true,followup?:FollowupProof):Promise<void>{
    let d: Descriptor;
    try { d=await descriptor(type,payload); } catch(error) {
      if(error instanceof Error && 'requestNotSent' in error)throw error;
      throw Object.assign(new Error('Command recovery identity could not be prepared; no command was sent'),{requestNotSent:true});
    }
    if(!canAdmit())throw Object.assign(new Error('Command cancelled before admission'),{requestNotSent:true});
    this.recoverUnsent();
    const entries=this.read();
    if(entries.some(e=>e.sessionId===sessionId&&e.commandId===commandId))throw Object.assign(new Error('Command identity is pending or unconfirmed; check its original result first'),{requestNotSent:true});
    const previous=entries.find(e=>e.sessionId===sessionId);
    const certifiedQueue = type==='queue' && followup?.sessionId===sessionId && payload.expected_turn_id===followup.expectedTurnId
      && matchesFollowupPending(entries,followup);
    // A synchronous run remains pending while its exact tool call awaits an answer.
    // The server resolves the call id; retain the run receipt and fence any other write.
    const sessionPending=entries.filter(e=>e.sessionId===sessionId);
    const answeringRun=['approve','approval','reject'].includes(type) && sessionPending.length===1 && sessionPending[0].type==='run';
    if(previous && !certifiedQueue && !answeringRun && (type!=='stop'||sessionId===null||typeof payload.expected_turn_id!=='string'||!payload.expected_turn_id.trim()||payload.expected_turn_id.length>128||previous.commandId===commandId))throw Object.assign(new Error('Another command is pending or unconfirmed; check its original result first'),{requestNotSent:true});
    if(entries.length>=128)throw Object.assign(new Error('Command recovery storage is full; check original results before sending'),{requestNotSent:true,receiptStorageBlocked:true});
    if(!canAdmit())throw Object.assign(new Error('Command cancelled before admission'),{requestNotSent:true});
    entries.push({sessionId,commandId,type,descriptor:d});
    try { this.write(entries); } catch(error) {
      // A committed write with a failed read-back is still certainly pre-transport.
      // Only this newly admitted identity is owned here; never clean up a conflict.
      this.knownUnsent.set(JSON.stringify([sessionId,commandId]),{sessionId,commandId});
      try { this.recoverUnsent(); } catch { /* Retry exact unsent cleanup when storage recovers. */ }
      throw error;
    }
  }
  forget(sessionId:string|null,commandId:string):void {const entries=this.read();this.write(entries.filter(e=>e.sessionId!==sessionId||e.commandId!==commandId));}
  markDispatched(sessionId:string|null,commandId:string):void { this.knownUnsent.delete(JSON.stringify([sessionId,commandId])); }
  recoveryError(): string | null {
    try { this.pending();return null; }
    catch(error) { return error instanceof Error ? error.message : String(error); }
  }
  recoveryWarning(): string | null {
    try {
      const entries=this.pending();
      for(const key of this.cleanupWarnings.keys())if(!entries.some(e=>JSON.stringify([e.sessionId,e.commandId])===key))this.cleanupWarnings.delete(key);
      return this.cleanupWarnings.values().next().value ?? null;
    } catch { return null; }
  }
  private retireConfirmed(sessionId:string|null,commandId:string):void {
    const key=JSON.stringify([sessionId,commandId]);
    try { this.forget(sessionId,commandId);this.cleanupWarnings.delete(key); }
    catch { this.cleanupWarnings.set(key,'Command result is confirmed, but recovery storage cleanup failed. Check the original result again when storage is available.'); }
  }
  async confirmWithdrawal(sessionId: string, root: string, proof: import('./queueApi').QueueWithdrawal, current: () => boolean): Promise<boolean> {
    const entry=this.read().find(e=>e.sessionId===sessionId&&e.commandId===proof.id);
    if(!entry)return true;
    if(entry.type!=='withdraw_queue'||proof.sessionId!==sessionId||proof.root!==root||proof.queueId!==entry.descriptor.queueId
      ||proof.expectedRevision!==entry.descriptor.expectedRevision||!Number.isSafeInteger(proof.createdAt)||proof.createdAt<0
      ||!Number.isSafeInteger(proof.expiresAt)||proof.expiresAt<=proof.createdAt||proof.expiresAt<=Date.now()
      ||typeof proof.text!=='string'||typeof proof.hasContext!=='boolean'||await hash(proof.text)!==entry.descriptor.textHash||!current())return false;
    this.retireConfirmed(sessionId,proof.id);return true;
  }
  async settle(sessionId:string|null,commandId:string,ack:SessionCommandAck|'unknown',canSettle:()=>boolean=()=>true):Promise<boolean>{
    const entry=this.read().find(e=>e.sessionId===sessionId&&e.commandId===commandId);
    if(!entry)return true;
    if(ack==='unknown'||ack.commandId!==commandId||!canSettle())return false;
    const status=ack.status==='duplicate'?ack.originalStatus:ack.status;
    if(status==='rejected'||status==='stale'){this.retireConfirmed(sessionId,commandId);return true;}
    // A run's stored `failed` ACK is written only after /run has returned its
    // terminal response. It is safe to release the run fence; the session
    // projection and ACK message carry the failure the user needs to see.
    if(status==='failed'&&entry.type==='run'){this.retireConfirmed(sessionId,commandId);return true;}
    if(status!=='accepted'&&status!=='noop')return false;
    try{await validate(entry,ack.result);}catch{return false;}
    if(!canSettle())return false;
    this.retireConfirmed(sessionId,commandId);return true;
  }
}
