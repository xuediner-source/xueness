import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getRunChoices, setRunChoices, type RunChoices } from '../../xuenessBridge';
import type { ComposerInput } from '../../xuenessComposer';
import { SessionCommandClient } from './commandClient';
import { CommandReceiptLedger } from './commandLedger';
import { DeliveryUnconfirmedError } from './submissionTransport';
import {
  SecondaryPaneComposer,
  PaneComposer,
  secondaryComposerDraftKey,
  stopSecondaryPane,
  submitSecondaryPaneTurn,
  submitPaneDraftTurn,
  paneDraftAdmission,
  remotePaneCreationReady,
  recoverPaneDraftCreation,
  restorePaneWithdrawalDraft,
} from './secondaryPaneComposer';
import { RemoteSessionAdapter } from '../remote/remoteSessionAdapter';
import { remoteConnections, remoteWorkspaceKey } from '../remote/remoteConnectionStore';
import { paneDraftAddress } from './paneIdentity';

const sessionA = 'a'.repeat(32);
const sessionB = 'b'.repeat(32);
const attachmentId = 'c'.repeat(32);

function accepted(commandId: string, result: unknown) {
  return { commandId, status: 'accepted', result };
}

test('secondary recovered active-run follow-up is fenced to its turn and preparation rebind cannot dispatch',async()=>{
 const values=new Map<string,string>(),storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);}};
 const ledger=new CommandReceiptLedger('secondary-followup',storage);await ledger.admit(sessionA,'original-run','run',{});
 let prepares=0,accepts=0;const bodies:Record<string,unknown>[]=[];
 const commands=new SessionCommandClient({receiptScope:'secondary-followup',receiptStorage:storage,isEffective:()=>true,
   post:async(_path,value)=>{const body=value as {commandId:string;payload:Record<string,unknown>};bodies.push(body.payload);
     return accepted(body.commandId,{id:'q',item:{id:'q',text:body.payload.text,status:'queued',position:0}});},get:async()=>({result:'unknown'})});
 const proof={sessionId:sessionA,runCommandId:'original-run',expectedTurnId:'turn'};
 let current=true,finishPrepare!:(value:Awaited<ReturnType<typeof import('../../xuenessComposer').prepareComposer>>)=>void;
 const prepared={text:'follow-up',token:'prepared',root:'/work/alpha',metadata:{},goal:false};
 const args={sessionId:sessionA,text:'follow-up',enabled:true,running:true,workspaceRoot:'/work/alpha',choices:choices(),commands,
   activeTurnId:'turn',delivery:'queue' as const,followupProof:proof,followupCurrent:()=>current,
   prepare:async()=>{prepares++;return prepared;},ensurePermission:async(selected:RunChoices)=>selected,onAccepted:()=>{accepts++;}};
 await assert.rejects(submitSecondaryPaneTurn({...args,followupProof:undefined}),/current/);assert.equal(prepares,0);
 assert.equal(await submitSecondaryPaneTurn(args),true);assert.equal(accepts,1);assert.equal(bodies[0].expected_turn_id,'turn');
 assert.deepEqual(commands.pendingCommands(),[{sessionId:sessionA,commandId:'original-run',type:'run'}]);
 const delayed=submitSecondaryPaneTurn({...args,prepare:async()=>new Promise(resolve=>{finishPrepare=resolve;})});
 while(!finishPrepare)await new Promise(resolve=>setTimeout(resolve,0));current=false;finishPrepare(prepared);
 await assert.rejects(delayed,/current/);assert.equal(bodies.length,1);assert.equal(accepts,1);commands.dispose();
});

function commandClient(effective: () => boolean, post: (path: string, body: unknown) => Promise<unknown>, get?: (path: string) => Promise<unknown>) {
  return new SessionCommandClient({
    isEffective: effective,
    post: async (path, body) => post(path, body),
    get: async path => get ? get(path) : { result: 'unknown' },
  });
}

function choices(patch: Partial<RunChoices> = {}): RunChoices {
  return { ...getRunChoices(), ...patch };
}

const input: ComposerInput = {
  attachments: [],
  attachmentRefs: [{ id: attachmentId }],
  files: [], sessions: [], skills: [], plugins: [],
  goal: false,
};

test('remote composer requires a current injected owner and never exposes local attachment uploads', () => {
  const owner = { connectionId: 'composer-test', workspaceIdentity: 'remote-work', digest: 'digest', generation: 'generation-1',
    state: 'connected', capabilities: {} };
  remoteConnections.publish(owner, []);
  const adapter = new RemoteSessionAdapter(owner);
  const identity = { groupId: 'remote', paneId: 'secondary', bindingRevision: 1,
    scope: { remoteConnectionId: owner.connectionId, workspaceIdentity: 'remote-work', workspaceRoot: '/remote' }, sessionId: sessionA };
  const render = (sessionId: string | null, remoteAdapter?: RemoteSessionAdapter) => renderToStaticMarkup(<PaneComposer
    identity={{ ...identity, sessionId }} choices={choices()} onChoicesChange={() => undefined} enabled
    remoteAdapter={remoteAdapter} onCreateSession={async () => sessionA} onSessionPromoted={() => undefined} />);
  assert.equal(render(sessionA), '');
  const connected = render(sessionA, adapter);
  assert.match(connected, /data-testid="xn-pane-secondary-composer"/);
  assert.match(connected, /<input[^>]*type="file"[^>]*disabled=""/);
  const draft = render(null, adapter);
  assert.match(draft, /<button[^>]*type="submit"[^>]*disabled=""/);
  const address = paneDraftAddress(identity);
  remoteConnections.publish({ ...owner, generation: 'generation-2' }, []);
  assert.equal(render(sessionA, adapter), '');
  const next = render(sessionA, new RemoteSessionAdapter({ ...owner, generation: 'generation-2' }));
  assert.match(next, /data-testid="xn-pane-secondary-composer"/);
  assert.deepEqual(paneDraftAddress(identity), address, 'connection generations do not re-key the draft');
  remoteConnections.disconnect(owner.connectionId);
});

test('secondary composer drafts stay off the primary session key', () => {
  assert.equal(secondaryComposerDraftKey(sessionA), `pane-secondary:${sessionA}`);
  assert.notEqual(secondaryComposerDraftKey(sessionA), `session:${sessionA}`);
  assert.notEqual(secondaryComposerDraftKey(sessionA), secondaryComposerDraftKey(sessionB));
  const first = renderToStaticMarkup(<SecondaryPaneComposer sessionId={sessionA} workspaceRoot="/work/alpha" enabled />);
  const second = renderToStaticMarkup(<SecondaryPaneComposer sessionId={sessionB} workspaceRoot="/work/beta" enabled running />);
  const hidden = renderToStaticMarkup(<SecondaryPaneComposer sessionId={sessionA} workspaceRoot="/work/alpha" enabled={false} />);
  assert.match(first, new RegExp(`data-draft-key="pane-secondary:${sessionA}"`));
  assert.match(first, /data-rich-composer="true"/u);
  assert.match(first, /data-session="/u);
  assert.match(first, /<textarea/u);
  assert.doesNotMatch(first, /data-testid="composer-stop"/u);
  assert.match(second, new RegExp(`data-draft-key="pane-secondary:${sessionB}"`));
  assert.match(second, /data-testid="composer-stop"/u);
  assert.doesNotMatch(second, /data-testid="composer-queue"/u);
  assert.equal(hidden, '');
});

test('the secondary conversation chunk is not a startup import', () => {
  const container = readFileSync(resolve(process.cwd(), 'src/XuenessWorkbenchContainer.tsx'), 'utf8');
  const layout = readFileSync(resolve(process.cwd(), 'src/plugins/sessions/SessionPaneLayout.tsx'), 'utf8');
  assert.match(container, /import\(\s*['"]\.\/plugins\/sessions\/(?:secondaryConversationPane|SessionPaneWorkbench)['"]\s*\)/u);
  assert.doesNotMatch(container, /from\s+['"]\.\/plugins\/sessions\/secondaryConversationPane['"]/u);
  assert.doesNotMatch(container, /secondaryPaneComposer/u);
  assert.doesNotMatch(layout, /secondaryConversationPane|secondaryPaneComposer/u);
  assert.match(layout, /lazy\(\(\) => import\(['"]\.\/SessionPaneSplit['"]\)/u);
  assert.doesNotMatch(layout, /import ['"]\.\/pane-layout\.css['"]|onPointerMove|requestAnimationFrame/u);
});

describe('secondary pane command admission', { concurrency: false }, () => {
test('a disabled secondary composer does not prepare or send', async () => {
  const previous = getRunChoices();
  let prepares = 0;
  let posts = 0;
  let confirms = 0;
  const commands = commandClient(() => false, async () => { posts += 1; throw new Error('posted'); });
  try {
    const skipped = await submitSecondaryPaneTurn({
      sessionId: sessionA, text: 'hello', enabled: false, running: false, workspaceRoot: '/work/alpha',
      choices: choices(), commands, input,
      prepare: async () => { prepares += 1; throw new Error('prepared'); },
      ensurePermission: async () => { confirms += 1; return null; },
    });
    const ineffective = await submitSecondaryPaneTurn({
      sessionId: sessionA, text: 'hello', enabled: true, running: false, workspaceRoot: '/work/alpha',
      choices: choices(), commands, input,
      prepare: async () => { prepares += 1; throw new Error('prepared'); },
      ensurePermission: async () => { confirms += 1; return choices(); },
    });
    const invalid = await submitSecondaryPaneTurn({
      sessionId: '../nope', text: 'hello', enabled: true, running: false, workspaceRoot: '/work/alpha',
      choices: choices(), commands: commandClient(() => true, async () => { posts += 1; throw new Error('posted'); }), input,
      prepare: async () => { prepares += 1; throw new Error('prepared'); },
      ensurePermission: async () => { confirms += 1; return choices(); },
    });
    assert.equal(skipped, false);
    assert.equal(ineffective, false);
    assert.equal(invalid, false);
    assert.equal(prepares, 0);
    assert.equal(posts, 0);
    assert.equal(confirms, 0);
    const stopped = await stopSecondaryPane(sessionA, 'turn-1', false, commands);
    assert.deepEqual(stopped, { ok: false, error: '' });
    assert.equal(posts, 0);
  } finally {
    commands.dispose();
    setRunChoices(previous);
  }
});

test('cancelling full-access confirmation does not prepare the secondary turn', async () => {
  const previous = getRunChoices();
  let prepares = 0;
  const commands = commandClient(() => true, async () => { throw new Error('posted'); });
  try {
    const result = await submitSecondaryPaneTurn({
      sessionId: sessionA, text: 'hello', enabled: true, running: false, workspaceRoot: '/work/alpha',
      choices: choices({ permission_mode: 'yolo' }), commands, input,
      prepare: async () => { prepares += 1; throw new Error('prepared'); },
      ensurePermission: async () => null,
    });
    assert.equal(result, false);
    assert.equal(prepares, 0);
  } finally {
    commands.dispose();
    setRunChoices(previous);
  }
});

test('an idle secondary send admits send then run through command ack without editor state', async () => {
  const previous = getRunChoices();
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  const prepares: { text: string; input: ComposerInput | undefined; selection: Record<string, unknown> }[] = [];
  let admitted = false;
  const commands = commandClient(() => true, async (path, body) => {
    const record = body as Record<string, unknown>;
    posts.push({ path, body: record });
    const commandId = String(record.commandId);
    if (record.type === 'run') return accepted(commandId, { id: sessionA, status: 'running', steps: 1 });
    return accepted(commandId, { id: sessionA, status: 'idle', steps: 0 });
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('offline'); };
  try {
    const ok = await submitSecondaryPaneTurn({
      sessionId: sessionA, text: 'hello', enabled: true, running: false, workspaceRoot: '/work/alpha',
      permissionMode: 'build', choices: choices({ provider_id: 'prov', model: 'demo-model' }), commands, input,
      prepare: async (text, composerInput, selection) => {
        prepares.push({ text, input: composerInput, selection: selection as Record<string, unknown> });
        return { text, token: 'prepared-token', root: '/work/alpha', metadata: {}, goal: true };
      },
      ensurePermission: async selected => selected,
      onAccepted: () => { admitted = true; },
    });
    assert.equal(ok, true);
    assert.equal(admitted, true);
    assert.equal(prepares.length, 1);
    assert.equal(prepares[0].text, 'hello');
    assert.equal(prepares[0].selection.session_id, sessionA);
    assert.equal(prepares[0].selection.root, '/work/alpha');
    assert.equal(prepares[0].selection.model, 'demo-model');
    assert.deepEqual(prepares[0].input?.attachmentRefs, [{ id: attachmentId }]);
    assert.deepEqual(posts.map(item => item.body.type), ['send', 'run']);
    assert.equal(posts[0].path, `/api/sessions/${sessionA}/commands`);
    assert.deepEqual(posts[0].body.payload, { text: 'hello', prepared_token: 'prepared-token' });
    assert.equal((posts[1].body.payload as { model?: string }).model, 'demo-model');
    assert.equal((posts[1].body.payload as { goal?: boolean }).goal, true);
    assert.equal(JSON.stringify(posts).includes('editorState'), false);
    assert.equal(JSON.stringify(posts).includes(attachmentId), false);
  } finally {
    globalThis.fetch = originalFetch;
    commands.dispose();
    setRunChoices(previous);
  }
});

test('a running secondary pane queues on the same command client and does not start a run', async () => {
  const previous = getRunChoices();
  const types: string[] = [];
  const commands = commandClient(() => true, async (_path, body) => {
    const record = body as { commandId: string; type: string; payload: { text?: string } };
    types.push(record.type);
    return accepted(record.commandId, {
      id: 'queue-1',
      item: { id: 'queue-1', text: record.payload.text, status: 'queued', position: 0 },
    });
  });
  try {
    let acceptedTurn = false;
    const ok = await submitSecondaryPaneTurn({
      sessionId: sessionB, text: '  follow up  ', enabled: true, running: true, workspaceRoot: '',
      choices: choices(), commands,
      prepare: async () => ({ text: 'follow up', token: 'queue-token', root: '', metadata: {}, goal: false }),
      ensurePermission: async selected => selected,
      onAccepted: () => { acceptedTurn = true; },
    });
    assert.equal(ok, true);
    assert.equal(acceptedTurn, true);
    assert.deepEqual(types, ['queue']);
  } finally {
    commands.dispose();
    setRunChoices(previous);
  }
});

test('a lost secondary send stays unconfirmed and is not replayed as a second write', async () => {
  const previous = getRunChoices();
  let posts = 0;
  const commands = commandClient(() => true, async () => { posts += 1; throw new TypeError('lost'); });
  try {
    await assert.rejects(() => submitSecondaryPaneTurn({
      sessionId: sessionA, text: 'hello', enabled: true, running: false, workspaceRoot: '/work/alpha',
      choices: choices(), commands,
      prepare: async () => ({ text: 'hello', token: 'tok', root: '/work/alpha', metadata: {}, goal: false }),
      ensurePermission: async selected => selected,
    }), error => error instanceof DeliveryUnconfirmedError);
    assert.equal(posts, 1);
  } finally {
    commands.dispose();
    setRunChoices(previous);
  }
});

test('a refused secondary send does not start a run', async () => {
  const previous = getRunChoices();
  const types: string[] = [];
  const commands = commandClient(() => true, async (_path, body) => {
    const record = body as { commandId: string; type: string };
    types.push(record.type);
    return { commandId: record.commandId, status: 'rejected', reasonCode: 'lease', message: 'run already in progress' };
  });
  try {
    await assert.rejects(() => submitSecondaryPaneTurn({
      sessionId: sessionA, text: 'hello', enabled: true, running: false, workspaceRoot: '/work/alpha',
      choices: choices(), commands,
      prepare: async () => ({ text: 'hello', token: 'tok', root: '/work/alpha', metadata: {}, goal: false }),
      ensurePermission: async selected => selected,
    }), /run already in progress/u);
    assert.deepEqual(types, ['send']);
  } finally {
    commands.dispose();
    setRunChoices(previous);
  }
});

test('stopping the secondary pane uses the stop command for that session only', async () => {
  const posts: { path: string; type: string; turn: unknown }[] = [];
  const commands = commandClient(() => true, async (path, body) => {
    const record = body as { commandId: string; type: string; payload: { expected_turn_id?: unknown } };
    posts.push({ path, type: record.type, turn: record.payload.expected_turn_id });
    return accepted(record.commandId, { stopping: true });
  });
  try {
    const stopped = await stopSecondaryPane(sessionB, 'turn-9', true, commands);
    assert.deepEqual(stopped, { ok: true });
    assert.deepEqual(posts, [{ path: `/api/sessions/${sessionB}/commands`, type: 'stop', turn: 'turn-9' }]);
    const blocked = await stopSecondaryPane(sessionB, 'turn-9', true, commandClient(() => false, async () => {
      throw new Error('posted');
    }));
    assert.deepEqual(blocked, { ok: false, error: '' });
  } finally {
    commands.dispose();
  }
});
});

test('late confirmation and preparation cannot send or change rebound leaf choices', async () => {
  for (const phase of ['confirmation', 'prepare']) {
    let current = true; let updates = 0; let posts = 0;
    const commands = commandClient(() => true, async () => { posts++; throw new Error('must not send'); });
    const result = await submitSecondaryPaneTurn({ sessionId: sessionA, text: 'old', enabled: true, running: false,
      workspaceRoot: '/a', choices: choices(), commands, isCurrent: () => current,
      onChoicesChange: () => { updates++; },
      ensurePermission: async selected => { if (phase === 'confirmation') current = false; return selected; },
      prepare: async () => { current = false; return { text: 'old', token: 'tok', root: '/a', metadata: {}, goal: false }; },
    });
    assert.equal(result, false); assert.equal(posts, 0); assert.equal(updates, phase === 'confirmation' ? 0 : 1);
    commands.dispose();
  }
});
test('late send or queue completion cannot clear a rebound draft or start a run', async () => {
  for (const running of [false, true]) {
    let current = true; let clears = 0; const types: string[] = [];
    const commands = commandClient(() => true, async (_path, body) => {
      const record = body as { commandId: string; type: string };
      types.push(record.type); current = false;
      return accepted(record.commandId, running ? { id: 'q', item: { id: 'q', text: 'old', status: 'queued', position: 0 } }
        : { id: sessionA, status: 'idle', steps: 0 });
    });
    await submitSecondaryPaneTurn({ sessionId: sessionA, text: 'old', enabled: true, running, workspaceRoot: '/a',
      choices: choices(), commands, isCurrent: () => current, onAccepted: () => { clears++; },
      ensurePermission: async selected => selected,
      prepare: async () => ({ text: 'old', token: 'tok', root: '/a', metadata: {}, goal: false }),
    });
    assert.equal(clears, 0); assert.deepEqual(types, [running ? 'queue' : 'send']); commands.dispose();
  }
});


test('draft first intent prepares then creates real text once and runs before promotion', async () => {
  const types: string[] = []; const events: string[] = [];
  const commands = commandClient(() => true, async (_path, body) => {
    const record = body as { commandId: string; type: string; payload: Record<string, unknown> };
    types.push(record.type);
    if (record.type === 'create_session') {
      assert.equal(record.payload.task, 'real first turn'); assert.equal(record.payload.prepared_token, 'token');
      return accepted(record.commandId, { id: sessionA, status: 'idle', root: '/a' });
    }
    return accepted(record.commandId, { id: sessionA, status: 'running', steps: 1 });
  });
  const ok = await submitPaneDraftTurn({ identity: { groupId: 'test-1', paneId: 'p', bindingRevision: 0, scope: { workspaceRoot: '/a' }, sessionId: null },
    text: 'real first turn', enabled: true, workspaceRoot: '/a', choices: choices(), commands,
    prepare: async (_text, _input, selection) => {
      assert.equal(selection?.session_id, undefined); assert.equal(selection?.root, '/a');
      return { text: 'real first turn', token: 'token', root: '/a', metadata: {}, goal: false };
    }, ensurePermission: async selected => selected,
    onAccepted: () => events.push('accepted'), onSessionPromoted: id => { assert.equal(id, sessionA); events.push('promoted'); },
  });
  assert.equal(ok, true); assert.deepEqual(types, ['create_session', 'run']); assert.deepEqual(events, ['accepted', 'promoted']); commands.dispose();
});

test('late creation ACK cannot run, promote or clear a rebound draft', async () => {
  let current = true; const types: string[] = []; let callbacks = 0;
  const commands = commandClient(() => true, async (_path, body) => {
    const record = body as { commandId: string; type: string }; types.push(record.type); current = false;
    return accepted(record.commandId, { id: sessionA, status: 'idle', root: '/a' });
  });
  await submitPaneDraftTurn({ identity: { groupId: 'test-2', paneId: 'p', bindingRevision: 0, scope: { workspaceRoot: '/a' }, sessionId: null },
    text: 'first', enabled: true, workspaceRoot: '/a', choices: choices(), commands, isCurrent: () => current,
    prepare: async () => ({ text: 'first', token: 'tok', root: '/a', metadata: {}, goal: false }),
    ensurePermission: async selected => selected, onAccepted: () => { callbacks++; }, onSessionPromoted: () => { callbacks++; },
  });
  assert.deepEqual(types, ['create_session']); assert.equal(callbacks, 0); commands.dispose();
});


test('unknown draft creation stays unconfirmed without a second create, run or promotion', async () => {
  let writes = 0; let callbacks = 0;
  const commands = commandClient(() => true, async () => { writes++; throw new TypeError('lost create'); });
  await assert.rejects(() => submitPaneDraftTurn({ identity: { groupId: 'test-3', paneId: 'p', bindingRevision: 0, scope: { workspaceRoot: '/a' }, sessionId: null },
    text: 'first', enabled: true, workspaceRoot: '/a', choices: choices(), commands,
    prepare: async () => ({ text: 'first', token: 'tok', root: '/a', metadata: {}, goal: false }),
    ensurePermission: async selected => selected, onAccepted: () => { callbacks++; }, onSessionPromoted: () => { callbacks++; },
  }), error => error instanceof DeliveryUnconfirmedError);
  assert.equal(writes, 1); assert.equal(callbacks, 0); commands.dispose();
});

test('remote draft scope fails closed before confirmation, preparation or local creation', async () => {
  const commands = commandClient(() => true, async () => { throw new Error('local write'); });
  const result = await submitPaneDraftTurn({ identity: { groupId: 'test-4', paneId: 'p', bindingRevision: 0,
    scope: { workspaceRoot: '/a', remoteConnectionId: 'remote' }, sessionId: null },
    text: 'first', enabled: true, workspaceRoot: '/a', choices: choices(), commands,
    prepare: async () => { throw new Error('prepare'); }, ensurePermission: async () => { throw new Error('confirm'); },
    onSessionPromoted: () => { throw new Error('promote'); },
  });
  assert.equal(result, false); commands.dispose();
});

test('remote creation requires matching ready capabilities and uses injected prepare without a local root', async () => {
  const owner = { connectionId: 'remote-create', workspaceIdentity: 'remote-work', digest: 'digest', generation: 'generation-1',
    state: 'connected', capabilities: { durableCommands: true, preparedMedia: true } };
  remoteConnections.publish(owner, []);
  const adapter = new RemoteSessionAdapter(owner);
  const identity = { groupId: 'remote-create', paneId: 'p', bindingRevision: 0, sessionId: null,
    scope: { workspaceRoot: '/local-must-not-leak', workspaceIdentity: remoteWorkspaceKey(owner), remoteConnectionId: owner.connectionId } };
  assert.equal(remotePaneCreationReady(identity, adapter), true);
  assert.equal(remotePaneCreationReady({ ...identity, scope: { ...identity.scope, remoteConnectionId: 'other' } }, adapter), false);
  const types: string[] = []; let prepares = 0; let promoted = '';
  adapter.prepare = async (_text, _input, selection) => {
    prepares++; assert.equal(selection.root, undefined);
    return { text: 'first remote', token: 'remote-token', root: 'remote-work', metadata: {}, goal: false };
  };
  const commands = commandClient(() => adapter.isCurrent(), async (_path, raw) => {
    const body = raw as { commandId: string; type: string; payload: Record<string, unknown> };
    types.push(body.type); assert.equal(body.payload.root, undefined);
    return accepted(body.commandId, { id: sessionA, status: 'idle', root: '/remote' });
  });
  const result = await submitPaneDraftTurn({ identity, remoteAdapter: adapter, text: 'first remote', enabled: true,
    workspaceRoot: '/local-must-not-leak', choices: choices(), commands,
    prepare: async () => { throw new Error('local prepare forbidden'); }, ensurePermission: async selected => selected,
    onSessionPromoted: id => { promoted = id; } });
  assert.equal(result, true); assert.equal(prepares, 1); assert.equal(promoted, sessionA);
  assert.deepEqual(types, ['create_session', 'run']);
  commands.dispose(); remoteConnections.disconnect(owner.connectionId);
});

test('unknown remote creation keeps its original receipt across reconnect and explicit recovery never runs or creates again', async () => {
  const owner = { connectionId: 'remote-recover', workspaceIdentity: 'remote-work', digest: 'digest', generation: 'generation-1',
    state: 'connected', capabilities: { durableCommands: true, preparedMedia: true } };
  remoteConnections.publish(owner, []);
  const identity = { groupId: 'remote-recover', paneId: 'p', bindingRevision: 0, sessionId: null,
    scope: { workspaceRoot: '/remote', workspaceIdentity: remoteWorkspaceKey(owner), remoteConnectionId: owner.connectionId } };
  let adapter = new RemoteSessionAdapter(owner);
  let prepares = 0, writes = 0, originalCommandId = '', promoted = '';
  const prepare = async () => { prepares++; return { text: 'remote', token: 'remote-token', root: 'remote-work', metadata: {}, goal: false }; };
  adapter.prepare = prepare;
  const oldCommands = commandClient(() => adapter.isCurrent(), async (_path, raw) => {
    writes++; originalCommandId = (raw as {commandId:string}).commandId; throw new TypeError('lost create ACK');
  });
  const args = { identity, remoteAdapter: adapter, text: 'remote', enabled: true, workspaceRoot: '/remote', choices: choices(), commands: oldCommands,
    prepare, ensurePermission: async (selected: RunChoices) => selected, onSessionPromoted: (id: string) => { promoted = id; } };
  await assert.rejects(() => submitPaneDraftTurn(args), DeliveryUnconfirmedError);
  assert.equal(paneDraftAdmission(identity)?.commandId, originalCommandId);
  oldCommands.dispose();
  const nextOwner = { ...owner, generation: 'generation-2' };
  remoteConnections.publish(nextOwner, []); adapter = new RemoteSessionAdapter(nextOwner); adapter.prepare = prepare;
  const queried: string[] = [];
  const newCommands = commandClient(() => adapter.isCurrent(), async () => { writes++; throw new Error('recovery must not write'); }, async path => {
    queried.push(path); return { result: accepted(originalCommandId, { id: sessionA, status: 'idle', root: '/remote' }) };
  });
  await assert.rejects(() => submitPaneDraftTurn({ ...args, remoteAdapter: adapter, commands: newCommands }), DeliveryUnconfirmedError);
  assert.equal(await recoverPaneDraftCreation(identity, adapter, newCommands, id => { promoted = id; }), true);
  assert.equal(writes, 1); assert.equal(prepares, 1); assert.equal(promoted, sessionA);
  assert.deepEqual(queried, [`/api/sessions/commands/${encodeURIComponent(originalCommandId)}`]);
  assert.equal(paneDraftAdmission(identity)?.phase, 'created');
  newCommands.dispose(); remoteConnections.disconnect(owner.connectionId);
});


test('create ACK keeps synchronous first-turn admission locked through deferred run and remount', async () => {
  let finishRun!: (value: unknown) => void; let runCommand = ''; const types: string[] = []; let acceptedCount = 0;
  const commands = commandClient(() => true, async (_path, body) => {
    const record = body as { commandId: string; type: string }; types.push(record.type);
    if (record.type === 'create_session') return accepted(record.commandId, { id: sessionA, status: 'idle', root: '/a' });
    runCommand = record.commandId;
    return new Promise(resolve => { finishRun = resolve; });
  });
  const draftStore = { current: new Map() };
  const identity = { groupId: 'deferred-run', paneId: 'p', bindingRevision: 0, scope: { workspaceRoot: '/a' }, sessionId: null };
  const args = { identity, draftStore, text: 'first', enabled: true, workspaceRoot: '/a', choices: choices(), commands,
    prepare: async () => ({ text: 'first', token: 'tok', root: '/a', metadata: {}, goal: false }),
    ensurePermission: async (selected: RunChoices) => selected, onAccepted: () => { acceptedCount++; }, onSessionPromoted: () => undefined };
  const first = submitPaneDraftTurn(args);
  for (let i = 0; i < 30; i++) await Promise.resolve();
  assert.deepEqual(types, ['create_session', 'run']); assert.equal(acceptedCount, 0);
  assert.equal(paneDraftAdmission(identity)?.phase, 'pending');
  assert.equal(paneDraftAdmission(identity)?.draftStore, draftStore, 'remount adopts original ACK-owned draft store');
  assert.equal(await submitPaneDraftTurn({ ...args, text: 'second from remounted composer' }), false);
  assert.deepEqual(types, ['create_session', 'run']);
  finishRun(accepted(runCommand, { id: sessionA, status: 'running', steps: 1 }));
  assert.equal(await first, true); assert.equal(acceptedCount, 1);
  assert.equal(paneDraftAdmission(identity)?.phase, 'created');
  commands.dispose();
});

test('accepted first turn with refused run promotes and reports error without making draft retryable', async () => {
  const types: string[] = []; let clears = 0; let promoted = ''; let error = '';
  const commands = commandClient(() => true, async (_path, body) => {
    const record = body as { commandId: string; type: string }; types.push(record.type);
    return record.type === 'create_session' ? accepted(record.commandId, { id: sessionA, status: 'idle', root: '/a' })
      : { commandId: record.commandId, status: 'rejected', message: 'provider unavailable', reasonCode: 'provider' };
  });
  const identity = { groupId: 'refused-run', paneId: 'p', bindingRevision: 0, scope: { workspaceRoot: '/a' }, sessionId: null };
  const result = await submitPaneDraftTurn({ identity, text: 'first', enabled: true, workspaceRoot: '/a', choices: choices(), commands,
    prepare: async () => ({ text: 'first', token: 'tok', root: '/a', metadata: {}, goal: false }), ensurePermission: async selected => selected,
    onAccepted: () => { clears++; }, onSessionPromoted: id => { promoted = id; }, onRunError: message => { error = message; },
  });
  assert.equal(result, true); assert.equal(clears, 1); assert.equal(promoted, sessionA); assert.match(error, /provider unavailable/);
  assert.equal(paneDraftAdmission(identity)?.phase, 'created'); assert.deepEqual(types, ['create_session', 'run']); commands.dispose();
});

test('remote create recovery releases only definitive non-created refusal, preserving draft and requiring explicit retry', async () => {
  for (const status of ['rejected', 'stale', 'failed', 'unknown', 'duplicate'] as const) {
    const owner = { connectionId: `refusal-${status}`, workspaceIdentity: 'remote-work', digest: 'digest', generation: 'generation-1',
      state: 'connected', capabilities: { durableCommands: true, preparedMedia: true } };
    remoteConnections.publish(owner, []);
    const adapter = new RemoteSessionAdapter(owner);
    adapter.prepare = async () => ({ text: 'keep me', token: 'token', root: 'remote-work', metadata: {}, goal: false });
    const identity = { groupId: `refusal-${status}`, paneId: 'p', bindingRevision: 0, sessionId: null,
      scope: { workspaceRoot: '/remote', workspaceIdentity: remoteWorkspaceKey(owner), remoteConnectionId: owner.connectionId } };
    let writes = 0, id = '', queried = false;
    const draftStore = { current: new Map([['draft', { text: 'keep me', attachments: [], goal: false,
      selectedContext: { files: [], sessions: [], skills: [], plugins: [] }, selectedCapabilities: [], submissionError: '', attachmentError: '', revision: 1 }]]) };
    const commands = commandClient(() => true, async (_path, body) => { writes++; id = (body as {commandId:string}).commandId; throw new TypeError('lost'); },
      async () => ({ result: !queried || status === 'unknown' ? 'unknown' : { commandId: id, status, ...(status === 'duplicate' ? { originalStatus: 'stale' } : {}) } }));
    const args = { identity, remoteAdapter: adapter, commands, draftStore, text: 'keep me', enabled: true, workspaceRoot: '/remote', choices: choices(),
      prepare: adapter.prepare, ensurePermission: async (selected: RunChoices) => selected, onSessionPromoted: () => assert.fail('must not promote') };
    await assert.rejects(() => submitPaneDraftTurn(args), DeliveryUnconfirmedError);
    queried = true;
    const released = await recoverPaneDraftCreation(identity, adapter, commands, args.onSessionPromoted);
    assert.equal(released, ['rejected', 'stale', 'duplicate'].includes(status));
    assert.equal(writes, 1, 'recovery never writes'); assert.equal(draftStore.current.get('draft')?.text, 'keep me');
    assert.equal(paneDraftAdmission(identity) === undefined, released);
    commands.dispose(); remoteConnections.disconnect(owner.connectionId);
  }
});


test('withdrawal draft swap preserves live, pending, attachments and canonical draft IDs', () => {
  const previous = { text: 'current', draftId: 'draft-live', attachments: [], goal: false,
    selectedContext: { files: [], sessions: [], skills: [], plugins: [] }, selectedCapabilities: [], submissionError: '', attachmentError: '', revision: 1 };
  const pending = { token: 'pending', draft: { ...previous, text: 'pending original', draftId: 'draft-pending' } };
  const existing = { ...previous, pendingSubmission: pending } as unknown as import('./XuenessWorkbenchView').ComposerDraftState;
  const next = restorePaneWithdrawalDraft(existing, { id: 'recovery', queueId: 'queue', sessionId: sessionA, root: '/a',
    text: 'withdrawn', hasContext: true, expectedRevision: 1, createdAt: 1, expiresAt: 2 });
  assert.equal(next.text, 'withdrawn'); assert.equal(next.pendingSubmission, existing.pendingSubmission);
  assert.notEqual(next.draftId, existing.draftId); assert.equal(next.recoverableDrafts?.[0].draftId, 'draft-live');
  assert.equal(next.recoverableDrafts?.[0].text, 'current'); assert.equal(next.hadAttachments, true);
});

test('local lost create ACK is recoverable by querying original ID without a remote adapter', async () => {
  const identity = { groupId: 'local-recovery', paneId: 'local', bindingRevision: 1, sessionId: null, scope: { workspaceRoot: '/work' } };
  let original = ''; let writes = 0; let queryReady = false; let promoted = '';
  const commands = commandClient(() => true, async (_path, body) => { writes++; original = (body as {commandId:string}).commandId; throw new TypeError('lost'); },
    async () => ({result: queryReady ? accepted(original, {id:sessionA,status:'idle',root:'/work'}) : 'unknown'}));
  await assert.rejects(() => submitPaneDraftTurn({ identity, commands, text:'keep', enabled:true, workspaceRoot:'/work', choices:choices(),
    prepare:async()=>({text:'keep',token:'token',root:'/work',metadata:{},goal:false}), ensurePermission:async selected=>selected,
    onSessionPromoted:id=>{promoted=id;} }), DeliveryUnconfirmedError);
  assert.equal(paneDraftAdmission(identity)?.commandId, original);
  queryReady=true;
  assert.equal(await recoverPaneDraftCreation(identity, undefined, commands, id=>{promoted=id;}),true);
  assert.equal(writes,1);assert.equal(promoted,sessionA);commands.dispose();
});
