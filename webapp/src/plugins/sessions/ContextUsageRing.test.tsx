import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  contextUsagePercent,
  contextUsageReading,
  ContextUsageRing,
  type ContextUsageReading,
} from './ContextUsageRing';

test('context usage prefers latest provider-reported input and the model context window', () => {
  assert.deepEqual(contextUsageReading({
    reportedInputTokens: 2048,
    estimatedInputTokens: 1800,
    contextWindow: 8192,
    inputBudgetTokens: 6144,
  }), {
    usedTokens: 2048,
    capacityTokens: 8192,
    usageSource: 'provider-reported',
    capacitySource: 'context-window',
  });
});

test('reported input without a declared context window is labelled against the input budget', () => {
  assert.deepEqual(contextUsageReading({ reportedInputTokens: 2048, inputBudgetTokens: 6144 }), {
    usedTokens: 2048,
    capacityTokens: 6144,
    usageSource: 'provider-reported',
    capacitySource: 'input-budget',
  });
});

test('estimated current input is compared only with a positive input budget', () => {
  assert.deepEqual(contextUsageReading({ estimatedInputTokens: 1800, inputBudgetTokens: 6144 }), {
    usedTokens: 1800,
    capacityTokens: 6144,
    usageSource: 'estimated',
    capacitySource: 'input-budget',
  });
  assert.equal(contextUsageReading({ estimatedInputTokens: 1800, contextWindow: 8192 }), null);
  assert.equal(contextUsageReading({ reportedInputTokens: 120, contextWindow: 0 }), null);
});

test('missing or malformed current usage stays unknown instead of becoming zero', () => {
  assert.equal(contextUsageReading(undefined), null);
  assert.equal(contextUsageReading(null), null);
  assert.equal(contextUsageReading({ contextWindow: 8192, inputBudgetTokens: 6144 }), null);
  assert.equal(contextUsageReading({ estimatedInputTokens: Number.NaN, inputBudgetTokens: 6144 }), null);
  assert.equal(contextUsageReading({ reportedInputTokens: 30.5, inputBudgetTokens: 6144 }), null);
  assert.equal(contextUsageReading({ reportedInputTokens: 30, inputBudgetTokens: 0 }), null);
});

test('provider-reported zero is distinct from unknown, and visual percentage clamps overflow', () => {
  const zero = contextUsageReading({ reportedInputTokens: 0, contextWindow: 8192 });
  assert.deepEqual(zero, {
    usedTokens: 0,
    capacityTokens: 8192,
    usageSource: 'provider-reported',
    capacitySource: 'context-window',
  });
  assert.equal(contextUsagePercent(zero), 0);
  assert.equal(contextUsagePercent({
    usedTokens: 9000,
    capacityTokens: 8192,
    usageSource: 'provider-reported',
    capacitySource: 'context-window',
  }), 100);
  assert.equal(contextUsagePercent({
    usedTokens: 1,
    capacityTokens: 0,
    usageSource: 'estimated',
    capacitySource: 'input-budget',
  }), null);
});

test('context ring is gated, exposes accessible progress, and identifies both data sources', () => {
  const reading: ContextUsageReading = {
    usedTokens: 2048,
    capacityTokens: 8192,
    usageSource: 'provider-reported',
    capacitySource: 'context-window',
  };
  assert.equal(renderToStaticMarkup(<ContextUsageRing enabled={false} reading={reading} />), '');

  const html = renderToStaticMarkup(<ContextUsageRing enabled reading={reading} />);
  assert.match(html, /role="progressbar"/);
  assert.match(html, /aria-valuemin="0"/);
  assert.match(html, /aria-valuemax="100"/);
  assert.match(html, /aria-valuenow="25"/);
  assert.match(html, /data-usage-source="provider-reported"/);
  assert.match(html, /data-capacity-source="context-window"/);
  assert.match(html, /2,048 \/ 8,192/);
  assert.match(html, /服务报告的 Token 用量/);
  assert.match(html, /上下文窗口/);
  assert.match(html, /role="tooltip"/);
});

test('unknown context ring reports unavailable and omits numeric progress values', () => {
  const html = renderToStaticMarkup(<ContextUsageRing enabled reading={null} />);
  assert.match(html, /data-known="false"/);
  assert.match(html, /aria-valuetext="上下文用量：不可用"/);
  assert.doesNotMatch(html, /aria-valuenow=/);
  assert.doesNotMatch(html, /xn-context-usage-ring__value/);
  assert.doesNotMatch(html, /0 \/ 0/);
  assert.match(html, /role="tooltip"/);
});
