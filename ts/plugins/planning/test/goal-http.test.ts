import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Session, SessionStore } from "@xueness/sessions";
import { createPlanningApi } from "../src/http-api.ts";
import type { Row } from "../src/delivery.ts";

const sid = "b".repeat(32);
const enabled = () => true;

describe("planning goal HTTP controls", () => {
  it("uses the host interrupt port only for running pause, then reloads the paused goal", async () => {
    let session: Session = { id: sid, goal: { text: "Keep the report accurate", status: "active", setAt: "2026-10-18T00:00:00+00:00", updatedAt: "2026-10-18T00:00:00+00:00", history: [], budget: { maxRounds: 3 }, runtime: { rounds: 2, reportedTokens: 90, elapsedSeconds: 12 } } };
    let leases = 0, interrupts = 0;
    const store = {
      async load() { return session; },
      async save(next: Session) { session = next; },
      async lease() { leases++; return { async release() {} }; },
    } as unknown as SessionStore;
    const running = new Set([sid]);
    const api = createPlanningApi({ store, enabled, running, async interruptSession(id, mutate) { interrupts++; assert.equal(id, sid); mutate(session); return true; } });
    const paused = await api.dispatch("POST", ["api", "sessions", sid, "goal"], {}, { action: "pause" });
    assert.equal(paused?.[0], 200); assert.equal(((paused?.[1] as Row).goal as Row).status, "paused");
    assert.equal(interrupts, 1); assert.equal(leases, 0);
    const edit = await api.dispatch("POST", ["api", "sessions", sid, "goal"], {}, { action: "budget", budget: {} });
    assert.equal(edit?.[0], 409); assert.equal(leases, 0);
    running.delete(sid);
    const budget = await api.dispatch("POST", ["api", "sessions", sid, "goal"], {}, { action: "budget", budget: {} });
    assert.equal(budget?.[0], 200); assert.deepEqual(((budget?.[1] as Row).goal as Row).budget, {});
    assert.equal(((budget?.[1] as Row).goal as Row).status, "paused");
    assert.equal(((budget?.[1] as Row).goal as Row).id, ((session.goal as Row).id));
    assert.equal(leases, 1);
  });

  it("keeps live edits at 409 when no host interrupt port is provided", async () => {
    const session: Session = { id: sid, goal: { text: "Current goal", status: "active", setAt: "2026-10-18T00:00:00+00:00", updatedAt: "2026-10-18T00:00:00+00:00", history: [] } };
    const store = { async load() { return session; }, async lease() { throw new Error("must not lease a running session"); } } as unknown as SessionStore;
    const api = createPlanningApi({ store, enabled, running: new Set([sid]) });
    const paused = await api.dispatch("POST", ["api", "sessions", sid, "goal"], {}, { action: "pause" });
    const resumed = await api.dispatch("POST", ["api", "sessions", sid, "goal"], {}, { action: "resume" });
    assert.equal(paused?.[0], 409); assert.equal(resumed?.[0], 409);
    assert.equal((session.goal as Row).status, "active");
  });
});
