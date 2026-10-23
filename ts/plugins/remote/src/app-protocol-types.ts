/** Native stdio protocol ports. Feature operations remain behind their HTTP owners. */
import { isDict } from '@xueness/contracts';

export type ProtocolRow = Record<string, any>;
export type ProtocolMethods = Record<string, (params: ProtocolRow) => Promise<unknown>>;
export interface AppProtocolPort {
  workspaceIdentity: string;
  ask(method: string, path: string, data?: ProtocolRow, query?: Record<string, string[]>): Promise<ProtocolRow>;
  authorize(sessionId: string): Promise<void>;
  enabled(pluginId: string): boolean;
}
export class AppProtocolError extends Error {
  code: number;
  data: ProtocolRow | null;
  constructor(message: string, code = -32000, data: ProtocolRow | null = null) {
    super(message); this.code = code; this.data = data;
  }
}
export function protocolKeys(params: ProtocolRow, allowed: readonly string[]): void {
  const unknown = Object.keys(params).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new AppProtocolError('unexpected keys: ' + unknown.sort().join(', '), -32602);
}
export async function protocolScope(port: AppProtocolPort, params: ProtocolRow, nullable = false): Promise<string | null> {
  if (params.workspaceIdentity !== port.workspaceIdentity) throw new AppProtocolError('workspace identity mismatch', -32000, { status: 403 });
  const id = params.sessionId;
  if (nullable && (id === undefined || id === null)) return null;
  if (typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id)) throw new AppProtocolError('sessionId must be a 32-character session id', -32602);
  await port.authorize(id);
  return id;
}
export function protocolPayload(params: ProtocolRow): ProtocolRow {
  const value = params.payload ?? {};
  if (!isDict(value)) throw new AppProtocolError('payload must be an object', -32602);
  return { ...value };
}
export function protocolToken(value: unknown, label = 'identity'): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{32}$/.test(value)) throw new AppProtocolError('invalid ' + label, -32602);
  return value;
}
/** Nested routing fields cannot override the outer workspace/session owner. */
export function protocolBoundPayload(port: AppProtocolPort, params: ProtocolRow, sessionId: string | null): ProtocolRow {
  const body = protocolPayload(params);
  for (const name of ['sessionId', 'session_id']) {
    if (Object.hasOwn(body, name) && body[name] !== sessionId) throw new AppProtocolError('payload session scope mismatch', -32602);
    delete body[name];
  }
  if (Object.hasOwn(body, 'root') && body.root !== port.workspaceIdentity) throw new AppProtocolError('payload workspace scope mismatch', -32602);
  delete body.root;
  if (Object.hasOwn(body, 'remote')) throw new AppProtocolError('nested remote routing is unavailable', -32602);
  return body;
}
