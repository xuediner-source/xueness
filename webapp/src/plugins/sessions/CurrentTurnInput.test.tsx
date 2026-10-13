import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { Composer } from './XuenessWorkbenchView';
import { CurrentTurnInput, PendingGuidancePanel, followupDelivery,
  followupPointerDelivery } from './CurrentTurnInput';

test('running composer defaults to current-turn guidance and ordinary send follows the selected mode', () => {
  const html = renderToStaticMarkup(<Composer running queueWhenRunning guideWhenRunning
    defaultValue="Add a detail" onSend={() => undefined} />);
  assert.match(html, /aria-label="后续输入方式：当前轮引导"/);
  assert.match(html, /aria-pressed="true"[^>]*>.*当前轮引导/);
  assert.match(html, /aria-pressed="false"[^>]*>.*加入队列/);
  assert.equal(followupDelivery('guide'), 'guide');
  assert.equal(followupDelivery('queue'), 'queue');
});

test('Mod+Enter reverses guide to queue and queue to send-now on each supported platform', () => {
  assert.equal(followupDelivery('guide', true), 'queue');
  assert.equal(followupDelivery('queue', true), 'startNow');
  assert.equal(followupPointerDelivery('guide', { ctrlKey: true }, 'win32'), 'queue');
  assert.equal(followupPointerDelivery('queue', { metaKey: true }, 'darwin'), 'startNow');
  assert.equal(followupPointerDelivery('guide', {}, 'win32'), undefined);
});

test('guidance panel keeps a missed-turn input visible and offers withdrawal', () => {
  const html = renderToStaticMarkup(<PendingGuidancePanel items={[
    { id: 'input-1', text: 'clarify this', status: 'paused', targetTurnId: 'turn-1' },
  ]} onWithdraw={() => {}} />);
  assert.match(html, /待处理引导/);
  assert.match(html, /目标轮次已结束，请撤回后重新发送/);
  assert.match(html, /撤回到输入框/);
});

test('guide mode is unavailable when the sessions capability is disabled', () => {
  const html = renderToStaticMarkup(<CurrentTurnInput mode="queue" onChange={() => {}} canGuide={false} />);
  assert.match(html, /aria-label="当前轮引导"[^>]*disabled=""/);
  assert.match(html, /aria-label="加入队列"[^>]*aria-pressed="true"/);
});
