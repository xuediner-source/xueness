import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionQueue } from "./SessionQueue";
import type { QueuedMessage } from "../../xuenessWorkbench";

test("queue panel shows FIFO positions, supports paused cancellation and exposes explicit continuation", () => {
  const html = renderToStaticMarkup(<SessionQueue items={[
    { id: "q1", text: "first follow-up", status: "queued", position: 1 },
    { id: "q2", text: "being processed", status: "running" },
    { id: "q3", text: "paused follow-up", status: "paused", position: 2, pause_reason: "Needs review" },
  ]} cancellingId="q1" onCancel={() => {}} canContinue continuing />);
  assert.match(html, /data-testid="session-queue"/);
  assert.match(html, /队列位置 1/);
  assert.match(html, /first follow-up/);
  assert.match(html, /data-status="running"/);
  assert.match(html, /正在取消/);
  assert.match(html, /继续中/);
  assert.equal((html.match(/aria-label="取消排队"/gu) ?? []).length, 2);
  assert.match(html, /paused follow-up/);
  assert.match(html, /暂停原因：Needs review/);
});

test("an empty queue adds no timeline noise", () => {
  assert.equal(renderToStaticMarkup(<SessionQueue items={[]} onCancel={() => {}} />), "");
});

test('claimed paused turn stays fixed while pending turns expose keyboard-accessible ordering and full previews', () => {
  const html = renderToStaticMarkup(<SessionQueue currentId="claimed" items={[
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
  const html = renderToStaticMarkup(<SessionQueue items={[
    { id: "q1", text: "pending", status: "queued", editable: true },
    { id: "q2", text: "active", status: "running", editable: false },
    { id: "q3", text: "/expanded", status: "paused", editable: false },
  ]} onCancel={() => {}} onEdit={async () => {}} />);
  assert.match(html, /aria-expanded="true"/);
  assert.equal((html.match(/aria-label="编辑排队消息"/g) ?? []).length, 1);
});

test('queue exposes edit, withdraw-to-composer, and send-now as separate actions', () => {
  const html = renderToStaticMarkup(<SessionQueue items={[
    { id: 'q1', text: 'prepared with an attachment', status: 'queued', editable: true },
  ]} onCancel={() => {}} onEdit={async () => {}} onWithdraw={async () => {}}
    onSendNow={async () => {}} />);
  assert.match(html, /aria-label="编辑排队消息"/);
  assert.match(html, /aria-label="撤回到输入框"/);
  assert.match(html, /aria-label="立即发送"/);
  assert.match(html, /aria-label="取消排队"/);
});

test('a reserved send-now item cannot be edited, withdrawn, cancelled, or reordered', () => {
  const item = { id: 'q1', text: 'selected next', status: 'queued', editable: true,
    promotion: { state: 'reserved' } } as unknown as QueuedMessage;
  const html = renderToStaticMarkup(<SessionQueue items={[item, {
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
