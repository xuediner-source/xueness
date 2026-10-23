/** Z8 guarded execution and goal-pause acceptance through ApplicationApi. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requestedMode = process.argv.slice(2).find((value) => ["source", "built", "--source", "--built"].includes(value)) ?? "source";
const built = requestedMode === "built" || requestedMode === "--built";
const runtimeRoot = join(root, "ts", ...(built ? ["dist"] : []));
const ext = built ? "js" : "ts";
const { createApplicationApi } = await import(pathToFileURL(join(runtimeRoot, "apps/server/src/application-api." + ext)).href);
const scratch = mkdtempSync(join(tmpdir(), "xueness-verify-z8-"));
const workspace = join(scratch, "workspace");
const state = join(scratch, "state");
const webRuns = join(scratch, "web-runs");
const pluginState = join(state, "plugin-state.json");
const providersDir = join(state, "providers");
for (const path of [workspace, state, webRuns, providersDir]) mkdirSync(path, { recursive: true });
writeFileSync(join(state, "settings.json"), JSON.stringify({
  workspace: { selectedRoots: [workspace], defaultRoot: workspace },
  general: { sessionsAutoTitleEnabled: false, sessionsCancelPropagateEnabled: true },
}));
writeFileSync(pluginState, JSON.stringify({ apiVersion: 1 }));

const records = [];
const counts = new Map();
const fixtureState = { verifierStarted: false, verifierVerdictReady: false, verifierDelivered: false, verifierEvidenceId: null, verifierDone: null };
let resolveVerifierDone;
fixtureState.verifierDone = new Promise((resolveDone) => { resolveVerifierDone = resolveDone; });
const fixture = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => { raw += chunk.toString("utf8"); });
  req.on("end", () => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const provider = path.split("/")[1] ?? "unknown";
    let body;
    try { body = JSON.parse(raw); } catch { body = {}; }
    records.push({ provider, path, body });
    const count = (counts.get(provider) ?? 0) + 1;
    counts.set(provider, count);
    void answerFixture(provider, count, body, res);
  });
});
function usage(total = 32) {
  return { id: "z8-fixture", choices: [], usage: { prompt_tokens: total - 8, completion_tokens: 8, total_tokens: total } };
}
function sendStream(res, delta, finish, totalTokens = 12) {
  if (res.destroyed || res.writableEnded) return false;
  res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "close" });
  const chunk = { id: "z8-fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] };
  res.write("data: " + JSON.stringify(chunk) + "\n\n");
  res.write("data: " + JSON.stringify(usage(totalTokens)) + "\n\n");
  res.end("data: [DONE]\n\n");
  return true;
}
function toolCall(id, args) {
  return { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name: "exec", arguments: JSON.stringify(args) } }] };
}
function goalEvidenceId(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const message of [...messages].reverse()) {
    if (message?.role !== "user" || typeof message.content !== "string") continue;
    try {
      const context = JSON.parse(message.content);
      const evidence = Array.isArray(context.evidence) ? context.evidence : [];
      const row = evidence.find((item) => item && typeof item.id === "string" && item.id);
      if (row) return row.id;
    } catch { /* The verifier's final user message is the bounded JSON context. */ }
  }
  return null;
}
async function answerFixture(provider, count, body, res) {
  if (provider === "z8-guarded") {
    if (count === 1) {
      const code = "require('node:fs').writeFileSync(" + JSON.stringify(ordinaryMarker) + ", 'ordinary-ran')";
      sendStream(res, toolCall("z8-ordinary", { argv: [process.execPath, "-e", code] }), "tool_calls", 12);
    } else if (count === 2 || count === 3) {
      sendStream(res, toolCall(count === 2 ? "z8-remember" : "z8-once", { command: dangerousCommand }), "tool_calls", 12);
    } else {
      sendStream(res, { role: "assistant", content: "Guarded fixture run finished." }, "stop", 12);
    }
    return;
  }
  if (provider === "z8-live") {
    if (count === 1) {
      sendStream(res, toolCall("z8-live-first", { command: liveDangerousCommand }), "tool_calls", 12);
    } else if (count === 2) {
      mkdirSync(liveDeletionTarget, { recursive: true });
      writeFileSync(join(liveDeletionTarget, "sentinel.txt"), "must survive the rejected repeat");
      sendStream(res, toolCall("z8-live-repeat", { command: liveDangerousCommand }), "tool_calls", 12);
    } else {
      sendStream(res, { role: "assistant", content: "Live approval fixture run finished." }, "stop", 12);
    }
    return;
  }
  if (provider === "z8-goal") {
    if (count === 1) {
      sendStream(res, { role: "assistant", content: "The requested answer is 42." }, "stop", 32);
      return;
    }
    if (count === 2) {
      fixtureState.verifierStarted = true;
      fixtureState.verifierEvidenceId = goalEvidenceId(body);
      fixtureState.verifierVerdictReady = typeof fixtureState.verifierEvidenceId === "string";
      await delay(1400);
      const verdict = {
        passed: true, reason: "A delayed positive verifier fixture result.",
        remaining: [], evidenceIds: fixtureState.verifierEvidenceId ? [fixtureState.verifierEvidenceId] : [],
      };
      fixtureState.verifierDelivered = sendStream(res, { role: "assistant", content: JSON.stringify(verdict) }, "stop", 10);
      resolveVerifierDone();
      return;
    }
    sendStream(res, { role: "assistant", content: "Unexpected extra goal-model request." }, "stop", 10);
    return;
  }
  if (!res.destroyed) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unknown fixture provider" }));
  }
}
await new Promise((resolveListen, rejectListen) => {
  fixture.once("error", rejectListen);
  fixture.listen(0, "127.0.0.1", resolveListen);
});
const providerBase = "http://127.0.0.1:" + fixture.address().port;
const model = "z8-loopback-fixture";
for (const id of ["z8-guarded", "z8-live", "z8-goal"]) {
  writeFileSync(join(providersDir, id + ".json"), JSON.stringify({
    id, name: "Z8 loopback fixture", baseUrl: providerBase + "/" + id + "/v1", model,
    apiKey: "fixture-only-key", allowLoopbackHttp: true,
  }));
}

const ordinaryMarker = join(workspace, "ordinary-exec-ran.txt");
const deletionTarget = join(workspace, "guarded-delete-target");
mkdirSync(deletionTarget, { recursive: true });
writeFileSync(join(deletionTarget, "sentinel.txt"), "isolated temporary target");
const quotePowerShell = (value) => "'" + value.replaceAll("'", "''") + "'";
const quotePosix = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const dangerousCommand = process.platform === "win32"
  ? "Remove-Item -LiteralPath " + quotePowerShell(deletionTarget) + " -Recurse -Force"
  : "rm -rf -- " + quotePosix(deletionTarget);
const liveDeletionTarget = join(workspace, "guarded-live-delete-target");
mkdirSync(liveDeletionTarget, { recursive: true });
writeFileSync(join(liveDeletionTarget, "sentinel.txt"), "isolated live-approval target");
const liveDangerousCommand = process.platform === "win32"
  ? "Remove-Item -LiteralPath " + quotePowerShell(liveDeletionTarget) + " -Recurse -Force"
  : "rm -rf -- " + quotePosix(liveDeletionTarget);

const checks = [];
const failures = [];
let api;
let guardedRun;
let guardedRunReply = null;
let guardedSessionId = null;
let liveRun;
let liveRunReply = null;
let liveSessionId = null;
let goalRun;
let goalSessionId = null;
const waitingApprovals = [];
let nextApprovalWaiter = null;
const liveApprovalSessions = new Set();
const customApprover = (sessionId, _session, stopped) => liveApprovalSessions.has(sessionId)
  ? api.agent.liveApprovals.approver(sessionId, { stopped })
  : (request) => new Promise((resolveAnswer) => {
    waitingApprovals.push({ request, resolve: resolveAnswer });
    if (nextApprovalWaiter) { const waiter = nextApprovalWaiter; nextApprovalWaiter = null; waiter(); }
  });
async function apiCall(method, path, data = {}) {
  const parts = path.split("/").filter(Boolean);
  const reply = await api.dispatch(method, parts, {}, data);
  assert.ok(reply, method + " " + path + " is owned by ApplicationApi");
  return { status: reply[0], body: reply[1] };
}
async function waitUntil(read, accept, label, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await read();
    if (accept(value)) return value;
    await delay(20);
  }
  throw new Error(label + " did not reach the expected state");
}
async function waitApproval(index, timeoutMs = 15000) {
  await waitUntil(() => waitingApprovals.length, (count) => count >= index, "host approval " + index, timeoutMs);
  return waitingApprovals[index - 1];
}
async function waitLiveApproval(sessionId, callId, timeoutMs = 15000) {
  return waitUntil(async () => {
    const approval = api.agent.liveApprovals.get(sessionId, callId);
    const detail = await apiCall("GET", "/api/sessions/" + sessionId);
    const pending = Array.isArray(detail.body.pending) ? detail.body.pending.find((entry) => entry.tool_call_id === callId) : null;
    return { approval, detail, pending };
  }, (state) => !!state.approval && state.pending?.waiting === true && state.pending?.oneShot === true,
  "public one-shot approval " + callId, timeoutMs);
}
async function scenario(name, body) {
  try { checks.push({ name, ok: true, ...(await body()) }); }
  catch (error) { failures.push({ name, error: String(error.stack ?? error) }); checks.push({ name, ok: false }); }
}

try {
  api = await createApplicationApi({
    projectRoot: root, projectDir: workspace, stateDir: state, webRuns,
    workspaceRoots: [workspace], scheduler: false, allowReal: true,
    agent: { approver: customApprover },
  });

  await scenario("guarded_ordinary_exec_and_once_only_dangerous_delete", async () => {
    const created = await apiCall("POST", "/api/sessions", {
      task: "Run one ordinary command, then confirm the isolated cleanup command.",
      root: workspace, provider_id: "z8-guarded", model,
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    guardedSessionId = created.body.id;
    guardedRun = apiCall("POST", "/api/sessions/" + guardedSessionId + "/run", {
      provider_id: "z8-guarded", model, permission_mode: "guarded", steps: 8,
    });
    void guardedRun.then((reply) => { guardedRunReply = reply; }, () => {});

    await waitUntil(() => waitingApprovals.length > 0 || guardedRunReply !== null, (ready) => ready, "guarded host approval or early run reply");
    if (waitingApprovals.length === 0) throw new Error("guarded run failed before approval: " + JSON.stringify(guardedRunReply));
    const first = waitingApprovals[0];
    assert.equal(first.request.callId, "z8-remember");
    assert.equal(first.request.code, "guarded");
    assert.equal(first.request.remember, null);
    assert.equal(existsSync(ordinaryMarker), true, "ordinary guarded exec should have run before dangerous-command approval");
    assert.equal(existsSync(join(deletionTarget, "sentinel.txt")), true, "dangerous delete must not run while approval is pending");
    first.resolve({ behavior: "allow", remember: ["exec(*)"] });

    const second = await waitApproval(2);
    assert.equal(second.request.callId, "z8-once");
    assert.equal(second.request.code, "guarded");
    assert.equal(second.request.remember, null);
    assert.equal(existsSync(join(deletionTarget, "sentinel.txt")), true, "a rejected remember result must not execute the command");
    second.resolve({ behavior: "allow" });

    const runReply = await guardedRun;
    assert.equal(runReply.status, 200, JSON.stringify(runReply.body));
    const saved = await api.store.load(guardedSessionId);
    assert.equal(existsSync(ordinaryMarker), true);
    assert.equal(existsSync(deletionTarget), false, "an explicit one-call allow should run the isolated delete");
    assert.equal(saved.results["z8-ordinary"]?.ok, true);
    assert.equal(saved.results["z8-remember"]?.error?.code, "permission_denied");
    assert.equal(saved.results["z8-remember"]?.data?.reason, "guarded_once_only");
    assert.equal(saved.results["z8-once"]?.ok, true);
    return {
      approvalCount: waitingApprovals.length,
      approvalCodes: waitingApprovals.map((entry) => entry.request.code),
      rememberWasUnavailable: waitingApprovals.every((entry) => entry.request.remember === null),
      rememberGrantRejected: saved.results["z8-remember"]?.data?.reason,
      ordinaryExecRanBeforeApproval: true, deleteRanOnlyAfterOnce: true,
      providerRequests: counts.get("z8-guarded") ?? 0,
    };
  });

  await scenario("guarded_live_session_scope_is_one_shot_and_repeat_is_reasked", async () => {
    const created = await apiCall("POST", "/api/sessions", {
      task: "Confirm one guarded cleanup command, then reject its repeated request.",
      root: workspace, provider_id: "z8-live", model,
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    liveSessionId = created.body.id;
    liveApprovalSessions.add(liveSessionId);
    liveRun = apiCall("POST", "/api/sessions/" + liveSessionId + "/run", {
      provider_id: "z8-live", model, permission_mode: "guarded", steps: 8,
    });
    void liveRun.then((reply) => { liveRunReply = reply; }, () => {});

    const first = await waitLiveApproval(liveSessionId, "z8-live-first");
    assert.equal(first.approval.code, "guarded");
    assert.equal(first.approval.subject, liveDangerousCommand);
    assert.equal(existsSync(join(liveDeletionTarget, "sentinel.txt")), true, "the first deletion must remain blocked while pending");
    const firstAnswer = await apiCall("POST", "/api/sessions/" + liveSessionId + "/approvals", {
      tool_call_id: "z8-live-first", kind: "exec", decision: "approve", scope: "session",
    });
    assert.equal(firstAnswer.status, 200, JSON.stringify(firstAnswer.body));
    assert.deepEqual(api.agent.liveApprovals.sessionAllowed(liveSessionId), [], "guarded must not persist a session allow even when scope=session is submitted");

    const second = await waitLiveApproval(liveSessionId, "z8-live-repeat");
    assert.equal(second.approval.code, "guarded");
    assert.equal(second.approval.subject, liveDangerousCommand, "the repeat must use the exact same command subject");
    assert.equal(existsSync(join(liveDeletionTarget, "sentinel.txt")), true, "the repeated command must wait again, without deleting the recreated sentinel");
    assert.deepEqual(api.agent.liveApprovals.sessionAllowed(liveSessionId), []);
    const secondAnswer = await apiCall("POST", "/api/sessions/" + liveSessionId + "/approvals", {
      tool_call_id: "z8-live-repeat", kind: "exec", decision: "reject", message: "reject repeated guarded deletion",
    });
    assert.equal(secondAnswer.status, 200, JSON.stringify(secondAnswer.body));
    const runReply = await liveRun;
    assert.equal(runReply.status, 200, JSON.stringify(runReply.body));
    const saved = await api.store.load(liveSessionId);
    assert.equal(saved.results["z8-live-first"]?.ok, true);
    assert.equal(saved.results["z8-live-repeat"]?.error?.code, "permission_denied");
    assert.equal(saved.results["z8-live-repeat"]?.data?.reason, "user_denied");
    assert.equal(existsSync(join(liveDeletionTarget, "sentinel.txt")), true, "the rejected repeated command must not execute");
    return {
      firstPublicOneShot: first.pending.oneShot,
      secondPublicOneShot: second.pending.oneShot,
      firstScopeSessionDidNotPersist: api.agent.liveApprovals.sessionAllowed(liveSessionId).length === 0,
      exactCommandWasAskedAgain: second.approval.subject === first.approval.subject,
      repeatRejectedWithoutDeletingTarget: true,
      providerRequests: counts.get("z8-live") ?? 0,
    };
  });

  await scenario("guarded_mode_requires_planning_before_model_admission", async () => {
    const created = await apiCall("POST", "/api/sessions", {
      task: "Guarded mode must be refused when planning is disabled.",
      root: workspace, provider_id: "z8-guarded", model,
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const before = counts.get("z8-guarded") ?? 0;
    writeFileSync(pluginState, JSON.stringify({ apiVersion: 1, enabled: { planning: false } }));
    const reply = await apiCall("POST", "/api/sessions/" + created.body.id + "/run", {
      provider_id: "z8-guarded", model, permission_mode: "guarded", steps: 2,
    });
    assert.equal(reply.status, 409, JSON.stringify(reply.body));
    assert.equal(reply.body.code, "unsupported_run");
    assert.equal(counts.get("z8-guarded") ?? 0, before, "planning refusal must happen before a provider request");
    writeFileSync(pluginState, JSON.stringify({ apiVersion: 1 }));
    return { refusedStatus: reply.status, code: reply.body.code, providerRequestsAdded: 0 };
  });

  await scenario("pause_during_goal_verification_drains_and_resume_preserves_budget", async () => {
    const created = await apiCall("POST", "/api/sessions", {
      task: "Give the requested short answer, 42.",
      root: workspace, provider_id: "z8-goal", model,
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    goalSessionId = created.body.id;
    const staged = await apiCall("POST", "/api/sessions/" + goalSessionId + "/goal", {
      text: "Answer with the number 42.", budget: { maxTokens: 200 },
    });
    assert.equal(staged.status, 200, JSON.stringify(staged.body));
    assert.equal(staged.body.goal.status, "active");

    goalRun = apiCall("POST", "/api/sessions/" + goalSessionId + "/run", {
      provider_id: "z8-goal", model, permission_mode: "build", steps: 4,
    });
    void goalRun.catch(() => {});
    await waitUntil(() => counts.get("z8-goal") ?? 0, (count) => count >= 2, "delayed goal verifier request", 20000);
    assert.equal(fixtureState.verifierStarted, true);
    assert.equal(fixtureState.verifierVerdictReady, true, "fixture must prepare a valid positive verdict against supplied evidence");
    assert.ok(fixtureState.verifierEvidenceId);

    const pause = await apiCall("POST", "/api/sessions/" + goalSessionId + "/goal", { action: "pause" });
    assert.equal(pause.status, 200, JSON.stringify(pause.body));
    assert.equal(pause.body.goal.status, "paused");
    const runReply = await goalRun;
    assert.ok([200, 409].includes(runReply.status), JSON.stringify(runReply.body));

    const drained = await api.store.load(goalSessionId);
    assert.equal(drained.active_turn_id ?? null, null, "pause response must wait for the active turn to drain");
    assert.equal(drained.goal.status, "paused");
    assert.ok(Number(drained.goal.runtime?.reportedTokens ?? 0) >= 24, "reported model usage must be accumulated while pausing");
    assert.ok(Number(drained.goal.runtime?.rounds ?? 0) >= 1, "the interrupted goal invocation must be accounted for");
    assert.equal(drained.goal.verification, undefined, "the pending positive verifier result must not complete a paused goal");

    await fixtureState.verifierDone;
    await delay(20);
    const afterStale = await api.store.load(goalSessionId);
    assert.equal(afterStale.goal.status, "paused");
    assert.equal(afterStale.goal.verification, undefined);
    assert.equal(afterStale.goal.runtime.reportedTokens, drained.goal.runtime.reportedTokens);

    const pausedBudget = structuredClone(afterStale.goal.budget);
    const pausedRuntime = structuredClone(afterStale.goal.runtime);
    const resumed = await apiCall("POST", "/api/sessions/" + goalSessionId + "/goal", { action: "resume" });
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
    assert.equal(resumed.body.goal.status, "active");
    assert.deepEqual(resumed.body.goal.budget, pausedBudget);
    assert.equal(resumed.body.goal.runtime.reportedTokens, pausedRuntime.reportedTokens);
    assert.equal(resumed.body.goal.runtime.elapsedSeconds, pausedRuntime.elapsedSeconds);
    return {
      goalRunHttpStatus: runReply.status, pausedAfterDrain: true,
      accumulatedReportedTokens: drained.goal.runtime.reportedTokens,
      stalePositiveVerdictPrepared: fixtureState.verifierVerdictReady,
      stalePositiveVerdictDelivered: fixtureState.verifierDelivered,
      goalStayedPausedAfterVerifierDelay: afterStale.goal.status === "paused",
      resumePreservedBudgetAndUsage: true,
      goalProviderRequests: counts.get("z8-goal") ?? 0,
    };
  });
} catch (error) {
  failures.push({ name: "setup_or_cleanup", error: String(error.stack ?? error) });
} finally {
  for (const entry of waitingApprovals) entry.resolve({ behavior: "deny", message: "fixture cleanup" });
  if (liveSessionId) api?.agent.liveApprovals.defer(liveSessionId);
  if (guardedRun) { try { await guardedRun; } catch { /* cleanup */ } }
  if (liveRun) { try { await liveRun; } catch { /* cleanup */ } }
  if (goalRun) { try { await goalRun; } catch { /* cleanup */ } }
  await api?.close().catch((error) => failures.push({ name: "api_cleanup", error: String(error) }));
  fixture.closeAllConnections?.();
  await new Promise((resolveClose) => fixture.close(() => resolveClose()));
  if (resolve(dirname(scratch)) !== resolve(tmpdir()) || !basename(scratch).startsWith("xueness-verify-z8-")) throw new Error("unexpected scratch cleanup path");
  rmSync(scratch, { recursive: true, force: true });
}

const output = {
  schema: "xueness.z8.guard-goal.v1", ok: failures.length === 0, mode: built ? "built" : "source",
  network: "127.0.0.1-only", scenarios: checks, failures,
  modelRequests: { guarded: counts.get("z8-guarded") ?? 0, liveApproval: counts.get("z8-live") ?? 0, goal: counts.get("z8-goal") ?? 0 },
  goalVerifier: { started: fixtureState.verifierStarted, positiveVerdictPrepared: fixtureState.verifierVerdictReady,
    positiveVerdictDelivered: fixtureState.verifierDelivered, evidenceId: fixtureState.verifierEvidenceId },
};
const serialized = JSON.stringify(output, null, 2) + "\n";
const log = join(root, "验收资料", "验证记录", built ? "z8-guard-goal-built.json" : "z8-guard-goal-source.json");
mkdirSync(dirname(log), { recursive: true });
writeFileSync(log, serialized, "utf8");
process.stdout.write(serialized);
if (failures.length) process.exitCode = 1;
