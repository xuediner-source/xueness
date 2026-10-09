import { test, describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  answerQuestion,
  approvePending,
  createSession,
  deleteSession,
  forkSession,
  listSessions,
  loadFiles,
  loadFilePreview,
  loadForkBoundaries,
  loadSession,
  loadTimeline,
  loadCompleteTimeline,
  renameSession,
  runSession,
  sendTurn,
  queueTurn,
  cancelQueuedTurn,
  toTimelineRows,
  hydrateTimelineTools,
  hydrateTimelineJournalRows,
  withAssistantStream,
  withInitialUserMessage,
  stabilizeTimelineRows,
  stabilizeSession,
  stabilizeSessionList,
  type PendingApproval,
} from "./xuenessWorkbench";
import type { XuenessEventV1 } from "./xuenessEvents";

test('journal text and reasoning hydrate exact event positions including a partial event page', () => {
  const fullUser='u'.repeat(700), fullAssistant='a'.repeat(800);
  const journal={messages:[{role:'system',content:'system'},{role:'user',content:'first task'},
    {role:'assistant',content:'first reply',tool_calls:[{id:'call',function:{arguments:'{}'}}]},
    {role:'tool',tool_call_id:'call',content:'{}'}, {role:'user',content:fullUser},
    {role:'assistant',content:fullAssistant}]};
  const rows: import('./xuenessWorkbench').TimelineRow[]=[{kind:'user',seq:5,turnId:'turn-2',text:'preview'},
    {kind:'assistant',seq:6,turnId:'turn-2',text:'preview'}];
  const before=JSON.stringify(rows);
  const hydrated=hydrateTimelineJournalRows(rows,journal,[{message_index:5,text:'reasoning'}]);
  assert.equal(hydrated[0].kind==='user'&&hydrated[0].text,fullUser);
  assert.equal(hydrated[1].kind==='assistant'&&hydrated[1].text,fullAssistant);
  assert.equal(hydrated[1].kind==='assistant'&&hydrated[1].reasoning,'reasoning');
  assert.equal(JSON.stringify(rows),before);
  const streamed=withAssistantStream([], {id:'thinking',text:'',reasoning:'only reasoning',status:'streaming'});
  assert.equal(streamed[0].kind==='assistant'&&streamed[0].reasoning,'only reasoning');
});

test('journal projects tool-response reasoning and narration before their real call IDs without fabricated timing', () => {
  const tool: import('./xuenessWorkbench').TimelineRow = { kind: 'tool', seq: 2, turnId: 'turn-1', toolCallId: 'real-call', name: 'exec', subject: 'pwd', status: 'ok', error: '', errorCode: '' };
  const journal = { messages: [{ role: 'user', content: 'task' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'real-call' }] }, { role: 'tool', content: '{}' }] };
  const history = [{ message_index: 1, text: 'Check the folder first.' }];
  const out = hydrateTimelineJournalRows([tool], journal, history);
  assert.equal(out.length, 2);
  assert.equal(out[0].kind === 'assistant' && out[0].reasoning, history[0].text);
  assert.equal(out[0].seq, 1.75);
  assert.equal(out[1], tool);
  assert.equal('startedAt' in out[0], false);
  assert.deepEqual(hydrateTimelineJournalRows(out, journal, history), out, 'idempotent across polling');
  assert.deepEqual(hydrateTimelineJournalRows([], journal, history), [], 'no matching visible call means no invented row');
  const narrated = hydrateTimelineJournalRows([tool, { kind: 'assistant', seq: 3, turnId: 'turn-1', text: 'preview' }],
    { messages: [journal.messages[0], { ...journal.messages[1], content: 'I will inspect it.' }] }, history);
  assert.equal(narrated[0].kind === 'assistant' && narrated[0].text, 'I will inspect it.');
  assert.equal(narrated[1], tool);
});

test('journal hydration accounts for prior turn completions and structured user content before relocating tool narration', () => {
  const journal = { messages: [{ role: 'user', content: 'task' }, { role: 'assistant', content: 'first answer' },
    { role: 'user', content: [{ type: 'text', text: 'second full task' }, { type: 'image_url', image_url: {} }] },
    { role: 'assistant', content: 'I will run pwd.', tool_calls: [{ id: 'second-call' }] },
    { role: 'tool', tool_call_id: 'second-call', content: '{}' }, { role: 'assistant', content: 'Second final answer' }],
    completion_history: [{ turn_id: 'turn-1' }, { turn_id: 'turn-1' }, { turn_id: 'bad-record' }] };
  const rows: import('./xuenessWorkbench').TimelineRow[] = [
    { kind: 'user', seq: 5, turnId: 'turn-2', text: 'preview task' },
    { kind: 'tool', seq: 6, turnId: 'turn-2', toolCallId: 'second-call', name: 'exec', subject: 'pwd', status: 'ok', error: '', errorCode: '' },
    { kind: 'assistant', seq: 7, turnId: 'turn-2', text: 'preview narration' },
    { kind: 'assistant', seq: 9, turnId: 'turn-2', text: 'preview final' },
  ];
  const out = hydrateTimelineJournalRows(rows, journal, [{ message_index: 3, text: 'second reasoning' }]);
  assert.equal(out[0].kind === 'user' && out[0].text, 'second full task');
  assert.equal(out[1].kind === 'assistant' && out[1].text, 'I will run pwd.');
  assert.equal(out[1].kind === 'assistant' && out[1].reasoning, 'second reasoning');
  assert.equal(out[2], rows[1]);
  assert.equal(out[3].kind === 'assistant' && out[3].text, 'Second final answer');
  assert.deepEqual(hydrateTimelineJournalRows(out, journal, [{ message_index: 3, text: 'second reasoning' }]), out);
});

test('initial task message is restored from the journal once, with fallback only when no user task is available',()=>{
  const fullTask='complete initial task '.repeat(300);
  const rows:import('./xuenessWorkbench').TimelineRow[]=[
    {kind:'assistant',seq:1,turnId:'turn-2',text:'preview reply'},
    {kind:'user',seq:0,turnId:'stale',text:'duplicate initial task'},
  ];
  const before=JSON.stringify(rows);
  const withJournal=withInitialUserMessage(rows,{messages:[
    {role:'system',content:'system prompt'},
    {role:'user',content:fullTask},
    {role:'user',content:'later turn'},
  ]},'fallback task');
  assert.deepEqual(withJournal[0],{kind:'user',seq:0,turnId:'turn-1',text:fullTask});
  assert.equal(withJournal.filter(row=>row.seq===0).length,1);
  assert.equal(withJournal[1],rows[0]);
  assert.equal(JSON.stringify(rows),before);

  const fallback=withInitialUserMessage([], {messages:[{role:'assistant',content:'no user message'}]}, 'fallback task');
  assert.deepEqual(fallback,[{kind:'user',seq:0,turnId:'turn-1',text:'fallback task'}]);
  const noTask=withInitialUserMessage([], {messages:[
    {role:'user',content:'  '},
    {role:'user',content:'later turn must not replace the initial task'},
  ]});
  assert.deepEqual(noTask,[]);
  const invalidFirst=withInitialUserMessage([], {messages:[
    {role:'user',content:[{type:'image',image:'data:image/png;base64,private-bytes'}]},
    {role:'user',content:'later turn'},
  ]},'fallback task');
  assert.deepEqual(invalidFirst,[{kind:'user',seq:0,turnId:'turn-1',text:'fallback task'}]);
  const textBlocks=withInitialUserMessage([], {messages:[{role:'user',content:[
    {type:'text',text:'prompt text'},
    {type:'image',image:'data:image/png;base64,private-bytes'},
  ]}]},'unused fallback');
  assert.deepEqual(textBlocks,[{kind:'user',seq:0,turnId:'turn-1',text:'prompt text'}]);
});

test('tool details are matched by recorded call ID without changing legacy events',()=>{
  const rows: import('./xuenessWorkbench').TimelineRow[]=[{kind:'tool',seq:1,turnId:'t',toolCallId:'b',name:'read',subject:'',status:'ok',error:'',errorCode:''},{kind:'tool',seq:2,turnId:'t',toolCallId:'a',name:'exec',subject:'',status:'ok',error:'',errorCode:''},{kind:'assistant',seq:3,turnId:'t',text:'preview'}];
  const before=JSON.stringify(rows);
  const out=hydrateTimelineTools(rows,{messages:[{role:'assistant',tool_calls:[{id:'a',function:{arguments:'{"command":"pwd"}'}},{id:'b',function:{arguments:'{"path":"sample.txt"}'}}]},{role:'tool',tool_call_id:'a',content:'{"stdout":"/work"}'},{role:'tool',tool_call_id:'b',content:'{"text":"sample"}'},{role:'assistant',content:'complete reply'}]});
  assert.equal(JSON.stringify(rows),before);assert.equal(out[0].kind,'tool');if(out[0].kind==='tool'){assert.deepEqual(out[0].input,{path:'sample.txt'});assert.deepEqual(out[0].output,{text:'sample'});}assert.equal(out[2].kind==='assistant'&&out[2].text,'complete reply');
  assert.equal(hydrateTimelineTools(rows,null),rows);
});
test('malformed and excessively large recorded tool details preserve summaries and remain bounded',()=>{
  const row:import('./xuenessWorkbench').TimelineRow={kind:'tool',seq:1,turnId:'t',toolCallId:'a',name:'read',subject:'file',status:'ok',error:'',errorCode:''};
  const out=hydrateTimelineTools([row],{messages:[{role:'assistant',tool_calls:[{id:'a',function:{arguments:'{bad'}}]},{role:'tool',tool_call_id:'a',content:'x'.repeat(200000)}]})[0];
  assert.equal(out.kind,'tool');if(out.kind==='tool'){assert.equal(out.input,undefined);assert.equal(out.subject,'file');assert.ok(String(out.output).length<16100);}
});

describe("durable assistant text", () => {
  it("shows live and interrupted text, avoids the just-completed row and preserves repeated answers in a new turn", () => {
    const stream = { id: "stream", text: "received text", status: "streaming" as const };
    assert.equal(withAssistantStream([], stream)[0].kind, "assistant");
    assert.equal(withAssistantStream([], { ...stream, status: "interrupted" })[0].kind, "assistant");
    const completed = [{ kind: "assistant" as const, seq: 3, turnId: "stream", text: stream.text }];
    const liveRefresh = withAssistantStream(completed, stream);
    assert.equal(liveRefresh.length, 1);
    assert.equal(liveRefresh[0]?.kind === "assistant" && liveRefresh[0].streaming, true);
    const interruptedRefresh = withAssistantStream(liveRefresh, { ...stream, status: "interrupted" });
    assert.equal(interruptedRefresh[0]?.kind === "assistant" ? interruptedRefresh[0].streaming : undefined, false);
    const resumedRefresh = withAssistantStream(interruptedRefresh, stream);
    assert.equal(resumedRefresh[0]?.kind === "assistant" ? resumedRefresh[0].streaming : undefined, true);
    assert.equal(resumedRefresh[0]?.kind === "assistant" ? resumedRefresh[0].interrupted : undefined, false);
    assert.equal(withAssistantStream(resumedRefresh, stream), resumedRefresh, "unchanged resumed stream preserves row and array identity");
    assert.equal(withAssistantStream([...completed, { kind: "user", seq: 4, turnId: "next", text: "repeat" }], stream).length, 3);
    assert.deepEqual(withAssistantStream([], null), []);
  });
});

// ---------------------------------------------------------------------------
// globalThis.fetch stubbing — the data layer must only ever talk through it.
// ---------------------------------------------------------------------------

type RecordedCall = { url: string; init: RequestInit };

const recorded: RecordedCall[] = [];
const originalFetch = globalThis.fetch;

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(handler: (url: string, init: RequestInit) => Response): void {
  recorded.length = 0;
  globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : String((input as { url?: string }).url ?? "");
    recorded.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as unknown as typeof fetch;
}

function stubFetchFailure(error: Error): void {
  recorded.length = 0;
  globalThis.fetch = (async (): Promise<Response> => {
    throw error;
  }) as unknown as typeof fetch;
}

/** Router covering the shared endpoints (csrf, settings) plus per-test payloads. */
function stubStandardFetch(responses: Record<string, unknown> = {}): void {
  stubFetch((url) => {
    if (url === "/api/csrf") return jsonResponse({ csrfToken: "test-csrf-token" });
    if (url === "/api/settings/agent") {
      return jsonResponse({
        values: { allowMcp: true, allowSubagents: false, allowHooks: false },
      });
    }
    const override = responses[url];
    if (override !== undefined) return jsonResponse(override);
    throw new Error(`unexpected fetch: ${url}`);
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  recorded.length = 0;
});

function callsTo(url: string): RecordedCall[] {
  return recorded.filter((call) => call.url === url);
}

function headerOf(call: RecordedCall, name: string): string {
  return new Headers(call.init.headers as HeadersInit | undefined).get(name) ?? "";
}

function lastCall(): RecordedCall {
  assert.ok(recorded.length > 0, "expected at least one fetch call");
  return recorded[recorded.length - 1];
}

function bodyOf(call: RecordedCall): unknown {
  assert.equal(typeof call.init.body, "string", "POST call must carry a string body");
  return JSON.parse(call.init.body as string);
}

const SESSION = "s1";

function eventAt(seq: number): XuenessEventV1 {
  return {
    schema: "xueness.event.v1",
    seq,
    sessionId: SESSION,
    type: "turn.user",
    turnId: `turn-${seq}`,
    preview: `task ${seq}`,
  };
}

function timelineEnvelope(cursor: number, head: number, nextCursor = Math.min(cursor + 200, head), hasMore = nextCursor < head) {
  return {
    schema: "xueness.events.v1",
    protocolVersion: 1,
    sessionId: SESSION,
    status: "completed",
    steps: 1,
    mode: "build",
    events: Array.from({ length: Math.max(0, nextCursor - cursor) }, (_, index) => eventAt(cursor + index + 1)),
    cursor,
    nextCursor,
    head,
    hasMore,
  };
}

describe("session management", () => {
  it("loads only server-issued fork boundaries and creates a revision-bound fork using its opaque token", async () => {
    const boundaries = {
      sourceId: "s1", revision: "rev-12", historyTruncated: true, truncationReason: "compacted history", hasUnclosedTurn: false,
      boundaries: [{ token: "sha256-boundary", turn: 3, endIndex: 17, preview: "later user request" }],
    };
    const child = {
      session: { id: "s2", status: "pending", root: "/workspace", title: "Explore follow-up" },
      sourceId: "s1", boundary: { turn: 3, preview: "later user request" },
      historyTruncated: true, truncationReason: "compacted history",
    };
    stubFetch((url) => {
      if (url === "/api/csrf") return jsonResponse({ csrfToken: "test-csrf-token" });
      if (url === "/api/sessions/s1/fork-boundaries") return jsonResponse(boundaries);
      if (url === "/api/sessions/s1/fork") return jsonResponse(child, 201);
      throw new Error(`unexpected fetch: ${url}`);
    });

    const loaded = await loadForkBoundaries("s1");
    if (!loaded.ok) assert.fail(loaded.error);
    assert.deepEqual(loaded.value.boundaries, boundaries.boundaries);
    assert.equal(recorded[0].init.cache, "no-store");
    assert.equal(recorded[0].init.credentials, "same-origin");
    const created = await forkSession("s1", loaded.value.boundaries[0].token, loaded.value.revision, "Explore follow-up");
    assert.deepEqual(created, { ok: true, value: child });
    assert.deepEqual(recorded.map(call => call.url), ["/api/sessions/s1/fork-boundaries", "/api/csrf", "/api/sessions/s1/fork"]);
    assert.equal(recorded[2].init.method, "POST");
    assert.equal(headerOf(recorded[2], "X-CSRF-Token"), "test-csrf-token");
    assert.deepEqual(bodyOf(recorded[2]), { boundary: "sha256-boundary", revision: "rev-12", title: "Explore follow-up" });
    assert.equal("endIndex" in (bodyOf(recorded[2]) as Record<string, unknown>), false);
  });

  it("rejects malformed fork boundary data and reports a stale-revision conflict", async () => {
    stubFetch(url => {
      if (url === "/api/sessions/s1/fork-boundaries") return jsonResponse({ sourceId: "other", revision: "rev", boundaries: [], historyTruncated: false, truncationReason: null });
      if (url === "/api/csrf") return jsonResponse({ csrfToken: "test-csrf-token" });
      return jsonResponse({ error: "session revision changed" }, 409);
    });
    assert.deepEqual(await loadForkBoundaries("s1"), { ok: false, error: "invalid fork boundaries response" });
    assert.deepEqual(await forkSession("s1", "old-token", "old-revision"), { ok: false, error: "session revision changed" });
  });

  it("renames via CSRF-protected PATCH without modifying the original task", async () => {
    stubStandardFetch({ "/api/sessions/s1": { id: "s1", title: "New name" } });
    const result = await renameSession("s1", "  New name ");
    assert.deepEqual(result, { ok: true, value: "New name" });
    const call = callsTo("/api/sessions/s1")[0];
    assert.equal(call.init.method, "PATCH");
    assert.equal(call.init.credentials, "same-origin");
    assert.equal(headerOf(call, "X-CSRF-Token"), "test-csrf-token");
    assert.deepEqual(bodyOf(call), { title: "New name" });
    assert.deepEqual(await renameSession("s1", "\n"), { ok: false, error: "title must be 1..120 printable characters" });
    assert.equal(callsTo("/api/sessions/s1").length, 1);
  });

  it("archives via CSRF-protected DELETE and reports server errors", async () => {
    stubStandardFetch({ "/api/sessions/s1": { deleted: true } });
    assert.deepEqual(await deleteSession("s1"), { ok: true, value: undefined });
    const call = callsTo("/api/sessions/s1")[0];
    assert.equal(call.init.method, "DELETE");
    assert.deepEqual(bodyOf(call), {});
    assert.equal(headerOf(call, "X-CSRF-Token"), "test-csrf-token");
    stubFetch((url) => url === "/api/csrf" ? jsonResponse({ csrfToken: "test-csrf-token" }) : jsonResponse({ error: "session run already in progress" }, 409));
    assert.deepEqual(await deleteSession("s1"), { ok: false, error: "session run already in progress" });
  });
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

describe("xuenessWorkbench reads", () => {
  it("listSessions parses the session list and uses a same-origin uncached GET", async () => {
    stubStandardFetch({
      "/api/sessions": {
        sessions: [
          { id: "s1", task: "first task", status: "running" },
          { id: "s2", task: "second task", status: "completed" },
        ],
      },
    });

    const result = await listSessions();
    if (!result.ok) assert.fail(result.error);
    assert.deepEqual(result.value, [
      { id: "s1", task: "first task", status: "running" },
      { id: "s2", task: "second task", status: "completed" },
    ]);

    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].url, "/api/sessions");
    assert.equal(recorded[0].init.credentials, "same-origin");
    assert.equal(recorded[0].init.cache, "no-store");
  });

  it("loadSession parses the workbench session detail", async () => {
    stubStandardFetch({
      "/api/sessions/s1": {
        id: "s1",
        task: "detail task",
        status: "waiting_approval",
        steps: 4,
        mode: "build",
        runtime_profile: "lightweight",
        runtime_budget: { profile: "lightweight", contextWindow: 8192, reservedOutputTokens: 1024, inputBudgetTokens: 6656, estimatedInputTokens: 1800, activeTools: 4 },
        pause_reason: "provider paused",
        pending: [
          {
            tool_call_id: "call-1",
            name: "write",
            subject: "src/a.ts",
            preview: "…preview…",
          },
        ],
        approved: { write: [], edit: [], exec: [], mcp: [] },
        changed_files: ["src/a.ts"],
        queued_messages: [
          { id: "q-1", text: "follow-up", status: "queued", position: 1, created_at: "2026-10-02T00:00:00Z" },
          { id: "q-2", text: "review later", status: "paused", position: 2, pause_reason: "needs review" },
        ],
      },
    });

    const result = await loadSession(SESSION);
    if (!result.ok) assert.fail(result.error);
    assert.equal(result.value.id, "s1");
    assert.equal(result.value.status, "waiting_approval");
    assert.equal(result.value.runtime_profile, "lightweight");
    assert.equal(result.value.runtime_budget?.estimatedInputTokens, 1800);
    assert.equal(result.value.runtime_budget?.activeTools, 4);
    assert.equal(result.value.pause_reason, "provider paused");
    assert.equal(result.value.pending.length, 1);
    assert.equal(result.value.pending[0].tool_call_id, "call-1");
    assert.deepEqual(result.value.queued_messages, [
      { id: "q-1", text: "follow-up", status: "queued", position: 1, created_at: "2026-10-02T00:00:00Z" },
      { id: "q-2", text: "review later", status: "paused", position: 2, pause_reason: "needs review" },
    ]);
    assert.equal(recorded[0].url, "/api/sessions/s1");
  });

  it("loadSession rejects a queue row with a non-string status instead of trusting it in the view", async () => {
    stubStandardFetch({ "/api/sessions/s1": { id: "s1", task: "task", queued_messages: [
      { id: "q-1", text: "follow-up", status: ["queued"], position: 1 },
    ] } });
    const result = await loadSession(SESSION);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /queued messages/i);
  });

  it("loadSession rejects a malformed queue pause reason and preserves valid reasons", async () => {
    stubStandardFetch({ "/api/sessions/s1": { id: "s1", task: "task", queued_messages: [
      { id: "q-1", text: "follow-up", status: "paused", pause_reason: ["needs review"] },
    ] } });
    const malformed = await loadSession(SESSION);
    assert.equal(malformed.ok, false);
    if (!malformed.ok) assert.match(malformed.error, /queued messages/i);
    stubStandardFetch({ "/api/sessions/s1": { id: "s1", task: "task", queued_messages: [
      { id: "q-1", text: "follow-up", status: "paused", pause_reason: "needs review" },
    ] } });
    const valid = await loadSession(SESSION);
    if (!valid.ok) assert.fail(valid.error);
    assert.equal(valid.value.queued_messages?.[0]?.pause_reason, "needs review");
  });

  it("loadTimeline parses a valid events.v1 envelope with default paging", async () => {
    const envelope = {
      schema: "xueness.events.v1",
      protocolVersion: 1,
      sessionId: "s1",
      status: "running",
      steps: 2,
      mode: "build",
      events: [
        { schema: "xueness.event.v1", seq: 1, sessionId: "s1", type: "turn.user", turnId: "t1", preview: "go" },
        {
          schema: "xueness.event.v1",
          seq: 2,
          sessionId: "s1",
          type: "tool.call",
          turnId: "t1",
          toolCallId: "call-1",
          name: "write",
          subject: "a.ts",
        },
        {
          schema: "xueness.event.v1",
          seq: 3,
          sessionId: "s1",
          type: "tool.result",
          turnId: "t1",
          toolCallId: "call-1",
          name: "write",
          subject: "a.ts",
          ok: true,
          errorCode: "",
          error: "",
        },
      ],
      cursor: 0,
      nextCursor: 3,
      head: 3,
      hasMore: false,
    };
    stubStandardFetch({ [`/api/sessions/s1/events.v1?cursor=0&limit=200`]: envelope });

    const result = await loadTimeline(SESSION);
    if (!result.ok) assert.fail(result.error);
    assert.equal(result.value.cursor, 0);
    assert.equal(result.value.nextCursor, 3);
    assert.equal(result.value.head, 3);
    assert.equal(result.value.hasMore, false);
    assert.deepEqual(result.value.events.map((event) => event.seq), [1, 2, 3]);
  });

  it("loadTimeline forwards explicit cursor and limit", async () => {
    const base = {
      schema: "xueness.events.v1",
      protocolVersion: 1,
      sessionId: "s1",
      status: "running",
      steps: 1,
      mode: "build",
      events: [],
      cursor: 5,
      nextCursor: 5,
      head: 9,
      hasMore: true,
    };
    stubStandardFetch({ "/api/sessions/s1/events.v1?cursor=5&limit=50": base });

    const result = await loadTimeline(SESSION, 5, 50);
    if (!result.ok) assert.fail(result.error);
    assert.equal(result.value.cursor, 5);
    assert.equal(result.value.hasMore, true);
  });

  it("loadTimeline rejects a malformed envelope as {ok:false}", async () => {
    stubFetch((url) => {
      assert.equal(url, "/api/sessions/s1/events.v1?cursor=0&limit=200");
      return jsonResponse({ schema: "xueness.events.v1", protocolVersion: 1, events: "not-an-array" });
    });

    const result = await loadTimeline(SESSION);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /envelope/i);
  });

  it("loadCompleteTimeline reads every page through the first head snapshot", async () => {
    const head = 450;
    stubFetch((url) => {
      const query = new URL(url, "http://xueness.test").searchParams;
      assert.equal(query.get("limit"), "200");
      const cursor = Number(query.get("cursor"));
      const nextCursor = Math.min(cursor + 200, head);
      return jsonResponse(timelineEnvelope(cursor, head, nextCursor, nextCursor < head));
    });

    const result = await loadCompleteTimeline(SESSION);
    if (!result.ok) assert.fail(result.error);
    assert.deepEqual(recorded.map((call) => new URL(call.url, "http://xueness.test").searchParams.get("cursor")), ["0", "200", "400"]);
    assert.equal(result.value.cursor, 0);
    assert.equal(result.value.nextCursor, head);
    assert.equal(result.value.head, head);
    assert.equal(result.value.hasMore, false);
    assert.equal(result.value.events.length, head);
    assert.deepEqual(result.value.events.slice(0, 2).map((event) => event.seq), [1, 2]);
    assert.deepEqual(result.value.events.slice(-2).map((event) => event.seq), [449, 450]);
  });

  it("loadCompleteTimeline reports a failed later page rather than returning a partial timeline", async () => {
    stubFetch((url) => {
      const cursor = Number(new URL(url, "http://xueness.test").searchParams.get("cursor"));
      if (cursor === 0) return jsonResponse(timelineEnvelope(0, 450, 200, true));
      return jsonResponse({ error: "page two unavailable" }, 503);
    });

    assert.deepEqual(await loadCompleteTimeline(SESSION), { ok: false, error: "page two unavailable" });
    assert.equal(recorded.length, 2);
  });

  it("loadCompleteTimeline rejects a page whose cursor does not advance", async () => {
    stubFetch((url) => {
      const cursor = Number(new URL(url, "http://xueness.test").searchParams.get("cursor"));
      return jsonResponse(cursor === 0
        ? timelineEnvelope(0, 250, 200, true)
        : timelineEnvelope(200, 250, 200, true));
    });

    const result = await loadCompleteTimeline(SESSION);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /cursor did not advance/i);
    assert.equal(recorded.length, 2);
  });
});

// ---------------------------------------------------------------------------
// Failure paths — never throw, always {ok:false, error}
// ---------------------------------------------------------------------------

describe("xuenessWorkbench failure paths", () => {
  it("HTTP 500 with a JSON error body reports the server error", async () => {
    stubFetch(() => jsonResponse({ error: "boom" }, 500));

    const result = await listSessions();
    assert.deepEqual(result, { ok: false, error: "boom" });
  });

  it("HTTP 500 without a JSON body reports HTTP status", async () => {
    stubFetch(() => new Response("server exploded", { status: 500 }));

    const result = await loadSession(SESSION);
    assert.deepEqual(result, { ok: false, error: "HTTP 500" });
  });

  it("a non-JSON 200 response is reported as invalid JSON", async () => {
    stubFetch(() => new Response("<html>oops</html>", { status: 200 }));

    const result = await listSessions();
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /json/i);
  });

  it("a network failure is caught into {ok:false}", async () => {
    stubFetchFailure(new TypeError("network down"));

    const result = await loadTimeline(SESSION);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, "network down");
  });

  it("loadFiles and loadFilePreview also fail soft", async () => {
    stubFetch(() => jsonResponse({ error: "nope" }, 404));

    const files = await loadFiles(SESSION);
    assert.deepEqual(files, { ok: false, error: "nope" });

    const preview = await loadFilePreview(SESSION, "a.ts");
    assert.deepEqual(preview, { ok: false, error: "nope" });
  });
});

// ---------------------------------------------------------------------------
// Approvals — contract §4, including no-network rejection branches
// ---------------------------------------------------------------------------

describe("xuenessWorkbench approvePending", () => {
  const writePending: PendingApproval = {
    tool_call_id: "call-1",
    name: "write",
    subject: "src/a.ts",
    preview: "…",
  };

  it("write approval sends {kind, subject, tool_call_id} with CSRF headers", async () => {
    stubStandardFetch({ "/api/sessions/s1/approvals": { approved: writePending } });

    const result = await approvePending(SESSION, writePending);
    if (!result.ok) assert.fail(result.error);
    assert.equal(result.value, "call-1");

    // GET /api/csrf first, then the POST.
    assert.deepEqual(recorded.map((call) => call.url), ["/api/csrf", "/api/sessions/s1/approvals"]);
    assert.equal(recorded[0].init.method, undefined);
    assert.equal(recorded[0].init.credentials, "same-origin");
    assert.equal(recorded[0].init.cache, "no-store");

    const post = recorded[1];
    assert.equal(post.init.method, "POST");
    assert.equal(post.init.credentials, "same-origin");
    assert.equal(headerOf(post, "X-CSRF-Token"), "test-csrf-token");
    assert.equal(headerOf(post, "Content-Type"), "application/json");
    assert.deepEqual(bodyOf(post), { kind: "write", subject: "src/a.ts", tool_call_id: "call-1" });
  });

  it("canonical capability approvals send only kind and journal call id", async () => {
    stubStandardFetch({ "/api/sessions/s1/approvals": { approved: {} } });
    const result = await approvePending(SESSION, {
      tool_call_id: "call-network", name: "web_fetch", kind: "network",
      subject: JSON.stringify({ url: "https://example.invalid" }), preview: "GET ...",
    });
    if (!result.ok) assert.fail(result.error);
    assert.deepEqual(bodyOf(recorded[1]), { kind: "network", tool_call_id: "call-network" });
  });

  it("edit approval keeps kind=edit", async () => {
    stubStandardFetch({ "/api/sessions/s1/approvals": { approved: {} } });

    const result = await approvePending(SESSION, {
      tool_call_id: "call-2",
      name: "edit",
      subject: "src/b.ts",
      preview: "…",
    });
    if (!result.ok) assert.fail(result.error);

    const post = lastCall();
    assert.deepEqual(bodyOf(post), { kind: "edit", subject: "src/b.ts", tool_call_id: "call-2" });
  });

  it("exec approval parses the canonical argv JSON array from subject", async () => {
    stubStandardFetch({ "/api/sessions/s1/approvals": { approved: {} } });

    const result = await approvePending(SESSION, {
      tool_call_id: "call-3",
      name: "exec",
      subject: '["python","--version"]',
      preview: "python --version",
    });
    if (!result.ok) assert.fail(result.error);

    assert.deepEqual(bodyOf(lastCall()), {
      kind: "exec",
      argv: ["python", "--version"],
      tool_call_id: "call-3",
    });
  });

  it("mcp approval sends kind=tool_call_id only and never the subject", async () => {
    stubStandardFetch({ "/api/sessions/s1/approvals": { approved: {} } });

    const result = await approvePending(SESSION, {
      tool_call_id: "call-4",
      name: "mcp__weather",
      subject: "some journal subject",
      preview: "weather tool",
    });
    if (!result.ok) assert.fail(result.error);

    const body = bodyOf(lastCall()) as Record<string, unknown>;
    assert.deepEqual(body, { kind: "mcp", tool_call_id: "call-4" });
    assert.equal("subject" in body, false);
    assert.equal("argv" in body, false);
    assert.equal(JSON.stringify(body).includes('"subject"'), false);
  });

  // -- rejection branches: no request at all --------------------------------

  it("unsupported kind returns an error without any network request", async () => {
    stubFetch(() => {
      throw new Error("must not be called");
    });

    const result = await approvePending(SESSION, {
      tool_call_id: "call-5",
      name: "bash",
      subject: "irrelevant",
      preview: "…",
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, "unsupported approval kind");
    assert.equal(recorded.length, 0);
  });

  it("exec subject that is not valid JSON is rejected before any request", async () => {
    stubFetch(() => {
      throw new Error("must not be called");
    });

    const result = await approvePending(SESSION, {
      tool_call_id: "call-6",
      name: "exec",
      subject: "not json at all",
      preview: "…",
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /JSON array/);
    assert.equal(recorded.length, 0);
  });

  it("exec subject that is JSON but not an array is rejected before any request", async () => {
    stubFetch(() => {
      throw new Error("must not be called");
    });

    const result = await approvePending(SESSION, {
      tool_call_id: "call-7",
      name: "exec",
      subject: '{"not":"an array"}',
      preview: "…",
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /JSON array/);
    assert.equal(recorded.length, 0);
  });

  it("empty subject is rejected without any request", async () => {
    stubFetch(() => {
      throw new Error("must not be called");
    });

    const result = await approvePending(SESSION, { ...writePending, subject: "" });
    assert.equal(result.ok, false);
    assert.equal(recorded.length, 0);
  });

  it("empty tool_call_id is rejected without any request", async () => {
    stubFetch(() => {
      throw new Error("must not be called");
    });

    const result = await approvePending(SESSION, { ...writePending, tool_call_id: "" });
    assert.equal(result.ok, false);
    assert.equal(recorded.length, 0);
  });

  it("a server-side 400 becomes {ok:false, error}", async () => {
    stubFetch((url) => {
      if (url === "/api/csrf") return jsonResponse({ csrfToken: "test-csrf-token" });
      if (url === "/api/sessions/s1/approvals") return jsonResponse({ error: "denied" }, 400);
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await approvePending(SESSION, writePending);
    assert.deepEqual(result, { ok: false, error: "denied" });
    assert.equal(callsTo("/api/sessions/s1/approvals").length, 1);
  });
});

// ---------------------------------------------------------------------------
// Run orchestration: createSession / sendTurn / answerQuestion / runSession
// ---------------------------------------------------------------------------

describe("xuenessWorkbench run orchestration", () => {
  it("createSession posts {task} without root, then immediately runs", async () => {
    stubStandardFetch({ "/api/sessions": { id: "new-1" }, "/api/sessions/new-1/run": {} });

    const result = await createSession("修复登录 bug");
    assert.deepEqual(result, { ok: true, value: "new-1" });

    assert.deepEqual(recorded.map((call) => call.url), [
      "/api/csrf",
      "/api/sessions",
      "/api/settings/agent",
      "/api/csrf",
      "/api/sessions/new-1/run",
    ]);

    const createBody = bodyOf(recorded[1]) as Record<string, unknown>;
    assert.deepEqual(createBody, { task: "修复登录 bug" });
    assert.equal("root" in createBody, false);

    const runBody = bodyOf(recorded[4]) as Record<string, unknown>;
    assert.deepEqual(runBody, {
      provider: "real",
      mode: "build",
      permission_mode: "build",
      browser: false,
      allow_mcp: true,
      allow_subagents: false,
      allow_hooks: false,
    });
  });

  it("createSession forwards explicit run choices into the run body", async () => {
    stubStandardFetch({ "/api/sessions": { id: "new-2" }, "/api/sessions/new-2/run": {} });

    const result = await createSession("real run", { provider: "real", mode: "plan", runtime_profile: "lightweight" });
    if (!result.ok) assert.fail(result.error);

    const runBody = bodyOf(lastCall()) as Record<string, unknown>;
    assert.equal(runBody.provider, "real");
    assert.equal(runBody.mode, "plan");
    assert.equal(runBody.runtime_profile, "lightweight");
    assert.equal("steps" in runBody, false, "ordinary runs inherit the selected server profile budget");
  });

  it("createSession fails soft when the server returns no id", async () => {
    stubStandardFetch({ "/api/sessions": {} });

    const result = await createSession("no id");
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /no id/);
    assert.equal(callsTo("/api/sessions/new-1/run").length, 0);
  });

  it("goal runs keep their explicit budget while ordinary runs preserve explicit caller budgets", async () => {
    stubStandardFetch({ "/api/sessions": { id: "goal-1" }, "/api/sessions/goal-1/run": {} });
    const goalResult = await createSession("goal run", { provider: "real", mode: "build", goal: true });
    if (!goalResult.ok) assert.fail(goalResult.error);
    assert.equal((bodyOf(lastCall()) as Record<string, unknown>).steps, 20);

    stubStandardFetch({ "/api/sessions/s-explicit/run": {} });
    const explicitChoices = { provider: "real", mode: "build", steps: 5 } as Parameters<typeof runSession>[1] & { steps: number };
    const explicitResult = await runSession("s-explicit", explicitChoices);
    assert.deepEqual(explicitResult, { ok: true, value: undefined });
    assert.equal((bodyOf(lastCall()) as Record<string, unknown>).steps, 5);
  });

  it("sendTurn posts {text} then runs", async () => {
    stubStandardFetch({ "/api/sessions/s9/messages": {}, "/api/sessions/s9/run": {} });

    const result = await sendTurn("s9", "继续下一步");
    assert.deepEqual(result, { ok: true, value: undefined });

    assert.deepEqual(recorded.map((call) => call.url), [
      "/api/csrf",
      "/api/sessions/s9/messages",
      "/api/settings/agent",
      "/api/csrf",
      "/api/sessions/s9/run",
    ]);
    assert.deepEqual(bodyOf(recorded[1]), { text: "继续下一步" });
  });

  it('sendTurn acknowledges the durable message before model execution, even if the run fails', async () => {
    let accepted = false;
    stubFetch(url => {
      if (url === '/api/csrf') return jsonResponse({ csrfToken: 'test-csrf-token' });
      if (url === '/api/settings/agent') return jsonResponse({ values: {} });
      if (url.endsWith('/messages')) { assert.equal(accepted, false); return jsonResponse({}); }
      if (url.endsWith('/run')) { assert.equal(accepted, true); return jsonResponse({ error: 'provider failed' }, 502); }
      throw new Error(url);
    });
    const result = await sendTurn('s9', 'accepted text', undefined, undefined, () => { accepted = true; });
    assert.equal(accepted, true);
    assert.equal(result.ok, false);
    assert.equal(result.accepted, true);
  });

  it("sendTurn does not run when posting the message fails", async () => {
    stubFetch((url) => {
      if (url === "/api/csrf") return jsonResponse({ csrfToken: "test-csrf-token" });
      if (url === "/api/sessions/s9/messages") return jsonResponse({ error: "conflict" }, 409);
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await sendTurn("s9", "hi");
    assert.deepEqual(result, { ok: false, error: "conflict" });
    assert.equal(callsTo("/api/sessions/s9/run").length, 0);
  });

  it("queueTurn posts one-use prepared input and validates the returned queued item identity", async () => {
    stubStandardFetch({ "/api/sessions/s9/queue": { id: "q-1", item: {
      id: "q-1", text: "follow-up", status: "queued", position: 2, created_at: "2026-10-02T00:00:00Z",
    } } });
    const result = await queueTurn("s9", "follow-up", "prepared-once");
    assert.deepEqual(result, { ok: true, value: {
      id: "q-1", text: "follow-up", status: "queued", position: 2, created_at: "2026-10-02T00:00:00Z",
    } });
    assert.deepEqual(recorded.map(call => call.url), ["/api/csrf", "/api/sessions/s9/queue"]);
    assert.equal(recorded[1].init.method, "POST");
    assert.equal(headerOf(recorded[1], "X-CSRF-Token"), "test-csrf-token");
    assert.deepEqual(bodyOf(recorded[1]), { text: "follow-up", prepared_token: "prepared-once" });
  });

  it("queueTurn accepts a paused 202 response without treating the submitted turn as failed", async () => {
    stubStandardFetch({ "/api/sessions/s9/queue": { id: "q-paused", item: {
      id: "q-paused", text: "follow-up", status: "paused", position: 1, pause_reason: "needs review",
      created_at: "2026-10-02T00:00:00Z",
    } } });
    const result = await queueTurn("s9", "follow-up");
    assert.deepEqual(result, { ok: true, value: {
      id: "q-paused", text: "follow-up", status: "paused", position: 1, pause_reason: "needs review", created_at: "2026-10-02T00:00:00Z",
    } });
    assert.deepEqual(recorded.map(call => call.url), ["/api/csrf", "/api/sessions/s9/queue"]);
    assert.equal(recorded.filter(call => call.url === "/api/sessions/s9/queue").length, 1);
  });

  it("queueTurn rejects malformed status enums even when an array contains a valid label", async () => {
    stubStandardFetch({ "/api/sessions/s9/queue": { id: "q-1", item: {
      id: "q-1", text: "follow-up", status: ["queued"], position: 1,
    } } });
    const result = await queueTurn("s9", "follow-up");
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /invalid queue response/i);
  });

  it("cancelQueuedTurn sends an authenticated DELETE for only the selected queue ID", async () => {
    stubStandardFetch({ "/api/sessions/s9/queue/q%2F1": { removed: true, id: "q/1", remaining: 0 } });
    const result = await cancelQueuedTurn("s9", "q/1");
    assert.deepEqual(result, { ok: true, value: undefined });
    assert.deepEqual(recorded.map(call => call.url), ["/api/csrf", "/api/sessions/s9/queue/q%2F1"]);
    assert.equal(recorded[1].init.method, "DELETE");
    assert.equal(headerOf(recorded[1], "X-CSRF-Token"), "test-csrf-token");
  });

  it("answerQuestion posts {answer}", async () => {
    stubStandardFetch({ "/api/sessions/s7/answer": {} });

    const result = await answerQuestion("s7", "42");
    assert.deepEqual(result, { ok: true, value: undefined });

    assert.deepEqual(recorded.map((call) => call.url), [
      "/api/csrf",
      "/api/sessions/s7/answer",
    ]);
    assert.deepEqual(bodyOf(recorded[1]), { answer: "42" });
    assert.equal(headerOf(recorded[1], "X-CSRF-Token"), "test-csrf-token");
  });

  it("runSession reads opt-ins first, then posts the run with CSRF token", async () => {
    stubStandardFetch({ "/api/sessions/s5/run": {} });

    const result = await runSession("s5");
    assert.deepEqual(result, { ok: true, value: undefined });

    assert.deepEqual(recorded.map((call) => call.url), [
      "/api/settings/agent",
      "/api/csrf",
      "/api/sessions/s5/run",
    ]);
    const runBody = bodyOf(recorded[2]) as Record<string, unknown>;
    assert.deepEqual(runBody, {
      provider: "real",
      mode: "build",
      permission_mode: "build",
      browser: false,
      allow_mcp: true,
      allow_subagents: false,
      allow_hooks: false,
    });
    assert.equal(headerOf(recorded[2], "X-CSRF-Token"), "test-csrf-token");
  });

  it("runSession carries the yolo acknowledgement from RunChoices into the request", async () => {
    stubStandardFetch({ "/api/sessions/s6/run": {} });

    const result = await runSession("s6", {
      provider: "real",
      mode: "build",
      permission_mode: "yolo",
      acknowledge_yolo: true,
    });
    assert.deepEqual(result, { ok: true, value: undefined });
    const runCall = recorded.find(call => call.url === "/api/sessions/s6/run");
    assert.ok(runCall);
    assert.equal((bodyOf(runCall) as Record<string, unknown>).acknowledge_yolo, true);
    assert.equal((bodyOf(runCall) as Record<string, unknown>).permission_mode, "yolo");
  });

  it("runSession reports server errors as {ok:false}", async () => {
    stubFetch((url) => {
      if (url === "/api/settings/agent") return jsonResponse({ values: {} });
      if (url === "/api/csrf") return jsonResponse({ csrfToken: "test-csrf-token" });
      if (url === "/api/sessions/s5/run") return jsonResponse({ error: "provider gate" }, 403);
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await runSession("s5");
    assert.deepEqual(result, { ok: false, error: "provider gate" });
  });

  it("runSession sends continue_queue only for an explicit paused-queue continuation", async () => {
    stubStandardFetch({ "/api/sessions/s5/run": {} });

    const result = await runSession("s5", undefined, { continueQueue: true });
    assert.deepEqual(result, { ok: true, value: undefined });
    const runCall = recorded.find(call => call.url === "/api/sessions/s5/run");
    assert.ok(runCall);
    assert.deepEqual(bodyOf(runCall), {
      provider: "real",
      mode: "build",
      permission_mode: "build",
      browser: false,
      allow_mcp: true,
      allow_subagents: false,
      allow_hooks: false,
      continue_queue: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

describe("xuenessWorkbench files", () => {
  it("loadFiles returns the workspace listing", async () => {
    stubStandardFetch({
      "/api/sessions/s1/files": {
        files: [
          { path: "README.md", size: 120 },
          { path: "src/a.ts", size: 456 },
        ],
        truncated: true,
        count: 2,
      },
    });

    const result = await loadFiles(SESSION);
    if (!result.ok) assert.fail(result.error);
    assert.deepEqual(result.value, {
      files: [
        { path: "README.md", size: 120 },
        { path: "src/a.ts", size: 456 },
      ],
      truncated: true,
      count: 2,
    });
    assert.equal(recorded[0].url, "/api/sessions/s1/files");
  });

  it("loadFilePreview encodes the requested path into the query string", async () => {
    stubStandardFetch({
      [`/api/sessions/s1/file?${new URLSearchParams({ path: "docs/说明.md" }).toString()}`]: {
        path: "docs/说明.md",
        size: 12,
        truncated: false,
        text: "hello 世界",
      },
    });

    const result = await loadFilePreview(SESSION, "docs/说明.md");
    if (!result.ok) assert.fail(result.error);
    assert.deepEqual(result.value, {
      path: "docs/说明.md",
      size: 12,
      truncated: false,
      text: "hello 世界",
    });
  });
});

// ---------------------------------------------------------------------------
// toTimelineRows — contract §5 pure projection
// ---------------------------------------------------------------------------

describe("toTimelineRows", () => {
  const base = { schema: "xueness.event.v1", sessionId: "s1" } as const;

  const mixed: XuenessEventV1[] = [
    { ...base, seq: 1, type: "session.status", status: "running", steps: 0, mode: "build" },
    { ...base, seq: 2, type: "turn.user", turnId: "t1", preview: "帮我把默认页改成暗色" },
    {
      ...base,
      seq: 3,
      type: "tool.call",
      turnId: "t1",
      toolCallId: "call-1",
      name: "write",
      subject: "src/theme.ts",
    },
    {
      ...base,
      seq: 4,
      type: "tool.result",
      turnId: "t1",
      toolCallId: "call-1",
      name: "write",
      subject: "src/theme.ts",
      ok: true,
      errorCode: "",
      error: "",
    },
    { ...base, seq: 5, type: "assistant.text", turnId: "t1", preview: "已改完" },
    { ...base, seq: 6, type: "session.completion", verified: true, summary: "done", evidenceCount: 1 },
    { ...base, seq: 7, type: "session.pending_question", question: "要继续吗?" },
  ];

  it("projects the full happy path: user/tool(paired)/assistant/completion/question, and session.status produces no row", () => {
    const rows = toTimelineRows(mixed);
    assert.deepEqual(rows, [
      { kind: "user", seq: 2, turnId: "t1", text: "帮我把默认页改成暗色" },
      {
        kind: "tool",
        seq: 3,
        turnId: "t1",
        toolCallId: "call-1",
        name: "write",
        subject: "src/theme.ts",
        status: "ok",
        error: "",
        errorCode: "",
      },
      { kind: "assistant", seq: 5, turnId: "t1", text: "已改完" },
      { kind: "completion", seq: 6, verified: true, summary: "done" },
      { kind: "pending_question", seq: 7, question: "要继续吗?" },
    ]);
  });

  it("upgrades the paired tool row in place with the error outcome, keeping the call seq", () => {
    const events: XuenessEventV1[] = [
      { ...base, seq: 3, type: "tool.call", turnId: "t1", toolCallId: "call-1", name: "exec", subject: '["bash"]' },
      {
        ...base,
        seq: 4,
        type: "tool.result",
        turnId: "t1",
        toolCallId: "call-1",
        name: "exec",
        subject: '["bash"]',
        ok: false,
        errorCode: "xueness.error.denied",
        error: "denied: outside workspace",
      },
    ];

    const rows = toTimelineRows(events);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], {
      kind: "tool",
      seq: 3,
      turnId: "t1",
      toolCallId: "call-1",
      name: "exec",
      subject: '["bash"]',
      status: "error",
      error: "denied: outside workspace",
      errorCode: "xueness.error.denied",
    });
  });

  it("a tool row without a result stays running", () => {
    const events: XuenessEventV1[] = [
      { ...base, seq: 3, type: "tool.call", turnId: "t1", toolCallId: "call-1", name: "write", subject: "a.ts" },
    ];

    const rows = toTimelineRows(events);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.kind, "tool");
    if (row.kind === "tool") {
      assert.equal(row.status, "running");
      assert.equal(row.error, "");
      assert.equal(row.errorCode, "");
    }
  });

  it("an orphan tool.result adds a terminal row instead of upgrading", () => {
    const events: XuenessEventV1[] = [
      {
        ...base,
        seq: 9,
        type: "tool.result",
        turnId: "t2",
        toolCallId: "call-9",
        name: "edit",
        subject: "b.ts",
        ok: false,
        errorCode: "xueness.error.tool_failed",
        error: "boom",
      },
    ];

    assert.deepEqual(toTimelineRows(events), [
      {
        kind: "tool",
        seq: 9,
        turnId: "t2",
        toolCallId: "call-9",
        name: "edit",
        subject: "b.ts",
        status: "error",
        error: "boom",
        errorCode: "xueness.error.tool_failed",
      },
    ]);
  });

  it("interleaved calls/results upgrade their own rows in place", () => {
    const events: XuenessEventV1[] = [
      { ...base, seq: 3, type: "tool.call", turnId: "t1", toolCallId: "A", name: "write", subject: "a.ts" },
      { ...base, seq: 4, type: "tool.call", turnId: "t1", toolCallId: "B", name: "write", subject: "b.ts" },
      {
        ...base,
        seq: 5,
        type: "tool.result",
        turnId: "t1",
        toolCallId: "B",
        name: "write",
        subject: "b.ts",
        ok: true,
        errorCode: "",
        error: "",
      },
      {
        ...base,
        seq: 6,
        type: "tool.result",
        turnId: "t1",
        toolCallId: "A",
        name: "write",
        subject: "a.ts",
        ok: false,
        errorCode: "xueness.error.tool_failed",
        error: "a failed",
      },
    ];

    const rows = toTimelineRows(events);
    assert.equal(rows.length, 2);
    const [rowA, rowB] = rows;
    assert.equal(rowA.kind, "tool");
    assert.equal(rowB.kind, "tool");
    if (rowA.kind === "tool" && rowB.kind === "tool") {
      assert.equal(rowA.toolCallId, "A");
      assert.equal(rowA.seq, 3);
      assert.equal(rowA.status, "error");
      assert.equal(rowB.toolCallId, "B");
      assert.equal(rowB.seq, 4);
      assert.equal(rowB.status, "ok");
    }
    // Row order still ascending by call seq after in-place upgrades.
    const seqs = rows.map((row) => row.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  });

  it("keeps rows in ascending seq order even for out-of-order input", () => {
    const events: XuenessEventV1[] = [
      { ...base, seq: 5, type: "assistant.text", turnId: "t1", preview: "later" },
      { ...base, seq: 2, type: "turn.user", turnId: "t1", preview: "earlier" },
    ];

    assert.deepEqual(toTimelineRows(events), [
      { kind: "user", seq: 2, turnId: "t1", text: "earlier" },
      { kind: "assistant", seq: 5, turnId: "t1", text: "later" },
    ]);
  });

  it("projects optional completion status metadata without changing legacy v1 rows", () => {
    const event: XuenessEventV1 = { ...base, seq: 2, type: "session.completion", verified: false,
      summary: "hello", evidenceCount: 0, status: "not_applicable", toolExecutionStatus: "not_applicable",
      deliveryStatus: "not_assessed", turnId: "t1" };
    assert.deepEqual(toTimelineRows([event]), [{ kind: "completion", seq: 2, verified: false, summary: "hello",
      status: "not_applicable", toolExecutionStatus: "not_applicable", deliveryStatus: "not_assessed", turnId: "t1" }]);
  });

  it("never mutates the input events", () => {
    const events: XuenessEventV1[] = [...mixed];
    const snapshot = structuredClone(events);
    toTimelineRows(events);
    assert.deepEqual(events, snapshot);
  });
});

describe("structural sharing stabilization", () => {
  it("stabilizeTimelineRows returns the identical array instance when rows match", () => {
    const prev: any[] = [
      { kind: "user", seq: 1, turnId: "t1", text: "hello" },
      { kind: "assistant", seq: 2, turnId: "t1", text: "world", streaming: false },
    ];
    const next: any[] = [
      { kind: "user", seq: 1, turnId: "t1", text: "hello" },
      { kind: "assistant", seq: 2, turnId: "t1", text: "world", streaming: false },
    ];
    const result = stabilizeTimelineRows(prev, next);
    assert.equal(result, prev);
    assert.equal(result[0], prev[0]);
    assert.equal(result[1], prev[1]);
  });

  it("stabilizeTimelineRows reuses unchanged row instances when new rows append", () => {
    const prev: any[] = [
      { kind: "user", seq: 1, turnId: "t1", text: "hello" },
    ];
    const next: any[] = [
      { kind: "user", seq: 1, turnId: "t1", text: "hello" },
      { kind: "assistant", seq: 2, turnId: "t1", text: "new response", streaming: true },
    ];
    const result = stabilizeTimelineRows(prev, next);
    assert.notEqual(result, prev);
    assert.equal(result[0], prev[0]); // reused previous instance!
    assert.equal(result[1], next[1]);
  });

  it("stabilizeSession returns the same session instance when data has not changed", () => {
    const prev: any = {
      id: "s1", status: "completed", task: "do something", title: "Task 1",
      pinned: false, root: "/ws", streaming: null, todos: [], queued_messages: [],
      model_selection: { provider_id: "p1", model: "m1" }, changed_files: ["src/a.ts"],
      future_metadata: { revision: 2, tags: ["ready", "reviewed"] },
    };
    const next: any = {
      id: "s1", status: "completed", task: "do something", title: "Task 1",
      pinned: false, root: "/ws", streaming: null, todos: [], queued_messages: [],
      future_metadata: { tags: ["ready", "reviewed"], revision: 2 }, changed_files: ["src/a.ts"],
      model_selection: { model: "m1", provider_id: "p1" },
    };
    assert.equal(stabilizeSession(prev, next), prev);
  });

  it("stabilizeSession accepts goal, permission, model, file and additive metadata changes", () => {
    const base: any = {
      id: "s1", status: "completed", task: "do something", title: "Task 1",
      pinned: false, root: "/ws", streaming: null, todos: [], queued_messages: [],
      goal: null, permission_mode: "build", model_selection: { provider_id: "p1", model: "m1" },
      changed_files: ["src/a.ts"],
    };
    const goal = { text: "Ship the report", status: "active", setAt: "t1", updatedAt: "t1", history: [] };
    const savedGoal: any = { ...base, goal };
    assert.equal(stabilizeSession(base, savedGoal), savedGoal, "saving a goal must update the snapshot");

    const clearedGoal: any = { ...savedGoal, goal: { ...goal, status: "cleared", updatedAt: "t2" } };
    assert.equal(stabilizeSession(savedGoal, clearedGoal), clearedGoal, "clearing a goal must update the snapshot");
    const removedGoal: any = { ...clearedGoal, goal: null };
    assert.equal(stabilizeSession(clearedGoal, removedGoal), removedGoal, "removing a goal must update the snapshot");

    const changes: Array<[string, Record<string, unknown>]> = [
      ["permission mode", { permission_mode: "yolo" }],
      ["model selection", { model_selection: { provider_id: "p2", model: "m2" } }],
      ["changed files", { changed_files: ["src/a.ts", "out/report.pdf"] }],
      ["additive API field", { future_metadata: { revision: 3, labels: ["new"] } }],
    ];
    for (const [label, change] of changes) {
      const next: any = { ...base, ...change };
      assert.equal(stabilizeSession(base, next), next, `${label} change must be accepted`);
    }
  });

  it("stabilizeSession preserves array order and still accepts streaming updates", () => {
    const prev: any = {
      id: "s1", status: "running", task: "do something",
      streaming: { id: "turn1", status: "streaming", text: "same" },
      changed_files: ["src/a.ts", "src/b.ts"],
    };
    const reordered: any = { ...prev, changed_files: ["src/b.ts", "src/a.ts"] };
    assert.equal(stabilizeSession(prev, reordered), reordered, "ordered product data must not be normalized away");

    const streamed: any = { ...prev, streaming: { id: "turn1", status: "streaming", text: "same plus more" } };
    assert.equal(stabilizeSession(prev, streamed), streamed);
  });

  it("stabilizeSession returns new session instance when streaming status updates", () => {
    const prev: any = {
      id: "s1", status: "running", task: "do something",
      streaming: { id: "turn1", status: "streaming", text: "foo" },
    };
    const next: any = {
      id: "s1", status: "running", task: "do something",
      streaming: { id: "turn1", status: "streaming", text: "foo bar" },
    };
    assert.notEqual(stabilizeSession(prev, next), prev);
  });

  it("stabilizeSessionList returns the identical array when sessions match", () => {
    const prev: any[] = [
      { id: "s1", task: "task 1", title: "Title 1", status: "completed", pinned: true },
      { id: "s2", task: "task 2", title: "Title 2", status: "running", pinned: false },
    ];
    const next: any[] = [
      { id: "s1", task: "task 1", title: "Title 1", status: "completed", pinned: true },
      { id: "s2", task: "task 2", title: "Title 2", status: "running", pinned: false },
    ];
    const result = stabilizeSessionList(prev, next);
    assert.equal(result, prev);
  });

  it("stabilizeSessionList reuses unchanged item references when one status changes", () => {
    const prev: any[] = [
      { id: "s1", task: "task 1", title: "Title 1", status: "running", pinned: false },
      { id: "s2", task: "task 2", title: "Title 2", status: "completed", pinned: true },
    ];
    const next: any[] = [
      { id: "s1", task: "task 1", title: "Title 1", status: "completed", pinned: false },
      { id: "s2", task: "task 2", title: "Title 2", status: "completed", pinned: true },
    ];
    const result = stabilizeSessionList(prev, next);
    assert.notEqual(result, prev);
    assert.equal(result[1], prev[1]); // s2 reused!
    assert.equal(result[0], next[0]); // s1 updated!
  });
});

test("formatCommandArgv quotes arguments with spaces so distinct argv never render the same", async () => {
  const { formatCommandArgv } = await import("./xuenessWorkbench");
  assert.equal(formatCommandArgv(["git", "status"]), "git status");
  assert.equal(formatCommandArgv(["git", "commit", "-m", "fix bug"]), 'git commit -m "fix bug"');
  assert.notEqual(formatCommandArgv(["a", "b c"]), formatCommandArgv(["a", "b", "c"]));
  // Windows 路径保持反斜杠可读，只给带空格的段加引号
  assert.equal(formatCommandArgv(["C:\\Program Files\\Git\\bin\\git.exe", "--version"]), '"C:\\Program Files\\Git\\bin\\git.exe" --version');
  assert.equal(formatCommandArgv(["echo", 'say "hi"', ""]), 'echo "say \\"hi\\"" ""');
});

test("loadSession and loadFiles forward AbortSignal to fetch and handle aborts gracefully", async () => {
  stubFetch((url, init) => {
    if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
    if (url === "/api/sessions/s1") return jsonResponse({ id: "s1", status: "idle", task: "test" });
    if (url === "/api/sessions/s1/files") return jsonResponse({ files: [], truncated: false });
    throw new Error(`unexpected url: ${url}`);
  });

  const controller = new AbortController();
  const sessionRes = await loadSession("s1", controller.signal);
  assert.equal(sessionRes.ok, true);
  assert.equal(callsTo("/api/sessions/s1")[0].init.signal, controller.signal);

  const filesRes = await loadFiles("s1", controller.signal);
  assert.equal(filesRes.ok, true);
  assert.equal(callsTo("/api/sessions/s1/files")[0].init.signal, controller.signal);

  controller.abort();
  const abortedRes = await loadSession("s1", controller.signal);
  assert.equal(abortedRes.ok, false);
});
