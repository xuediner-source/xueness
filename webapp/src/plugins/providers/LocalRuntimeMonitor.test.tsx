import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  formatRuntimeBytes,
  estimatedMemoryUsedBytes,
  LocalRuntimeMonitor,
  RequestTiming,
  RuntimeMonitorDetails,
  memoryAvailabilityExplanation,
  runtimeCharacterTrend,
  startRequestElapsedClock,
} from './LocalRuntimeMonitor';
import type { LocalRuntimeSession } from './LocalRuntimeMonitor';

test('monitor stays absent outside lightweight mode', () => {
  assert.equal(renderToStaticMarkup(<LocalRuntimeMonitor lightweight={false} session={null} />), '');
});

test('calibrated budget stays labelled as an estimate and counts cached context', () => {
  const html = renderToStaticMarkup(<RuntimeMonitorDetails lightweight session={{
    runtime_budget: { estimatedInputTokens: 2500, inputBudgetTokens: 6144,
      reservedOutputTokens: 1024, safetyReserveTokens: 512, calibrationFactor: 1.25 },
  }} />);
  assert.match(html, /输入预算估算/);
  assert.match(html, /已按实际输入用量校准估算/);
  assert.match(html, /1\.25/);
  assert.match(html, /缓存 Token 仍占上下文/);
});

test('monitor defaults to a compact collapsed button without mounting resource sampling details', () => {
  const html = renderToStaticMarkup(<LocalRuntimeMonitor lightweight session={{ runtime_activity: { phase: 'generating' } }} />);
  assert.match(html, /本机资源/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-controls="[^"]+"/);
  assert.doesNotMatch(html, /compact-status|生成/);
  assert.match(html, /hidden=""/);
  assert.doesNotMatch(html, /xn-runtime-monitor__body|本进程 CPU|progressbar|暂停采样/);
});

test('lightweight monitor displays local resource and separated request activity estimates', () => {
  const session: LocalRuntimeSession & { content: string } = {
    content: 'private model output should not be rendered',
    runtime_profile: 'lightweight',
    runtime_budget: {
      profile: 'lightweight', contextWindow: 8192, inputBudgetTokens: 6144, estimatedInputTokens: 2048,
      reservedOutputTokens: 1024, safetyReserveTokens: 256,
    },
    runtime_activity: {
      phase: 'generating', startedAt: '2026-10-01T01:00:00Z', requestStep: 3,
      outputChars: 120, reasoningChars: 42, firstOutputSeconds: 0.8, firstReasoningSeconds: 0.4,
      requestSeconds: 8, charactersPerSecond: 15, reportedOutputTokens: 30, tokensPerSecond: 3.75,
    },
    runtime_activity_history: [
      { phase: 'completed', requestStep: 1, charactersPerSecond: 4, outputChars: 32, reportedOutputTokens: 8, tokensPerSecond: 1 },
      { phase: 'completed', requestStep: 2, charactersPerSecond: 9, outputChars: 80 },
    ],
  };
  const html = renderToStaticMarkup(<RuntimeMonitorDetails lightweight session={session} />);
  assert.match(html, /详细资源采样/);
  assert.match(html, /CPU/);
  assert.match(html, /内存已用估算/);
  assert.match(html, /轻量输出状态/);
  assert.match(html, /生成/);
  assert.match(html, /按整个请求耗时计算的平均输出 Token 速率/);
  assert.match(html, /3\.8 Token\/秒/);
  assert.match(html, /已报告输出 Token/);
  assert.match(html, />30</);
  assert.match(html, /2,048 \/ 6,144 Token/);
  assert.match(html, /GPU \/ 模型显存遥测不可用/);
  assert.match(html, /资源数据来自本机 Xueness 服务所在设备/);
  assert.match(html, /不代表逐字解码速度/);
  assert.match(html, /<svg/);
  assert.doesNotMatch(html, /private model output should not be rendered/);
  assert.doesNotMatch(html, /apiKey|private-test-secret|baseUrl/i);
});

test('token rate is withheld unless output token usage was reported', () => {
  const session: LocalRuntimeSession = { runtime_activity: {
    phase: 'completed', charactersPerSecond: 5, requestSeconds: 2, outputChars: 10, tokensPerSecond: 90,
  } };
  const html = renderToStaticMarkup(<RuntimeMonitorDetails lightweight session={session} />);
  assert.match(html, /本轮未报告输出 Token/);
  assert.doesNotMatch(html, /90 Token\/秒/);
});

test('request timing has a compact live summary and retains the first request details before history exists', () => {
  const html = renderToStaticMarkup(<RequestTiming session={{
    status: 'running',
    runtime_activity: { phase: 'waiting_model', startedAt: '2026-10-07T00:00:00Z', requestStep: 4 },
  }} />);
  assert.match(html, /当前模型请求状态/);
  assert.match(html, /等待模型/);
  assert.match(html, /请求轮次 #4/);
  assert.match(html, /输入 Token/);
  assert.match(html, /缓存 Token/);
  assert.match(html, /输出 Token/);
  assert.equal((html.match(/<dd>—<\/dd>/g) ?? []).length, 3);
  assert.match(html, /<details class="xn-runtime-monitor__timings">/);
  assert.doesNotMatch(html, /<details[^>]* open/);
  assert.match(html, /尚无已完成请求耗时记录/);
  assert.match(html, /data-testid="request-telemetry"/);
});

test('request details expand for provider errors while normal completed details remain collapsed', () => {
  const failed = renderToStaticMarkup(<RequestTiming session={{ status: 'provider_error' }} />);
  assert.match(failed, /data-testid="request-telemetry" open=""/);
  const completed = renderToStaticMarkup(<RequestTiming session={{ status: 'completed' }} />);
  assert.doesNotMatch(completed, /data-testid="request-telemetry" open/);
  assert.equal(completed, '', 'A completed turn with no recorded telemetry has no empty diagnostics panel');
  const recorded = renderToStaticMarkup(<RequestTiming session={{status:'completed', runtime_activity:{phase:'completed',requestSeconds:2}}} />);
  assert.match(recorded, /已报告 Token 用量/);
});

test('lightweight completed request summary is omitted while error diagnostics remain visible', () => {
  const completed = renderToStaticMarkup(<RequestTiming session={{ status: 'completed', runtime_profile: 'lightweight' }} />);
  assert.equal(completed, '');
  const failed = renderToStaticMarkup(<RequestTiming session={{ status: 'provider_error', runtime_profile: 'lightweight' }} />);
  assert.match(failed, /data-testid="request-telemetry" open=""/);
  assert.match(failed, /供应商错误/);
});

test('the live request phase and provider-reported usage stay visible without history', () => {
  for (const [phase, label] of [['thinking', '思考'], ['generating', '生成'], ['tools', '工具调用']] as const) {
    const html = renderToStaticMarkup(<RequestTiming session={{ status: 'running', runtime_activity: {
      phase, startedAt: '2026-10-07T00:00:00Z', requestStep: 2,
      reportedInputTokens: 1200, reportedCachedTokens: 480, reportedOutputTokens: 37,
    } }} />);
    assert.match(html, new RegExp(label));
    assert.match(html, /请求轮次 #2/);
    assert.match(html, />1,200</);
    assert.match(html, />480</);
    assert.match(html, />37</);
  }
});

test('terminal session status overrides stale generating activity and disables elapsed timing', () => {
  for (const [status, label] of [['completed', '已完成'], ['stopped', '已停止'], ['provider_error', '供应商错误']] as const) {
    const html = renderToStaticMarkup(<RequestTiming session={{ status, runtime_activity: {
      phase: 'generating', startedAt: '2026-10-07T00:00:00Z', requestStep: 7,
    } }} />);
    assert.match(html, new RegExp(label));
    assert.doesNotMatch(html, /xn-runtime-monitor__request-phase--generating|>生成</);
    assert.doesNotMatch(html, /已运行/);
  }
});

test('legacy unknown status is shown as unknown instead of trusting a stale phase', () => {
  for (const status of [undefined, 'unknown'] as const) {
    const html = renderToStaticMarkup(<RequestTiming session={{ status, runtime_activity: {
      phase: 'generating', startedAt: '2026-10-07T00:00:00Z', requestStep: 8,
    } }} />);
    assert.match(html, /未知/);
    assert.doesNotMatch(html, /xn-runtime-monitor__request-phase--generating|>生成</);
    assert.doesNotMatch(html, /已运行/);
  }
});

test('missing usage stays missing and the collapsed request table is bounded', () => {
  const history = Array.from({ length: 30 }, (_, index) => ({ phase: 'completed', requestStep: index + 1 }));
  const html = renderToStaticMarkup(<RequestTiming session={{ status: 'completed', runtime_activity: {
    phase: 'completed', tokensPerSecond: 900, requestStep: 31,
  }, runtime_activity_history: history }} />);
  assert.equal((html.match(/<tr>/g) ?? []).length, 25); // one header plus the latest 24 requests
  assert.match(html, /<details class="xn-runtime-monitor__timings">/);
  assert.doesNotMatch(html, /<details[^>]* open/);
  assert.doesNotMatch(html, /900 Token\/秒/);
  assert.match(html, /<dd>—<\/dd>/);
});

test('elapsed clock schedules only for a running request and always returns cleanup', () => {
  let scheduled = 0;
  let cancelled = 0;
  let delay = 0;
  const schedule = (_callback: () => void, delayMs: number) => {
    scheduled++;
    delay = delayMs;
    return () => { cancelled++; };
  };
  const terminalCleanup = startRequestElapsedClock({ status: 'failed', runtime_activity: {
    phase: 'generating', startedAt: '2026-10-07T00:00:00Z',
  } }, () => {}, schedule);
  terminalCleanup();
  assert.equal(scheduled, 0);
  const unknownCleanup = startRequestElapsedClock({ runtime_activity: {
    phase: 'generating', startedAt: '2026-10-07T00:00:00Z',
  } }, () => {}, schedule);
  unknownCleanup();
  assert.equal(scheduled, 0);
  const staleActivityCleanup = startRequestElapsedClock({ status: 'running', runtime_activity: {
    phase: 'completed', startedAt: '2026-10-07T00:00:00Z',
  } }, () => {}, schedule);
  staleActivityCleanup();
  assert.equal(scheduled, 0);

  let ticks = 0;
  const runningCleanup = startRequestElapsedClock({ status: 'running', runtime_activity: {
    phase: 'thinking', startedAt: '2026-10-07T00:00:00Z',
  } }, () => { ticks++; }, schedule);
  assert.equal(ticks, 1);
  assert.equal(scheduled, 1);
  assert.equal(delay, 1000);
  runningCleanup();
  assert.equal(cancelled, 1);
});

test('formatting and trend helpers tolerate missing or invalid optional telemetry', () => {
  assert.equal(formatRuntimeBytes(null), '—');
  assert.equal(formatRuntimeBytes(1536), '1.5 KiB');
  assert.equal(estimatedMemoryUsedBytes(16 * 1024 ** 3, 5 * 1024 ** 3), 11 * 1024 ** 3);
  assert.equal(estimatedMemoryUsedBytes(null, 2), null);
  assert.equal(memoryAvailabilityExplanation('kernel_estimate'), '可用内存为内核估计');
  assert.equal(memoryAvailabilityExplanation('free_plus_reclaimable_estimate'), '可用内存含可回收估算');
  assert.equal(memoryAvailabilityExplanation(null), '');
  assert.deepEqual(runtimeCharacterTrend([{ phase: 'completed' }, { phase: 'completed', charactersPerSecond: -1 }]), []);
  const points = runtimeCharacterTrend([
    { phase: 'completed', requestStep: 1, charactersPerSecond: 4, outputChars: 16 },
    { phase: 'completed', requestStep: 2, charactersPerSecond: 8, outputChars: 32 },
  ]);
  assert.equal(points.length, 2);
  assert.match(points[0].title, /#1/);
  assert.match(points[1].title, /8 字符\/秒/);
});
