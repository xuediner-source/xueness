/**
 * Private message identities (`core._ensure_message_identity`).
 *
 * Every message carries `_turn_id` (`turn-N`, assigned at each non-guide
 * user message) and a unique 32-hex `_message_id`; `_turn_count` remembers
 * the highest turn so a compacted transcript never reuses a number. Turn
 * numbers are Python ints, so digits beyond 2**53 stay exact (bigint).
 */
import { isDict, isPyIntValue, pyDictGet, pyIter, pyTruthy, uuid4Hex } from "@xueness/contracts";
import { normalizeInt } from "./history-ops.ts";

const TURN = /^turn-[1-9][0-9]*$/;
const MESSAGE_ID = /^[0-9a-f]{32}$/;

function turnNumber(value: unknown): bigint | null {
  return typeof value === "string" && TURN.test(value) ? BigInt(value.slice(5)) : null;
}

function messagesOf(session: Record<string, unknown>): unknown[] {
  const messages = pyDictGet(session, "messages");
  return pyTruthy(messages) ? pyIter(messages) : [];
}

/** Assign missing turn and message identities in place. */
export function ensureMessageIdentity(session: Record<string, unknown>): void {
  let count = 0n;
  let current = "turn-1";
  const seen = new Set<string>();
  const persistedRaw = pyDictGet(session, "_turn_count", 0);
  const persisted = isPyIntValue(persistedRaw) && BigInt(persistedRaw) >= 0n ? BigInt(persistedRaw) : 0n;
  let highest = persisted;
  for (const message of messagesOf(session)) {
    if (!isDict(message)) continue;
    const number = turnNumber(pyDictGet(message, "_turn_id"));
    if (number !== null && number > highest) highest = number;
  }
  for (const message of messagesOf(session)) {
    if (!isDict(message)) continue;
    const existing = pyDictGet(message, "_turn_id");
    const number = turnNumber(existing);
    if (message.role === "user" && pyDictGet(message, "_input_kind") !== "guide") {
      if (number !== null) {
        if (number > count) count = number;
        current = existing as string;
      } else {
        count = (count > highest ? count : highest) + 1n;
        current = `turn-${count}`;
        highest = count;
      }
    }
    if (number === null) message._turn_id = current;
    const mid = pyDictGet(message, "_message_id");
    let id: string;
    if (typeof mid !== "string" || !MESSAGE_ID.test(mid) || seen.has(mid)) {
      id = uuid4Hex();
      message._message_id = id;
    } else {
      id = mid;
    }
    seen.add(id);
  }
  session._turn_count = normalizeInt(count > highest ? count : highest);
}
