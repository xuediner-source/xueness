import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionQueue } from "./SessionQueue";
import type { QueuedMessage } from "../../xuenessWorkbench";

test("queue panel shows FIFO positions, supports paused cancellation and exposes explicit continuation", () => {
  const html = renderToStaticMarkup(<SessionQueue queueRevision={5} items={[
    { id: "q1", text: "first follow-up", status: "queued", position: 1 },
    { id: "q2", text: "being processed", status: "running" },
    { id: "q3", text: "paused follow-up", status: "paused", position: 2, pause_reason: "Needs review" },
  ]} cancellingId="q1" onCancel={() => {}} canContinue continuing />);
  assert.match(html, /data-testid="session-queue"/);
  assert.match(html, /队列位置 1/);
  assert.match(html, /first follow-up/);
  assert.match(html, /data-status="queued">等待中/);
  assert.match(html, /data-status="running"/);
  assert.match(html, /正在取消/);
  assert.match(html, /继续中/);
  assert.equal((html.match(/aria-label="取消排队"/gu) ?? []).length, 2);
  assert.match(html, /paused follow-up/);
  assert.match(html, /暂停原因：Needs review/);
});

test('queue review is not mislabeled as verification failure, while failed stays explicit', () => {
  const html = renderToStaticMarkup(<SessionQueue items={[
    { id: 'review', text: 'evidence is incomplete', status: 'needs_review' },
    { id: 'failed', text: 'tool returned an error', status: 'failed' },
  ]} onCancel={() => {}} />);
  assert.match(html, /data-status="needs_review">需要复核/);
  assert.match(html, /data-status="failed">失败/);
  assert.doesNotMatch(html, /未通过验证/);
});

test("an empty queue adds no timeline noise", () => {
  assert.equal(renderToStaticMarkup(<SessionQueue queueRevision={5} items={[]} onCancel={() => {}} />), "");
});

test('claimed paused turn stays fixed while pending turns expose keyboard-accessible ordering and full previews', () => {
  const html = renderToStaticMarkup(<SessionQueue queueRevision={5} currentId="claimed" items={[
    { id: 'claimed', text: 'already in journal', status: 'paused' },
    { id: 'one', text: 'line one\nline two\n'.repeat(12), status: 'paused' },
    { id: 'two', text: 'other pending', status: 'paused' },
  ]} onCancel={() => {}} onEdit={async () => {}} onReorder={async () => {}} />);
  assert.equal((html.match(/aria-label="上移排队消息"/g) ?? []).length, 2);
  assert.equal((html.match(/aria-label="取消排队"/g) ?? []).length, 2);
  assert.match(html, /aria-label="查看完整排队消息"/);
  assert.match(html, /<pre tabindex="0">/);
});

test("queue can collapse and editing is offered only for safely replaceable pending messages", () => {
  const html = renderToStaticMarkup(<SessionQueue queueRevision={5} items={[
    { id: "q1", text: "pending", status: "queued", editable: true },
    { id: "q2", text: "active", status: "running", editable: false },
    { id: "q3", text: "/expanded", status: "paused", editable: false },
  ]} onCancel={() => {}} onEdit={async () => {}} />);
  assert.match(html, /aria-expanded="true"/);
  assert.equal((html.match(/aria-label="编辑排队消息"/g) ?? []).length, 1);
});

test('queue exposes edit, withdraw-to-composer, and send-now as separate actions', () => {
  const html = renderToStaticMarkup(<SessionQueue queueRevision={5} items={[
    { id: 'q1', text: 'prepared with an attachment', status: 'queued', editable: true },
  ]} onCancel={() => {}} onEdit={async () => {}} onWithdraw={async () => {}}
    onSendNow={async () => {}} />);
  assert.match(html, /aria-label="编辑排队消息"/);
  assert.match(html, /aria-label="撤回到输入框"/);
  assert.match(html, /aria-label="立即发送"/);
  assert.match(html, /aria-label="取消排队"/);
});

test('composer queue rows keep cancel visible and group only available secondary actions in the overflow menu', () => {
  const withActions = renderToStaticMarkup(<SessionQueue queueRevision={4} items={[
    { id: 'dock-row', text: 'follow-up from the composer', status: 'queued', editable: true },
  ]} onCancel={() => {}} onEdit={async () => {}} onWithdraw={async () => {}} onSendNow={async () => {}} />);
  assert.match(withActions, /data-testid="session-queue-row-dock-row"/);
  assert.match(withActions, /class="xn-session-queue__mode"[\s\S]*?排队/);
  assert.match(withActions, /aria-haspopup="menu"[^>]*data-testid="session-queue-more-dock-row"/);
  assert.match(withActions, /role="menu"[^>]*hidden=""[^>]*data-testid="session-queue-more-menu-dock-row"/);
  assert.match(withActions, /role="menuitem"[^>]*aria-label="撤回到输入框"/);
  assert.match(withActions, /role="menuitem"[^>]*aria-label="立即发送"/);
  assert.match(withActions, /role="menuitem"[^>]*aria-label="编辑排队消息"/);
  assert.match(withActions, /class="xn-session-queue__cancel"[^>]*aria-label="取消排队"/);

  const cancelOnly = renderToStaticMarkup(<SessionQueue items={[
    { id: 'cancel-only', text: 'one action', status: 'queued' },
  ]} onCancel={() => {}} />);
  assert.match(cancelOnly, /aria-label="取消排队"/);
  assert.doesNotMatch(cancelOnly, /aria-label="更多排队操作"/);
  assert.doesNotMatch(cancelOnly, /aria-label="撤回到输入框"/);
});

test('a reserved send-now item cannot be edited, withdrawn, cancelled, or reordered', () => {
  const item = { id: 'q1', text: 'selected next', status: 'queued', editable: true,
    promotion: { state: 'reserved' } } as unknown as QueuedMessage;
  const html = renderToStaticMarkup(<SessionQueue queueRevision={5} items={[item, {
    id: 'q2', text: 'later', status: 'queued', editable: true,
  }]} onCancel={() => {}} onEdit={async () => {}} onWithdraw={async () => {}}
    onSendNow={async () => {}} onReorder={async () => {}} />);
  const first = html.slice(0, html.indexOf('</li>'));
  assert.match(first, /aria-label="立即发送"[^>]*disabled=""/);
  assert.match(first, /aria-label="撤回到输入框"[^>]*disabled=""/);
  assert.match(first, /aria-label="编辑排队消息"[^>]*disabled=""/);
  assert.match(first, /aria-label="取消排队"[^>]*disabled=""/);
  assert.match(html, /aria-label="调整队列顺序"[^>]*draggable="false"/);
});

import { QueueWithdrawalRecovery } from './SessionQueue';

test('durable withdrawal metadata offers explicit restore and dismissal and survives queue row removal', () => {
  const withdrawals = [{ sessionId: 's', root: '/original', queueId: 'gone', hasContext: true,
    id: 'c_original', expectedRevision: 2, createdAt: 1000, expiresAt: 86401000 }];
  const actions = { onRefresh: async () => {}, onRestore: async () => {}, onDismiss: async () => {} };
  const html = renderToStaticMarkup(<QueueWithdrawalRecovery withdrawals={withdrawals} disabled={false} {...actions} />);
  assert.match(html, /24 小时/u); assert.match(html, /恢复原文到输入框/u);
  assert.match(html, /原附件或上下文不会恢复/u); assert.match(html, /当前输入会保留/u);
  assert.doesNotMatch(html, /<textarea|contenteditable|type="submit"|保持此页面打开/u);
  assert.equal((html.match(/<button/g) ?? []).length, 3);
  const disabled = renderToStaticMarkup(<QueueWithdrawalRecovery withdrawals={withdrawals} disabled {...actions} />);
  assert.equal((disabled.match(/disabled=""/gu) ?? []).length, 3);
  assert.equal(renderToStaticMarkup(<QueueWithdrawalRecovery withdrawals={[]} disabled={false} {...actions} />), '');
  const unknown = renderToStaticMarkup(<QueueWithdrawalRecovery withdrawals={[]} notice="unknown" disabled={false} {...actions} />);
  assert.equal((unknown.match(/<button/g) ?? []).length, 1);
  assert.doesNotMatch(unknown, /恢复原文到输入框/u);
});

test('legacy snapshots remain readable but cannot expose unguarded queue mutations', () => {
  for (const revision of [undefined, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const html = renderToStaticMarkup(<SessionQueue queueRevision={revision} items={[
      { id: 'q1', text: 'first', status: 'queued' }, { id: 'q2', text: 'second', status: 'queued' },
    ]} onCancel={() => {}} onEdit={async () => {}} onReorder={async () => {}}
      onWithdraw={async () => {}} onSendNow={async () => {}} />);
    for (const label of ['编辑排队消息', '撤回到输入框', '取消排队', '立即发送', '上移排队消息', '下移排队消息']) {
      const buttons = html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`, 'gu')) ?? [];
      assert.ok(buttons.length > 0);
      assert.ok(buttons.every(button => button.includes('disabled=""')));
    }
    assert.match(html, /draggable="false"/u);
    assert.match(html, /first/u);
  }
});

test('revision zero permits guarded queue actions', () => {
  const html = renderToStaticMarkup(<SessionQueue queueRevision={0} items={[{ id: 'q', text: 'first', status: 'queued' }]}
    onCancel={() => {}} onEdit={async () => {}} onWithdraw={async () => {}} />);
  const buttons = html.match(/<button[^>]*aria-label="(?:编辑排队消息|撤回到输入框|取消排队)"[^>]*>/gu) ?? [];
  assert.equal(buttons.length, 3);
  assert.ok(buttons.every(button => !button.includes('disabled=""')));
});
