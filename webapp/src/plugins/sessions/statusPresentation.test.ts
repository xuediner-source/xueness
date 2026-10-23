import assert from 'node:assert/strict';
import test from 'node:test';
import { setLocale } from '../../i18n';
import { sessionStatusPresentation } from './statusPresentation';

test('needs_review stays a review state and only explicit failure states use the error tone', () => {
  assert.deepEqual(sessionStatusPresentation('needs_review'), { label: '需要复核', tone: 'paused' });
  assert.deepEqual(sessionStatusPresentation('failed'), { label: '失败', tone: 'error' });
  assert.deepEqual(sessionStatusPresentation('provider_error'), { label: '模型连接失败', tone: 'error' });
  assert.deepEqual(sessionStatusPresentation('completed'), { label: '已完成', tone: 'done' });
});

test('real pending interaction metadata distinguishes approval from a user answer', () => {
  assert.deepEqual(sessionStatusPresentation('paused', { pendingInteraction: { kind: 'permission' } }),
    { label: '等待批准', tone: 'paused' });
  assert.deepEqual(sessionStatusPresentation('needs_review', { pendingInteraction: { kind: 'userInput' } }),
    { label: '等待答复', tone: 'paused' });
  assert.deepEqual(sessionStatusPresentation('paused', { pendingInteraction: true }),
    { label: '待处理', tone: 'paused' });
  assert.equal(sessionStatusPresentation('paused', { pendingInteraction: { kind: 'other', label: '选择一个选项' } })?.label,
    '选择一个选项');
});

test('shared status labels remain translated across the three conversation surfaces', () => {
  setLocale('en');
  try {
    assert.equal(sessionStatusPresentation('needs_review')?.label, 'Review needed');
    assert.equal(sessionStatusPresentation('awaiting_approval')?.label, 'Awaiting approval');
    assert.equal(sessionStatusPresentation('awaiting_user')?.label, 'Awaiting your answer');
    assert.equal(sessionStatusPresentation('provider_error')?.label, 'Model connection failed');
  } finally {
    setLocale('zh');
  }
});
