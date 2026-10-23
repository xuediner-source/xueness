import test from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteWorkflowTransport } from './remoteWorkflowTransport';
import { createRemoteHistoryMediaTransport } from './remoteMediaTransport';
import type { RemoteSessionAdapter } from './remoteSessionAdapter';
const restoreStorage = new Map<string,string>();
Object.defineProperty(globalThis, 'sessionStorage', {configurable:true,value:{
  getItem:(key:string)=>restoreStorage.get(key)??null,setItem:(key:string,value:string)=>{restoreStorage.set(key,value);},removeItem:(key:string)=>{restoreStorage.delete(key);},clear:()=>restoreStorage.clear(),
}});
function fixture(request: (method: string, params: Record<string, unknown>) => Promise<unknown>) {
  return createRemoteWorkflowTransport({ owner: { connectionId: crypto.randomUUID(), digest: 'config', workspaceIdentity: 'workspace' }, request, confirmWithdrawalProof: () => true } as unknown as RemoteSessionAdapter);
}
test('lost exact-question answer recovers by query without another mutation', async () => {
  const calls: string[] = [];
  const workflow = fixture(async (method, params) => {
    calls.push(method); assert.equal(params.sessionId, 'session');
    if (method === 'question/answer') throw new TypeError('lost response');
    return { questionId: 'q', result: 'accepted' };
  });
  const result = await workflow.question.answer('session', 'q', 'yes');
  assert.equal(result.accepted, true);
  assert.deepEqual(calls, ['question/answer', 'question/query']);
});
test('unknown answer and guidance retain identity guards and never resend', async () => {
  const calls: string[] = [];
  const workflow = fixture(async method => { calls.push(method); throw new TypeError('lost'); });
  await assert.rejects(workflow.question.answer('session', 'q', 'yes'));
  await assert.rejects(workflow.question.answer('session', 'q', 'changed'));
  assert.equal(calls.filter(c => c === 'question/answer').length, 1);
  assert.equal((await workflow.guidance.send('session', 'turn', 'one')).ok, false);
  assert.equal((await workflow.guidance.send('session', 'turn', 'two')).ok, false);
  assert.equal(calls.filter(c => c === 'guidance/send').length, 1);
});
test('withdrawal plaintext requires exact workspace session and recovery identity', async () => {
  const id = 'c_1760000000000_' + 'a'.repeat(32);
  const metadata = { id, queueId: 'b'.repeat(32), sessionId: 'session', root: 'workspace', hasContext: false, expectedRevision: 1, createdAt: 1, expiresAt: 2, text: 'original' };
  const workflow = fixture(async () => ({ withdrawal: metadata }));
  assert.equal((await workflow.withdrawal.get('session', 'workspace', id)).text, 'original');
  await assert.rejects(workflow.withdrawal.get('other', 'workspace', id));
  await assert.rejects(workflow.withdrawal.get('session', '/physical/root', id));
});
test('history restore binds remote ownership; preview refuses cross-session ref without request', async () => {
  const calls: string[] = [];
  const endpoint = { connectionId: 'connection', digest: 'config', workspaceIdentity: 'workspace' };
  const media = createRemoteHistoryMediaTransport(endpoint, async method => {
    calls.push(method); return { text: 'saved', refs: [{ id: 'a'.repeat(32), token: 'a'.repeat(32), name: 'note.txt', mimeType: 'text/plain', size: 1, origin: 'file', source: 'upload' }] };
  });
  const restored = await media.restore('session', 1, 'sha256:' + 'a'.repeat(64), 'draft', undefined, 'a'.repeat(32), 1);
  assert.equal(restored.refs[0].remoteOwner.sessionId, 'session');
  await assert.rejects(media.preview('other', restored.refs[0]));
  assert.deepEqual(calls, ['media/restore']);
  await media.preview('session', restored.refs[0]);
  assert.deepEqual(calls, ['media/restore', 'media/preview']);
});

test('changed answer cannot reuse an unknown original answer acceptance', async () => {
  const calls: {method: string; params: Record<string, unknown>}[] = [];
  let accepted = false;
  const workflow = fixture(async (method, params) => {
    calls.push({method, params});
    if (method === 'question/answer') throw new TypeError('lost response');
    return {questionId:'q',result:accepted ? 'accepted' : 'unknown'};
  });
  await assert.rejects(workflow.question.answer('session','q','A'));
  accepted = true;
  await assert.rejects(workflow.question.answer('session','q','B'), /changed answer has not been sent/);
  assert.equal(calls.length,2);
  assert.equal((await workflow.question.answer('session','q','A')).accepted,true);
  assert.deepEqual(calls[2].params.payload,{answer:'A'});
});

test('exact original guidance receipt clears unknown without resending and missing receipt retains guard', async () => {
  let original: Record<string, unknown> | undefined, accepted = false, writes = 0;
  const workflow = fixture(async (method, params) => {
    if (method === 'guidance/send') { writes++; original = params.payload as Record<string,unknown>; throw new TypeError('lost'); }
    if (method === 'guidance/query') {
      const query = params.payload as {payload: Record<string,unknown>};
      assert.deepEqual(query.payload, original);
      return {requestId: original!.request_id, result:accepted ? 'accepted':'unknown', ...(accepted ? {receipt:{id:'a'.repeat(32),item:{id:'a'.repeat(32),text:'one',delivery:'guide',targetTurnId:'turn',status:'queued',position:1}}}: {})};
    }
    return {pending_guidance:[],guidance_history:[]};
  });
  assert.equal((await workflow.guidance.send('session','turn','one')).ok,false);
  assert.equal((await workflow.guidance.reconcile('session')).result,'unknown');
  assert.equal((await workflow.guidance.send('session','turn','two')).ok,false);
  assert.equal(writes,1);
  accepted = true;
  assert.equal((await workflow.guidance.reconcile('session')).result,'accepted');
  assert.equal((await workflow.guidance.reconcile('session')).result,'none');
  assert.equal(writes,1);
});

test('cancel unknown reconciles exact guidance identity without repeat delete', async () => {
  const calls: string[] = [];
  const workflow = fixture(async (method, params) => {
    calls.push(method);
    if(method === 'guidance/cancel') throw new TypeError('lost');
    assert.deepEqual(params.payload,{operation:'cancel',guidanceId:'item'});
    return {requestId:'item',result:'accepted',receipt:{id:'item',removed:true}};
  });
  await assert.rejects(workflow.guidance.cancel('session','item'));
  assert.equal((await workflow.guidance.reconcile('session')).result,'accepted');
  assert.deepEqual(calls,['guidance/cancel','guidance/query']);
});

test('delayed reconciliation of old operation cannot clear a new unknown guard', async () => {
  let old: Record<string,unknown> | undefined, writes=0, queries=0;
  let release!: (value: unknown) => void;
  const delayed = new Promise(resolve => {release=resolve;});
  const receipt = () => ({requestId:old!.request_id,result:'accepted',receipt:{id:'a'.repeat(32),item:{id:'a'.repeat(32),text:'old',delivery:'guide',targetTurnId:'turn',status:'queued',position:1}}});
  const workflow = fixture(async (method,params) => {
    if(method==='guidance/send') {writes++; if(!old) old=params.payload as Record<string,unknown>; throw new TypeError('lost');}
    if(method==='guidance/query') {queries++; return queries===1 ? delayed : receipt();}
    throw new Error('unexpected');
  });
  await workflow.guidance.send('session','turn','old');
  const stale=workflow.guidance.reconcile('session');
  assert.equal((await workflow.guidance.reconcile('session')).result,'accepted');
  await workflow.guidance.send('session','turn','new');
  release(receipt());
  await assert.rejects(stale);
  await workflow.guidance.send('session','turn','third');
  assert.equal(writes,2);
});

test('late remote restore retains disposal through pane disable and lifecycle suspension', async () => {
  const {RemoteSessionAdapter} = await import('./remoteSessionAdapter');
  const {remoteConnections} = await import('./remoteConnectionStore');
  const {createRemoteMessageEditAttachmentTransport} = await import('./remoteWorkflowTransport');
  const {setComposerAttachmentLifecycleEnabled} = await import('../sessions/composerAttachmentLifecycle');
  const owner = {connectionId:'late-restore',digest:'config',generation:'original',workspaceIdentity:'workspace',state:'connected',capabilities:{historyMedia:true,stagedMedia:true}};
  remoteConnections.publish(owner,[]);
  const original = globalThis.fetch, calls: Record<string,unknown>[]=[];
  let pane=true; let restoreBody: Record<string,unknown>;
  const ref={id:'d'.repeat(32),token:'d'.repeat(32),name:'note.txt',mimeType:'text/plain',size:1,origin:'file',source:'upload'};
  const transport=createRemoteMessageEditAttachmentTransport(new RemoteSessionAdapter(owner),()=>pane);
  setComposerAttachmentLifecycleEnabled(false);
  globalThis.fetch=(async(path:string,init?:RequestInit)=>{
    if(path==='/api/csrf') return new Response(JSON.stringify({csrfToken:'test'}));
    const body=JSON.parse(String(init?.body));
    if(body.method==='media/restore-epoch') return Response.json({sessionId:'session',root:'workspace',restoreEpoch:1});
    calls.push(body);
    if(body.method==='media/restore') {restoreBody=body.params.payload; pane=false; return new Response(JSON.stringify({text:'saved',root:'/remote/root',refs:[ref]}));}
    assert.equal(body.expectedGeneration,'original');
    assert.deepEqual(body.params.payload,restoreBody);
    return new Response(JSON.stringify({...restoreBody,sessionId:'session',root:'workspace',status:body.method==='media/restore-status'?'committed':'aborted',cleanupComplete:body.method==='media/restore-abort',result:{text:'saved',root:'/remote/root',refs:[ref]}}));
  }) as typeof fetch;
  try {
    await assert.rejects(transport.restore({sessionId:'session',messageIndex:0,revision:'sha256:'+'a'.repeat(64)},()=>pane));
    assert.equal(calls.length,1);
    setComposerAttachmentLifecycleEnabled(true);
    await new Promise(resolve=>setTimeout(resolve,0));
    assert.deepEqual(calls.map(c=>c.method),['media/restore','media/restore-status','media/restore-abort']);
    await assert.rejects(transport.cleanup('/api/composer/attachments/begin',{root:'workspace',session_id:'session',id:ref.id}));
  } finally {setComposerAttachmentLifecycleEnabled(false);globalThis.fetch=original;}
});

test('late commit cleanup reconciles lost abort by status then releases original owner only', async () => {
  const {RemoteSessionAdapter} = await import('./remoteSessionAdapter');
  const {remoteConnections} = await import('./remoteConnectionStore');
  const {createRemoteMessageEditAttachmentTransport} = await import('./remoteWorkflowTransport');
  const {setComposerAttachmentLifecycleEnabled} = await import('../sessions/composerAttachmentLifecycle');
  const owner={connectionId:'late-commit',digest:'config',generation:'original',workspaceIdentity:'workspace',state:'connected',capabilities:{stagedMedia:true}};
  remoteConnections.publish(owner,[]);
  let pane=true; const calls:string[]=[]; const original=globalThis.fetch;
  const ref={id:'e'.repeat(32),token:'e'.repeat(32),name:'note.txt',mimeType:'text/plain',size:1,origin:'file',source:'upload'};
  const transport=createRemoteMessageEditAttachmentTransport(new RemoteSessionAdapter(owner),()=>pane);
  setComposerAttachmentLifecycleEnabled(true);
  globalThis.fetch=(async(path:string,init?:RequestInit)=>{
    if(path==='/api/csrf') return new Response(JSON.stringify({csrfToken:'test'}));
    const body=JSON.parse(String(init?.body)); calls.push(body.method); assert.equal(body.expectedGeneration,'original');
    if(body.method==='media/commit') {pane=false;return new Response(JSON.stringify({status:'committed',ref}));}
    if(body.method==='media/abort') throw new TypeError('lost abort response');
    if(body.method==='media/status') return new Response(JSON.stringify({status:'committed',ref}));
    if(body.method==='media/release') return new Response(JSON.stringify({released:true}));
    throw new Error('unexpected');
  }) as typeof fetch;
  try {
    await assert.rejects(transport.upload('/api/composer/attachments/commit',{root:'workspace',session_id:'session',id:ref.id}));
    await new Promise(resolve=>setTimeout(resolve,0));
    assert.deepEqual(calls,['media/commit','media/abort','media/status','media/release']);
    remoteConnections.publish({...owner,generation:'replacement'},[]);
    await assert.rejects(transport.cleanup('/api/composer/attachments/release',{root:'workspace',session_id:'session',id:ref.id}));
    assert.equal(calls.length,4);
  } finally {setComposerAttachmentLifecycleEnabled(false);globalThis.fetch=original;}
});

test('lost restore response queries original durable identity without a second restore', async()=>{
  const {RemoteSessionAdapter}=await import('./remoteSessionAdapter');
  const {remoteConnections}=await import('./remoteConnectionStore');
  const {createRemoteMessageEditAttachmentTransport}=await import('./remoteWorkflowTransport');
  const {setComposerAttachmentLifecycleEnabled}=await import('../sessions/composerAttachmentLifecycle');
  const owner={connectionId:'lost-receipt',digest:'config',generation:'original',workspaceIdentity:'workspace',state:'connected',capabilities:{historyMedia:true,stagedMedia:true}};
  remoteConnections.publish(owner,[]);const original=globalThis.fetch,calls:string[]=[];let identity:Record<string,unknown>;
  const ref={id:'f'.repeat(32),token:'f'.repeat(32),name:'note.txt',mimeType:'text/plain',size:1,origin:'file',source:'upload'};
  const transport=createRemoteMessageEditAttachmentTransport(new RemoteSessionAdapter(owner),()=>true);
  setComposerAttachmentLifecycleEnabled(true);
  globalThis.fetch=(async(path:string,init?:RequestInit)=>{
    if(path==='/api/csrf')return new Response(JSON.stringify({csrfToken:'test'}));
    const body=JSON.parse(String(init?.body));
    if(body.method==='media/restore-epoch') return Response.json({sessionId:'session',root:'workspace',restoreEpoch:1});
    calls.push(body.method);
    if(body.method==='media/restore'){identity=body.params.payload;assert.ok([...restoreStorage.values()].some(v=>v.includes(String(identity.restoreId))));throw new TypeError('lost response');}
    if(body.method==='media/release')return new Response(JSON.stringify({ok:true}));
    assert.deepEqual(body.params.payload,identity);
    return new Response(JSON.stringify({...identity,sessionId:'session',root:'workspace',status:body.method==='media/restore-abort'?'aborted':'committed',cleanupComplete:body.method==='media/restore-abort',result:{text:'saved',root:'/remote/root',refs:[ref]}}));
  }) as typeof fetch;
  try{
    const result=await transport.restore({sessionId:'session',messageIndex:1,revision:'sha256:'+'a'.repeat(64)},()=>true);
    assert.ok('refs' in result); assert.equal(result.refs[0].id,ref.id);assert.deepEqual(calls,['media/restore','media/restore-status']);
    await transport.cleanup('/api/composer/attachments/release',{root:'workspace',session_id:'session',id:ref.id});
    await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(calls.filter(c=>c==='media/restore').length,1);assert.equal(calls.at(-1),'media/restore-abort');
  }finally{setComposerAttachmentLifecycleEnabled(false);globalThis.fetch=original;}
});

test('persisted abandoned restore recovers only matching remote configuration after reconnect',async()=>{
  const {remoteConnections}=await import('./remoteConnectionStore');
  const {recoverRemoteRestoreCleanup,REMOTE_RESTORE_STORAGE_KEY}=await import('./remoteRestoreLedger');
  const {setComposerAttachmentLifecycleEnabled}=await import('../sessions/composerAttachmentLifecycle');
  const intent={cleanup:true,restoreEpoch:1,connectionId:'reload-receipt',digest:'original-config',workspaceIdentity:'workspace',sessionId:'session',restoreId:'9'.repeat(32),messageIndex:1,revision:'sha256:'+'a'.repeat(64)};
  restoreStorage.set(REMOTE_RESTORE_STORAGE_KEY,JSON.stringify([intent]));
  const original=globalThis.fetch,calls:Record<string,unknown>[]=[];
  const owner={connectionId:intent.connectionId,digest:'wrong-config',generation:'new-generation',workspaceIdentity:'workspace',state:'connected',capabilities:{historyMedia:true}};
  globalThis.fetch=(async(path:string,init?:RequestInit)=>{
    if(path==='/api/csrf')return new Response(JSON.stringify({csrfToken:'test'}));
    const body=JSON.parse(String(init?.body));calls.push(body);assert.equal(body.expectedDigest,intent.digest);assert.equal(body.expectedGeneration,'new-generation');
    return new Response(JSON.stringify({...intent,root:'workspace',status:body.method==='media/restore-status'?'preparing':'aborted',cleanupComplete:body.method==='media/restore-abort'}));
  }) as typeof fetch;
  try{
    remoteConnections.publish(owner,[]);setComposerAttachmentLifecycleEnabled(true);recoverRemoteRestoreCleanup();
    await new Promise(resolve=>setTimeout(resolve,0));assert.equal(calls.length,0);
    remoteConnections.publish({...owner,digest:intent.digest},[]);recoverRemoteRestoreCleanup();
    await new Promise(resolve=>setTimeout(resolve,0));assert.deepEqual(calls.map(c=>c.method),['media/restore-status','media/restore-abort']);
    assert.equal(restoreStorage.get(REMOTE_RESTORE_STORAGE_KEY),'[]');
  }finally{setComposerAttachmentLifecycleEnabled(false);globalThis.fetch=original;}
});

test('cloned active remote restore hydrates without cleanup and reopens by exact old epoch query', async () => {
  const { remoteConnections } = await import('./remoteConnectionStore');
  const { RemoteSessionAdapter } = await import('./remoteSessionAdapter');
  const { createRemoteMessageEditAttachmentTransport } = await import('./remoteWorkflowTransport');
  const { recoverRemoteRestoreCleanup, REMOTE_RESTORE_STORAGE_KEY } = await import('./remoteRestoreLedger');
  const { setComposerAttachmentLifecycleEnabled } = await import('../sessions/composerAttachmentLifecycle');
  const intent = { cleanup: false, restoreEpoch: 3, connectionId: 'clone-active', digest: 'config', workspaceIdentity: 'workspace', sessionId: 'session', restoreId: '8'.repeat(32), messageIndex: 2, revision: 'sha256:' + 'a'.repeat(64) };
  restoreStorage.set(REMOTE_RESTORE_STORAGE_KEY, JSON.stringify([intent]));
  const owner = { connectionId: intent.connectionId, digest: intent.digest, generation: 'reconnected', workspaceIdentity: 'workspace', state: 'connected', capabilities: { historyMedia: true, stagedMedia: true } };
  const previous = globalThis.fetch; const calls: string[] = [];
  const ref = { id: '7'.repeat(32), token: '7'.repeat(32), name: 'note.txt', mimeType: 'text/plain', size: 1, origin: 'file', source: 'upload' };
  globalThis.fetch = async (path, init) => {
    if (path === '/api/csrf') return Response.json({ csrfToken: 'test' });
    const body = JSON.parse(String(init?.body)); calls.push(body.method);
    assert.equal(body.params.payload.restoreEpoch, 3);
    assert.equal(body.params.payload.restoreId, intent.restoreId);
    return Response.json({ ...intent, root: 'workspace', status: 'committed', result: { text: 'saved', root: '/physical', refs: [ref] } });
  };
  try {
    remoteConnections.publish(owner, []); setComposerAttachmentLifecycleEnabled(true); recoverRemoteRestoreCleanup();
    await new Promise(resolve => setTimeout(resolve, 0)); assert.deepEqual(calls, []);
    const transport = createRemoteMessageEditAttachmentTransport(new RemoteSessionAdapter(owner));
    const restored = await transport.restore({ sessionId: 'session', messageIndex: 2, revision: intent.revision }, () => true);
    assert.ok('refs' in restored); assert.equal(restored.refs[0].id, ref.id);
    assert.deepEqual(calls, ['media/restore-status']);
    assert.equal(JSON.parse(restoreStorage.get(REMOTE_RESTORE_STORAGE_KEY)!)[0].cleanup, false);
  } finally { setComposerAttachmentLifecycleEnabled(false); globalThis.fetch = previous; restoreStorage.clear(); }
});

test('remote cleanup rejects mismatched epoch proof before aborting across reconnect', async () => {
  const { remoteConnections } = await import('./remoteConnectionStore');
  const { recoverRemoteRestoreCleanup, REMOTE_RESTORE_STORAGE_KEY } = await import('./remoteRestoreLedger');
  const { setComposerAttachmentLifecycleEnabled } = await import('../sessions/composerAttachmentLifecycle');
  const intent = { cleanup: true, restoreEpoch: 4, connectionId: 'epoch-proof', digest: 'config', workspaceIdentity: 'workspace', sessionId: 'deleted-session', restoreId: '6'.repeat(32), messageIndex: 2, revision: 'sha256:' + 'a'.repeat(64) };
  restoreStorage.set(REMOTE_RESTORE_STORAGE_KEY, JSON.stringify([intent]));
  const previous = globalThis.fetch; const calls: string[] = [];
  globalThis.fetch = async (path, init) => {
    if (path === '/api/csrf') return Response.json({ csrfToken: 'test' });
    const body = JSON.parse(String(init?.body)); calls.push(body.method);
    return Response.json({ ...intent, restoreEpoch: 5, root: 'workspace', status: 'committed' });
  };
  try {
    remoteConnections.publish({ connectionId: intent.connectionId, digest: intent.digest, generation: 'new', workspaceIdentity: 'workspace', state: 'connected', capabilities: { historyMedia: true } }, []);
    setComposerAttachmentLifecycleEnabled(true); recoverRemoteRestoreCleanup();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(calls, ['media/restore-status']);
    assert.equal(JSON.parse(restoreStorage.get(REMOTE_RESTORE_STORAGE_KEY)!)[0].restoreEpoch, 4);
  } finally { setComposerAttachmentLifecycleEnabled(false); remoteConnections.publish({ connectionId: intent.connectionId, digest: intent.digest, generation: 'new', workspaceIdentity: 'workspace', state: 'disconnected', capabilities: { historyMedia: true } }, []); globalThis.fetch = previous; }
});

test('retired remote restore stays query-only until explicit cancellation', async () => {
  const { remoteConnections } = await import('./remoteConnectionStore');
  const { RemoteSessionAdapter } = await import('./remoteSessionAdapter');
  const { createRemoteMessageEditAttachmentTransport } = await import('./remoteWorkflowTransport');
  const { REMOTE_RESTORE_STORAGE_KEY } = await import('./remoteRestoreLedger');
  const { setComposerAttachmentLifecycleEnabled } = await import('../sessions/composerAttachmentLifecycle');
  const intent = { cleanup: false, restoreEpoch: 0, connectionId: 'retired-clone', digest: 'config', workspaceIdentity: 'workspace', sessionId: 'session', restoreId: '3'.repeat(32), messageIndex: 2, revision: 'sha256:' + 'a'.repeat(64) };
  restoreStorage.set(REMOTE_RESTORE_STORAGE_KEY, JSON.stringify([intent]));
  const owner = { connectionId: intent.connectionId, digest: intent.digest, generation: 'new', workspaceIdentity: 'workspace', state: 'connected', capabilities: { historyMedia: true } };
  const previous = globalThis.fetch; const calls: string[] = [];
  globalThis.fetch = async (path, init) => {
    if (path === '/api/csrf') return Response.json({ csrfToken: 'test' });
    const body = JSON.parse(String(init?.body)); calls.push(body.method);
    assert.equal(body.params.payload.restoreEpoch, 0);
    return Response.json({ ...intent, root: 'workspace', status: 'aborted', cleanupComplete: true });
  };
  try {
    remoteConnections.publish(owner, []); setComposerAttachmentLifecycleEnabled(true);
    const transport = createRemoteMessageEditAttachmentTransport(new RemoteSessionAdapter(owner));
    const draft = await transport.restore({ sessionId: 'session', messageIndex: 2, revision: intent.revision }, () => true);
    assert.deepEqual(calls, ['media/restore-status']);
    assert.equal(JSON.parse(restoreStorage.get(REMOTE_RESTORE_STORAGE_KEY)!)[0].cleanup, false);
    draft.disposeRestore(); await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(calls, ['media/restore-status', 'media/restore-status']);
    assert.equal(restoreStorage.get(REMOTE_RESTORE_STORAGE_KEY), '[]');
  } finally { setComposerAttachmentLifecycleEnabled(false); globalThis.fetch = previous; }
});
