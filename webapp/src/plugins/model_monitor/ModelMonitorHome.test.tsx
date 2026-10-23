import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { latestSessionObservation, ModelMonitorHomeView } from './ModelMonitorHome';
import type { ModelObservation } from './index';

const row: ModelObservation = { id: 'first', sessionId: 'a'.repeat(32), at: '2026-10-11T12:00:00Z', providerId: 'profile', requestedModel: 'request', returnedModels: ['wire'], protocol: 'openai', outcome: 'success' };
test('home evidence stays isolated to the current conversation, including legacy history', () => {
  const rows = [row, { ...row, id: 'other', sessionId: 'b'.repeat(32) }, { ...row, id: 'legacy', sessionId: undefined }];
  assert.equal(latestSessionObservation(rows, row.sessionId)?.id, 'first');
  assert.equal(latestSessionObservation(rows), undefined);
  assert.equal(latestSessionObservation(rows, 'c'.repeat(32)), undefined);
  const html = renderToStaticMarkup(<ModelMonitorHomeView sessionId="other" requestedModel="new-model" observation={row} onOpenHistory={() => {}} />);
  assert.match(html, /data-state="ready"/); assert.doesNotMatch(html, />wire</);
});
test('new conversation monitor stays compact and keeps history available', () => {
  const html = renderToStaticMarkup(<ModelMonitorHomeView requestedModel="qwen-local" onOpenHistory={() => {}} />);
  assert.match(html, /class="xn-model-monitor-home__route"[^>]*>[\s\S]*?qwen-local[\s\S]*?等待会话响应/);
  assert.match(html, /aria-label="返回模型监测"/);
  assert.match(html, /title="查看监测记录"/);
  assert.doesNotMatch(html, /xn-model-monitor-home__models|<details/);
});
test('home shows a collapsed model mismatch summary, with route explanation on demand', () => {
  const html = renderToStaticMarkup(<ModelMonitorHomeView sessionId={row.sessionId} providerId="profile" requestedModel="new-model" observation={row} onOpenHistory={() => {}} />);
  assert.match(html, /data-state="different"/); assert.match(html, /返回型号不同/);
  assert.match(html, /title="请求模型: request → 返回模型: wire"/);
  assert.match(html, /模型选择已更改/); assert.match(html, /响应详情/);
  const details = html.match(/<details[^>]*>/)?.[0] ?? '';
  assert.doesNotMatch(details, /\sopen(?:=|\s|>)/, 'normal mismatch details stay closed until requested');
  assert.match(html, /返回字段与请求型号不同/);
  assert.doesNotMatch(html, /灰度到|Gemini 4/);
});
test('monitor transport and model request failures are visible and expand the exact diagnostic', () => {
  const unavailable = renderToStaticMarkup(<ModelMonitorHomeView sessionId={row.sessionId} error="offline" onOpenHistory={() => {}} />);
  assert.match(unavailable, /监测暂不可用/);
  assert.match(unavailable, /<details[^>]*open=""/);
  assert.match(unavailable, /role="alert">offline/);

  const failed = renderToStaticMarkup(<ModelMonitorHomeView sessionId={row.sessionId}
    observation={{ ...row, outcome: 'error', returnedModels: [] }} onOpenHistory={() => {}} />);
  assert.match(failed, /data-outcome="error"/);
  assert.match(failed, /本次请求未完成，未获得可用的返回型号。/);
  assert.match(failed, /<details[^>]*open=""/);
});
test('an older failed response does not mask the active request state', () => {
  const html = renderToStaticMarkup(<ModelMonitorHomeView sessionId={row.sessionId} running
    observation={{ ...row, outcome: 'error', returnedModels: [] }} onOpenHistory={() => {}} />);
  assert.match(html, /正在等待本轮响应/);
  const status = html.match(/<span class="xn-model-monitor-home__status"[^>]*>[^<]*(?:<svg[\s\S]*?<\/svg>)?[^<]*<\/span>/)?.[0] ?? '';
  assert.match(status, /正在等待本轮响应/);
  assert.doesNotMatch(status, /本次请求未完成/);
  const details = html.match(/<details[^>]*>/)?.[0] ?? '';
  assert.ok(details);
  assert.doesNotMatch(details, /\sopen(?:=|\s|>)/);
  assert.doesNotMatch(html, /模型选择已更改/, 'optional selector props are unknown, not evidence of a changed selection');
});
