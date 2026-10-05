import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionGoal, type SessionGoalRecord } from './SessionGoal';

const goal = (patch: Partial<SessionGoalRecord> = {}): SessionGoalRecord => ({
  text: '把首屏渲染降到 1 秒内', status: 'active',
  setAt: '2026-10-05T10:00:00+00:00', updatedAt: '2026-10-05T10:00:00+00:00',
  history: [{ action: 'set', at: '2026-10-05T10:00:00+00:00', source: 'composer' }],
  ...patch,
});

test('an active goal is one quiet line above the composer with its own status', () => {
  const html = renderToStaticMarkup(<SessionGoal sessionId="abc" goal={goal()} onChanged={() => {}} />);
  assert.match(html, /会话目标/);
  assert.match(html, /把首屏渲染降到 1 秒内/);
  assert.match(html, /进行中/);
  assert.match(html, /data-status="active"/);
});

test('an achieved goal stays visible as achieved and a cleared one disappears', () => {
  assert.match(renderToStaticMarkup(<SessionGoal sessionId="abc" goal={goal({ status: 'achieved' })}
    onChanged={() => {}} />), /已达成/);
  assert.equal(renderToStaticMarkup(<SessionGoal sessionId="abc" goal={goal({ status: 'cleared' })}
    onChanged={() => {}} />), '');
  assert.equal(renderToStaticMarkup(<SessionGoal sessionId="abc" goal={null} onChanged={() => {}} />), '');
  assert.equal(renderToStaticMarkup(<SessionGoal sessionId="abc" onChanged={() => {}} />), '');
});

test('clearing is offered but never while the session is busy', () => {
  const open = renderToStaticMarkup(<SessionGoal sessionId="abc" goal={goal()} onChanged={() => {}} />);
  assert.match(open, /清除目标/);
  assert.doesNotMatch(open, /disabled/);
  assert.match(renderToStaticMarkup(<SessionGoal sessionId="abc" goal={goal()} disabled
    onChanged={() => {}} />), /disabled/);
});

test('the long goal text stays on one line and the full text is available when expanded', () => {
  const long = '把首屏渲染降到 1 秒内，'.repeat(40);
  const html = renderToStaticMarkup(<SessionGoal sessionId="abc" goal={goal({ text: long })}
    onChanged={() => {}} />);
  assert.match(html, /class="xn-session-goal__text"/);
  assert.match(html, /<p class="xn-session-goal__full">/);
});
