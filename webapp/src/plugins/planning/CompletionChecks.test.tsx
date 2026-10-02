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
