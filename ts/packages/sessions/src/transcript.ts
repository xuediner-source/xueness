/**
 * Display-history projections settled with a run (`sessions/history.py`):
 * an interrupted stream's partial text anchored to its turn, and reasoning
 * intervals attached to the assistant messages that produced them.
 */
import { isDict, isPyIntValue, pyDictGet, pyEquals, pyLen, pyTruthy, setOwn } from "@xueness/contracts";

export const REASONING_TIMING_MAX = 20;
const TURN_ID = /^turn-[1-9][0-9]*$/;
const MESSAGE_ID = /^[0-9a-f]{32}$/;

type Row = Record<string, unknown>;

function isMessageId(value: unknown): value is string {
  return typeof value === "string" && MESSAGE_ID.test(value);
}

/**
 * `preserve_interrupted_partial`: record a manually stopped stream's text
 * for the transcript without adding it to `messages` (the next prompt).
 */
export function preserveInterruptedPartial(session: unknown, turnId: unknown, options: { previousStreamId?: unknown } = {}): boolean {
  if (!isDict(session) || pyDictGet(session, "status") !== "stopped") return false;
  if (typeof turnId !== "string" || !TURN_ID.test(turnId)) return false;
  const stream = pyDictGet(session, "streaming");
  if (!isDict(stream) || pyDictGet(stream, "status") !== "interrupted") return false;
  const streamId = pyDictGet(stream, "id");
  const previous = options.previousStreamId;
  if (pyDictGet(stream, "interrupted") !== true || pyDictGet(stream, "final_message_index") !== null
    || (typeof previous === "string" && pyEquals(streamId, previous))) return false;
  if (!isMessageId(streamId)) return false;
  const text = pyDictGet(stream, "text");
  const reasoning = pyDictGet(stream, "reasoning");
  if (!((typeof text === "string" && text) || (typeof reasoning === "string" && reasoning))) return false;
  const messages = pyDictGet(session, "messages");
  if (!Array.isArray(messages)) return false;
  const existingTurn = pyDictGet(stream, "transcript_turn_id");
  const existingAnchor = pyDictGet(stream, "after_message_id");
  let anchor: Row | undefined;
  if (pyDictGet(stream, "transcript_partial") === true) {
    // An interrupted stream belongs to the turn that first anchored it.
    if (!pyEquals(existingTurn, turnId) || !isMessageId(existingAnchor)) return false;
    anchor = messages.find((message): message is Row => isDict(message)
      && pyEquals(pyDictGet(message, "_message_id"), existingAnchor) && pyEquals(pyDictGet(message, "_turn_id"), existingTurn));
  } else {
    anchor = [...messages].reverse().find((message): message is Row => isDict(message)
      && ["user", "assistant", "tool"].some((role) => pyEquals(pyDictGet(message, "role"), role))
      && pyEquals(pyDictGet(message, "_turn_id"), turnId) && isMessageId(pyDictGet(message, "_message_id")));
  }
  if (anchor === undefined) return false;
  const anchorId = anchor._message_id as string;
  let partials = pyDictGet(session, "interrupted_transcripts");
  if (!Array.isArray(partials)) {
    partials = [];
    session.interrupted_transcripts = partials;
  }
  const list = partials as unknown[];
  const existing = list.find((item): item is Row => isDict(item) && pyEquals(pyDictGet(item, "stream_id"), streamId));
  const fields = (): Row => ({
    text: typeof text === "string" ? text : "",
    reasoning: typeof reasoning === "string" ? reasoning : "",
    reasoning_started_at: pyDictGet(stream, "reasoning_started_at"),
    reasoning_ended_at: pyDictGet(stream, "reasoning_ended_at"),
    interrupted_at: pyDictGet(stream, "interrupted_at"),
  });
  if (existing === undefined) {
    list.push({ stream_id: streamId, turn_id: turnId, after_message_id: anchorId, ...fields() });
  } else if (!pyEquals(pyDictGet(existing, "turn_id"), turnId) || !pyEquals(pyDictGet(existing, "after_message_id"), anchorId)) {
    // A stream ID is an identity, not a hint. Refuse conflicting anchors.
    return false;
  } else if (!pyTruthy(pyDictGet(existing, "text")) && !pyTruthy(pyDictGet(existing, "reasoning"))) {
    for (const [key, value] of Object.entries(fields())) setOwn(existing, key, value);
  }
  stream.transcript_partial = true;
  stream.transcript_turn_id = turnId;
  stream.after_message_id = anchorId;
  return true;
}

function boundedStamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && pyLen(value) <= 40;
}

function assistantAt(messages: unknown[], index: unknown): index is number {
  return isPyIntValue(index) && typeof index === "number" && index >= 0 && index < messages.length
    && isDict(messages[index]) && pyDictGet(messages[index] as Row, "role") === "assistant";
}

/** `settle_reasoning_timing`: attach completed stream reasoning intervals to their messages. */
export function settleReasoningTiming(session: Row): void {
  const messages = pyDictGet(session, "messages");
  const streams = pyDictGet(session, "stream_history");
  if (!Array.isArray(messages) || !Array.isArray(streams)) return;
  const rawTiming = pyDictGet(session, "reasoning_timing");
  const timing = Array.isArray(rawTiming) ? rawTiming : [];
  const byIndex = new Map<number, Row>();
  for (const item of timing) {
    if (!isDict(item)) continue;
    const index = pyDictGet(item, "message_index");
    const started = pyDictGet(item, "started_at");
    const ended = pyDictGet(item, "ended_at");
    if (assistantAt(messages, index) && boundedStamp(started) && boundedStamp(ended)) {
      byIndex.set(index, { message_index: index, started_at: started, ended_at: ended });
    }
  }
  for (const stream of streams.slice(-REASONING_TIMING_MAX)) {
    if (!isDict(stream)) continue;
    const index = pyDictGet(stream, "final_message_index");
    const started = pyDictGet(stream, "reasoning_started_at");
    const ended = pyDictGet(stream, "reasoning_ended_at");
    if (!assistantAt(messages, index) || !boundedStamp(started) || !boundedStamp(ended)) continue;
    byIndex.set(index, { message_index: index, started_at: started, ended_at: ended });
  }
  if (byIndex.size) session.reasoning_timing = [...byIndex.values()].slice(-REASONING_TIMING_MAX);
}
