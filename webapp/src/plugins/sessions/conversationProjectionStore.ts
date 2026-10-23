import { parseConversationSnapshot } from '../../xuenessWorkbench';
import { applyConversationPatch } from './LiveConversation';

export const CONVERSATION_TRANSPORT_SCHEMA = 'xueness.conversation-transport.v1' as const;
export type ConversationCursor = { logEpoch: string; seq: number };
export type ConversationProjection = ConversationCursor & { snapshot: unknown };
export type ConversationProjectionResult =
  | { kind: 'applied' | 'unchanged'; projection: ConversationProjection }
  | { kind: 'resync' };

type Operation = Parameters<typeof applyConversationPatch>[1]['operations'][number];
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const sequence = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const epoch = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 1024;

function operations(value: unknown): Operation[] {
  if (!Array.isArray(value) || value.length > 100000) throw new Error('Invalid conversation operations');
  for (const item of value) {
    const operation = record(item);
    if (!operation || !['set', 'delete', 'append'].includes(operation.op as string)
      || !Array.isArray(operation.path) || operation.path.length > 32
      || operation.path.some(key => typeof key !== 'string' && !sequence(key)
        || ['__proto__', 'constructor', 'prototype'].includes(String(key)))
      || operation.op !== 'delete' && !Object.hasOwn(operation, 'value')) {
      throw new Error('Invalid conversation operation');
    }
  }
  return value as Operation[];
}

/** A cursor belongs only to a complete, validated projection. Failed responses
 * keep the last display state but discard resume eligibility until a snapshot. */
export class ConversationProjectionStore {
  private projection: ConversationProjection | null = null;
  private needsSnapshot = true;

  constructor(private readonly sessionId: string,
    private readonly validate: (snapshot: unknown) => void = snapshot => { parseConversationSnapshot(sessionId, snapshot); }) {}

  getProjection(): ConversationProjection | null { return this.projection; }
  getBase(): ConversationCursor | null {
    return !this.needsSnapshot && this.projection
      ? { logEpoch: this.projection.logEpoch, seq: this.projection.seq } : null;
  }
  invalidate(): void { this.needsSnapshot = true; }

  /** All frames and the consumer's synchronous validation succeed before the
   * one commit. No partially patched state or watermark can escape. */
  apply(payload: unknown, publish?: (projection: ConversationProjection) => void): ConversationProjectionResult {
    try {
      const response = record(payload);
      if (!response || response.schema !== CONVERSATION_TRANSPORT_SCHEMA
        || response.topic !== `conversation/${this.sessionId}`
        || !['snapshot', 'resume'].includes(response.mode as string)
        || !epoch(response.logEpoch) || !sequence(response.seq)
        || !Array.isArray(response.frames) || response.frames.length > 10000) throw new Error('Invalid conversation response');
      const logEpoch = response.logEpoch;
      let next = this.projection;
      let changed = false;
      let sawSnapshot = false;
      if (response.mode === 'resume' && (this.needsSnapshot || !next || next.logEpoch !== logEpoch)) {
        throw new Error('Conversation snapshot required');
      }
      for (const item of response.frames) {
        const frame = record(item);
        if (!frame || frame.logEpoch !== logEpoch || !sequence(frame.fromSeq) || !sequence(frame.toSeq)
          || frame.toSeq < frame.fromSeq) throw new Error('Invalid conversation frame');
        if (frame.kind === 'snapshot') {
          if (response.mode !== 'snapshot' || sawSnapshot || frame.fromSeq !== 0 || changed || !record(frame.snapshot)) {
            throw new Error('Invalid conversation snapshot frame');
          }
          sawSnapshot = true;
          // A late snapshot of the same generation cannot overwrite newer text.
          if (!this.needsSnapshot && next?.logEpoch === logEpoch && frame.toSeq <= next.seq) continue;
          next = { logEpoch, seq: frame.toSeq, snapshot: structuredClone(frame.snapshot) };
          changed = true;
        } else if (frame.kind === 'delta') {
          if (!next || next.logEpoch !== logEpoch || response.mode === 'snapshot' && !sawSnapshot) {
            throw new Error('Conversation snapshot required');
          }
          if (frame.toSeq <= next.seq) continue;
          if (frame.fromSeq !== next.seq || frame.toSeq === frame.fromSeq) throw new Error('Conversation sequence gap');
          const patched = applyConversationPatch({ revision: next.seq, snapshot: next.snapshot }, {
            baseRevision: frame.fromSeq, revision: frame.toSeq, operations: operations(frame.operations),
          });
          next = { logEpoch, seq: frame.toSeq, snapshot: patched.snapshot };
          changed = true;
        } else throw new Error('Invalid conversation frame kind');
      }
      if (!next || response.mode === 'snapshot' && !sawSnapshot || next.logEpoch !== logEpoch
        || response.seq > next.seq || changed && response.seq !== next.seq) throw new Error('Incomplete conversation response');
      if (changed) {
        this.validate(next.snapshot);
        publish?.(next);
        this.projection = next;
      }
      this.needsSnapshot = false;
      return { kind: changed ? 'applied' : 'unchanged', projection: next };
    } catch {
      this.invalidate();
      return { kind: 'resync' };
    }
  }
}
