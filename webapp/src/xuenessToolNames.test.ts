import test from 'node:test';
import assert from 'node:assert/strict';
import { internalToolName, modelToolName } from './xuenessToolNames';
import { approvalImpactKind } from './plugins/sessions/approvalImpact';
import { resolveToolRenderer } from './plugins/sessions/toolRenderers';

test('ZCode model names map to the Xueness tools for renderers and approvals (Step 3)', () => {
  assert.equal(internalToolName('Bash'), 'exec');
  assert.equal(internalToolName('TodoWrite'), 'todo_write');
  assert.equal(internalToolName('web_fetch'), 'web_fetch');
  assert.equal(modelToolName('exit_plan_mode'), 'ExitPlanMode');
  assert.equal(internalToolName('Agent'), 'task');
  assert.equal(modelToolName('mcp__a__b'), 'mcp__a__b');
  for (const name of ['exec', 'read', 'edit', 'write']) {
    assert.equal(resolveToolRenderer(internalToolName(modelToolName(name)), new Set(['sessions', 'files', 'shell'])).id,
      resolveToolRenderer(name, new Set(['sessions', 'files', 'shell'])).id, name);
  }
  assert.equal(approvalImpactKind('plan_exit', 'exit_plan_mode'), 'plan');
  assert.equal(approvalImpactKind(undefined, 'ExitPlanMode'), 'plan');
  assert.equal(approvalImpactKind(undefined, 'Bash'), 'execute');
});
