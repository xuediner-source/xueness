/**
 * Classification of V4 physical assembly faults (F11.02).
 *
 * Mirrors upstream `zcode-protocol-v4/wire-fault.ts`. The recovery ladder
 * treats faults as transient by default: same-subscription resync, then
 * forceSnapshot escalation, then fail closed. That ladder is right for lost
 * fragments, timeouts and checksum mismatches — a redelivery probably fixes
 * them. It is wrong for schema rejection: bytes that already passed the
 * length/checksum/UTF-8/JSON gates and still failed schema parsing mean this
 * end cannot read the peer's content, and resending the same delta will fail
 * identically. This module only answers "is this reason code a deterministic
 * content fault"; handling lives in the consuming stores.
 */

/**
 * The frame content passed checksum/JSON but failed the logical schema.
 *
 * Constant instead of ad-hoc literals everywhere: the classifier and the
 * producers (reassembly) must forever be the same word — a fork between the
 * two is exactly the silent mismatch this module exists to prevent.
 */
export const V4_WIRE_FAULT_INVALID_PAYLOAD = 'proto.frameAssemblyInvalidPayload';

/**
 * Is this fault "resending the same content will necessarily be rejected
 * again"? Only schema rejection qualifies. `proto.frameAssemblyInvalidJson`
 * is deliberately excluded: invalid JSON can also come from the assembly path
 * itself (fragment joins, encoding boundaries), where a retry may genuinely
 * differ. Misclassifying a transient fault as deterministic would strand a
 * self-healing gap in place — worse than one wasted retry. Add by evidence,
 * not by guess.
 */
export function isDeterministicV4ContentFault(reasonCode: string | undefined): boolean {
  return reasonCode === V4_WIRE_FAULT_INVALID_PAYLOAD;
}

/**
 * Client terminal code for a deterministic content fault. Kept distinct from
 * `fault.subscription.recoveryFailed`: that one means "the link did not come
 * back" and reconnecting makes sense; this one means "this end cannot read
 * what the peer sent" and reconnecting will produce the identical result.
 * Telemetry aggregates by code — merging the two reads one version mismatch
 * as a field of network jitter.
 */
export const V4_SUBSCRIPTION_CONTENT_REJECTED = 'fault.subscription.contentRejected';
