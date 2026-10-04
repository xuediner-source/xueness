import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completionPresentation } from './completionPresentation';
import { isXuenessEventV1 } from '../../xuenessEvents';

test('truncated delivery stays paused even after successful tools and cannot claim completion', () => {
  const message = '本次生成达到输出上限，回答尚未完成。';
  const presentation = completionPresentation({
    verified: false, status: 'incomplete', toolExecutionStatus: 'succeeded', summary: message,
  });
  assert.equal(presentation.title, '回答尚未完成');
  assert.equal(presentation.label, '已暂停');
  assert.equal(presentation.status, 'review');
  assert.equal(presentation.summary, message);
  assert.equal(presentation.detailsOpen, true);
});

test('v1 completion accepts the explicit incomplete outcome without weakening other fields', () => {
  const event = { schema: 'xueness.event.v1', seq: 1, sessionId: 'abc', type: 'session.completion',
    verified: false, evidenceCount: 0, summary: 'Partial answer retained', status: 'incomplete' };
  assert.equal(isXuenessEventV1(event), true);
  assert.equal(isXuenessEventV1({ ...event, status: 'anything' }), false);
  assert.equal(isXuenessEventV1({ ...event, verified: 'true' }), false);
});
