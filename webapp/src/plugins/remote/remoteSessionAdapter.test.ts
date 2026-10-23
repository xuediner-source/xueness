import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteConnectionStore, remoteConnections, remoteSessionKey, remoteWorkspaceKey, type RemoteOwner } from './remoteConnectionStore';
import { RemoteSessionAdapter } from './remoteSessionAdapter';
const owner = (id = 'r', generation = 'g1'): RemoteOwner => ({ connectionId: id, digest: 'digest', generation,
  state: 'connected', workspaceIdentity: 'workspace', capabilities: { durableCommands: true, conversationResume: true, preparedMedia: true } });

test('remote follow-up admission is rechecked after the asynchronous CSRF request before dispatch', async () => {
  const remote = owner('followup-csrf'); remoteConnections.publish(remote, []);
  const adapter = new RemoteSessionAdapter(remote), client = adapter.createCommands(() => true);
  const original = globalThis.fetch; let current = true, writes = 0;
  globalThis.fetch = (async (path: string) => {
    if (path === '/api/csrf') { current = false; return new Response(JSON.stringify({ csrfToken: 'test' })); }
    writes++; throw new Error('A stale turn must never reach the remote gateway');
  }) as typeof fetch;
  try {
    await assert.rejects(client.submit('session', 'queue', { text: 'follow-up', expected_turn_id: 'turn-a' },
      async () => { throw new Error('No local fallback'); }, 'queue-proof',
      { proof: { sessionId: 'session', runCommandId: 'run-a', expectedTurnId: 'turn-a' }, current: () => current }));
    assert.equal(writes, 0);
    assert.deepEqual(adapter.pendingCommands(), []);
  } finally { globalThis.fetch = original; client.dispose(); }
});
test('remote index windows retain missing historical rows and distinct endpoint identity', () => {
  const store = new RemoteConnectionStore();
  store.publish(owner(), [{id: 'same'}, {id: 'older'}]);
  store.publish(owner(), [{id: 'same'}]);
  store.publish(owner('other'), [{id: 'same'}]);
  assert.equal(store.sessions().length, 3);
  assert.notEqual(remoteSessionKey(owner(), 'same'), remoteSessionKey(owner('other'), 'same'));
  store.disconnect('r');
  assert.equal(store.sessions().length, 3);
  assert.equal(store.current(owner()), false);
  assert.equal(store.sessions().find(row => row.owner.connectionId === 'r')?.owner.state,'disconnected');
  store.publish({...owner(),workspaceIdentity:'other-workspace'},[{id:'new'}]);
  assert.equal(store.sessions().find(row => row.session.id === 'older')?.owner.state,'disconnected');
});
test('generation fences retire runtime without changing persisted workspace identity', () => {
  remoteConnections.publish(owner(), []);
  const adapter = new RemoteSessionAdapter(owner());
  assert.equal(adapter.isCurrent(), true);
  remoteConnections.publish(owner('r', 'g2'), []);
  assert.equal(adapter.isCurrent(), false);
  assert.equal(remoteWorkspaceKey(owner()), remoteWorkspaceKey(owner('r', 'g2')));
  assert.notEqual(adapter.runtimeKey, new RemoteSessionAdapter(owner('r', 'g2')).runtimeKey);
});
test('remote preparation rejects local attachment refs before any request', async () => {
  const adapter = new RemoteSessionAdapter(owner('local-ref'));
  remoteConnections.publish(owner('local-ref'),[]);
  await assert.rejects(adapter.prepare('text', {attachments: [], attachmentRefs:[{id:'local'}], files:[],sessions:[],skills:[],plugins:[],goal:false}, {}), /Remote media|remote staged uploads/);
});
test('disconnected adapters and unknown routes never fall back locally', async () => {
  const adapter = new RemoteSessionAdapter(owner('disconnected'));
  await assert.rejects(adapter.conversationRequest('/api/sessions/s/conversation-transport', new AbortController().signal), /unavailable/);
  await assert.rejects(adapter.conversationRequest('/api/sessions/s', new AbortController().signal), /Unsupported/);
});
test('real connect publishes only after verified owner and index, cancellation targets exact operation', async () => {
  const { connectRemote } = await import('./remoteSessionAdapter');
  const original = globalThis.fetch;
  const calls: {path: string; body?: Record<string, unknown>}[] = [];
  let indexRequested = false;
  let activeReads = 0;
  const remote = owner('verified');
  globalThis.fetch = (async (path: string, init?: RequestInit) => {
    calls.push({path, ...(init?.body ? {body:JSON.parse(String(init.body))} : {})});
    let result: unknown;
    if (path === '/api/csrf') result = {csrfToken:'test'};
    else if (path.endsWith('/connect')) result = {requestId:'operation',connectionId:'verified',generation:'g1',status:'connected'};
    else if (path === '/api/remote/active') { assert.equal(remoteConnections.owner('verified'), undefined); result={connections: activeReads++ ? [remote] : []}; }
    else if (path.includes('/sessions?')) { indexRequested=true; result={workspaceIdentity:'workspace',sessions:[{id:'remote-session'}]}; }
    else throw new Error(`unexpected ${path}`);
    return new Response(JSON.stringify(result));
  }) as typeof fetch;
  try {
    const adapter = await connectRemote('verified','digest',new AbortController().signal,() => undefined,'operation');
    assert.equal(indexRequested,true); assert.equal(adapter.isCurrent(),true);
    assert.equal(adapter.sessions[0].id,'remote-session');
    assert.equal(calls.find(row => row.path.endsWith('/connect'))?.body?.requestId,'operation');
  } finally { globalThis.fetch=original; }
});
test('closing during connect cancels the exact request and does not publish a connected owner', async () => {
  const { connectRemote } = await import('./remoteSessionAdapter');
  const original = globalThis.fetch;
  const controller = new AbortController();
  const calls: string[] = [];
  globalThis.fetch = (async (path: string) => {
    calls.push(path);
    if (path === '/api/csrf') return new Response(JSON.stringify({csrfToken:'test'}));
    if (path === '/api/remote/active') return new Response(JSON.stringify({connections:[]}));
    if (path.endsWith('/connect')) {
      controller.abort();
      return new Response(JSON.stringify({requestId:'cancel-me',connectionId:'cancelled',generation:'opaque',status:'connected'}));
    }
    if (path === '/api/remote/operations/cancel-me/cancel') return new Response(JSON.stringify({status:'cancelled'}));
    throw new Error(`unexpected ${path}`);
  }) as typeof fetch;
  try {
    await assert.rejects(connectRemote('cancelled','digest',controller.signal,() => undefined,'cancel-me'), /cancelled/);
    await new Promise(resolve => setTimeout(resolve,0));
    assert.ok(calls.includes('/api/remote/operations/cancel-me/cancel'));
    assert.equal(remoteConnections.owner('cancelled'),undefined);
    assert.equal(calls.filter(path => path === '/api/remote/active').length,1);
  } finally { globalThis.fetch=original; }
});
test('remote command clients never invoke direct local fallback', async () => {
  const adapter = new RemoteSessionAdapter(owner('absent'));
  const client = adapter.createCommands(() => true);
  let calls=0;
  await assert.rejects(client.submitCreate({},async () => {calls++; return {}; }), /unavailable/);
  assert.equal(calls,0); client.dispose();
});
test('paginated index reads beyond fifty and deduplicates overlapping windows', async () => {
  const {connectRemote} = await import('./remoteSessionAdapter');
  const original=globalThis.fetch; let active=0; const pages:number[]=[];
  globalThis.fetch=(async (path:string) => {
    let result:unknown;
    if(path==='/api/csrf') result={csrfToken:'test'};
    else if(path==='/api/remote/active') result={connections:active++ ? [owner('paged')] : []};
    else if(path.endsWith('/connect')) result={requestId:'pages',connectionId:'paged',generation:'g1',status:'connected'};
    else if(path.includes('/sessions?')) {
      const offset=Number(new URL(path,'http://test').searchParams.get('offset')); pages.push(offset);
      result={workspaceIdentity:'workspace',sessions: offset===0 ? Array.from({length:100},(_,n)=>({id:`s${n}`})) : [{id:'s99'},{id:'s100'}],nextOffset:offset===0?100:null};
    } else throw new Error(path);
    return new Response(JSON.stringify(result));
  }) as typeof fetch;
  try { const adapter=await connectRemote('paged','digest',new AbortController().signal,()=>undefined,'pages');
    assert.deepEqual(pages,[0,100]);assert.equal(adapter.sessions.length,101);
  } finally {globalThis.fetch=original;}
});
test('unknown command survives reconnect and only explicit same-scope receipt query retires it', async () => {
  const original=globalThis.fetch; const remote=owner('receipts');remoteConnections.publish(remote,[]);
  let executes=0,queries=0;
  globalThis.fetch=(async (path:string,init?:RequestInit) => {
    if(path==='/api/csrf') return new Response(JSON.stringify({csrfToken:'test'}));
    const body=JSON.parse(String(init?.body));
    if(body.method==='command/execute') {executes++;throw new TypeError('lost reply');}
    if(body.method==='command/query') {queries++;return new Response(JSON.stringify({result:queries<4?'unknown':{commandId:'original',status:'accepted',result:{id:'session',status:'running'}}}));}
    throw new Error(path);
  }) as typeof fetch;
  try {
    const first=new RemoteSessionAdapter(remote);const client=first.createCommands(()=>true);
    await assert.rejects(client.submit('session','run',{},async()=>{throw new Error('local');},'original'));
    assert.equal(first.pendingCommands()[0].commandId,'original');
    client.dispose();const next={...remote,generation:'g2'};remoteConnections.publish(next,[]);
    const adapter=new RemoteSessionAdapter(next);
    assert.equal(adapter.pendingCommands()[0].commandId,'original');
    await adapter.queryReceipt(adapter.pendingCommands()[0]);
    assert.equal(adapter.pendingCommands().length,0);assert.equal(executes,1);assert.equal(queries,4);
    await assert.rejects(new RemoteSessionAdapter(owner('different')).queryReceipt({commandId:'original',sessionId:'session',type:'run',scopeKey:'wrong'}),/another remote/);
  } finally {globalThis.fetch=original;}
});
test('capped index retains historical sessions and reports its incomplete window', async () => {
  const {connectRemote}=await import('./remoteSessionAdapter');
  const remote=owner('capped');remoteConnections.publish(remote,[{id:'historical'}]);
  const original=globalThis.fetch;let pages=0;
  globalThis.fetch=(async(path:string)=>{
    let result:unknown;
    if(path==='/api/csrf')result={csrfToken:'test'};
    else if(path==='/api/remote/active')result={connections:[remote]};
    else if(path.endsWith('/reconnect'))result={requestId:'cap',connectionId:'capped',generation:'g1',status:'connected'};
    else if(path.includes('/sessions?')){const offset=Number(new URL(path,'http://test').searchParams.get('offset'));pages++;result={workspaceIdentity:'workspace',sessions:[{id:`row${offset}`}],nextOffset:offset+100};}
    else throw new Error(path);
    return new Response(JSON.stringify(result));
  })as typeof fetch;
  try{const adapter=await connectRemote('capped','digest',new AbortController().signal,()=>undefined,'cap');
    assert.equal(pages,10);assert.equal(adapter.indexTruncated,true);assert.equal(adapter.sessions.length,11);
    assert.ok(adapter.sessions.some(row=>row.id==='historical'));
  }finally{globalThis.fetch=original;}
});

test('failed and duplicate-failed receipts retain original guards across reconnect', async () => {
  for (const duplicate of [false, true]) {
    const originalFetch = globalThis.fetch;
    const remote = owner(`failed-${duplicate}`); remoteConnections.publish(remote, []);
    let executes = 0;
    let accepted = false;
    const ack = () => ({ commandId: 'original-failed', status: accepted ? 'accepted' : duplicate ? 'duplicate' : 'failed',
      ...(!accepted && duplicate ? { originalStatus: 'failed' } : {}), result: { id: 'session', status: 'running' } });
    globalThis.fetch = (async (path: string, init?: RequestInit) => {
      if (path === '/api/csrf') return new Response(JSON.stringify({ csrfToken: 'test' }));
      const body = JSON.parse(String(init?.body));
      if (body.method === 'command/execute') { executes++; return new Response(JSON.stringify(ack())); }
      if (body.method === 'command/query') return new Response(JSON.stringify({ result: body.params.commandId === 'original-failed' ? ack() : 'unknown' }));
      throw new Error(path);
    }) as typeof fetch;
    const first = new RemoteSessionAdapter(remote), client = first.createCommands(() => true);
    try {
      await assert.rejects(client.submit('session', 'run', {}, async () => assert.fail('local fallback'), 'original-failed'));
      assert.equal(first.pendingCommands()[0]?.commandId, 'original-failed');
      client.dispose();
      const next = { ...remote, generation: 'g2' }; remoteConnections.publish(next, []);
      const adapter = new RemoteSessionAdapter(next), second = adapter.createCommands(() => true);
      await adapter.queryReceipt(adapter.pendingCommands()[0]);
      assert.equal(adapter.pendingCommands().length, 1);
      await assert.rejects(second.submit('session', 'run', {}, async () => assert.fail('local fallback'), 'replacement'));
      assert.equal(executes, 1);
      accepted = true;
      await adapter.queryReceipt(adapter.pendingCommands()[0]);
      assert.equal(adapter.pendingCommands().length, 0);
      second.dispose();
    } finally { client.dispose(); globalThis.fetch = originalFetch; }
  }
});

test('HTTP writer uncertainty retains original identity and never replays on reconnect', async () => {
  const originalFetch = globalThis.fetch, remote = owner('http-uncertain'); remoteConnections.publish(remote, []);
  let executes = 0, queries = 0;
  globalThis.fetch = (async (path: string, init?: RequestInit) => {
    if (path === '/api/csrf') return new Response(JSON.stringify({ csrfToken: 'test' }));
    const body = JSON.parse(String(init?.body));
    if (body.method === 'command/execute') { executes++; return new Response(JSON.stringify({ error: 'remote request refused',
      rpcError: { data: { status: 503, reasonCode: 'command_unknown' } } }), { status: 503 }); }
    if (body.method === 'command/query') { queries++; return new Response(JSON.stringify({ result: 'unknown' })); }
    throw new Error(path);
  }) as typeof fetch;
  const first = new RemoteSessionAdapter(remote), client = first.createCommands(() => true);
  try {
    await assert.rejects(client.submit('session', 'run', {}, async () => assert.fail('local fallback'), 'http-original'));
    assert.equal(first.pendingCommands()[0]?.commandId, 'http-original');
    const next = { ...remote, generation: 'g2' }; remoteConnections.publish(next, []);
    const adapter = new RemoteSessionAdapter(next);
    assert.equal(executes, 1); assert.equal(queries, 0);
    await adapter.queryReceipt(adapter.pendingCommands()[0]);
    assert.equal(adapter.pendingCommands()[0]?.commandId, 'http-original');
    assert.equal(executes, 1); assert.equal(queries, 1);
  } finally { client.dispose(); globalThis.fetch = originalFetch; }
});

test('exact withdrawal escrow settles original remote and command guards; wrong proof cannot', async () => {
  const current = owner('withdraw-proof'); remoteConnections.publish(current, []);
  const adapter = new RemoteSessionAdapter(current), client = adapter.createCommands(() => true);
  const original = globalThis.fetch;
  globalThis.fetch = (async (path: string) => {
    if (path === '/api/csrf') return new Response(JSON.stringify({csrfToken: 'test'}));
    return new Response(JSON.stringify({error: 'uncertain'}), {status: 503});
  }) as typeof fetch;
  try {
    const queueId = 'b'.repeat(32);
    await assert.rejects(client.submitQueue('session', 'withdraw_queue', {queueId, expectedText: 'original', expectedRevision: 7}, async () => { throw new Error('No fallback'); }, () => {}));
    const pending = adapter.pendingCommands()[0]; assert.ok(pending);
    const next = {...current, generation: 'g2'}; remoteConnections.publish(next, []);
    const recovered = new RemoteSessionAdapter(next);
    const proof = { id: pending.commandId, queueId, sessionId: 'session', root: 'workspace', text: 'original', expectedRevision: 7, hasContext: false, createdAt: Date.now() - 1, expiresAt: Date.now() + 60000 };
    for (const changed of [{...proof, text: 'different'}, {...proof, expectedRevision: 8}, {...proof, queueId: 'c'.repeat(32)}, {...proof, root: 'other'}, {...proof, expiresAt: 1}]) assert.equal(recovered.confirmWithdrawalProof('session', changed), false);
    assert.equal(recovered.pendingCommands().length, 1);
    assert.equal(recovered.confirmWithdrawalProof('session', proof), true);
    assert.equal(recovered.pendingCommands().length, 0);
    // The original client is generation-fenced; recovery after reconnect uses
    // a fresh command owner, while the original exact proof remains valid.
    const nextClient = recovered.createCommands(() => true);
    assert.equal(nextClient.confirmQueueWithdrawal('session', 'workspace', proof), true);
    nextClient.dispose();
  } finally { globalThis.fetch = original; client.dispose(); }
});

test('pane disable or owner replacement during CSRF prevents remote mutation dispatch', async () => {
  const original = globalThis.fetch;
  try {
    for (const change of ['disable', 'replace']) {
      const current = {...owner(`csrf-${change}`), capabilities: {guidanceControls: true}};
      remoteConnections.publish(current, []);
      const adapter = new RemoteSessionAdapter(current);
      let enabled = true, dispatches = 0;
      globalThis.fetch = (async (path: string) => {
        if (path === '/api/csrf') {
          if (change === 'disable') enabled = false;
          else remoteConnections.publish({...current, generation: 'replacement'}, []);
          return new Response(JSON.stringify({csrfToken: 'test'}));
        }
        dispatches++; return new Response(JSON.stringify({}));
      }) as typeof fetch;
      await assert.rejects(adapter.request('guidance/send', {sessionId:'session', payload:{}}, undefined, () => enabled), /before dispatch/);
      assert.equal(dispatches, 0);
    }
  } finally { globalThis.fetch = original; }
});

test('mounted mutations retain malformed accepted ACK guards across reconnect until exact proof', async () => {
  const queueId = 'a'.repeat(32), revision = 'sha256:' + 'b'.repeat(64);
  const cases: { type: import('../sessions/commandClient').SessionCommandType; payload: Record<string, unknown>; valid: (id: string) => unknown }[] = [
    { type: 'withdraw_queue', payload: {queueId, expectedText: 'original', expectedRevision: 4}, valid: id => ({id: queueId, removed: true, recoveryId: id}) },
    { type: 'edit_message', payload: {revision, messageIndex: 2, action: 'edit', text: 'changed'}, valid: () => ({id: 'session', messageIndex: 2, action: 'edit', revision}) },
    { type: 'edit_queue', payload: {queueId, text: 'changed'}, valid: () => ({id: queueId, item: {id: queueId, text: 'changed'}}) },
    { type: 'cancel_queue', payload: {queueId}, valid: () => ({id: queueId, removed: true}) },
    { type: 'reorder_queue', payload: {ids: [queueId]}, valid: () => ({ids: [queueId]}) },
    { type: 'queue', payload: {text: 'queued'}, valid: () => ({id: queueId, item: {id: queueId, text: 'queued', status: 'queued', position: 0}}) },
    { type: 'stop', payload: {expected_turn_id: 'turn'}, valid: () => ({stopping: true}) },
    { type: 'approve', payload: {kind: 'write', tool_call_id: 'call', decision: 'approve'}, valid: () => ({approved: {kind: 'write', tool_call_id: 'call'}}) },
    { type: 'approval', payload: {kind: 'write', tool_call_id: 'call', decision: 'approve'}, valid: () => ({approved: {kind: 'write', tool_call_id: 'call'}}) },
    { type: 'reject', payload: {kind: 'write', tool_call_id: 'call', decision: 'reject'}, valid: () => ({rejected: {kind: 'write', tool_call_id: 'call'}}) },
    { type: 'fork', payload: {revision}, valid: () => ({sourceId: 'session', session: {id: 'c'.repeat(32)}, boundary: {turn: 1, preview: 'original'}, historyTruncated: false, truncationReason: null}) },
  ];
  for (const scenario of cases) {
    const remote = owner(`malformed-${scenario.type}`), commandId = `original-${scenario.type}`;
    remoteConnections.publish(remote, []);
    const originalFetch = globalThis.fetch; let executes = 0, valid = false;
    globalThis.fetch = (async (path: string, init?: RequestInit) => {
      if (path === '/api/csrf') return new Response(JSON.stringify({csrfToken: 'test'}));
      const body = JSON.parse(String(init?.body));
      const ack = {commandId, status: 'accepted', result: valid ? scenario.valid(commandId) : {}};
      if (body.method === 'command/execute') { executes++; return new Response(JSON.stringify(ack)); }
      if (body.method === 'command/query') return new Response(JSON.stringify({result: body.params.commandId === commandId ? ack : 'unknown'}));
      throw new Error(path);
    }) as typeof fetch;
    const first = new RemoteSessionAdapter(remote), client = first.createCommands(() => true);
    try {
      await assert.rejects(client.submit('session', scenario.type, scenario.payload, async () => assert.fail('No local fallback'), commandId));
      assert.equal(first.pendingCommands()[0]?.commandId, commandId);
      client.dispose();
      const next = {...remote, generation: 'g2'}; remoteConnections.publish(next, []);
      const adapter = new RemoteSessionAdapter(next);
      await assert.rejects(adapter.queryReceipt(adapter.pendingCommands()[0]));
      assert.equal(adapter.pendingCommands()[0]?.commandId, commandId);
      const second = adapter.createCommands(() => true);
      await assert.rejects(second.submit('session', 'run', {}, async () => assert.fail('No local fallback'), 'replacement'));
      assert.equal(executes, 1);
      valid = true;
      await adapter.queryReceipt(adapter.pendingCommands()[0]);
      assert.equal(adapter.pendingCommands().length, 0);
      second.dispose();
    } finally {client.dispose(); globalThis.fetch = originalFetch;}
  }
});

test('disconnected owner permits only exact-generation terminal disposal and opening receipt recovery', async () => {
  const remote = {...owner('terminal-cleanup'), capabilities: {interactiveTerminals: true}};
  remoteConnections.publish(remote, []);
  const adapter = new RemoteSessionAdapter(remote), originalFetch = globalThis.fetch;
  const methods: string[] = [];
  globalThis.fetch = (async (path: string, init?: RequestInit) => {
    if (path === '/api/csrf') return new Response(JSON.stringify({csrfToken: 'test'}));
    const body = JSON.parse(String(init?.body)); methods.push(body.method);
    if (body.method === 'terminal/open') return new Response(JSON.stringify({error: 'unknown'}), {status: 503});
    return new Response(JSON.stringify(body.method === 'terminal/list' ? {terminals: []} : {closed: true}));
  }) as typeof fetch;
  try {
    await assert.rejects(adapter.request('terminal/open', {sessionId: 'session', openId: 'opening'}));
    assert.equal(adapter.isCurrent(), false);
    await adapter.request('terminal/list', {cleanupOpenId: 'opening'});
    await adapter.request('terminal/cancel-open', {openId: 'opening', sessionId: 'session'});
    await adapter.request('terminal/close', {sessionId: 'session', terminalId: 'a'.repeat(32)});
    for (const [method, params] of [['terminal/open', {}], ['terminal/input', {}], ['terminal/list', {}],
      ['terminal/list', {cleanupOpenId: 'x'.repeat(129)}], ['terminal/list', {cleanupOpenId: 'opening', extra: true}], ['terminal/cancel-open', {openId: 'x'.repeat(129), sessionId: 'session'}],
      ['terminal/cancel-open', {openId: 'opening', sessionId: 'session', extra: true}]] as const) {
      await assert.rejects(adapter.request(method, params));
    }
    for (const changed of [{...remote, generation: 'new'}, {...remote, digest: 'changed'}, {...remote, workspaceIdentity: 'other'}]) {
      remoteConnections.publish({...changed, state: 'disconnected'}, []);
      await assert.rejects(adapter.request('terminal/close', {sessionId: 'session', terminalId: 'a'.repeat(32)}));
      await assert.rejects(adapter.request('terminal/list', {cleanupOpenId: 'opening'}));
      await assert.rejects(adapter.request('terminal/cancel-open', {openId: 'opening', sessionId: 'session'}));
    }
    assert.deepEqual(methods, ['terminal/open', 'terminal/list', 'terminal/cancel-open', 'terminal/close']);
  } finally {globalThis.fetch = originalFetch;}
});

test('browser close cleanup requires exact target shape and original owner; other browser methods remain fenced', async () => {
  const remote = {...owner('browser-cleanup'), capabilities: {browserTabs: true}};
  remoteConnections.publish({...remote, state: 'disconnected'}, []);
  const adapter = new RemoteSessionAdapter(remote), originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (path: string, init?: RequestInit) => {
    if (path === '/api/csrf') return new Response(JSON.stringify({csrfToken: 'test'}));
    calls.push(JSON.parse(String(init?.body)).method); return new Response(JSON.stringify({closed: true}));
  }) as typeof fetch;
  try {
    await adapter.request('browser/close', {pageId: 'a'.repeat(32), sessionId: 'session'});
    await adapter.request('browser/cancel-open', {openId: 'a'.repeat(32), sessionId: 'b'.repeat(32)});
    for (const [method, params] of [['browser/open', {}], ['browser/navigate', {}], ['browser/list', {}],
      ['browser/cancel-open', {openId: 'invalid', sessionId: 'b'.repeat(32)}],
      ['browser/cancel-open', {openId: 'a'.repeat(32), sessionId: 'b'.repeat(32), extra: true}],
      ['browser/close', {pageId: 'invalid', sessionId: 'session'}], ['browser/close', {pageId: 'a'.repeat(32), sessionId: 'session', extra: true}]] as const) await assert.rejects(adapter.request(method, params));
    remoteConnections.publish({...remote, generation: 'other', state: 'disconnected'}, []);
    await assert.rejects(adapter.request('browser/close', {pageId: 'a'.repeat(32), sessionId: 'session'}));
    await assert.rejects(adapter.request('browser/cancel-open', {openId: 'a'.repeat(32), sessionId: 'b'.repeat(32)}));
    assert.deepEqual(calls, ['browser/close', 'browser/cancel-open']);
  } finally {globalThis.fetch = originalFetch;}
});

test('explicit turn-fenced safety stop sends once without releasing unknown original write', async () => {
  const remote = owner('safety-stop'); remoteConnections.publish(remote, []);
  const adapter = new RemoteSessionAdapter(remote), client = adapter.createCommands(() => true);
  const originalFetch = globalThis.fetch; const writes: {commandId: string; type: string}[] = [];
  let malformedStop = false;
  globalThis.fetch = (async (path: string, init?: RequestInit) => {
    if (path === '/api/csrf') return new Response(JSON.stringify({csrfToken: 'test'}));
    const {method, params} = JSON.parse(String(init?.body));
    if (method === 'command/query') return new Response(JSON.stringify({result: 'unknown'}));
    writes.push({commandId: params.commandId, type: params.type});
    if (params.type === 'send') throw new TypeError('lost original reply');
    if (params.payload.expected_turn_id === 'stale-turn') return new Response(JSON.stringify({commandId: params.commandId, status: 'stale', reasonCode: 'stale_turn'}));
    return new Response(JSON.stringify({commandId: params.commandId, status: 'accepted', result: malformedStop ? {} : {stopping: true}}));
  }) as typeof fetch;
  const unused = async () => assert.fail('No local fallback');
  try {
    await assert.rejects(client.submit('session', 'send', {text: 'original'}, unused, 'original'));
    const original = adapter.pendingCommands()[0];
    assert.equal(original.commandId, 'original');
    for (const payload of [{}, {expected_turn_id: null}, {expected_turn_id: 4}, {expected_turn_id: ''}, {expected_turn_id: '   '}, {expected_turn_id: 'x'.repeat(129)}]) {
      await assert.rejects(client.submit('session', 'stop', payload, unused));
    }
    await assert.rejects(adapter.createCommands(() => true).submit('session', 'stop', {expected_turn_id: 'active-turn'}, unused, 'original'));
    assert.equal(writes.length, 1);
    assert.deepEqual(await client.submit('session', 'stop', {expected_turn_id: 'active-turn'}, unused, 'safety-stop'), {stopping: true});
    assert.deepEqual(adapter.pendingCommands().map(row => row.commandId), ['original']);
    assert.strictEqual(adapter.pendingCommands()[0], original);
    await assert.rejects(client.submit('session', 'stop', {expected_turn_id: 'stale-turn'}, unused, 'stale-stop'));
    assert.deepEqual(adapter.pendingCommands().map(row => row.commandId), ['original']);
    await assert.rejects(client.submit('session', 'run', {}, unused, 'new-run'));
    malformedStop = true;
    await assert.rejects(client.submit('session', 'stop', {expected_turn_id: 'active-turn'}, unused, 'malformed-stop'));
    assert.deepEqual(adapter.pendingCommands().map(row => row.commandId), ['original', 'malformed-stop']);
    assert.deepEqual(writes, [{commandId: 'original', type: 'send'}, {commandId: 'safety-stop', type: 'stop'},
      {commandId: 'stale-stop', type: 'stop'}, {commandId: 'malformed-stop', type: 'stop'}]);
  } finally {client.dispose(); globalThis.fetch = originalFetch;}
});

test('503-disconnected exact owner admits only explicit observed-turn Stop while reads and other writes stay disabled', async () => {
  const remote = owner('disconnected-safety-stop'); remoteConnections.publish(remote, []);
  const adapter = new RemoteSessionAdapter(remote), first = adapter.createCommands(() => true);
  const originalFetch = globalThis.fetch; const calls: {method: string; type?: string; commandId?: string}[] = [];
  let eligible = true;
  const stop = adapter.createCommands(() => false, () => eligible);
  globalThis.fetch = (async (path: string, init?: RequestInit) => {
    if (path === '/api/csrf') return new Response(JSON.stringify({csrfToken: 'test'}));
    const {method, params} = JSON.parse(String(init?.body));
    calls.push({method, type: params.type, commandId: params.commandId});
    if (params.type === 'send') return new Response(JSON.stringify({error: 'unknown write'}), {status: 503});
    return new Response(JSON.stringify({commandId: params.commandId, status: 'accepted', result: {stopping: true}}));
  }) as typeof fetch;
  const unused = async () => assert.fail('No fallback');
  try {
    await assert.rejects(first.submit('session', 'send', {text: 'original'}, unused, 'before-503'));
    assert.equal(adapter.isCurrent(), false);
    assert.equal(stop.isEffective(), false);
    assert.equal(adapter.isSafetyStopAvailable(), true);
    const pending = adapter.pendingCommands()[0];
    await assert.rejects(stop.query('session', 'before-503'));
    await assert.rejects(stop.submit('session', 'run', {}, unused, 'not-run'));
    await assert.rejects(stop.submit('session', 'stop', {expected_turn_id: null}, unused, 'not-stop'));
    await assert.rejects(stop.submit('session', 'stop', {expected_turn_id: 'turn', extra: true}, unused, 'extra-stop'));
    assert.deepEqual(await stop.submit('session', 'stop', {expected_turn_id: 'turn'}, unused, 'after-503-stop'), {stopping: true});
    assert.deepEqual(adapter.pendingCommands().map(row => row.commandId), ['before-503']);
    assert.strictEqual(adapter.pendingCommands()[0], pending);
    assert.equal(adapter.isCurrent(), false);
    for (const [method, params] of [['session/read', {sessionId: 'session'}], ['command/query', {sessionId: 'session', commandId: 'before-503'}],
      ['command/execute', {sessionId: 'session', commandId: 'wrong', type: 'run', payload: {}}],
      ['command/execute', {sessionId: 'session', commandId: 'wrong', type: 'stop', payload: {expected_turn_id: ''}}]] as const) await assert.rejects(adapter.request(method, params));
    eligible = false;
    await assert.rejects(stop.submit('session', 'stop', {expected_turn_id: 'turn'}, unused, 'retired-pane-stop'));
    eligible = true;
    remoteConnections.publish({...remote, generation: 'new', state: 'disconnected'}, []);
    assert.equal(adapter.isSafetyStopAvailable(), false);
    await assert.rejects(stop.submit('session', 'stop', {expected_turn_id: 'turn'}, unused, 'old-owner-stop'));
    assert.deepEqual(calls, [{method: 'command/execute', type: 'send', commandId: 'before-503'},
      {method: 'command/execute', type: 'stop', commandId: 'after-503-stop'}]);
  } finally {first.dispose(); stop.dispose(); globalThis.fetch = originalFetch;}
});
