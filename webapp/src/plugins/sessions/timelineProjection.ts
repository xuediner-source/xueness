/**
 * Pure view model: events.v1 become timeline rows, and the session journal
 * supplies full text, tool content, reasoning and message identity.
 */
import { internalToolName } from '../../xuenessToolNames';
import type { XuenessEventV1 } from '../../xuenessEvents';
import { projectJournalAssistantWork } from './conversationJournalProjection';
import { reasoningTimeMs } from './timelineRowSharing';
import type { ReasoningHistoryEntry, ReasoningTimingEntry, TimelineRow } from './workbenchTypes';

/** Attach recorded tool content without changing the stable event sequence.
 * Events intentionally carry small summaries; the existing journal endpoint
 * owns full observations. Each call is matched by ID, never by row position.
 */
export function hydrateTimelineTools(rows: TimelineRow[], journal: unknown): TimelineRow[] {
  if (!journal || typeof journal !== "object" || Array.isArray(journal)) return rows;
  const source = journal as Record<string, unknown>;
  const inputs = new Map<string, Record<string, unknown>>();
  const outputs = new Map<string, unknown>();
  const texts: string[] = [];
  let remaining = 80_000;
  const bounded = (value: unknown, depth = 0): unknown => {
    if (remaining <= 0 || depth > 8) return "…";
    if (typeof value === "string") {
      const result = value.slice(0, Math.min(16_000, remaining));
      remaining -= result.length;
      return result.length < value.length ? `${result}\n…` : result;
    }
    if (Array.isArray(value)) return value.slice(0, 200).map(item => bounded(item, depth + 1));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [key, bounded(item, depth + 1)]));
    return value;
  };
  for (const message of Array.isArray(source.messages) ? source.messages : []) {
    if (!message || typeof message !== "object") continue;
    if (message.role === "assistant") {
      if (typeof message.content === "string" && message.content) texts.push(message.content);
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        if (typeof call?.id !== "string" || typeof call?.function?.arguments !== "string") continue;
        try {
          const parsed = JSON.parse(call.function.arguments);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) inputs.set(call.id, bounded(parsed) as Record<string, unknown>);
        } catch { /* Invalid recorded arguments stay represented by the event summary. */ }
      }
    } else if (message.role === "tool" && typeof message.tool_call_id === "string") {
      try { outputs.set(message.tool_call_id, bounded(JSON.parse(message.content))); }
      catch { if (typeof message.content === "string") outputs.set(message.tool_call_id, bounded(message.content)); }
    }
  }
  let textIndex = 0;
  const judged = source.tool_judge && typeof source.tool_judge === "object" ? (source.tool_judge as { calls?: unknown }).calls : null;
  const verdicts = judged && typeof judged === "object" && !Array.isArray(judged) ? judged as Record<string, unknown> : {};
  return rows.map(row => {
    if (row.kind === "assistant") return { ...row, text: texts[textIndex++]?.slice(0, 40_000) ?? row.text };
    if (row.kind !== "tool") return row;
    return { ...row, ...(inputs.has(row.toolCallId) ? { input: inputs.get(row.toolCallId) } : {}),
      ...(outputs.has(row.toolCallId) ? { output: outputs.get(row.toolCallId) } : {}), ...(Object.hasOwn(verdicts, row.toolCallId) ? { judge: verdicts[row.toolCallId] } : {}) };
  });
}

/** Full text and display-only reasoning are joined by the existing v1 event
 * position. The event protocol stays bounded and unchanged; row ordering and
 * message identity come from the same journal used by the server projection.
 */
export function hydrateTimelineJournalRows(rows: TimelineRow[], journal: unknown, history: ReasoningHistoryEntry[] = [], timing: ReasoningTimingEntry[] = []): TimelineRow[] {
  if (!journal || typeof journal !== "object" || Array.isArray(journal)) return rows;
  const source = journal as Record<string, unknown>;
  const messages = source.messages;
  if (!Array.isArray(messages)) return rows;
  const reasoning = new Map(history.filter(item => Number.isInteger(item?.message_index) && typeof item?.text === "string")
    .map(item => [item.message_index, item.text.slice(0, 32_000)]));
  const sourceTiming = timing.length > 0 ? timing
    : Array.isArray(source.reasoning_timing) ? source.reasoning_timing as ReasoningTimingEntry[] : [];
  const reasoningTiming = new Map(sourceTiming.filter(item => Number.isInteger(item?.message_index)
    && typeof item?.started_at === "string" && typeof item?.ended_at === "string")
    .map(item => [item.message_index, item]));
  const texts = new Map<number, {
    kind: "user" | "assistant"; text: string; messageIndex: number; messageId?: string;
    streamId?: string; interrupted?: boolean; reasoning?: string; startedAt?: number; endedAt?: number;
  }>();
  // events.v1 inserts historical completion records before the next user
  // message. Ignoring them shifts every later message and its reasoning.
  const completionCounts = new Map<string, number>();
  for (const record of Array.isArray(source.completion_history) ? source.completion_history.slice(-200) : []) {
    if (!record || typeof record !== 'object' || Array.isArray(record) || typeof record.turn_id !== 'string' || !/^turn-[1-9][0-9]*$/u.test(record.turn_id)) continue;
    completionCounts.set(record.turn_id, (completionCounts.get(record.turn_id) ?? 0) + 1);
  }
  const messageWindow = source.message_window && typeof source.message_window === 'object'
    ? source.message_window as Record<string, unknown> : undefined;
  const pagedStart = Number.isSafeInteger(messageWindow?.start) ? messageWindow!.start as number : 0;
  const messageIndices = Array.isArray(messageWindow?.messageIndices) ? messageWindow!.messageIndices as unknown[] : undefined;
  let seq = 1, firstUser = pagedStart === 0, turn = 1;
  if (pagedStart > 0) {
    const firstVisibleUser = messages.find((message): message is Record<string, unknown> =>
      Boolean(message && typeof message === 'object' && (message as Record<string, unknown>).role === 'user'));
    const firstVisible = firstVisibleUser?._turn_id;
    if (typeof firstVisible === 'string' && /^turn-[1-9][0-9]*$/u.test(firstVisible)) {
      const turnNumber = Number(firstVisible.slice(5));
      turn = firstVisibleUser?._input_kind === 'guide' ? turnNumber : Math.max(1, turnNumber - 1);
    }
  }
  messages.forEach((message, messageIndex) => {
    if (!message || typeof message !== "object") return;
    const identity = typeof message._message_id === 'string' ? {messageId: message._message_id} : {};
    if (message.role === "assistant") {
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) if (call && typeof call === "object") seq++;
      if (message.content) texts.set(++seq, {
        kind:"assistant", text:String(message.content), messageIndex, ...identity,
        ...(message._transcript_partial === true ? {
          streamId: typeof message._stream_id === 'string' ? message._stream_id : undefined,
          interrupted: true,
          ...(typeof message._stream_reasoning === 'string' && message._stream_reasoning
            ? {reasoning: message._stream_reasoning} : {}),
          ...(reasoningTimeMs(message._stream_reasoning_started_at) !== undefined
            ? {startedAt: reasoningTimeMs(message._stream_reasoning_started_at)} : {}),
          ...(reasoningTimeMs(message._stream_reasoning_ended_at ?? message._stream_interrupted_at) !== undefined
            ? {endedAt: reasoningTimeMs(message._stream_reasoning_ended_at ?? message._stream_interrupted_at)} : {}),
        } : {}),
      });
    } else if (message.role === "tool") seq++;
    else if (message.role === "user") {
      if (firstUser) {
        firstUser = false;
        if (typeof message._turn_id === 'string' && /^turn-[1-9][0-9]*$/u.test(message._turn_id)) turn = Number(message._turn_id.slice(5));
      }
      else {
        if (message._input_kind !== 'guide') {
          seq += completionCounts.get(`turn-${turn}`) ?? 0;
          turn = typeof message._turn_id === 'string' && /^turn-[1-9][0-9]*$/u.test(message._turn_id) ? Number(message._turn_id.slice(5)) : turn + 1;
        }
        const content = Array.isArray(message.content) ? message.content.filter((part: unknown) =>
          part && typeof part === 'object' && (part as Record<string, unknown>).type === 'text' && typeof (part as Record<string, unknown>).text === 'string')
          .map((part: { text: string }) => part.text).join('\n') : String(message.content ?? '');
        texts.set(++seq, { kind:"user", text:content, messageIndex, ...identity });
      }
    }
  });
  const hydrated = rows.map((row): TimelineRow => {
    if (row.kind !== "user" && row.kind !== "assistant") return row;
    const full = texts.get(row.seq);
    if (!full || full.kind !== row.kind) return row;
    const revision = typeof source.message_revision === 'string' ? source.message_revision : undefined;
    if (row.kind === "user") return {...row, text:full.text, messageId:full.messageId, ...(revision ? {messageIndex:full.messageIndex, messageRevision:revision} : {})};
    const annotations = source.message_annotations && typeof source.message_annotations === 'object'
      ? (source.message_annotations as Record<string, unknown>)[String(full.messageIndex)] : undefined;
    const feedback = annotations && typeof annotations === 'object' ? (annotations as Record<string, unknown>).feedback : undefined;
    return {...row, text:full.text, messageIndex:full.messageIndex, messageId:full.messageId,
      ...(full.streamId ? {streamId:full.streamId} : {}),
      ...(full.interrupted ? {interrupted:true, streaming:false} : {}),
      ...(full.reasoning ? {reasoning:full.reasoning} : reasoning.has(full.messageIndex) ? { reasoning:reasoning.get(full.messageIndex) } : {}),
      ...(!full.interrupted && revision ? {messageRevision:revision, feedback:feedback === 'like' || feedback === 'dislike' ? feedback : undefined} : {}),
      ...(!full.interrupted && reasoningTiming.has(full.messageIndex) ? {
        startedAt: reasoningTimeMs(reasoningTiming.get(full.messageIndex)?.started_at),
        endedAt: reasoningTimeMs(reasoningTiming.get(full.messageIndex)?.ended_at),
      } : {}),
      ...(full.startedAt !== undefined ? {startedAt:full.startedAt} : {}),
      ...(full.endedAt !== undefined ? {endedAt:full.endedAt} : {})};
  });
  let projected = projectJournalAssistantWork(hydrated, messages, history, sourceTiming);
  if (messageIndices) {
    projected = projected.map(row => {
      if ((row.kind !== 'user' && row.kind !== 'assistant') || row.messageIndex === undefined) return row;
      const currentIndex = messageIndices[row.messageIndex];
      if (Number.isSafeInteger(currentIndex) && (currentIndex as number) >= 0) {
        return {...row, messageIndex: currentIndex as number,
          ...(typeof source.message_revision === 'string' ? {messageRevision: source.message_revision} : {})};
      }
      if (row.kind === 'assistant') {
        const {messageIndex: _index, messageRevision: _revision, feedback: _feedback, ...readonlyRow} = row;
        return readonlyRow;
      }
      const {messageIndex: _index, messageRevision: _revision, ...readonlyRow} = row;
      return readonlyRow;
    });
  }
  const offset = pagedStart * 1_000_000;
  return pagedStart ? projected.map(row => ({...row, seq: row.seq + offset})) : projected;
}

/** Add the journal's original task message, which events.v1 deliberately omits. */
export function withInitialUserMessage(rows: TimelineRow[], journal: unknown, fallbackTask?: string): TimelineRow[] {
  let initialText: string | undefined;
  let initialIndex: number | undefined;
  let initialTurnId = 'turn-1';
  let initialMessageId: string | undefined;
  const source = journal && typeof journal === 'object' && !Array.isArray(journal) ? journal as Record<string, unknown> : undefined;
  const messageWindow = source?.message_window && typeof source.message_window === 'object'
    ? source.message_window as Record<string, unknown> : undefined;
  if (Number.isSafeInteger(messageWindow?.start) && (messageWindow!.start as number) > 0) return rows;
  if (journal && typeof journal === "object" && !Array.isArray(journal)) {
    const messages = (journal as Record<string, unknown>).messages;
    if (Array.isArray(messages)) {
      for (const [index, message] of messages.entries()) {
        if (!message || typeof message !== "object") continue;
        const candidate = message as Record<string, unknown>;
        if (candidate.role !== "user") continue;
        initialIndex = index;
        if (typeof candidate._turn_id === 'string') initialTurnId = candidate._turn_id;
        if (typeof candidate._message_id === 'string') initialMessageId = candidate._message_id;
        if (typeof candidate.content === "string" && candidate.content.trim()) initialText = candidate.content;
        else if (Array.isArray(candidate.content)) {
          const text = candidate.content
            .filter((part: unknown): part is { type: "text"; text: string } => {
              if (!part || typeof part !== "object" || Array.isArray(part)) return false;
              const block = part as Record<string, unknown>;
              return block.type === "text" && typeof block.text === "string";
            })
            .map(part => part.text)
            .join("\n");
          if (text.trim()) initialText = text;
        }
        break;
      }
    }
  }
  if (initialText === undefined && typeof fallbackTask === "string" && fallbackTask.trim()) {
    initialText = fallbackTask;
  }
  if (initialText === undefined) return rows;
  const indices = Array.isArray(messageWindow?.messageIndices) ? messageWindow!.messageIndices as unknown[] : undefined;
  const activeIndex = indices?.[initialIndex ?? 0];
  return [
    { kind: "user", seq: 0, turnId: initialTurnId, text: initialText,
      ...(initialMessageId ? {messageId: initialMessageId} : {}),
      ...(initialIndex !== undefined && typeof source?.message_revision === 'string'
        && (indices === undefined || Number.isSafeInteger(activeIndex) && (activeIndex as number) >= 0)
        ? {messageIndex: indices ? activeIndex as number : initialIndex, messageRevision: source.message_revision} : {}) },
    ...rows.filter(row => row.seq !== 0),
  ];
}

export function toTimelineRows(events: XuenessEventV1[]): TimelineRow[] {
  // Contract §5: rows follow ascending seq; tool.result upgrades the matching
  // tool row in place instead of appending. Sort a copy so the input is never
  // mutated and out-of-order pages still project deterministically.
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const rows: TimelineRow[] = [];
  const rowIndexByToolCallId = new Map<string, number>();

  for (const event of ordered) {
    switch (event.type) {
      case "turn.user":
        rows.push({ kind: "user", seq: event.seq, turnId: event.turnId, text: event.preview });
        break;
      case "assistant.text":
        rows.push({ kind: "assistant", seq: event.seq, turnId: event.turnId, text: event.preview });
        break;
      case "tool.call": {
        rowIndexByToolCallId.set(event.toolCallId, rows.length);
        rows.push({
          kind: "tool",
          seq: event.seq,
          turnId: event.turnId,
          toolCallId: event.toolCallId,
          name: internalToolName(event.name),
          subject: event.subject,
          status: "running",
          error: "",
          errorCode: "",
        });
        break;
      }
      case "tool.result": {
        const index = rowIndexByToolCallId.get(event.toolCallId);
        const existing = index !== undefined ? rows[index] : undefined;
        if (index !== undefined && existing && existing.kind === "tool") {
          // In-place upgrade: same position, same call seq, only the outcome changes.
          rows[index] = {
            ...existing,
            // 取消态在行构造时显式确定，展示层只做 status → ToolDisplayStatus 的显式映射。
            status: event.ok ? "ok" : event.errorCode === "xueness.error.cancelled" ? "cancelled" : "error",
            error: event.error,
            errorCode: event.errorCode,
          };
        } else {
          // Orphan result: no matching call row, emit a terminal row directly.
          rowIndexByToolCallId.set(event.toolCallId, rows.length);
          rows.push({
            kind: "tool",
            seq: event.seq,
            turnId: event.turnId,
            toolCallId: event.toolCallId,
            name: internalToolName(event.name),
            subject: event.subject,
            status: event.ok ? "ok" : event.errorCode === "xueness.error.cancelled" ? "cancelled" : "error",
            error: event.error,
            errorCode: event.errorCode,
          });
        }
        break;
      }
      case "session.completion":
        rows.push({
          kind: "completion",
          seq: event.seq,
          verified: event.verified,
          summary: event.summary,
          ...(event.status ? { status: event.status } : {}),
          ...(event.toolExecutionStatus ? { toolExecutionStatus: event.toolExecutionStatus } : {}),
          ...(event.deliveryStatus ? { deliveryStatus: event.deliveryStatus } : {}),
          ...(event.turnId ? { turnId: event.turnId } : {}),
        });
        break;
      case "session.pending_question":
        rows.push({ kind: "pending_question", seq: event.seq, question: event.question });
        break;
      case "session.status":
        // Describes the session, not timeline content: no row.
        break;
    }
  }

  return rows;
}
