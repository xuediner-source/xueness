import test from 'node:test';
import assert from 'node:assert/strict';
import { paneHistoryWritable } from './paneHistoryActions';
import type { WorkbenchSession } from '../../xuenessWorkbench';
test('history actions require an idle accepted session projection', () => {
  assert.equal(paneHistoryWritable(null), false);
  for (const status of ['running', 'stopping']) assert.equal(paneHistoryWritable({ status } as WorkbenchSession), false);
  assert.equal(paneHistoryWritable({ status: 'completed', streaming: { status: 'streaming' } } as WorkbenchSession), false);
  assert.equal(paneHistoryWritable({ status: 'completed' } as WorkbenchSession), true);
});

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { usePaneHistoryActions } from './paneHistoryActions';
import { getRunChoices } from '../../xuenessBridge';
function Availability({ enabled = true, remote = false, session = { id: 'a'.repeat(32), status: 'completed' } as WorkbenchSession }: { enabled?: boolean; remote?: boolean; session?: WorkbenchSession }) {
  const actions = usePaneHistoryActions({ bindingKey: 'pane-1', enabled, remote, session, choices: getRunChoices(), onRefresh: async () => undefined });
  return <span data-edit={!!actions.onEdit} data-retry={!!actions.onRetry} />;
}
test('history handlers fail closed for disabled or unbound remote panes', () => {
  assert.match(renderToStaticMarkup(<Availability />), /data-edit="true" data-retry="true"/);
  assert.match(renderToStaticMarkup(<Availability enabled={false} />), /data-edit="false" data-retry="false"/);
  assert.match(renderToStaticMarkup(<Availability remote />), /data-edit="false" data-retry="false"/);
});
test('tool retry never silently grants pending tool permissions', () => {
  assert.match(renderToStaticMarkup(<Availability session={{ id: 'a'.repeat(32), status: 'paused', pending: [{ granted: false }] } as WorkbenchSession} />), /data-retry="false"/);
});
