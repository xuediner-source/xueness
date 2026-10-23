/**
 * `/api/workflows*` (Python `operations_api.dispatch`): ownership, the status
 * codes of each branch, the workspace fence, and the error ladder that turns
 * Python's exceptions into 409/404/400 bodies.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { isDict } from "@xueness/contracts";
import { SessionStore } from "@xueness/sessions";
import { createWorkflowHttp, WORKFLOW_ROUTES, type WorkflowHttpOptions } from "../src/http.ts";
import { workflowPlanDigest, type Row } from "../src/plan.ts";
import { WorkflowStore } from "../src/store.ts";

const PLAN = { name: "Fixture", nodes: [{ id: "one", kind: "command", argv: ["echo", "hi"] }], concurrency: 1 };

interface Fixture {
  state: string;
  root: string;
  other: string;
  store: WorkflowStore;
  options: WorkflowHttpOptions;
  http: ReturnType<typeof createWorkflowHttp>;
  cleanup(): void;
}

function fixture(overrides: Partial<WorkflowHttpOptions> = {}): Fixture {
  const base = mkdtempSync(join(tmpdir(), "xueness-http-"));
  const state = join(base, "state"), root = join(base, "workspace"), other = join(base, "other");
  mkdirSync(root, { recursive: true });
  mkdirSync(other, { recursive: true });
  // A launcher that does nothing: `launch` records `queued` and returns, which
  // is all these routes need. Python's handler never starts a worker itself.
  const store = new WorkflowStore(state, { launcher: () => {} });
  const options: WorkflowHttpOptions = {
    stateDir: state,
    store: () => store,
    sessionStore: new SessionStore(join(state, "sessions")),
    allowedRoots: () => [root],
    allowReal: () => true,
    allowRealHost: () => true,
    // The host owns the actor transcript; the store judges the answer first,
    // exactly as Python's `WorkflowStore.answer_actor` does.
    answerActor: async (wid, nodeId, answer) => {
      store.actorAwaiting(wid, nodeId, answer);
      return store.actorAnswered(wid, nodeId, answer);
    },
    expert: () => null,
    dynamicRuns: () => null,
    ...overrides,
  };
  return {
    state, root, other, store, options,
    http: createWorkflowHttp(options),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

/** `[status, body]` with the body asserted to be a JSON object. */
async function call(f: Fixture, method: string, parts: string[], data: Row = {}, query: Row = {}): Promise<[number, Row]> {
  const reply = await f.http.dispatch(method, parts, query, data);
  assert.ok(reply, "the workflow family must own /api/workflows*");
  assert.ok(isDict(reply[1]), `body is not an object: ${JSON.stringify(reply[1])}`);
  return [reply[0], reply[1]];
}

describe("workflow http ownership", () => {
  it("owns only the /api/workflows family", async () => {
    const f = fixture();
    try {
      assert.equal(f.http.owns("GET", ["api", "workflows"]), true);
      assert.equal(f.http.owns("POST", ["api", "workflows", "x"]), true);
      assert.equal(f.http.owns("GET", ["api", "workflows", "dwf"]), true);
      // Python also answers /api/sessions/<id>/tasks and /api/mcp/check, but
      // those belong to other plugins here.
      assert.equal(f.http.owns("GET", ["api", "sessions", "a".repeat(32), "tasks"]), false);
      assert.equal(f.http.owns("POST", ["api", "mcp", "check"]), false);
      assert.equal(f.http.owns("GET", ["api", "workflowsx"]), false);
      assert.equal(f.http.owns("GET", ["api"]), false);
      assert.equal(f.http.owns("GET", []), false);
      assert.equal(await f.http.dispatch("GET", ["api", "sessions"], {}, {}), null);
    } finally {
      f.cleanup();
    }
  });

  it("declares every route it answers", () => {
    for (const route of ["GET /api/workflows", "POST /api/workflows", "GET /api/workflows/*", "GET /api/workflows/*/logs/*", "POST /api/workflows/*/actors/*/answer", "POST /api/workflows/*/amend", "POST /api/workflows/*/start", "POST /api/workflows/*/resume"]) {
      assert.ok(WORKFLOW_ROUTES.includes(route), route);
    }
  });
});

describe("workflow http collection", () => {
  it("lists only runs inside a permitted root", async () => {
    const f = fixture();
    try {
      const visible = f.store.create(PLAN, f.root);
      f.store.create(PLAN, f.other);
      const [status, body] = await call(f, "GET", ["api", "workflows"]);
      assert.equal(status, 200);
      const rows = body.workflows as Row[];
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.id, visible.id);
    } finally {
      f.cleanup();
    }
  });

  it("creates a plan in a permitted workspace and refuses one outside", async () => {
    const f = fixture();
    try {
      const [status, body] = await call(f, "POST", ["api", "workflows"], { root: f.root, plan: PLAN });
      assert.equal(status, 200);
      assert.equal((body.plan as Row).name, "Fixture");
      const [refused, error] = await call(f, "POST", ["api", "workflows"], { root: f.other, plan: PLAN });
      assert.equal(refused, 400);
      assert.deepEqual(error, { error: "invalid operation, plan, approval or workspace" });
    } finally {
      f.cleanup();
    }
  });

  it("requires exactly one of plan or script and a root", async () => {
    const f = fixture();
    try {
      for (const data of [{ root: f.root }, { root: f.root, plan: PLAN, script: "phase('x')" }, { plan: PLAN }]) {
        const [status] = await call(f, "POST", ["api", "workflows"], data);
        assert.equal(status, 400, JSON.stringify(data));
      }
    } finally {
      f.cleanup();
    }
  });

  it("answers an unknown method on the collection with 404", async () => {
    const f = fixture();
    try {
      const [status, body] = await call(f, "PUT", ["api", "workflows"]);
      assert.equal(status, 404);
      assert.deepEqual(body, { error: "operation not found" });
    } finally {
      f.cleanup();
    }
  });
});

describe("workflow http records", () => {
  it("returns one record and hides a run from another workspace", async () => {
    const f = fixture();
    try {
      const created = f.store.create(PLAN, f.root);
      const [status, body] = await call(f, "GET", ["api", "workflows", created.id as string]);
      assert.equal(status, 200);
      assert.equal(body.id, created.id);
      const foreign = f.store.create(PLAN, f.other);
      const [hidden, error] = await call(f, "GET", ["api", "workflows", foreign.id as string]);
      assert.equal(hidden, 400);
      assert.deepEqual(error, { error: "invalid operation, plan, approval or workspace" });
    } finally {
      f.cleanup();
    }
  });

  it("maps a missing record to 404", async () => {
    const f = fixture();
    try {
      const [status, body] = await call(f, "GET", ["api", "workflows", "a".repeat(32)]);
      assert.equal(status, 404);
      assert.deepEqual(body, { error: "resource not found" });
    } finally {
      f.cleanup();
    }
  });

  it("returns the bounded log tail and refuses an unknown node", async () => {
    const f = fixture();
    try {
      const created = f.store.create(PLAN, f.root);
      const [status, body] = await call(f, "GET", ["api", "workflows", created.id as string, "logs", "one"]);
      assert.equal(status, 200);
      assert.deepEqual(body, { output: "", truncated: false });
      const [refused] = await call(f, "GET", ["api", "workflows", created.id as string, "logs", "nope"]);
      assert.equal(refused, 400);
    } finally {
      f.cleanup();
    }
  });

  it("answers an actor through the host callback", async () => {
    const f = fixture();
    try {
      const record = f.store.create({ name: "Actor", nodes: [{ id: "a", kind: "agent", prompt: "hi" }], concurrency: 1 }, f.root);
      f.store.update(record.id, (row) => {
        (row.nodes as Record<string, Row>).a = { status: "awaiting_user", attempts: 1, session_id: "b".repeat(32) };
        row.status = "awaiting_user";
      });
      const [status, body] = await call(f, "POST", ["api", "workflows", record.id as string, "actors", "a", "answer"], { answer: "go" });
      assert.equal(status, 200);
      assert.equal(body.status, "paused");
      assert.equal(body.control, "pause");
    } finally {
      f.cleanup();
    }
  });

  it("refuses an empty actor answer", async () => {
    const f = fixture();
    try {
      const record = f.store.create({ name: "Actor", nodes: [{ id: "a", kind: "agent", prompt: "hi" }], concurrency: 1 }, f.root);
      f.store.update(record.id, (row) => {
        (row.nodes as Record<string, Row>).a = { status: "awaiting_user", attempts: 1, session_id: "b".repeat(32) };
        row.status = "awaiting_user";
      });
      const [status] = await call(f, "POST", ["api", "workflows", record.id as string, "actors", "a", "answer"], { answer: "" });
      assert.equal(status, 400);
    } finally {
      f.cleanup();
    }
  });
});

describe("workflow http actions", () => {
  it("amends a settled run with a literal plan", async () => {
    const f = fixture();
    try {
      const created = f.store.create(PLAN, f.root);
      const amended = { name: "Amended", nodes: [{ id: "two", kind: "command", argv: ["true"] }], concurrency: 1 };
      const [status, body] = await call(f, "POST", ["api", "workflows", created.id as string, "amend"], { plan: amended });
      assert.equal(status, 200);
      assert.equal((body.plan as Row).name, "Amended");
      assert.equal(body.status, "created");
    } finally {
      f.cleanup();
    }
  });

  it("refuses to amend an active run with the generic 400", async () => {
    const f = fixture();
    try {
      const created = f.store.create(PLAN, f.root);
      f.store.update(created.id, (row) => { row.status = "running"; });
      const [status] = await call(f, "POST", ["api", "workflows", created.id as string, "amend"], { plan: PLAN });
      assert.equal(status, 400);
    } finally {
      f.cleanup();
    }
  });

  it("starts a run and reports a live owner as 409", async () => {
    const f = fixture();
    try {
      const created = f.store.create(PLAN, f.root);
      const [status, body] = await call(f, "POST", ["api", "workflows", created.id as string, "start"], { approve: true });
      assert.equal(status, 200);
      assert.equal(body.status, "queued");
      // The runner lock is what a detached owner holds: taking it makes the
      // next launch fail exactly as Python's nonblocking flock does.
      const held = f.store.lock(created.id as string, ".runner", { blocking: false });
      try {
        const [conflict, refusal] = await call(f, "POST", ["api", "workflows", created.id as string, "resume"], { approve: true });
        assert.equal(conflict, 409);
        assert.deepEqual(refusal, { error: "run has a live owner" });
      } finally {
        held.release();
      }
    } finally {
      f.cleanup();
    }
  });

  it("passes allowReal from the host switch to launch", async () => {
    const f = fixture({ allowRealHost: () => false });
    try {
      const agent = { name: "Actor", nodes: [{ id: "a", kind: "agent", prompt: "hi" }], concurrency: 1 };
      const created = f.store.create(agent, f.root);
      const [status] = await call(f, "POST", ["api", "workflows", created.id as string, "start"], { approve: true });
      // The agent node needs the real-model opt-in the host withholds.
      assert.equal(status, 400);
    } finally {
      f.cleanup();
    }
  });

  it("controls a queued run and rejects an unknown action", async () => {
    const f = fixture();
    try {
      const created = f.store.create(PLAN, f.root);
      f.store.update(created.id, (row) => { row.status = "running"; });
      const [status, body] = await call(f, "POST", ["api", "workflows", created.id as string, "pause"]);
      assert.equal(status, 200);
      assert.equal(body.control, "pause");
      assert.equal(body.status, "pausing");
      const [refused] = await call(f, "POST", ["api", "workflows", created.id as string, "explode"]);
      assert.equal(refused, 400);
    } finally {
      f.cleanup();
    }
  });

  it("answers an unknown sub-route with 404", async () => {
    const f = fixture();
    try {
      const created = f.store.create(PLAN, f.root);
      const [status, body] = await call(f, "GET", ["api", "workflows", created.id as string, "nope"]);
      assert.equal(status, 404);
      assert.deepEqual(body, { error: "operation not found" });
    } finally {
      f.cleanup();
    }
  });
});

describe("workflow http delegation", () => {
  it("hands dwf and expert paths to their owners first", async () => {
    const calls: string[] = [];
    const f = fixture({
      dynamicRuns: (method, parts) => {
        calls.push(`dwf:${method}:${parts.join("/")}`);
        return [200, { delegated: "dwf" }];
      },
      expert: (options) => {
        calls.push(`expert:${String(options.method)}`);
        return [200, { delegated: "expert" }];
      },
    });
    try {
      const [dwf] = await call(f, "GET", ["api", "workflows", "dwf"]);
      assert.equal(dwf, 200);
      const [expert] = await call(f, "POST", ["api", "workflows", "expert"]);
      assert.equal(expert, 200);
      assert.deepEqual(calls, ["dwf:GET:api/workflows/dwf", "expert:POST"]);
    } finally {
      f.cleanup();
    }
  });

  it("passes the state directory and the parsed body to the expert owner", async () => {
    // Typed as a mutable box: TypeScript narrows a plain `let` to `null` across
    // the closure, so the assertions below would read `never`.
    const seen: { value: Row | null } = { value: null };
    const f = fixture({ expert: (options) => { seen.value = options; return [200, { ok: true }]; } });
    try {
      await call(f, "POST", ["api", "workflows", "expert", "start"], { task: "x" });
      assert.ok(seen.value);
      assert.equal(seen.value.stateDir, f.state);
      assert.equal(seen.value.method, "POST");
      assert.deepEqual(seen.value.data, { task: "x" });
    } finally {
      f.cleanup();
    }
  });
});

describe("workflow http plan digests", () => {
  it("keeps the record's digest stable across a read", async () => {
    const f = fixture();
    try {
      const created = f.store.create(PLAN, f.root);
      const [status, body] = await call(f, "GET", ["api", "workflows", created.id as string]);
      assert.equal(status, 200);
      assert.equal(workflowPlanDigest(body), workflowPlanDigest(created));
    } finally {
      f.cleanup();
    }
  });
});
