import assert from "node:assert/strict";
import { it } from "node:test";
import { RequestActivity, settleActivity } from "../src/activity.ts";
import { pythonUnavailableReason, runPython } from "../../../test-support/python-oracle.ts";
it("keeps queue time across admission/start and clears it for the next unqueued attempt", async () => {
  const { publicRuntimeActivity } = await import("../../sessions/src/public-session.ts");
  const activity = new RequestActivity({ steps: 0 }, () => 1, () => "fixed");
  activity.start({ requestId: "r", attemptId: "a", queuedMs: 25 }); activity.phase("queued_model");
  assert.equal(publicRuntimeActivity(activity.record)?.phase, "queued_model");
  assert.equal(publicRuntimeActivity(activity.record)?.queuedMs, 25);
  activity.start({ requestId: "r", attemptId: "a", queuedMs: 25 });
  assert.equal(activity.record.queuedMs, 25);
  activity.start({ requestId: "r", attemptId: "b" });
  assert.equal(activity.record.queuedMs, undefined);
});
it("matches real Python measured activity without inventing missing provider counters", { skip: pythonUnavailableReason() ?? false }, () => {
  const expected = JSON.parse(runPython(`
import json
from unittest.mock import patch
from xueness.bundled_plugins.providers import activity
session={'steps':2}
times=iter([0,0.25,0.5,1.25])
with patch.object(activity.time,'monotonic',lambda:next(times)):
 a=activity.RequestActivity(session)
 a.delta('中文🕊️')
 a.delta('reasoning',reasoning=True)
 a.complete({'content':'final','tool_calls':[{}]}, {'prompt_tokens':120,'completion_tokens':40,'prompt_tokens_details':{'cached_tokens':30}},3,finish='tool_calls')
 a.tool('read','r1',0.2,True)
session['status']='completed';activity.settle_activity(session)
session['runtime_activity']['startedAt']='fixed'
session['runtime_activity_history'][0]['startedAt']='fixed'
print(json.dumps(session,ensure_ascii=True))
`));
  const session: Record<string, unknown> = { steps: 2 };
  const times = [0, 0.25, 0.5, 1.25];
  const activity = new RequestActivity(session, () => times.shift()!, () => "fixed");
  activity.delta("中文🕊️"); activity.delta("reasoning", true);
  activity.complete({ content: "final", tool_calls: [{}] }, { prompt_tokens: 120, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 30 } }, 3, "tool_calls");
  activity.tool("read", "r1", 0.2, true); session.status = "completed"; settleActivity(session);
  assert.deepEqual(session, expected);
  assert.equal((session.runtime_activity as Record<string, unknown>).reportedReasoningTokens, undefined);
});
it("records a ZCode model retry on the request activity and keeps only safe public facts", async () => {
  const { publicRuntimeActivity } = await import("../../sessions/src/public-session.ts");
  const session: Record<string, unknown> = { steps: 0 };
  const times = [0, 1.5, 1.5, 2];
  const activity = new RequestActivity(session, () => times.shift() ?? 2, () => "2026-10-22T00:00:00+00:00");
  activity.retry({ requestId: "r", attempt: 1, nextAttempt: 2, maxAttempts: 11, delayMs: 2000, reason: "rate_limited", errorCode: "model_rate_limited",
    message: "Provider rate limited the model request.", statusCode: 429, providerErrorCode: "1302" }, Date.parse("2026-10-22T00:00:01Z"));
  const record = session.runtime_activity as Record<string, unknown>;
  assert.equal(record.phase, "retrying");
  assert.equal(record.waitingSeconds, 1.5);
  assert.deepEqual(record.retry, { attempt: 2, maxAttempts: 11, delayMs: 2000, reason: "rate_limited", errorCode: "model_rate_limited", statusCode: 429, retryAt: "2026-10-22T00:00:03.000+00:00" });
  assert.deepEqual(publicRuntimeActivity(record), { phase: "retrying", requestStep: 1, outputChars: 0, waitingSeconds: 1.5, startedAt: "2026-10-22T00:00:00+00:00",
    retry: { reason: "rate_limited", attempt: 2, maxAttempts: 11, delayMs: 2000, errorCode: "model_rate_limited", statusCode: 429, retryAt: "2026-10-22T00:00:03.000+00:00" } });
  assert.equal(publicRuntimeActivity({ ...record, retry: { reason: "made_up", attempt: 2 } })?.retry, undefined);
  activity.delta("ok");
  assert.equal(record.phase, "generating");
});
