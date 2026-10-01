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
  toTimelineRows,
  hydrateTimelineTools,
  hydrateTimelineJournalRows,
  withAssistantStream,
  withInitialUserMessage,
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
    assert.equal(withAssistantStream(completed, stream), completed);
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
    assert.equal(recorded[0].url, "/api/sessions/s1");
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
      steps: 8,
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
    assert.equal(runBody.steps, 8);
  });

  it("createSession fails soft when the server returns no id", async () => {
    stubStandardFetch({ "/api/sessions": {} });

    const result = await createSession("no id");
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /no id/);
    assert.equal(callsTo("/api/sessions/new-1/run").length, 0);
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
      steps: 8,
      allow_mcp: true,
      allow_subagents: false,
      allow_hooks: false,
    });
    assert.equal(headerOf(recorded[2], "X-CSRF-Token"), "test-csrf-token");
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

  it("never mutates the input events", () => {
    const events: XuenessEventV1[] = [...mixed];
    const snapshot = structuredClone(events);
    toTimelineRows(events);
    assert.deepEqual(events, snapshot);
  });
});
