/** Session-owned composer and workflow methods for the native stdio protocol. */
import {
  AppProtocolError, protocolBoundPayload, protocolKeys, protocolScope, protocolToken,
  type AppProtocolPort, type ProtocolMethods, type ProtocolRow,
} from './app-protocol-types.ts';

const sidKeys = ['workspaceIdentity', 'sessionId'] as const;
const payloadKeys = ['workspaceIdentity', 'sessionId', 'payload'] as const;
const QUESTION_ID = /^q-[0-9a-f]{64}$/u;
const WITHDRAWAL_ID = /^c_\d{13}_[0-9a-f]{32}$/u;

function noPayload(port: AppProtocolPort, params: ProtocolRow, sid: string | null): void {
  if (Object.keys(protocolBoundPayload(port, params, sid)).length) {
    throw new AppProtocolError('payload must be empty', -32602);
  }
}

function requiredPayload(port: AppProtocolPort, params: ProtocolRow, sid: string | null): ProtocolRow {
  return protocolBoundPayload(port, params, sid);
}

function answerPayload(value: ProtocolRow, keys: readonly string[]): void {
  protocolKeys(value, keys);
  const hasAnswer = Object.hasOwn(value, 'answer'), hasAnswers = Object.hasOwn(value, 'answers');
  if (hasAnswer === hasAnswers) throw new AppProtocolError('expected one answer form', -32602);
}

function queryEnvelope(port: AppProtocolPort, params: ProtocolRow, sid: string): ProtocolRow {
  const envelope = requiredPayload(port, params, sid);
  const operation = envelope.operation;
  if (operation === 'cancel') {
    protocolKeys(envelope, ['operation', 'guidanceId']);
    protocolToken(envelope.guidanceId, 'guidance identity');
    return envelope;
  }
  if (operation !== 'send' && operation !== 'promote') throw new AppProtocolError('invalid guidance operation', -32602);
  protocolKeys(envelope, operation === 'promote' ? ['operation', 'payload', 'queueId'] : ['operation', 'payload']);
  if (operation === 'promote') protocolToken(envelope.queueId, 'queue identity');
  if (!envelope.payload || typeof envelope.payload !== 'object' || Array.isArray(envelope.payload)) {
    throw new AppProtocolError('invalid guidance payload', -32602);
  }
  protocolKeys(envelope.payload as ProtocolRow, operation === 'send'
    ? ['request_id', 'expected_turn_id', 'text', 'prepared_token']
    : ['request_id', 'expected_turn_id', 'expectedRevision']);
  return envelope;
}

/** Feature methods delegate to their existing HTTP owners and preserve their errors. */
export function createAppProtocolControls(port: AppProtocolPort): ProtocolMethods {
  const session = async (params: ProtocolRow, allowed: readonly string[] = sidKeys): Promise<string> => {
    protocolKeys(params, allowed);
    return (await protocolScope(port, params))!;
  };
  const withPayload = async (params: ProtocolRow): Promise<{ sid: string; body: ProtocolRow }> => {
    const sid = await session(params, payloadKeys);
    return { sid, body: requiredPayload(port, params, sid) };
  };
  return {
    'composer/catalog': async (params) => {
      protocolKeys(params, payloadKeys);
      const sid = await protocolScope(port, params, true);
      noPayload(port, params, sid);
      const query: Record<string, string[]> = { root: [port.workspaceIdentity] };
      if (sid !== null) query.session_id = [sid];
      return port.ask('GET', '/api/composer', undefined, query);
    },
    'composer/prepare': async (params) => {
      const sid = await protocolScope(port, params, true);
      protocolKeys(params, payloadKeys);
      const body = requiredPayload(port, params, sid);
      protocolKeys(body, ['text', 'language', 'provider_id', 'model', 'reasoning_effort', 'permission_mode', 'input']);
      if (Object.hasOwn(body, 'input')) {
        const input = body.input;
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppProtocolError('input must be an object', -32602);
        const row = input as ProtocolRow;
        protocolKeys(row, ['attachments', 'attachmentRefs', 'files', 'sessions', 'skills', 'plugins', 'capabilities', 'goal']);
        for (const name of ['attachments', 'files', 'sessions']) {
          if (Object.hasOwn(row, name) && (!Array.isArray(row[name]) || row[name].length !== 0)) {
            throw new AppProtocolError('local attachments and context selections are unavailable remotely', -32602);
          }
        }
        if (Object.hasOwn(row, 'attachmentRefs')) {
          if (!Array.isArray(row.attachmentRefs)) throw new AppProtocolError('attachmentRefs must be an array', -32602);
          for (const ref of row.attachmentRefs) {
            if (!ref || typeof ref !== 'object' || Array.isArray(ref)) throw new AppProtocolError('invalid attachment reference', -32602);
            protocolKeys(ref as ProtocolRow, ['id']);
            protocolToken((ref as ProtocolRow).id, 'attachment identity');
          }
        }
      }
      return port.ask('POST', '/api/composer/prepare', { ...body, root: port.workspaceIdentity, session_id: sid });
    },
    'question/read': async (params) => {
      const sid = await session(params);
      noPayload(port, params, sid);
      return port.ask('GET', `/api/sessions/${sid}/question`);
    },
    'question/answer': async (params) => {
      const { sid, body } = await withPayload(params);
      protocolKeys(body, ['questionId', 'answer', 'answers']);
      if (typeof body.questionId !== 'string' || !QUESTION_ID.test(body.questionId)) throw new AppProtocolError('invalid question identity', -32602);
      answerPayload(body, ['questionId', 'answer', 'answers']);
      return port.ask('POST', `/api/sessions/${sid}/answer-question`, body);
    },
    'question/query': async (params) => {
      protocolKeys(params, ['workspaceIdentity', 'sessionId', 'questionId', 'payload']);
      const sid = (await protocolScope(port, params))!;
      if (typeof params.questionId !== 'string' || !QUESTION_ID.test(params.questionId)) throw new AppProtocolError('invalid question identity', -32602);
      const body = requiredPayload(port, params, sid);
      answerPayload(body, ['answer', 'answers']);
      return port.ask('POST', `/api/sessions/${sid}/question-query`, { questionId: params.questionId, ...body });
    },
    'withdrawal/list': async (params) => {
      const sid = await session(params);
      noPayload(port, params, sid);
      return port.ask('GET', `/api/sessions/${sid}/queue-withdrawals`);
    },
    'withdrawal/get': async (params) => {
      protocolKeys(params, [...sidKeys, 'recoveryId']);
      const sid = (await protocolScope(port, params))!;
      const id = params.recoveryId;
      if (typeof id !== 'string' || !WITHDRAWAL_ID.test(id)) throw new AppProtocolError('invalid withdrawal identity', -32602);
      return port.ask('GET', `/api/sessions/${sid}/queue-withdrawals/${encodeURIComponent(id)}`);
    },
    'withdrawal/dismiss': async (params) => {
      protocolKeys(params, [...sidKeys, 'recoveryId']);
      const sid = (await protocolScope(port, params))!;
      const id = params.recoveryId;
      if (typeof id !== 'string' || !WITHDRAWAL_ID.test(id)) throw new AppProtocolError('invalid withdrawal identity', -32602);
      return port.ask('DELETE', `/api/sessions/${sid}/queue-withdrawals/${encodeURIComponent(id)}`);
    },
    'guidance/read': async (params) => {
      const sid = await session(params);
      noPayload(port, params, sid);
      return port.ask('GET', `/api/sessions/${sid}/steer`);
    },
    'guidance/send': async (params) => {
      const { sid, body } = await withPayload(params);
      protocolKeys(body, ['request_id', 'expected_turn_id', 'text', 'prepared_token']);
      return port.ask('POST', `/api/sessions/${sid}/steer`, body);
    },
    'guidance/cancel': async (params) => {
      protocolKeys(params, [...sidKeys, 'guidanceId']);
      const sid = (await protocolScope(port, params))!;
      const id = protocolToken(params.guidanceId, 'guidance identity');
      return port.ask('DELETE', `/api/sessions/${sid}/steer/${encodeURIComponent(id)}`);
    },
    'guidance/promote': async (params) => {
      protocolKeys(params, [...payloadKeys, 'queueId']);
      const sid = (await protocolScope(port, params))!;
      const queueId = protocolToken(params.queueId, 'queue identity');
      const body = requiredPayload(port, params, sid);
      protocolKeys(body, ['request_id', 'expected_turn_id', 'expectedRevision']);
      return port.ask('POST', `/api/sessions/${sid}/queue/${encodeURIComponent(queueId)}/send-now`, body);
    },
    'guidance/query': async (params) => {
      protocolKeys(params, payloadKeys);
      const sid = (await protocolScope(port, params))!;
      return port.ask('POST', `/api/sessions/${sid}/steer-query`, queryEnvelope(port, params, sid));
    },
  };
}
