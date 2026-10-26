/**
 * One ZCode compaction of a session journal: summary request, retries, journal rewrite.
 * Flow ported from ZCode v3.15.1 (aac4755, Apache-2.0) `core/runtime/methods/compact-active.ts`
 * and `compact-active-helpers.ts`. The summary request is the normal request view of the
 * summarized slice (same system prompt and tools) plus the ZCode compact prompt.
 * The journal becomes `[system, summary, ...kept rounds]`; the summary row is a system row
 * marked `_compact_summary` that the request view turns into ZCode's user summary message.
 */
import { isDict, pyDeepCopy, pySlice, uuid4Hex } from "@xueness/contracts";
import {
  buildCompactPrompt, buildCompactSummaryMessage, buildPostCompactReminders, capCompactSummaryMaxOutputTokens, COMPACT_EMPTY_SUMMARY_MESSAGE,
  COMPACT_PROMPT_TOO_LONG_USER_MESSAGE, COMPACT_TOOL_USE_DENIAL_MESSAGE, COMPACT_UP_TO_DATE_MESSAGE, CompactionError, countPrefixMessages,
  estimateMessageTokens, formatCompactSummary, getMessagesToSummarize, getUsageTotalTokens, hasEnoughMessagesToCompact, isModelContextExceededError,
  selectCompactEntries, selectCompactEntriesAfterPromptTooLong, selectCompactEntriesForInitialPromptTooLong, truncateForCompactRetry,
  type AgentProvider, type CompactSelection, type CompactTrigger, type RebuildRequest, type Row,
} from "@xueness/agent";
import { finishReason, incompleteReason, isStreamStop, ProviderCancelled, reportedUsage, type ModelRequestAdmission } from "@xueness/providers";
import { semanticIdentity, sumHandoffUsage } from "./semantic-core.ts";
import { runWithModelAdmission } from "./aux-admission.ts";
import { cloneHandoffProvider } from "./semantic-model.ts";
import { beginCompactTimeline, finishCompactTimeline } from '@xueness/sessions';

const AUTO_COMPACT_MAX_ATTEMPTS = 3;
const COMPACT_TOOL_KEEP_MAX_COUNT = 100;

export interface CompactConversationOptions {
  provider: AgentProvider;
  rebuild: RebuildRequest;
  root: string;
  trigger: CompactTrigger;
  phase?: "preflight" | "reactive" | "manual";
  reason?: string;
  customInstructions?: string;
  /** Reactive: the main request's overflow error (its token gap sizes the kept tail). */
  overflowCause?: unknown;
  preCompactTokens?: number;
  autoCompactThreshold?: number;
  signal?: AbortSignal;
  shouldStop?: () => boolean;
  save?: (session: Row) => Promise<unknown>;
  emit?: (event: Row) => void;
  stamp?: () => string;
  uuid?: () => string;
  /** Shared governor slot for the summary request; hosts bind the aux foreground scope. */
  admission?: ModelRequestAdmission;
}
export interface CompactConversationResult {
  compacted: boolean;
  reason?: "nothing_to_compact";
  displayText: string;
  record?: Row;
  before: { estimatedTokens: number; messages: number };
  after?: { estimatedTokens: number; messages: number };
  summarizedMessageCount?: number;
}

const cancelled = (error: unknown, options: CompactConversationOptions): boolean => isStreamStop(error) || error instanceof ProviderCancelled || !!options.signal?.aborted || !!options.shouldStop?.();
const isSummaryRow = (message: Row): boolean => message._compact_summary === true || message._semantic_summary === true;

/** Old journal index → new index for `[prefix, summary, ...journal.slice(cut)]`. */
function retainedIndex(index: number, prefixCount: number, cut: number): number | null {
  if (index < prefixCount) return index;
  return index >= cut ? index - cut + prefixCount + 1 : null;
}
function remap(staged: Row, total: number, prefixCount: number, cut: number): void {
  if (isDict(staged.message_annotations)) {
    const kept: Row = {};
    for (const [key, value] of Object.entries(staged.message_annotations)) {
      if (!/^\p{Decimal_Number}+$/u.test(key)) continue;
      const old = Number(key); const next = old < total ? retainedIndex(old, prefixCount, cut) : null;
      if (next !== null) Object.defineProperty(kept, String(next), { value, writable: true, enumerable: true, configurable: true });
    }
    staged.message_annotations = kept;
  }
  if (Array.isArray(staged.reasoning_history)) staged.reasoning_history = staged.reasoning_history.filter(isDict).flatMap((row) => {
    const old = row.message_index;
    const next = typeof old === "number" && Number.isInteger(old) && old >= 0 && old < total ? retainedIndex(old, prefixCount, cut) : null;
    return next === null ? [] : [{ ...row, message_index: next }];
  });
}

async function requestSummary(options: CompactConversationOptions, forSummary: Row[], usages: Row[]): Promise<string> {
  const request = await options.rebuild(forSummary);
  const messages = [...request.messages, { role: "user", content: buildCompactPrompt(options.customInstructions) }];
  const tools = request.tools.length > COMPACT_TOOL_KEEP_MAX_COUNT ? [] : request.tools;
  const client = cloneHandoffProvider(options.provider, capCompactSummaryMaxOutputTokens(options.provider.maxOutputTokens));
  // Streamed when the adapter streams (as ZCode does), so a long summary is not cut by idle timeouts.
  const response = await runWithModelAdmission(options.admission, options.provider, options.signal, async () => client.stream ? await client.stream(messages, tools, {}, { signal: options.signal ?? null }) : await client.complete(messages, tools, { signal: options.signal ?? null }));
  usages.push(reportedUsage(response._usage));
  // A summary that stops on the context limit is the same failure as a thrown overflow.
  if (incompleteReason(finishReason(response._finish_reason), response._usage, options.provider) === "context_limit") throw Object.assign(new Error("compact summary hit the context limit"), { code: "context_exceeded" });
  if (Array.isArray(response.tool_calls) && response.tool_calls.length) throw new CompactionError("compact_tool_use", COMPACT_TOOL_USE_DENIAL_MESSAGE, false);
  const summary = formatCompactSummary(typeof response.content === "string" ? response.content : "");
  if (!summary) throw new CompactionError("compact_empty_summary", COMPACT_EMPTY_SUMMARY_MESSAGE, true);
  return summary;
}

export async function compactConversation(session: Row, options: CompactConversationOptions): Promise<CompactConversationResult> {
  const stamp = options.stamp ?? (() => new Date().toISOString().replace(/Z$/, "+00:00"));
  const emit = (event: Row): void => { options.emit?.({ ...event, session_id: session.id ?? null }); };
  const journal = (Array.isArray(session.messages) ? session.messages : []) as Row[];
  const prefixCount = countPrefixMessages(journal);
  const preCompactTokens = options.preCompactTokens ?? estimateMessageTokens(journal);
  const before = { estimatedTokens: preCompactTokens, messages: journal.length };
  const { trigger } = options;
  const initial = (trigger === "reactive" && options.overflowCause !== undefined ? selectCompactEntriesForInitialPromptTooLong({ messages: journal, promptTooLongCause: options.overflowCause, trigger }) : null)
    ?? selectCompactEntries({ messages: journal, trigger });
  if (!hasEnoughMessagesToCompact(initial.forSummary)) return { compacted: false, reason: "nothing_to_compact", displayText: COMPACT_UP_TO_DATE_MESSAGE, before };
  const maxAttempts = trigger === "auto" ? AUTO_COMPACT_MAX_ATTEMPTS : 1;
  const operation = { trigger, phase: options.phase ?? (trigger === "manual" ? "manual" : trigger === "reactive" ? "reactive" : "preflight"), ...options.reason ? { reason: options.reason } : {} };
  const timeline = beginCompactTimeline(session, operation, (options.uuid ?? uuid4Hex)());
  await options.save?.(session);
  emit({ type: "context/compaction_started", ...operation, preCompactTokens, ...maxAttempts > 1 ? { attempt: 1, maxAttempts } : {} });
  const lastRow = journal.at(-1); const length = journal.length;
  const usages: Row[] = [];
  for (let attempt = 1; ; attempt += 1) {
    let selection: CompactSelection = initial;
    let forSummary = initial.forSummary;
    try {
      let summary = "";
      for (let tooLong = 0; ; ) {
        try { summary = await requestSummary(options, forSummary, usages); break; }
        catch (error) {
          if (cancelled(error, options) || !isModelContextExceededError(error)) throw error;
          const reselected = selectCompactEntriesAfterPromptTooLong({ messages: journal, promptTooLongCause: error, trigger, currentGroupsPreserved: selection.groupsPreserved });
          if (reselected) { tooLong += 1; selection = reselected; forSummary = reselected.forSummary; continue; }
          const truncated = trigger === "manual" ? truncateForCompactRetry(forSummary, error, tooLong) : null;
          if (truncated) { tooLong += 1; forSummary = truncated; continue; }
          throw new CompactionError("compact_prompt_too_long", COMPACT_PROMPT_TOO_LONG_USER_MESSAGE, false, { cause: error });
        }
      }
      if (journal !== session.messages || journal.length !== length || journal.at(-1) !== lastRow) throw new CompactionError("compact_history_changed", "history changed while summarizing", false);
      const preserved = selection.preserved;
      const cut = journal.length - preserved.length;
      if (preserved.some((row, index) => journal[cut + index] !== row)) throw new CompactionError("compact_history_changed", "kept rounds are not the journal tail", false);
      const summarized = journal.slice(prefixCount, cut);
      const checkpointId = (options.uuid ?? uuid4Hex)();
      const reminders = buildPostCompactReminders(session, options.root, summarized, preserved);
      const summaryRow: Row = { role: "system", _compact_summary: true, _message_id: "compact-" + checkpointId, _turn_id: summarized.at(-1)?._turn_id ?? null,
        content: buildCompactSummaryMessage(summary, { suppressFollowup: true }), ...reminders.length ? { _post_compact_reminders: reminders } : {} };
      const newMessages = [...journal.slice(0, prefixCount), summaryRow, ...preserved];
      const truePostCompactTokens = estimateMessageTokens((await options.rebuild(newMessages)).messages);
      const postCompactTokens = getUsageTotalTokens(usages.at(-1));
      const archived = summarized.filter((row) => !isSummaryRow(row)).map((row) => {
        const copy = pyDeepCopy(row) as Row;
        if (!Object.hasOwn(copy, "_message_id")) copy._message_id = semanticIdentity(row, journal.indexOf(row), session.id ?? "");
        return copy;
      });
      const at = stamp();
      const record: Row = { kind: "zcode", ...operation, operationId: timeline.id, checkpointId, removed: cut - prefixCount, kept: preserved.length, summarizedMessageCount: getMessagesToSummarize(forSummary.slice(prefixCount)).length,
        preCompactTokens, postCompactTokens, truePostCompactTokens, ...options.customInstructions?.trim() ? { customInstructions: pySlice(options.customInstructions.trim(), 2000) } : {},
        ...options.autoCompactThreshold !== undefined ? { willRetriggerNextTurn: truePostCompactTokens >= options.autoCompactThreshold } : {}, at };
      // Flat scalar record (the webapp drops records with nested values); usage lives on the checkpoint.
      const usageTotals = sumHandoffUsage(usages);
      const staged = pyDeepCopy(session) as Row;
      remap(staged, journal.length, prefixCount, cut);
      if (!Array.isArray(staged.context_checkpoints)) staged.context_checkpoints = [];
      (staged.context_checkpoints as Row[]).push({ id: checkpointId, operationId: timeline.id, kind: "zcode", at, trigger, sourceMessageIds: archived.map((row) => row._message_id),
        sourceTurnIds: [...new Set(archived.map((row) => row._turn_id).filter(Boolean))], messages: archived, summary, reportedUsage: usageTotals });
      if (!Array.isArray(staged.archived_messages)) staged.archived_messages = [];
      (staged.archived_messages as Row[]).push(...pyDeepCopy(archived) as Row[]);
      staged.messages = pyDeepCopy(newMessages);
      if (!Array.isArray(staged.compactions)) staged.compactions = [];
      (staged.compactions as Row[]).push(record);
      // C-TOOL-05: the discovery reminder rides the summary row's staged batch; a failed
      // compaction discards the ledger together with the summary, so the set re-announces then.
      if (reminders.some((reminder) => isDict(reminder) && reminder.source === "tool_discovery") && Array.isArray(session.discovered_tools)) {
        staged.announced_compact_discovered_tools = (session.discovered_tools as unknown[]).filter((name): name is string => typeof name === "string").sort();
      }
      finishCompactTimeline(staged, timeline.id, { status: 'completed', checkpointId, summaryMessageId: summaryRow._message_id, finishedAt: at });
      delete staged.context_usage;
      if (options.save) await options.save(staged);
      for (const key of Object.keys(session)) delete session[key];
      Object.assign(session, staged);
      emit({ type: "context/compaction_completed", ...operation, operationId: timeline.id, checkpointId, removed: record.removed, kept: record.kept, preCompactTokens, postCompactTokens, truePostCompactTokens });
      return { compacted: true, displayText: "Compacted", record, before, after: { estimatedTokens: truePostCompactTokens, messages: newMessages.length }, summarizedMessageCount: record.summarizedMessageCount as number };
    } catch (error) {
      const retryable = !(error instanceof CompactionError) || error.retryable;
      if (trigger === "auto" && attempt < maxAttempts && !cancelled(error, options) && retryable) {
        finishCompactTimeline(session, timeline.id, { status: 'retrying', attempt: attempt + 1 });
        await options.save?.(session);
        emit({ type: "context/compaction_started", ...operation, status: "retrying", attempt: attempt + 1, maxAttempts, reason: pySlice(error instanceof Error ? error.message : String(error), 300) });
        continue;
      }
      finishCompactTimeline(session, timeline.id, { status: cancelled(error, options) ? 'interrupted' : 'failed', finishedAt: stamp() });
      await options.save?.(session);
      emit({ type: "context/compaction_failed", ...operation, cancelled: cancelled(error, options), message: pySlice(error instanceof Error ? error.message : String(error), 300) });
      throw error;
    }
  }
}
