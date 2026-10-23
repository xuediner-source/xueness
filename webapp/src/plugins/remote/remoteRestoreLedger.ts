/** Per-tab reference-only restore ownership; never replays a restore mutation. */
import { RemoteSessionAdapter } from './remoteSessionAdapter';
import { remoteConnections } from './remoteConnectionStore';
import type { RemoteAttachmentEndpoint } from '../sessions/composerAttachmentRef';
import { deferComposerAttachmentRelease, flushComposerAttachmentReleases } from '../sessions/composerAttachmentCleanup';
import { isComposerAttachmentLifecycleEnabled, subscribeComposerAttachmentLifecycle } from '../sessions/composerAttachmentLifecycle';
export type RemoteRestoreIntent = RemoteAttachmentEndpoint & {sessionId:string;restoreId:string;messageIndex:number;revision:string;restoreEpoch:number;cleanup:boolean};
export const REMOTE_RESTORE_STORAGE_KEY='xueness.remote-history-restore-cleanup.v1';
const active=new Map<string,Set<string>|null>();
const key=(r:RemoteRestoreIntent)=>JSON.stringify([r.connectionId,r.digest,r.workspaceIdentity,r.sessionId,r.restoreEpoch,r.restoreId]);
function valid(value:unknown):value is RemoteRestoreIntent {
  if(!value||typeof value!=='object'||Array.isArray(value)) return false;
  const r=value as RemoteRestoreIntent;
  return Object.keys(r).sort().join(',')==='cleanup,connectionId,digest,messageIndex,restoreEpoch,restoreId,revision,sessionId,workspaceIdentity'
    && [r.connectionId,r.digest,r.workspaceIdentity,r.sessionId].every(v=>typeof v==='string'&&v.length>0&&v.length<=4096)
    && typeof r.cleanup==='boolean' && Number.isSafeInteger(r.restoreEpoch) && r.restoreEpoch>=0
    && /^[0-9a-f]{32}$/u.test(r.restoreId) && Number.isSafeInteger(r.messageIndex)&&r.messageIndex>=0&&/^sha256:[0-9a-f]{64}$/u.test(r.revision);
}
function read():RemoteRestoreIntent[]{
  const raw=sessionStorage.getItem(REMOTE_RESTORE_STORAGE_KEY),rows:unknown=raw===null?[]:JSON.parse(raw);
  if(!Array.isArray(rows)||rows.length>256||!rows.every(valid)||new Set(rows.map(key)).size!==rows.length) throw new Error('Remote restore ownership storage unavailable');
  return rows;
}
function write(rows:RemoteRestoreIntent[]){const raw=JSON.stringify(rows);sessionStorage.setItem(REMOTE_RESTORE_STORAGE_KEY,raw);if(sessionStorage.getItem(REMOTE_RESTORE_STORAGE_KEY)!==raw)throw new Error('Remote restore ownership was not persisted');}
export function remoteRestoreParams(r:RemoteRestoreIntent){return {sessionId:r.sessionId,payload:{restoreEpoch:r.restoreEpoch,restoreId:r.restoreId,messageIndex:r.messageIndex,revision:r.revision}};}
export function validateRemoteRestoreReceipt(value:unknown,r:RemoteRestoreIntent):Record<string,unknown>{
  if(!value||typeof value!=='object')throw new Error('Invalid remote restore receipt');
  const result=value as Record<string,unknown>;
  if(result.restoreEpoch!==r.restoreEpoch||result.restoreId!==r.restoreId||result.sessionId!==r.sessionId||result.root!==r.workspaceIdentity
    ||result.messageIndex!==r.messageIndex||result.revision!==r.revision||!['unknown','preparing','committed','aborted'].includes(String(result.status)))throw new Error('Remote restore receipt identity changed');
  return result;
}
function queue(r:RemoteRestoreIntent){
  deferComposerAttachmentRelease({root:r.workspaceIdentity,sessionId:r.sessionId,remote:{connectionId:r.connectionId,digest:r.digest,workspaceIdentity:r.workspaceIdentity},draftKey:'restore-receipt:'+r.restoreId},r.restoreId,
    ()=>active.has(key(r)),async<T>(_path:string,_body:object,signal?:AbortSignal)=>{
      const current=remoteConnections.owner(r.connectionId);
      if(!current||current.state!=='connected'||current.digest!==r.digest||current.workspaceIdentity!==r.workspaceIdentity)throw new Error('Original remote restore workspace unavailable');
      const adapter=new RemoteSessionAdapter(current,isComposerAttachmentLifecycleEnabled);
      const status=validateRemoteRestoreReceipt(await adapter.request('media/restore-status',remoteRestoreParams(r),signal,isComposerAttachmentLifecycleEnabled),r);
      const result=status.status==='aborted'&&status.cleanupComplete===true?status:
        validateRemoteRestoreReceipt(await adapter.request('media/restore-abort',remoteRestoreParams(r),signal,isComposerAttachmentLifecycleEnabled),r);
      if(result.status!=='aborted'||result.cleanupComplete!==true)throw new Error('Remote restore disposal remains unknown');
      write(read().filter(item=>key(item)!==key(r)));
      return result as T;
    });
}
export function recoverRemoteRestoreCleanup(){try{for(const r of read())if(r.cleanup)queue(r);flushComposerAttachmentReleases();}catch{/* Preserve inaccessible or malformed ownership storage. */}}
export function findRemoteRestore(endpoint:RemoteAttachmentEndpoint,input:{sessionId:string;messageIndex:number}):RemoteRestoreIntent|undefined {
  return read().find(r=>!r.cleanup&&r.connectionId===endpoint.connectionId&&r.digest===endpoint.digest
    &&r.workspaceIdentity===endpoint.workspaceIdentity&&r.sessionId===input.sessionId&&r.messageIndex===input.messageIndex);
}
export function claimRemoteRestore(r:RemoteRestoreIntent){
  if(active.has(key(r)))throw new Error('This history restore is already owned by an open editor');
  active.set(key(r),null);
}
export function unclaimRemoteRestore(r:RemoteRestoreIntent){active.delete(key(r));}
export function beginRemoteRestore(endpoint:RemoteAttachmentEndpoint,input:{sessionId:string;messageIndex:number;revision:string},restoreEpoch:number):RemoteRestoreIntent{
  recoverRemoteRestoreCleanup();
  if(findRemoteRestore(endpoint,input))throw new Error('This history restore is already owned by an open editor');
  const r={...endpoint,...input,restoreEpoch,cleanup:false,restoreId:crypto.randomUUID().replaceAll('-','')};
  if(!valid(r))throw new Error('Invalid remote restore identity');
  const rows=read();if(rows.length>=256)throw new Error('Remote restore cleanup capacity exhausted');
  write([...rows,r]);claimRemoteRestore(r);return r;
}
export function disposeRemoteRestore(r:RemoteRestoreIntent){
  active.delete(key(r));
  try{write(read().map(item=>key(item)===key(r)?{...item,cleanup:true}:item));}catch{/* Retain exact in-memory cleanup authority. */}
  queue(r);flushComposerAttachmentReleases();
}
export function ownRemoteRestoreRefs(r:RemoteRestoreIntent,ids:string[]){active.set(key(r),new Set(ids));if(!ids.length)disposeRemoteRestore(r);}
export function releasedRemoteRestoreRef(endpoint:RemoteAttachmentEndpoint,sessionId:string,id:string){
  for(const r of read())if(r.connectionId===endpoint.connectionId&&r.digest===endpoint.digest&&r.workspaceIdentity===endpoint.workspaceIdentity&&r.sessionId===sessionId){
    const refs=active.get(key(r));if(refs?.delete(id)&&refs.size===0)disposeRemoteRestore(r);
  }
}
subscribeComposerAttachmentLifecycle(()=>{if(isComposerAttachmentLifecycleEnabled())recoverRemoteRestoreCleanup();});
remoteConnections.subscribe(recoverRemoteRestoreCleanup);
recoverRemoteRestoreCleanup();
