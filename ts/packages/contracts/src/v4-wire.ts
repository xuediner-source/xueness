/**
 * V4 physical wire frame schemas (F11.02).
 *
 * Mirrors upstream `zcode-protocol-v4/wire.ts`: logical topic frames keep
 * atomic seq semantics; oversized frames split only at the UTF-8 byte layer.
 * Validation is split the same way upstream splits it:
 * - `parseTopicWireFrameCandidate` validates only the outer shape needed to
 *   safely route/measure a frame (topic + subscriptionId); inner payload
 *   faults must surface in the owned assembler as typed faults, never as an
 *   early warn/drop that leaves the store waiting forever.
 * - `createTopicWireFrameParser` validates the full frame including the inner
 *   logical payload against a caller-supplied parser.
 */
import { PROTOCOL_V4_LIMITS, V4_WIRE_PROTOCOL_VERSION } from './v4-core.ts';
import { isWireBase64 } from './v4-binary.ts';

export interface V4TopicWireChecksum {
  algorithm: 'crc32';
  value: string;
}

/** Publisher reservation marker; consumers must not guess from RPC timing. */
export type V4TopicFrameDeliveryKind = 'initial' | 'online' | 'recovery';
const DELIVERY_KINDS = new Set<string>(['initial', 'online', 'recovery']);

export interface V4TopicWireFragmentEnvelope {
  wireVersion: typeof V4_WIRE_PROTOCOL_VERSION;
  kind: 'fragment';
  deliveryKind: V4TopicFrameDeliveryKind;
  logicalFrameId: string;
  logicalFrameOrdinal: number;
  topic: string;
  subscriptionId: string;
  fragmentIndex: number;
  fragmentCount: number;
  logicalBytes: number;
  checksum: V4TopicWireChecksum;
  dataBase64: string;
}

export type V4TopicWireFrame<F> =
  | {
      wireVersion: typeof V4_WIRE_PROTOCOL_VERSION;
      kind: 'complete';
      deliveryKind: V4TopicFrameDeliveryKind;
      logicalFrameId: string;
      logicalFrameOrdinal: number;
      topic: string;
      subscriptionId: string;
      frame: F;
    }
  | V4TopicWireFragmentEnvelope;

/** Outer envelope every wire frame shares, regardless of inner payload state. */
export interface V4TopicWireRoute {
  kind: 'complete' | 'fragment';
  topic: string;
  subscriptionId: string;
  logicalFrameId: string;
  logicalFrameOrdinal: number;
}

export type V4Parsed<T> = { ok: true; value: T } | { ok: false; issue: string };

function isIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && Number.isSafeInteger(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Outer-shape validation only: enough to route by ownership (topic +
 * subscriptionId) and to meter frames. A frame that fails here is unroutable;
 * a frame that passes here but carries a bad payload must still be handed to
 * the assembler so the miss becomes a typed fault.
 */
export function parseTopicWireFrameCandidate(input: unknown): V4Parsed<V4TopicWireRoute & Record<string, unknown>> {
  if (!isPlainObject(input)) return { ok: false, issue: 'wire frame must be an object' };
  if (input.wireVersion !== V4_WIRE_PROTOCOL_VERSION) {
    return { ok: false, issue: `wireVersion must be ${V4_WIRE_PROTOCOL_VERSION}` };
  }
  if (input.kind !== 'complete' && input.kind !== 'fragment') {
    return { ok: false, issue: 'kind must be "complete" or "fragment"' };
  }
  for (const key of ['logicalFrameId', 'topic', 'subscriptionId'] as const) {
    if (typeof input[key] !== 'string' || input[key]!.length < 1) {
      return { ok: false, issue: `${key} must be a non-empty string` };
    }
  }
  if (!isIndex(input.logicalFrameOrdinal)) {
    return { ok: false, issue: 'logicalFrameOrdinal must be an integer' };
  }
  return { ok: true, value: input as V4TopicWireRoute & Record<string, unknown> };
}

export type V4FrameParser<F> = (input: unknown) => V4Parsed<F>;

interface FragmentChecks {
  fragmentIndex: number;
  fragmentCount: number;
  logicalBytes: number;
  checksum: V4TopicWireChecksum;
  dataBase64: string;
}

function parseFragmentFields(input: Record<string, unknown>): V4Parsed<FragmentChecks> {
  const fragmentIndex = input.fragmentIndex;
  const fragmentCount = input.fragmentCount;
  const logicalBytes = input.logicalBytes;
  if (!isIndex(fragmentIndex) || fragmentIndex < 0) return { ok: false, issue: 'fragmentIndex must be a nonnegative integer' };
  if (!isIndex(fragmentCount) || fragmentCount < 1 || fragmentCount > PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxFragments) {
    return { ok: false, issue: 'fragmentCount must be a positive integer within the assembly limit' };
  }
  if (!isIndex(logicalBytes) || logicalBytes < 1) return { ok: false, issue: 'logicalBytes must be a positive integer' };
  if (fragmentIndex >= fragmentCount) return { ok: false, issue: 'fragmentIndex must be smaller than fragmentCount' };
  if (fragmentCount > logicalBytes) return { ok: false, issue: 'fragmentCount cannot exceed logicalBytes' };
  const checksum = input.checksum;
  if (
    !isPlainObject(checksum) || checksum.algorithm !== 'crc32' ||
    typeof checksum.value !== 'string' || !/^[0-9a-f]{8}$/u.test(checksum.value)
  ) {
    return { ok: false, issue: 'checksum must be { algorithm: "crc32", value: 8 lowercase hex chars }' };
  }
  if (!isWireBase64(input.dataBase64)) return { ok: false, issue: 'dataBase64 must be valid base64' };
  return {
    ok: true,
    value: {
      fragmentIndex,
      fragmentCount,
      logicalBytes,
      checksum: { algorithm: 'crc32' as const, value: checksum.value as string },
      dataBase64: input.dataBase64,
    },
  };
}

/**
 * Full validation for a wire frame whose inner payload is parsed by
 * `parseFrame`. `strict` rejects unknown top-level keys, matching the
 * upstream `.strict()` schemas used at assembler boundaries.
 */
export function createTopicWireFrameParser<F>(
  parseFrame: V4FrameParser<F>,
  options: { strict?: boolean } = {},
): (input: unknown) => V4Parsed<V4TopicWireFrame<F>> {
  const strict = options.strict ?? true;
  const knownKeys = new Set([
    'wireVersion', 'kind', 'deliveryKind', 'logicalFrameId', 'logicalFrameOrdinal',
    'topic', 'subscriptionId', 'frame', 'fragmentIndex', 'fragmentCount', 'logicalBytes', 'checksum', 'dataBase64',
  ]);
  return (input) => {
    const outer = parseTopicWireFrameCandidate(input);
    if (!outer.ok) return outer;
    const record = outer.value as Record<string, unknown>;
    if (strict) {
      const unknown = Object.keys(record).filter((key) => !knownKeys.has(key)).sort();
      if (unknown.length) return { ok: false, issue: `unexpected wire frame keys: ${unknown.join(', ')}` };
    }
    if (!DELIVERY_KINDS.has(String(record.deliveryKind))) {
      return { ok: false, issue: 'deliveryKind must be one of: initial, online, recovery' };
    }
    const deliveryKind = record.deliveryKind as V4TopicFrameDeliveryKind;
    const base = {
      wireVersion: V4_WIRE_PROTOCOL_VERSION,
      deliveryKind,
      logicalFrameId: record.logicalFrameId as string,
      logicalFrameOrdinal: record.logicalFrameOrdinal as number,
      topic: record.topic as string,
      subscriptionId: record.subscriptionId as string,
    };
    if (!isIndex(base.logicalFrameOrdinal) || base.logicalFrameOrdinal < 1) {
      return { ok: false, issue: 'logicalFrameOrdinal must be a positive integer' };
    }
    if (record.kind === 'fragment') {
      const fields = parseFragmentFields(record);
      if (!fields.ok) return fields;
      return { ok: true, value: { ...base, kind: 'fragment' as const, ...fields.value } };
    }
    const frame = parseFrame(record.frame);
    if (!frame.ok) return frame;
    const envelope = frame.value as { topic?: unknown; subscriptionId?: unknown };
    if (isPlainObject(envelope)) {
      if (envelope.topic !== base.topic) return { ok: false, issue: 'complete wire topic must match logical frame topic' };
      if (envelope.subscriptionId !== base.subscriptionId) {
        return { ok: false, issue: 'complete wire subscriptionId must match logical frame subscriptionId' };
      }
    }
    return { ok: true, value: { ...base, kind: 'complete' as const, frame: frame.value } };
  };
}
