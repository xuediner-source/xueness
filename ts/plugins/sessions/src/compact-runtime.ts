import { recoverCompactTimelines } from '@xueness/sessions';
import type { AgentExtension } from '@xueness/agent';
export function sessionsCompactPersistenceExtension(): AgentExtension {
  return { id: 'sessions', capabilities: ['sessions.compact_persistence'],
    async beforeRun(context) { if (recoverCompactTimelines(context.session)) await context.save(); },
  };
}
