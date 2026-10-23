/**
 * Which journal messages a compaction summarizes and which it keeps verbatim.
 * Ported from ZCode v3.15.1 (aac4755, Apache-2.0) `core/runtime/helpers/compact-selection.ts`.
 * Groups are assistant-started rounds; the prefix is the journal's leading system
 * message. Auto and reactive compaction keep the latest round; manual keeps none.
 */
import { COMPACT_PROMPT_TOO_LONG_RETRY_MARKER, getPromptTooLongTokenGap, MAX_COMPACT_PROMPT_TOO_LONG_RETRIES } from "./errors.ts";
import { contentText, estimateMessageTokens, hasEnoughMessagesToCompact } from "./policy.ts";
import { groupByAssistantStartedRounds } from "./rounds.ts";

type Row = Record<string, unknown>;
export type CompactTrigger = "auto" | "reactive" | "manual";
export interface CompactSelection {
  forSummary: Row[];
  preserved: Row[];
  groupsPreserved: number;
  totalGroups: number;
}

const roleOf = (message: Row): string => String(message.role);
const groupsOf = (messages: readonly Row[]): Row[][] => groupByAssistantStartedRounds(messages, roleOf);
const positiveInt = (value: number | undefined): number | undefined => value === undefined || !Number.isFinite(value) || value < 0 ? undefined : Math.floor(value);

/** Leading journal system messages that stay in place (a prior summary is conversation, not prefix). */
export function countPrefixMessages(messages: readonly Row[]): number {
  let count = 0;
  while (count < messages.length && messages[count]!.role === "system" && messages[count]!._compact_summary !== true && messages[count]!._semantic_summary !== true) count += 1;
  return Math.min(count, 1);
}

function split(messages: readonly Row[], trigger: CompactTrigger): { prefix: Row[]; groups: Row[][]; preserveRecent: boolean } {
  const prefixCount = countPrefixMessages(messages);
  return { prefix: messages.slice(0, prefixCount), groups: groupsOf(messages.slice(prefixCount)), preserveRecent: trigger === "auto" || trigger === "reactive" };
}

export function selectCompactEntries(input: { messages: readonly Row[]; minimumGroupsToPreserve?: number; trigger: CompactTrigger }): CompactSelection {
  const { prefix, groups, preserveRecent } = split(input.messages, input.trigger);
  const base = preserveRecent && groups.length > 1 ? 1 : 0;
  const requested = Math.max(base, positiveInt(input.minimumGroupsToPreserve) ?? 0);
  const keep = preserveRecent ? Math.min(requested, Math.max(0, groups.length - 1)) : 0;
  const summaryGroups = keep > 0 ? groups.slice(0, groups.length - keep) : groups;
  return { forSummary: [...prefix, ...summaryGroups.flat()], preserved: keep > 0 ? groups.slice(-keep).flat() : [], groupsPreserved: keep, totalGroups: groups.length };
}

function countGroupsToCoverGap(estimates: readonly number[], groupCount: number, gap: number): number {
  if (gap <= 0 || groupCount <= 0) return 0;
  let covered = 0, groupsCovered = 0;
  for (let index = groupCount - 1; index >= 0; index -= 1) {
    covered += estimates[index] ?? 0; groupsCovered += 1;
    if (covered >= gap) break;
  }
  if (groupsCovered >= groupCount - 1) return Math.max(1, Math.floor(groupCount / 2));
  return Math.max(1, groupsCovered);
}

/** Auto/reactive: when the summary request itself overflows, keep more recent rounds verbatim. */
export function selectCompactEntriesAfterPromptTooLong(input: { messages: readonly Row[]; promptTooLongCause: unknown; trigger: CompactTrigger; currentGroupsPreserved: number }): CompactSelection | null {
  const { groups, preserveRecent } = split(input.messages, input.trigger);
  if (!preserveRecent || groups.length < 2) return null;
  const maxKeep = groups.length - 1;
  if (input.currentGroupsPreserved >= maxKeep) return null;
  const forSummary = groups.slice(0, groups.length - input.currentGroupsPreserved);
  if (forSummary.length < 2) return null;
  const gap = getPromptTooLongTokenGap(input.promptTooLongCause);
  const move = gap === undefined ? 1 : countGroupsToCoverGap(forSummary.map(estimateMessageTokens), forSummary.length, gap);
  const next = Math.min(maxKeep, input.currentGroupsPreserved + move);
  if (next <= input.currentGroupsPreserved) return null;
  const selection = selectCompactEntries({ messages: input.messages, minimumGroupsToPreserve: next, trigger: input.trigger });
  return hasEnoughMessagesToCompact(selection.forSummary) ? selection : null;
}

/** Reactive: the main request overflowed by a known gap, so start with enough rounds kept back. */
export function selectCompactEntriesForInitialPromptTooLong(input: { messages: readonly Row[]; promptTooLongCause: unknown; trigger: CompactTrigger }): CompactSelection | null {
  const { groups, preserveRecent } = split(input.messages, input.trigger);
  if (!preserveRecent || groups.length <= 3) return null;
  const gap = getPromptTooLongTokenGap(input.promptTooLongCause);
  if (gap === undefined) return null;
  const estimates = groups.map(estimateMessageTokens);
  const remaining = gap - (estimates.at(-1) ?? 0);
  if (remaining <= 0) return null;
  const selection = selectCompactEntries({ messages: input.messages, minimumGroupsToPreserve: 1 + countGroupsToCoverGap(estimates, groups.length - 1, remaining), trigger: input.trigger });
  return hasEnoughMessagesToCompact(selection.forSummary) ? selection : null;
}

const isRetryMarker = (message: Row): boolean => message.role === "user" && contentText(message.content) === COMPACT_PROMPT_TOO_LONG_RETRY_MARKER;

/** Manual: drop the oldest rounds of the summary input (token gap, else 20%), at most 3 times. */
export function truncateForCompactRetry(messages: readonly Row[], cause: unknown, attempt: number): Row[] | null {
  if (attempt >= MAX_COMPACT_PROMPT_TOO_LONG_RETRIES) return null;
  const prefixCount = countPrefixMessages(messages);
  const prefix = messages.slice(0, prefixCount);
  let candidates = messages.slice(prefixCount);
  if (candidates[0] && isRetryMarker(candidates[0])) candidates = candidates.slice(1);
  const groups = groupsOf(candidates);
  if (groups.length < 2) return null;
  const gap = getPromptTooLongTokenGap(cause);
  let drop = 0;
  if (gap !== undefined) {
    let dropped = 0;
    for (const group of groups) { dropped += estimateMessageTokens(group); drop += 1; if (dropped >= gap) break; }
  } else drop = Math.max(1, Math.floor(groups.length * 0.2));
  drop = Math.min(drop, groups.length - 1);
  if (drop < 1) return null;
  const sliced = groups.slice(drop).flat();
  if (!sliced.length) return null;
  return [...prefix, ...sliced[0]!.role === "assistant" ? [{ role: "user", content: COMPACT_PROMPT_TOO_LONG_RETRY_MARKER }] : [], ...sliced];
}
