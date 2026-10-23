import test from 'node:test';
import assert from 'node:assert/strict';
import { archiveProjectSessions } from './projectArchive';

test('project archive reports completed sessions and stops at a failure', async () => {
  const calls: string[] = [];
  const result = await archiveProjectSessions(['one', 'one', 'two', 'three'], () => true, async id => {
    calls.push(id); return id === 'two' ? { ok: false, error: 'still running' } : { ok: true, value: undefined };
  });
  assert.deepEqual(calls, ['one', 'two']);
  assert.deepEqual(result, { archivedIds: ['one'], error: 'still running' });
});
test('disabling sessions during archive prevents subsequent requests', async () => {
  let enabled = true;
  const result = await archiveProjectSessions(['one', 'two'], () => enabled, async () => {
    enabled = false; return { ok: true, value: undefined };
  });
  assert.deepEqual(result.archivedIds, ['one']);
});
