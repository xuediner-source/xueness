/** Admit one guide at each model-step boundary, including a text-only close. */
import type { AgentExtension } from '@xueness/agent';
import { beforeModelRequest, settleTurn } from './steering.ts';
export function sessionsSteeringExtension(): AgentExtension {
  const delivered = new WeakSet<object>();
  return { id: 'sessions', capabilities: ['sessions.steering'],
    async beforeModelRequest(context) { if (!delivered.delete(context)) await beforeModelRequest(context.session, context.store, context.stateDir, context.enabled, 1); },
    async beforeFinalResponse(context) {
      const count = await beforeModelRequest(context.session, context.store, context.stateDir, context.enabled, 1);
      if (count) delivered.add(context);
      return count > 0;
    },
    async settleRun(context) { await settleTurn(context.session, context.store, context.stateDir, context.session.active_turn_id); },
    close(context) { delivered.delete(context); },
  };
}
