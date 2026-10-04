import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { CompletionChecks } from './CompletionChecks';

test('tool success remains separate from delivery failure and missing items are visible', () => {
  const html = renderToStaticMarkup(<CompletionChecks sessionId="abc" items={[]} disabled onSaved={() => {}} completion={{ tool_execution_success: true, delivery_status: 'failed', delivery_checks: { planning: { status: 'failed', items: [{ id: 'r', label: '人物报告', contains: ['乙'], min_links: 1, passed: false, missing: ['缺少内容：乙'] }] } } }} />);
  assert.match(html, /工具执行成功/); assert.match(html, /交付检查未通过/); assert.match(html, /缺少内容：乙/); assert.match(html, /disabled/);
});
test('legacy evidence never silently certifies content completion', () => {
  const html = renderToStaticMarkup(<CompletionChecks sessionId="abc" items={[]} onSaved={() => {}} completion={{ verified: true }} />);
  assert.match(html, /交付内容尚未检查/); assert.doesNotMatch(html, /交付检查通过/);
});

test('a run without any completion is unchecked rather than a premature evidence failure', () => {
  const html = renderToStaticMarkup(<CompletionChecks sessionId="new" items={[]} onSaved={() => {}} />);
  assert.match(html, /工具证据尚未检查/);
  assert.doesNotMatch(html, /工具成功证据未通过|data-status="failed"/);
  const failed = renderToStaticMarkup(<CompletionChecks sessionId="ended" completion={{ verified: false }} items={[]} onSaved={() => {}} />);
  assert.match(failed, /工具成功证据未通过/);
});


test('tool execution status takes precedence over a contradictory legacy verified flag', () => {
  const html = renderToStaticMarkup(<CompletionChecks sessionId="mixed" completion={{
    verified: false, status: 'unverified', tool_execution_status: 'succeeded', delivery_status: 'not_assessed',
  }} items={[]} onSaved={() => {}} />);
  assert.match(html, /工具执行成功/);
  assert.doesNotMatch(html, /工具成功证据未通过/);
});

test('ordinary chat completion is marked as not needing tool verification', () => {
  const html = renderToStaticMarkup(<CompletionChecks sessionId="chat" completion={{
    verified: false, status: 'not_applicable', verification_status: 'not_applicable', tool_execution_status: 'not_applicable',
    delivery_status: 'not_assessed',
  }} items={[]} onSaved={() => {}} />);
  assert.match(html, /编辑交付清单/);
  assert.doesNotMatch(html, /class="xn-delivery-checks"|交付检查|工具验证/);
});

test('an unverified requirement remains a failure when the tool execution status is not applicable', () => {
  const html = renderToStaticMarkup(<CompletionChecks sessionId="required" completion={{
    verified: false, status: 'unverified', verification_status: 'unverified',
    tool_execution_status: 'not_applicable', delivery_status: 'not_assessed',
  }} items={[{ id: 'r', label: 'Build report', contains: [], min_links: 0 }]} onSaved={() => {}} />);
  assert.match(html, /工具成功证据未通过/);
  assert.doesNotMatch(html, /无需工具验证/);
});

test('a real tool failure remains visible even when a contradictory record says not applicable', () => {
  const html = renderToStaticMarkup(<CompletionChecks sessionId="mixed" completion={{
    verified: false, status: 'not_applicable', tool_execution_status: 'failed', delivery_status: 'not_assessed',
  }} items={[]} onSaved={() => {}} />);
  assert.match(html, /工具成功证据未通过/);
  assert.doesNotMatch(html, /无需工具验证/);
});
