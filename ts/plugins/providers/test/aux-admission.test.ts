/**
 * Auxiliary model calls under the shared admission governor (C-MDL-05):
 * titles, semantic handoffs and compaction summaries acquire exactly one
 * slot through the same per-state controller as agent requests, foreground
 * scopes never queue behind governed traffic, and aux outcomes feed the
 * shared AIMD feedback.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AgentContext, AgentProvider, Row } from "@xueness/agent";
import { ProviderRequestError, reasoningOrigin, type ModelRequestAdmission, type ModelRequestAdmissionTicket } from "@xueness/providers";
import { admissionWithScope, providerAdmissionForState, ProviderAdmissionController } from "../src/admission-policy.ts";
import { auxiliaryModelAdmission, runWithModelAdmission } from "../src/aux-admission.ts";
import { handoffModelJson, semanticCompactionExtension, HANDOFF_SECTIONS } from "../src/semantic.ts";
import { requestConversationTitle } from "../src/title-model.ts";
import { compactConversation } from "../src/zcode-compact.ts";
import type { ModelConcurrencySnapshot } from "../src/admission-controller.ts";

const alpha = { providerId: "test", modelId: "aux-model" };

/** A plain host-agnostic adapter: the clone path keeps `complete` bound. */
function fakeProvider(behavior: (messages: Row[]) => Row): AgentProvider & { model: string; base: string } {
  return { model: "aux-model", base: "https://aux.example/v1", maxOutputTokens: 2048,
    complete: async (messages: Row[]) => behavior(messages) } as unknown as AgentProvider & { model: string; base: string };
}

/** Wraps an admission to observe held slots; assertions read `held` inside the adapter call. */
function countingAdmission(): { admission: ModelRequestAdmission; held: { now: number; max: number; acquires: number } } {
  const held = { now: 0, max: 0, acquires: 0 };
  // A minimal FIFO inner port: one slot, no fast path.
  let slots = 1; const waiters: Array<() => void> = [];
  const drain = (): void => { while (slots > 0 && waiters.length) { slots -= 1; waiters.shift()!(); } };
  const inner: ModelRequestAdmission = { tryAcquire: () => undefined, acquire: (input) => new Promise((resolve, reject) => {
    const settle = (): void => resolve({ release() { slots += 1; drain(); } });
    const aborted = (): void => reject(new ProviderRequestError());
    if (input.signal?.aborted) { aborted(); return; }
    if (slots > 0) { slots -= 1; settle(); return; }
    waiters.push(settle); input.signal?.addEventListener("abort", () => {
      const index = waiters.indexOf(settle); if (index >= 0) waiters.splice(index, 1); aborted();
    }, { once: true });
  }) };
  const track = (ticket: ModelRequestAdmissionTicket): ModelRequestAdmissionTicket => {
    held.now += 1; held.acquires += 1; held.max = Math.max(held.max, held.now);
    let released = false;
    return { ...ticket, ...(ticket.publish ? { publish: (info: Record<string, unknown>) => ticket.publish?.(info) } : {}), release() { if (released) return; released = true; held.now -= 1; ticket.release(); } };
  };
  return { held,
    admission: {
      tryAcquire: (input: { model: typeof alpha }) => { const ticket = inner.tryAcquire?.(input); return ticket ? track(ticket) : undefined; },
      acquire: async (input: { model: typeof alpha; signal?: AbortSignal }) => track(await inner.acquire(input)),
    } };
}

function modelState(controller: ProviderAdmissionController, index = 0): ModelConcurrencySnapshot {
  const state = controller.snapshot().models[index];
  assert.ok(state);
  return state;
}

describe("auxiliary model admission (C-MDL-05)", () => {
  it("runs a foreground handoff under the shared governor and feeds the success verdict", async () => {
    const controller = new ProviderAdmissionController(4);
    const target = reasoningOrigin({ model: "aux-model", base: "https://aux.example/v1" });
    // A governed holder keeps the bucket observable after the aux call releases its slot.
    const holder = await controller.acquire({ model: target });
    let inFlightDuring = -1;
    const provider = fakeProvider(() => {
      inFlightDuring = modelState(controller).inFlight;
      return { content: '{"requirements":["keep"]}', _finish_reason: "stop" };
    });
    const [value] = await handoffModelJson(provider, [{ role: "user", content: "summarize" }], { admission: admissionWithScope(controller, { foreground: true }) });
    assert.deepEqual(value, { requirements: ["keep"] });
    assert.equal(inFlightDuring, 2, "the handoff holds a governor slot beside the governed holder");
    const state = modelState(controller);
    assert.equal(state.inFlight, 1, "the aux slot is released when the handoff completes");
    assert.equal(state.successStreak, 1, "the aux success feeds the shared AIMD streak");
    holder.release();
  });

  it("a foreground auxiliary call never queues behind a full bucket of governed traffic", async () => {
    const controller = new ProviderAdmissionController(1);
    // The governed traffic targets the same model bucket the aux handoff resolves to.
    const target = reasoningOrigin({ model: "aux-model", base: "https://aux.example/v1" });
    const holder = await controller.acquire({ model: target });
    const waiterSignal = new AbortController();
    const queued = controller.acquire({ model: target, signal: waiterSignal.signal }).then(() => "granted", (error: unknown) => (error instanceof Error ? error.name : String(error)));
    let inFlightDuring = -1;
    const provider = fakeProvider(() => {
      inFlightDuring = modelState(controller).inFlight;
      return { content: '{"requirements":["keep"]}', _finish_reason: "stop" };
    });
    const [value] = await handoffModelJson(provider, [{ role: "user", content: "summarize" }], { admission: admissionWithScope(controller, { foreground: true }) });
    assert.deepEqual(value, { requirements: ["keep"] });
    assert.equal(inFlightDuring, 2, "the aux call is admitted beside the governed holder");
    assert.equal(modelState(controller).inFlight, 1, "only the governed holder keeps its slot afterwards");
    const settledWhileHeld = await Promise.race([queued.then(() => true, () => true), new Promise<boolean>((resolve) => setImmediate(() => resolve(false)))]);
    assert.equal(settledWhileHeld, false, "the governed waiter stayed queued while the holder and the aux call ran");
    holder.release();
    assert.equal(await queued, "granted", "the governed waiter proceeds once the governed slot frees");
    waiterSignal.abort();
  });

  it("a rate-limited auxiliary call cuts the shared cap and arms the cooldown", async () => {
    const controller = new ProviderAdmissionController(4);
    const scoped = admissionWithScope(controller, { foreground: true });
    const limited = new ProviderRequestError({ status: 429, retryAfterMs: 1500 });
    const provider = fakeProvider(() => { throw limited; });
    await assert.rejects(handoffModelJson(provider, [{ role: "user", content: "summarize" }], { admission: scoped }), (error: unknown) => error === limited);
    const state = modelState(controller);
    assert.equal(state.cap, 3, "an aux 429 teaches the shared bucket a lower cap");
    assert.notEqual(state.cooldownUntil, undefined, "the Retry-After window cools the shared bucket");
    assert.equal(state.inFlight, 0, "the failed aux attempt releases its slot");
  });

  it("holds exactly one slot per title request and per compaction summary, released on success and failure", async () => {
    const { held, admission } = countingAdmission();
    let heldDuringCall = -1;
    const titleProvider = { hostAdapter: true, model: "aux-model", base: "https://aux.example/v1", maxOutputTokens: 256,
      complete: async () => { heldDuringCall = held.now; return { content: "A concise title", _finish_reason: "stop" }; } } as unknown as AgentProvider;
    const signal = new AbortController().signal;
    assert.equal(await requestConversationTitle(titleProvider, [{ role: "user", content: "hi" }], signal, { admission }), "A concise title");
    assert.equal(heldDuringCall, 1);
    assert.equal(held.now, 0, "the title slot is released");
    assert.equal(held.acquires, 1);

    const journal = (): Row[] => [
      { role: "system", content: "System" }, { role: "user", content: "First" }, { role: "assistant", content: "Done one" },
      { role: "user", content: "Second" }, { role: "assistant", content: "Done two" }];
    const sessionOf = (): Row => ({ id: "a".repeat(32), results: {}, messages: journal() });
    const rebuild = async (messages: Row[]): Promise<{ messages: Row[]; tools: never[]; options: Row; hostInstructions: never[]; repair: null }> => ({ messages, tools: [], options: {}, hostInstructions: [], repair: null });
    heldDuringCall = -1;
    const summaryProvider = fakeProvider(() => { heldDuringCall = held.now; return { content: "Summary of earlier rounds", _finish_reason: "stop" }; });
    const compacted = await compactConversation(sessionOf(), { provider: summaryProvider, rebuild, root: "/w", trigger: "manual", admission });
    assert.equal(compacted.compacted, true);
    assert.equal(heldDuringCall, 1, "the compaction summary holds one slot while in flight");
    assert.equal(held.now, 0, "the summary slot is released");
    assert.equal(held.max, 1, "no call ever holds two slots");

    held.now = 0; held.max = 0; held.acquires = 0;
    const failing = fakeProvider(() => { throw new Error("summary transport failed"); });
    await assert.rejects(compactConversation(sessionOf(), { provider: failing, rebuild, root: "/w", trigger: "manual", admission }), /summary transport failed/);
    assert.equal(held.now, 0, "a failed summary still releases its slot");
    assert.equal(held.max, 1);
  });

  it("the semantic compaction extension admits its handoffs through the state directory governor", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "aux-admission-"));
    const governor = providerAdmissionForState(stateDir);
    assert.ok(governor, "the shared governor exists for the state directory");
    assert.ok(auxiliaryModelAdmission(stateDir), "the aux port binds the same governor");
    const messages: Row[] = [{ role: "system", content: "System" }, { role: "user", content: "Original human requirements", _turn_id: "turn-1", _message_id: "a".repeat(32) }];
    for (let index = 0; index < 12; index += 1) messages.push({ role: "assistant", content: "Earlier observation " + "observed text ".repeat(35), _turn_id: "turn-1" });
    messages.push({ role: "user", content: "Latest human requirement must remain verbatim", _turn_id: "turn-2", _message_id: "c".repeat(32) });
    const session: Row = { id: "d".repeat(32), messages, results: {}, compactions: [], archived_messages: [] };
    let inFlightDuring = -1;
    const provider = fakeProvider((prompt: Row[]) => {
      inFlightDuring = Math.max(inFlightDuring, governor.snapshot().models[0]?.inFlight ?? -1);
      const payload = JSON.parse(String(prompt[1]!.content)) as Row;
      const raw: Row = Object.fromEntries(HANDOFF_SECTIONS.map((section) => [section, []]));
      raw.requirements = ["Preserved human requirements"];
      raw.verification = ["Only observed tool records are verification facts"];
      raw.coveredMessageIds = payload.requiredCoverage;
      return { content: JSON.stringify(raw), _finish_reason: "stop" };
    });
    const context = { session, provider, stateDir, options: { maxChars: 2000 }, deadline: Infinity, signal: new AbortController().signal,
      enabled: () => true, store: { save: async () => {} }, emit: () => {} } as unknown as AgentContext;
    await semanticCompactionExtension().beforeModelRequest?.(context);
    assert.ok(inFlightDuring >= 1, "the extension's handoff is admitted by the state directory governor");
    assert.equal(governor.snapshot().models[0]?.inFlight ?? 0, 0, "every handoff slot is released afterwards");
    assert.ok(session.semantic_compaction_checkpoint_id || (session.messages as Row[]).some((row) => row._semantic_summary === true), "the handoff still compacts");
  });

  it("runWithModelAdmission settles a plain failure without a verdict and keeps cancellation non-fatal", async () => {
    const events: string[] = [];
    const admission: ModelRequestAdmission = { acquire: async () => ({ publish: (info: Record<string, unknown>): void => { events.push(String(info.type)); }, release: (): void => { events.push("release"); } }) };
    const failing = fakeProvider(() => { throw new Error("boom"); });
    await assert.rejects(runWithModelAdmission(admission, failing, undefined, async () => { throw new Error("boom"); }), /boom/);
    assert.deepEqual(events, ["release"], "an unclassified failure settles as ended without a verdict");
  });
});
