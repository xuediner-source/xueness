import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionRecoveryNotice, showInterruptedRecovery } from './SessionRecoveryNotice';

test('model and execution errors take precedence over an interrupted stream', () => {
  assert.equal(showInterruptedRecovery('stopped', 'interrupted'), true);
  assert.equal(showInterruptedRecovery('provider_error', 'interrupted'), false);
  assert.equal(showInterruptedRecovery('failed', 'interrupted'), false);
  assert.equal(showInterruptedRecovery('pending', 'interrupted', 'Connection closed'), false);
});

test('interruption notice pairs retained-output status with a user-controlled composer action', () => {
  let invoked = false;
  const html = renderToStaticMarkup(<SessionRecoveryNotice kind="interrupted"
    reason="本轮已停止，已保留收到的内容。" actionLabel="接着做" onAction={() => { invoked = true; }} />);
  assert.match(html, /data-testid="session-recovery-notice"/);
  assert.match(html, /data-recovery-kind="interrupted"/);
  assert.match(html, /role="status"/);
  assert.match(html, /本轮已停止，已保留收到的内容/);
  assert.match(html, /接着做/);
  assert.equal(invoked, false, 'rendering the notice must not trigger a retry or send');
});
