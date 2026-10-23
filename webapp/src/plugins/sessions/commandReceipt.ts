import { DeliveryUnconfirmedError } from './submissionTransport';

/** Stable client identity for one sessions command admission. */
export function createSessionCommandId(): string {
  return `c_${Date.now()}_${crypto.randomUUID()}`;
}

export class CommandDeliveryUnconfirmedError extends DeliveryUnconfirmedError {
  constructor(readonly commandId: string) { super(); }
}

/** Refuse to start execution from an admission response for another session. */
export function validateSendCommandResult(sessionId: string, result: unknown, commandId?: string): void {
  const unconfirmed = () => commandId ? new CommandDeliveryUnconfirmedError(commandId) : new DeliveryUnconfirmedError();
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw unconfirmed();
  const record = result as Record<string, unknown>;
  if (record.id !== sessionId || typeof record.status !== 'string' || !record.status
    || (record.steps !== undefined && (!Number.isInteger(record.steps) || (record.steps as number) < 0))) {
    throw unconfirmed();
  }
}

/** A create ACK must identify the server-owned session before a run can start. */
export function validateCreateCommandResult(result: unknown, commandId?: string): string {
  const unconfirmed = () => commandId ? new CommandDeliveryUnconfirmedError(commandId) : new DeliveryUnconfirmedError();
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw unconfirmed();
  const record = result as Record<string, unknown>;
  if (typeof record.id !== 'string' || !/^[0-9a-f]{32}$/u.test(record.id)
    || typeof record.status !== 'string' || !record.status || typeof record.root !== 'string' || !record.root) {
    throw unconfirmed();
  }
  return record.id;
}

/** An edit ACK must confirm the persisted row before its replacement can run. */
export function validateEditCommandResult(sessionId: string, messageIndex: number, result: unknown, commandId?: string): void {
  const unconfirmed = () => commandId ? new CommandDeliveryUnconfirmedError(commandId) : new DeliveryUnconfirmedError();
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw unconfirmed();
  const record = result as Record<string, unknown>;
  if (record.id !== sessionId || record.messageIndex !== messageIndex || record.action !== 'edit'
    || typeof record.revision !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(record.revision)) throw unconfirmed();
}
