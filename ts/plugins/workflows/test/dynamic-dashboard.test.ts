import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DASHBOARD_MAX_ARTIFACTS, DASHBOARD_MAX_NODES, DASHBOARD_MAX_STREAMS, DASHBOARD_INLINE_MAX_CHARS,
  dashboardRun, dashboardSnapshot, renderDashboard,
} from "../src/dynamic-dashboard.ts";
import { DynamicArtifactStore } from "../src/dynamic-artifacts.ts";
import { DynamicStreamBroker } from "../src/dynamic-streams.ts";
import type { DynamicNode, DynamicWorkflowRun } from "../src/dynamic-types.ts";

const RUN_A = "a".repeat(32);
const RUN_B = "b".repeat(32);
const RUN_C = "c".repeat(32);

function node(partial: Partial<DynamicNode> & Pick<DynamicNode, "id" | "siteId" | "ordinal">): DynamicNode {
  return { kind: "read", inputHash: "0".repeat(64), status: "pending", ...partial };
}

function run(partial: Partial<DynamicWorkflowRun> & Pick<DynamicWorkflowRun, "id" | "name" | "status">): DynamicWorkflowRun {
  const at = "2026-10-25T10:00:00.000Z";
  return {
    parentSessionId: "1".repeat(32), root: "/tmp/panel", source: "", sourceHash: "2".repeat(64),
    maxConcurrency: 2, writable: false, createdAt: at, updatedAt: at,
    actors: {}, nodes: {}, events: [], reports: [], allowReal: false, ...partial,
  };
}

function sources(dir: string): { artifacts: DynamicArtifactStore; streams: DynamicStreamBroker } {
  return { artifacts: new DynamicArtifactStore(dir), streams: new DynamicStreamBroker(dir) };
}

describe("dynamic dashboard projection", () => {
  let dir: string;
  it("sets up a private state directory", () => {
    dir = mkdtempSync(join(tmpdir(), "dwf-dashboard-"));
  });

  it("projects durable run state: progress, ordering, awaiting questions, and stream facts", () => {
    const panel = sources(dir);
    const record = run({
      id: RUN_A, name: "panel-a", status: "awaiting_user", phase: "collect",
      updatedAt: "2026-10-25T10:05:00.000Z", error: "boom", importedFrom: RUN_C,
      nodes: {
        n3: node({ id: "n3", siteId: "s2", ordinal: 1, kind: "ask", status: "awaiting_user", actorId: "actor", question: "pick one?" }),
        n1: node({ id: "n1", siteId: "s1", ordinal: 0, status: "completed", result: 7 }),
        n2: node({ id: "n2", siteId: "s1", ordinal: 1, kind: "hole", status: "failed", error: "no file" }),
      },
    });
    panel.streams.publish(RUN_A, "progress", { done: 1 });
    const settled = panel.streams.publish(RUN_A, "progress", { done: 2 });
    panel.streams.settleFuture(RUN_A, "summary", { ok: true });
    const row = dashboardRun(record, panel);
    // Nodes are ordered by (siteId, ordinal, id), never by insertion order.
    assert.deepEqual(row.nodes.map((n) => n.id), ["n1", "n2", "n3"]);
    assert.deepEqual(row.progress, { completed: 1, failed: 1, awaitingUser: 1, active: 0, total: 3 });
    assert.equal(row.nodes[2]!.awaiting, "pick one?");
    assert.equal(row.nodes[1]!.error, "no file");
    assert.equal(row.inFlight, false);
    assert.equal(row.importedFrom, RUN_C);
    // Stream rows come from the durable log: seq advances, future reads as settled.
    assert.deepEqual(row.streams, [
      { name: "progress", lastSeq: settled.seq, lastAt: settled.at, settled: false },
      { name: "summary", lastSeq: 0, lastAt: null, settled: true },
    ]);
    assert.equal(row.result.kind, "none");
  });

  it("shows artifact metadata only and classifies results: inline, by reference, elided", () => {
    const panel = sources(dir);
    const big = "#".repeat(DASHBOARD_INLINE_MAX_CHARS + 64);
    const saved = panel.artifacts.save(RUN_B, "n1", { body: big.repeat(40) });
    assert.equal(saved.stored, true);
    const again = panel.artifacts.save(RUN_B, "n2", { other: big.repeat(5) });
    assert.equal(again.stored, true);
    const inline = dashboardRun(run({ id: RUN_B, name: "panel-b", status: "running", result: { small: true } }), panel);
    assert.equal(inline.result.kind, "inline");
    assert.deepEqual(inline.result, { kind: "inline", value: { small: true } });
    assert.equal(inline.inFlight, true);
    const byRef = dashboardRun(run({ id: RUN_B, name: "panel-b", status: "completed", result: saved.ref }), panel);
    assert.deepEqual(byRef.result, { kind: "artifact-ref", ref: saved.ref });
    // Only refs, never bodies: every listed row carries a sha256, never a value.
    assert.equal(byRef.artifacts.length, 2);
    assert.ok(byRef.artifacts.some((r) => r.$artifact === again.ref.$artifact));
    assert.ok(byRef.artifacts.every((r) => typeof r.sha256 === "string" && !("value" in r)));
    const elided = dashboardRun(run({ id: RUN_B, name: "panel-b", status: "completed", result: big }), panel);
    assert.equal(elided.result.kind, "elided");
    assert.ok(elided.result.kind === "elided" && elided.result.chars > DASHBOARD_INLINE_MAX_CHARS);
  });

  it("truncates oversized panels instead of shipping them whole", () => {
    const panel = sources(dir);
    const nodes: Record<string, DynamicNode> = {};
    for (let index = 0; index < DASHBOARD_MAX_NODES + 5; index += 1) {
      nodes[`n${index}`] = node({ id: `n${index}`, siteId: `s${index % 3}`, ordinal: index });
    }
    const record = run({ id: RUN_C, name: "panel-c", status: "draft", nodes });
    for (let index = 0; index < DASHBOARD_MAX_STREAMS + 2; index += 1) panel.streams.publish(RUN_C, `s${index}`, index);
    for (let index = 0; index < DASHBOARD_MAX_ARTIFACTS + 1; index += 1) {
      panel.artifacts.save(RUN_C, `an${index}`, { big: big2(), i: index });
    }
    const row = dashboardRun(record, panel);
    assert.equal(row.nodes.length, DASHBOARD_MAX_NODES);
    assert.equal(row.streams.length, DASHBOARD_MAX_STREAMS);
    assert.equal(row.artifacts.length, DASHBOARD_MAX_ARTIFACTS);
    assert.deepEqual(row.truncated, { nodes: true, streams: true, artifacts: true });
  });

  it("snapshots totals newest-first and renders a deterministic text panel", () => {
    const panel = sources(dir);
    const older = run({ id: RUN_B, name: "older", status: "completed", updatedAt: "2026-10-25T09:00:00.000Z", result: 42 });
    const newer = run({
      id: RUN_A, name: "newer", status: "awaiting_user", updatedAt: "2026-10-25T11:00:00.000Z",
      nodes: { n1: node({ id: "n1", siteId: "s1", ordinal: 0, kind: "hole", status: "awaiting_user", question: "q?" }) },
    });
    const snapshot = dashboardSnapshot([older, newer], panel);
    assert.deepEqual(snapshot.runs.map((r) => r.name), ["newer", "older"]);
    // RUN_B's two by-reference artifacts from the previous case are durable
    // disk facts, so the panel totals still count them for the older run.
    assert.deepEqual(snapshot.totals, { runs: 2, inFlight: 0, awaitingUser: 1, settled: 1, artifacts: 2 });
    assert.ok(snapshot.generatedAt !== "");
    const text = renderDashboard(snapshot);
    assert.match(text, /workflow dashboard — 2 runs \(0 in flight, 1 awaiting user, 1 settled, 2 artifacts\)/);
    assert.match(text, /\? newer \[aaaaaaaa\] awaiting_user — 0\/1 done, 0 failed, 1 awaiting/);
    assert.match(text, /✔ older \[bbbbbbbb\] completed — 0\/0 done, 0 failed, 0 awaiting/);
    assert.match(text, /result: 42/);
    // An empty panel still renders, never throws.
    const empty = renderDashboard(dashboardSnapshot([], panel));
    assert.match(empty, /\(no runs\)/);
    // A run with no artifact or stream directories shows none of either.
    const bare = dashboardRun(run({ id: "d".repeat(32), name: "bare", status: "completed" }), panel);
    assert.deepEqual(bare.artifacts, []);
    assert.deepEqual(bare.streams, []);
  });

  it("cleans up", () => { rmSync(dir, { recursive: true, force: true }); });
});

let cached: string | undefined;
function big2(): string { cached ??= "x".repeat(2200); return cached; }
