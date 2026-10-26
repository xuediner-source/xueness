/**
 * V4 physical wire reassembly (F11.02).
 *
 * Mirrors upstream `zcode-protocol-v4/wire-reassembly.ts`: fragments only
 * ever enter staging; a logical frame is produced only after bytes, checksum,
 * UTF-8, JSON and schema all pass, and only then is it atomically applicable.
 * Fragments may arrive in any order; identical duplicates are idempotent;
 * conflicting duplicates and any metadata drift are typed rejections.
 */
import { PROTOCOL_V4_LIMITS } from './v4-core.ts';
import { crc32WireBytes, decodeWireBase64 } from './v4-binary.ts';
import { V4_WIRE_FAULT_INVALID_PAYLOAD } from './v4-wire-fault.ts';
import type { V4FrameParser, V4TopicFrameDeliveryKind, V4TopicWireFrame } from './v4-wire.ts';

export type ReassembleV4TopicWireFramesResult<F> =
  | { kind: 'complete'; frame: F; deliveryKind: V4TopicFrameDeliveryKind }
  | { kind: 'incomplete'; logicalFrameId: string; missingIndexes: number[] }
  | { kind: 'rejected'; reasonCode: string };

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function frameMatchesEnvelope(frame: unknown, wire: { topic: string; subscriptionId: string }): boolean {
  if (typeof frame !== 'object' || frame === null) return false;
  const record = frame as { topic?: unknown; subscriptionId?: unknown };
  return record.topic === wire.topic && record.subscriptionId === wire.subscriptionId;
}

export function reassembleV4TopicWireFrames<F>(
  wires: readonly V4TopicWireFrame<unknown>[],
  parseFrame: V4FrameParser<F>,
  options: { maxAssemblyBytes?: number } = {},
): ReassembleV4TopicWireFramesResult<F> {
  if (wires.length === 0) return { kind: 'rejected', reasonCode: 'proto.frameAssemblyEmpty' };
  const first = wires[0]!;
  const requestedMaxAssemblyBytes =
    options.maxAssemblyBytes ?? PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes;
  if (!Number.isFinite(requestedMaxAssemblyBytes) || requestedMaxAssemblyBytes <= 0) {
    return { kind: 'rejected', reasonCode: 'proto.invalidLimit.maxAssemblyBytes' };
  }
  const maxAssemblyBytes = Math.min(
    Math.floor(requestedMaxAssemblyBytes),
    PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes,
  );

  if (first.kind === 'complete') {
    if (wires.length !== 1 || !frameMatchesEnvelope(first.frame, first)) {
      return { kind: 'rejected', reasonCode: 'proto.frameAssemblyMetadataMismatch' };
    }
    if (encodeJson(first.frame).byteLength > maxAssemblyBytes) {
      // complete and fragment are two physical carriers of the same logical
      // frame; limiting only fragments would let a receiver bypass the 16 MiB
      // authoritative-state ceiling through single-frame deliveries.
      return { kind: 'rejected', reasonCode: 'proto.frameAssemblyTooLarge' };
    }
    const parsed = parseFrame(first.frame);
    return parsed.ok
      ? { kind: 'complete', frame: parsed.value, deliveryKind: first.deliveryKind }
      : { kind: 'rejected', reasonCode: V4_WIRE_FAULT_INVALID_PAYLOAD };
  }

  if (first.fragmentCount > PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxFragments) {
    // fragmentCount was once bounded only by logicalBytes; hostile metadata
    // could mint tens of millions of missingIndexes on the missing-fragment
    // path. The protocol hard cap blocks the unbounded allocation first.
    return { kind: 'rejected', reasonCode: 'proto.frameFragmentCountExceeded' };
  }
  if (first.logicalBytes > maxAssemblyBytes) {
    return { kind: 'rejected', reasonCode: 'proto.frameAssemblyTooLarge' };
  }

  const fragments = new Map<number, Uint8Array>();
  let decodedByteTotal = 0;
  for (const wire of wires) {
    if (
      wire.kind !== 'fragment' ||
      wire.logicalFrameId !== first.logicalFrameId ||
      wire.logicalFrameOrdinal !== first.logicalFrameOrdinal ||
      wire.deliveryKind !== first.deliveryKind ||
      wire.topic !== first.topic ||
      wire.subscriptionId !== first.subscriptionId ||
      wire.fragmentCount !== first.fragmentCount ||
      wire.logicalBytes !== first.logicalBytes ||
      wire.checksum.algorithm !== first.checksum.algorithm ||
      wire.checksum.value !== first.checksum.value ||
      wire.fragmentCount > wire.logicalBytes ||
      !Number.isInteger(wire.fragmentIndex) ||
      wire.fragmentIndex < 0 ||
      wire.fragmentIndex >= wire.fragmentCount
    ) {
      return { kind: 'rejected', reasonCode: 'proto.frameAssemblyMetadataMismatch' };
    }
    const decoded = decodeWireBase64(wire.dataBase64);
    if (!decoded) return { kind: 'rejected', reasonCode: 'proto.frameAssemblyInvalidBase64' };
    const previous = fragments.get(wire.fragmentIndex);
    if (previous) {
      // Duplicate delivery is expected on redelivery; identical bytes are
      // idempotent, divergent bytes for the same index are a hard conflict.
      if (
        previous.byteLength !== decoded.byteLength ||
        previous.some((byte, index) => byte !== decoded[index])
      ) {
        return { kind: 'rejected', reasonCode: 'proto.frameAssemblyFragmentConflict' };
      }
      continue;
    }
    const nextDecodedByteTotal = decodedByteTotal + decoded.byteLength;
    if (nextDecodedByteTotal > maxAssemblyBytes) {
      // Total bytes must not be tallied only after every fragment lands;
      // checking per accepted fragment keeps staging memory under the cap.
      return { kind: 'rejected', reasonCode: 'proto.frameAssemblyTooLarge' };
    }
    if (nextDecodedByteTotal > first.logicalBytes) {
      return { kind: 'rejected', reasonCode: 'proto.frameAssemblyLengthMismatch' };
    }
    fragments.set(wire.fragmentIndex, decoded);
    decodedByteTotal = nextDecodedByteTotal;
  }

  const missingIndexes: number[] = [];
  for (let index = 0; index < first.fragmentCount; index += 1) {
    if (!fragments.has(index)) missingIndexes.push(index);
  }
  if (missingIndexes.length > 0) {
    return { kind: 'incomplete', logicalFrameId: first.logicalFrameId, missingIndexes };
  }
  if (decodedByteTotal !== first.logicalBytes) {
    return { kind: 'rejected', reasonCode: 'proto.frameAssemblyLengthMismatch' };
  }

  const logical = new Uint8Array(decodedByteTotal);
  let offset = 0;
  for (let index = 0; index < first.fragmentCount; index += 1) {
    const fragment = fragments.get(index)!;
    logical.set(fragment, offset);
    offset += fragment.byteLength;
  }
  if (crc32WireBytes(logical) !== first.checksum.value) {
    return { kind: 'rejected', reasonCode: 'proto.frameAssemblyChecksumMismatch' };
  }

  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(logical);
  } catch {
    return { kind: 'rejected', reasonCode: 'proto.frameAssemblyInvalidUtf8' };
  }
  let value: unknown;
  try {
    value = JSON.parse(decoded);
  } catch {
    return { kind: 'rejected', reasonCode: 'proto.frameAssemblyInvalidJson' };
  }
  if (!frameMatchesEnvelope(value, first)) {
    return { kind: 'rejected', reasonCode: 'proto.frameAssemblyMetadataMismatch' };
  }
  const parsed = parseFrame(value);
  return parsed.ok
    ? { kind: 'complete', frame: parsed.value, deliveryKind: first.deliveryKind }
    : { kind: 'rejected', reasonCode: V4_WIRE_FAULT_INVALID_PAYLOAD };
}
