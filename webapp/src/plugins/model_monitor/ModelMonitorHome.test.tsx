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
test('home shows wire mismatch, separate history entry and truthful selection changes', () => {
  const html = renderToStaticMarkup(<ModelMonitorHomeView sessionId={row.sessionId} providerId="profile" requestedModel="new-model" observation={row} onOpenHistory={() => {}} />);
  assert.match(html, /data-state="different"/); assert.match(html, /返回型号不同/);
  assert.match(html, />wire</); assert.match(html, /模型选择已更改/); assert.match(html, /响应详情/);
  assert.doesNotMatch(html, /灰度到|Gemini 4/);
});
