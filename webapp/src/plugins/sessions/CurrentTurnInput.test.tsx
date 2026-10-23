import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { Composer } from './XuenessWorkbenchView';
import { CurrentTurnInput, PendingGuidancePanel, followupDelivery,
  followupPointerDelivery } from './CurrentTurnInput';

function buttonTag(html: string, testId: string): string {
  return html.match(new RegExp(`<button(?=[^>]*data-testid="${testId}")[^>]*>`, 'u'))?.[0] ?? '';
}

test('running composer defaults to the compact guide control and ordinary send follows the selected mode', () => {
  const html = renderToStaticMarkup(<Composer running queueWhenRunning guideWhenRunning
    defaultValue="Add a detail" onSend={() => undefined} />);
  const trigger = buttonTag(html, 'current-turn-input-trigger');
  const guide = buttonTag(html, 'current-turn-input-guide');
  const queue = buttonTag(html, 'current-turn-input-queue');
  assert.match(trigger, /aria-haspopup="menu"/);
  assert.match(trigger, /aria-expanded="false"/);
  assert.match(guide, /role="menuitemradio"/);
  assert.match(guide, /aria-checked="true"/);
  assert.match(queue, /role="menuitemradio"/);
  assert.match(queue, /aria-checked="false"/);
  assert.match(html, /在下一步模型请求前处理，不中断正在执行的工具。/);
  assert.match(html, /当前轮结束后执行。/);
  assert.doesNotMatch(html, /<select\b/u);
  assert.doesNotMatch(html, />后续输入方式</u);
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
  assert.match(buttonTag(html, 'current-turn-input-guide'), /aria-checked="false"[^>]*disabled=""/);
  assert.match(buttonTag(html, 'current-turn-input-queue'), /aria-checked="true"/);
  assert.match(buttonTag(html, 'current-turn-input-trigger'), /aria-label="后续输入方式"/);
  assert.doesNotMatch(html, />后续输入方式</u);
});

test('pending guidance is a compact, labelled row and only offers a real withdrawal for withdrawable inputs', () => {
  const html = renderToStaticMarkup(<PendingGuidancePanel items={[
    { id: 'waiting-1', text: 'keep this detail in mind', status: 'queued', delivery: 'guide' },
    { id: 'done-1', text: 'already applied', status: 'completed', delivery: 'guide' },
    { id: 'paused-1', text: 'recheck this point', status: 'paused', targetTurnId: 'turn-old', has_context: true },
  ]} onWithdraw={() => {}} />);
  assert.match(html, /data-testid="pending-guidance-panel"/);
  assert.match(html, /data-testid="pending-guidance-row-waiting-1"/);
  assert.match(html, /data-testid="pending-guidance-row-paused-1"/);
  assert.equal((html.match(/class="xn-pending-guidance__mode"/gu) ?? []).length, 3);
  assert.equal((html.match(/>引导<\/span>/gu) ?? []).length, 3);
  assert.equal((html.match(/aria-label="撤回到输入框"/gu) ?? []).length, 2);
  assert.match(html, /目标轮次已结束，请撤回后重新发送/);
  assert.match(html, /原附件或上下文不会恢复，请重新添加/);
  assert.doesNotMatch(html, /aria-label="取消排队"/u);
});
