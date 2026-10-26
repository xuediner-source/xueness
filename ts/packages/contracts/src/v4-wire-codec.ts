/**
 * V4 physical wire encoder (F11.02).
 *
 * Mirrors upstream `zcode-protocol-v4/wire-codec.ts`: measure the caller's
 * real JSON/RPC envelope, keep a logical frame whole when it fits, and when it
 * does not, split only at the UTF-8 byte layer — seq/apply semantics never
 * change. The fragment byte budget is found by binary search against the
 * caller's own measurement function, using worst-case index digits so a real
 * envelope can only measure smaller, never larger.
 */
import { PROTOCOL_V4_LIMITS, V4_WIRE_PROTOCOL_VERSION } from './v4-core.ts';
import { crc32WireBytes, encodeWireBytesBase64 } from './v4-binary.ts';
import type { V4TopicFrameDeliveryKind, V4TopicWireChecksum, V4TopicWireFrame } from './v4-wire.ts';

export function utf8JsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function encodeWireJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

export class V4TopicWireFrameEncodingError extends Error {
  readonly reasonCode: string;
  constructor(reasonCode: string) {
    super(reasonCode);
    this.reasonCode = reasonCode;
    this.name = 'V4TopicWireFrameEncodingError';
  }
}

function hardBound(value: number | undefined, maximum: number, name: string): number {
  const resolved = value ?? maximum;
  if (!Number.isFinite(resolved) || resolved <= 0) throw new V4TopicWireFrameEncodingError(`proto.invalidLimit.${name}`);
  return Math.min(Math.floor(resolved), maximum);
}

export interface EncodeV4TopicWireFramesOptions<F> {
  deliveryKind: V4TopicFrameDeliveryKind;
  topic: string;
  subscriptionId: string;
  logicalFrameId: string;
  logicalFrameOrdinal: number;
  /** Hard cap for one physical frame's full envelope, measured by the caller. */
  maxPhysicalFrameBytes?: number;
  /** Hard cap for the reassembled logical frame (authoritative state ceiling). */
  maxAssemblyBytes?: number;
  /** Measures the real transport envelope around a wire frame. */
  measurePhysicalFrameBytes(wire: V4TopicWireFrame<F>): number;
}

interface FragmentParams {
  options: EncodeV4TopicWireFramesOptions<never>;
  fragmentIndex: number;
  fragmentCount: number;
  logicalBytes: number;
  checksum: V4TopicWireChecksum;
  dataBase64: string;
}

function makeFragment(params: FragmentParams): V4TopicWireFrame<never> {
  const options = params.options as unknown as EncodeV4TopicWireFramesOptions<unknown>;
  return {
    wireVersion: V4_WIRE_PROTOCOL_VERSION,
    kind: 'fragment',
    deliveryKind: options.deliveryKind,
    logicalFrameId: options.logicalFrameId,
    logicalFrameOrdinal: options.logicalFrameOrdinal,
    topic: options.topic,
    subscriptionId: options.subscriptionId,
    fragmentIndex: params.fragmentIndex,
    fragmentCount: params.fragmentCount,
    logicalBytes: params.logicalBytes,
    checksum: params.checksum,
    dataBase64: params.dataBase64,
  };
}

/**
 * Largest per-fragment byte budget whose worst-case envelope still fits the
 * physical cap. Worst case = single-byte fragments (count == logicalBytes) and
 * the largest fragmentIndex digits, so every real envelope measures smaller.
 */
function findFragmentByteBudget(params: {
  options: EncodeV4TopicWireFramesOptions<never>;
  logicalBytes: number;
  checksum: V4TopicWireChecksum;
  maxPhysicalFrameBytes: number;
}): number {
  let low = 1;
  let high = Math.min(params.logicalBytes, params.maxPhysicalFrameBytes);
  let best = 0;
  const worstCount = params.logicalBytes;
  while (low <= high) {
    const candidate = Math.floor((low + high) / 2);
    const dataBase64 = 'A'.repeat(4 * Math.ceil(candidate / 3));
    const wire = makeFragment({
      options: params.options,
      fragmentIndex: Math.max(0, worstCount - 1),
      fragmentCount: worstCount,
      logicalBytes: params.logicalBytes,
      checksum: params.checksum,
      dataBase64,
    });
    if (params.options.measurePhysicalFrameBytes(wire) <= params.maxPhysicalFrameBytes) {
      best = candidate;
      low = candidate + 1;
    } else {
      high = candidate - 1;
    }
  }
  return best;
}

export function encodeV4TopicWireFrames<F>(
  frame: F,
  options: EncodeV4TopicWireFramesOptions<F>,
): V4TopicWireFrame<F>[] {
  const maxPhysicalFrameBytes = hardBound(
    options.maxPhysicalFrameBytes,
    PROTOCOL_V4_LIMITS.maxFrameBytes,
    'maxPhysicalFrameBytes',
  );
  const maxAssemblyBytes = hardBound(
    options.maxAssemblyBytes,
    PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes,
    'maxAssemblyBytes',
  );
  const logical = encodeWireJson(frame);
  if (logical.byteLength > maxAssemblyBytes) {
    throw new V4TopicWireFrameEncodingError('proto.frameAssemblyTooLarge');
  }

  const complete: V4TopicWireFrame<F> = {
    wireVersion: V4_WIRE_PROTOCOL_VERSION,
    kind: 'complete',
    deliveryKind: options.deliveryKind,
    logicalFrameId: options.logicalFrameId,
    logicalFrameOrdinal: options.logicalFrameOrdinal,
    topic: options.topic,
    subscriptionId: options.subscriptionId,
    frame,
  };
  if (options.measurePhysicalFrameBytes(complete) <= maxPhysicalFrameBytes) {
    return [complete];
  }

  const checksum: V4TopicWireChecksum = { algorithm: 'crc32', value: crc32WireBytes(logical) };
  const chunkBytes = findFragmentByteBudget({
    options: options as unknown as EncodeV4TopicWireFramesOptions<never>,
    logicalBytes: logical.byteLength,
    checksum,
    maxPhysicalFrameBytes,
  });
  if (chunkBytes < 1) throw new V4TopicWireFrameEncodingError('proto.frameEnvelopeTooLarge');
  const fragmentCount = Math.ceil(logical.byteLength / chunkBytes);
  if (fragmentCount > PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxFragments) {
    throw new V4TopicWireFrameEncodingError('proto.frameFragmentCountExceeded');
  }

  const frames: V4TopicWireFrame<F>[] = [];
  for (let fragmentIndex = 0; fragmentIndex < fragmentCount; fragmentIndex += 1) {
    const start = fragmentIndex * chunkBytes;
    const end = Math.min(start + chunkBytes, logical.byteLength);
    const wire = makeFragment({
      options: options as unknown as EncodeV4TopicWireFramesOptions<never>,
      fragmentIndex,
      fragmentCount,
      logicalBytes: logical.byteLength,
      checksum,
      dataBase64: encodeWireBytesBase64(logical.subarray(start, end)),
    });
    if (options.measurePhysicalFrameBytes(wire as unknown as V4TopicWireFrame<F>) > maxPhysicalFrameBytes) {
      // The physical cap covers the caller's real envelope; any estimation
      // drift must fail closed, never hand an oversized frame downstream.
      throw new V4TopicWireFrameEncodingError('proto.frameEnvelopeTooLarge');
    }
    frames.push(wire as unknown as V4TopicWireFrame<F>);
  }
  return frames;
}
