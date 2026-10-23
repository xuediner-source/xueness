import test from 'node:test';
import assert from 'node:assert/strict';
import { approvalImpactKind, pendingBatchApprovals } from './approvalImpact';

test('approval impact uses the canonical permission kind and batch scope omits already granted calls', () => {
  assert.equal(approvalImpactKind('write', 'exec'), 'write');
  assert.equal(approvalImpactKind(undefined, 'exec'), 'execute');
  assert.deepEqual(pendingBatchApprovals([
    { tool_call_id: 'granted', granted: true },
    { tool_call_id: 'needs-approval' },
  ]).map(item => item.tool_call_id), ['needs-approval']);
});
