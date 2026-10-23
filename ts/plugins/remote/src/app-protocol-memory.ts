/** Explicit project-memory proposal controls through the memory HTTP owner. */
import { isDict } from '@xueness/contracts';
import { AppProtocolError, protocolKeys, protocolScope, protocolToken, type AppProtocolPort, type ProtocolMethods } from './app-protocol-types.ts';

export function createAppProtocolMemory(port: AppProtocolPort): ProtocolMethods {
  const methods: ProtocolMethods = {};
  for (const operation of ['list', 'propose', 'get', 'start', 'cancel', 'apply'] as const) {
    methods[`memory/dream/${operation}`] = async params => {
      if (!isDict(params)) throw new AppProtocolError('params must be an object', -32602);
      const extras = operation === 'propose' ? ['sourceSessionIds', 'name'] : operation === 'start' ? ['dreamId', 'digest', 'confirmed', 'allowReal'] : operation === 'apply' ? ['dreamId', 'digest', 'confirmed'] : operation === 'list' ? [] : ['dreamId'];
      protocolKeys(params, ['workspaceIdentity', 'sessionId', ...extras]);
      const sid = await protocolScope(port, params);
      if (!port.enabled('memory') && operation !== 'cancel') throw new AppProtocolError('plugin disabled or unavailable: memory', -32000, { status: 403, plugin: 'memory' });
      const data = Object.fromEntries(extras.filter(key => key !== 'dreamId' && Object.hasOwn(params, key)).map(key => [key, params[key]]));
      const path = `/api/sessions/${sid}/memory-dreams` + (['list', 'propose'].includes(operation) ? '' : '/' + protocolToken(params.dreamId, 'memory dream id'))
        + (['start', 'cancel', 'apply'].includes(operation) ? '/' + operation : '');
      return port.ask(['list', 'get'].includes(operation) ? 'GET' : 'POST', path, data);
    };
  }
  return methods;
}
