import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { Context, PluginHost } from '@xueness/kernel';
import { PermissionSession } from '@xueness/permissions';
import { createToolEnv } from '@xueness/engine-tools';
import { ToolBridge } from '@xueness/tool-bridge';
import { createPlanning, stageGoal } from '../src/index.ts';

it('reads the bound goal through the production gate in plan mode without requesting approval', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xueness-goal-read-'));
  const workspace = join(root, 'workspace'), artifacts = join(root, 'artifacts'); mkdirSync(workspace); mkdirSync(artifacts);
  const session: Record<string, unknown> = { id: 'a'.repeat(32), root: workspace };
  stageGoal(session, 'Keep the saved project goal', { enabled: () => true });
  const kernel = Context.create({ roots: { workspace: [workspace], state: root, temp: artifacts } });
  const host = new PluginHost(kernel, [createPlanning({ session: () => session })]);
  try {
    await host.start();
    const bridge = new ToolBridge({ kernel, permissions: new PermissionSession({ mode: 'plan' }), env: createToolEnv({ cwd: workspace, artifactsDir: artifacts }),
      approver: async () => { throw new Error('read-only goal inspection must never ask'); } });
    const result = await bridge.call({ id: 'read-goal', name: 'goal_read', input: {} });
    assert.equal(result.ok, true);
    assert.equal((result.data as { goal: { text: string } }).goal.text, 'Keep the saved project goal');
  } finally { await host.dispose(); await kernel.dispose(); rmSync(root, { recursive: true, force: true }); }
});
