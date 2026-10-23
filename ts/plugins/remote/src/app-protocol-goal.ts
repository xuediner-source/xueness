/** Session-owned goal controls delegate to planning's existing HTTP owner. */
import { isDict } from '@xueness/contracts';
import {
  AppProtocolError, protocolKeys, protocolScope,
  type AppProtocolPort, type ProtocolMethods, type ProtocolRow,
} from './app-protocol-types.ts';

const SCOPE_KEYS = ['workspaceIdentity', 'sessionId'] as const;
const SET_KEYS = [...SCOPE_KEYS, 'text', 'replace', 'budget'] as const;
const BUDGET_KEYS = ['maxRounds', 'maxWallSeconds', 'maxTokens'] as const;

function object(params: ProtocolRow): ProtocolRow {
  if (!isDict(params)) throw new AppProtocolError('params must be an object', -32602);
  return params;
}

function requireEnabled(port: AppProtocolPort): void {
  if (!port.enabled('planning')) throw new AppProtocolError('plugin disabled or unavailable: planning', -32000, { status: 403, plugin: 'planning' });
}

function validateBudget(value: unknown): ProtocolRow {
  if (!isDict(value)) throw new AppProtocolError('budget must be an object', -32602);
  protocolKeys(value, BUDGET_KEYS);
  return value;
}

/** Native goal methods keep workspace/session scope outside the route body. */
export function createAppProtocolGoals(port: AppProtocolPort): ProtocolMethods {
  const scopedSession = async (input: ProtocolRow, keys: readonly string[] = SCOPE_KEYS): Promise<string> => {
    const params = object(input);
    protocolKeys(params, keys);
    const sessionId = await protocolScope(port, params);
    requireEnabled(port);
    return sessionId!;
  };
  return {
    'goal/read': async (input) => {
      const sessionId = await scopedSession(input);
      return port.ask('GET', `/api/sessions/${sessionId}/goal`);
    },
    'goal/set': async (input) => {
      const params = object(input);
      const sessionId = await scopedSession(params, SET_KEYS);
      if (typeof params.text !== 'string' || !params.text.trim()) throw new AppProtocolError('text must be a non-empty string', -32602);
      const body: ProtocolRow = { text: params.text };
      if (Object.hasOwn(params, 'replace')) {
        if (typeof params.replace !== 'boolean') throw new AppProtocolError('replace must be a boolean', -32602);
        body.replace = params.replace;
      }
      if (Object.hasOwn(params, 'budget')) body.budget = validateBudget(params.budget);
      return port.ask('POST', `/api/sessions/${sessionId}/goal`, body);
    },
    'goal/pause': async (input) => {
      const sessionId = await scopedSession(input);
      return port.ask('POST', `/api/sessions/${sessionId}/goal`, { action: 'pause' });
    },
    'goal/resume': async (input) => {
      const sessionId = await scopedSession(input);
      return port.ask('POST', `/api/sessions/${sessionId}/goal`, { action: 'resume' });
    },
    'goal/clear': async (input) => {
      const sessionId = await scopedSession(input);
      return port.ask('DELETE', `/api/sessions/${sessionId}/goal`);
    },
    'goal/budget': async (input) => {
      const params = object(input);
      const sessionId = await scopedSession(params, [...SCOPE_KEYS, 'budget']);
      const budget = validateBudget(params.budget);
      return port.ask('POST', `/api/sessions/${sessionId}/goal`, { action: 'budget', budget });
    },
  };
}
