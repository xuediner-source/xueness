import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionQueue } from "./SessionQueue";

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

test("queue can collapse and editing is offered only for safely replaceable pending messages", () => {
  const html = renderToStaticMarkup(<SessionQueue items={[
    { id: "q1", text: "pending", status: "queued", editable: true },
    { id: "q2", text: "active", status: "running", editable: false },
    { id: "q3", text: "/expanded", status: "paused", editable: false },
  ]} onCancel={() => {}} onEdit={async () => {}} />);
  assert.match(html, /aria-expanded="true"/);
  assert.equal((html.match(/aria-label="编辑排队消息"/g) ?? []).length, 1);
});
