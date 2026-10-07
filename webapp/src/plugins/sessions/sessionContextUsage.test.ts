import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionContextUsage } from './sessionContextUsage';
import type { WorkbenchSession } from '../../xuenessWorkbench';
const choices = { provider: 'real' as const, mode: 'build' as const, provider_id: 'saved', model: 'small' };
const model = { id: 'saved', name: 'Small', model: 'small', configured: true, protocol: 'openai' as const,
  capabilities: [], reasoningLevels: [], contextWindow: 8192 };
const session = { model_selection: { provider_id: 'saved', model: 'small' },
  runtime_activity: { phase: 'completed', reportedInputTokens: 2048 },
  provider_usage: [{ prompt_tokens: 1000000 }] } as unknown as WorkbenchSession;
test('current input comes from the latest report and declared model capacity, never lifetime totals', () => {
  assert.deepEqual(sessionContextUsage(session, model, choices), {usedTokens:2048,capacityTokens:8192,
    usageSource:'provider-reported',capacitySource:'context-window'});
});
test('changing model hides a previous model reading; missing capacity is unknown', () => {
  assert.equal(sessionContextUsage(session, model, {...choices, model:'other'}), null);
  assert.equal(sessionContextUsage(session, {...model,contextWindow:undefined}, choices), null);
});
test('environment provider null and empty identifiers refer to the same provider', () => {
  const env = {...session,model_selection:{provider_id:null,model:'small'}};
  assert.equal(sessionContextUsage(env, {...model,id:''}, {...choices,provider_id:''})?.usedTokens, 2048);
});
