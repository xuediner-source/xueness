import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  formatRuntimeBytes,
  estimatedMemoryUsedBytes,
  LocalRuntimeMonitor,
  RuntimeMonitorDetails,
  memoryAvailabilityExplanation,
  runtimeCharacterTrend,
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
  assert.match(html, /生成/);
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
