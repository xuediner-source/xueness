/**
 * How much of each lightweight request a local server could reuse from the one before it.
 *
 * A local inference server keeps the evaluated prompt in its KV cache and only
 * evaluates what follows the longest prefix shared with the new prompt. This
 * measures that prefix from the requests themselves: the tool list first (chat
 * templates render it ahead of the conversation), then whole messages in order.
 * A message that changed counts as not shared, so the figure is a lower bound.
 *
 * The session keeps hashes and lengths of the last request, never its text, so
 * the measurement continues across turns and restarts. It is a property of
 * what was sent; it does not claim what a particular server actually cached.
 */
import { createHash } from "node:crypto";
import { isDict, pyJsonDumps } from "@xueness/contracts";

type Row = Record<string, unknown>;
const MAX_TRACE_MESSAGES = 600;
/** A request that keeps less than half of the previous one forces most of the prompt to be evaluated again. */
const BREAK_RATIO = 0.5;

const count = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
/** Fields starting with `_` are host bookkeeping and never reach the server. */
const sent = (message: Row): string => pyJsonDumps(Object.fromEntries(Object.entries(message).filter(([key]) => !key.startsWith("_"))), { separators: [",", ":"] });
const mark = (text: string): [string, number] => [createHash("sha256").update(text).digest("hex").slice(0, 16), text.length];

export interface PrefixMeasurement {
  /** Replaces `session.runtime_prefix_trace`. */
  trace: Row;
  /** Integer fields merged into `session.runtime_budget`. */
  stats: Row;
}

export function measurePrefixReuse(previous: unknown, providerKey: string, messages: Row[], tools: Row[]): PrefixMeasurement {
  const toolMark = mark(tools.length ? pyJsonDumps(tools, { separators: [",", ":"] }) : "");
  const marks = messages.map((message) => mark(sent(message)));
  const requestChars = toolMark[1] + marks.reduce((sum, item) => sum + item[1], 0);
  const prior = isDict(previous) && previous.providerKey === providerKey && Array.isArray(previous.messages) && Array.isArray(previous.tools) ? previous : null;
  const totals = { requests: count(prior?.requests), breaks: count(prior?.breaks), sharedChars: count(prior?.sharedChars), totalChars: count(prior?.totalChars) };
  const stats: Row = { prefixRequestChars: requestChars };
  if (prior) {
    const before = (prior.messages as unknown[]).filter((item): item is [string, number] => Array.isArray(item) && typeof item[0] === "string" && typeof item[1] === "number");
    const previousChars = count((prior.tools as unknown[])[1]) + before.reduce((sum, item) => sum + item[1], 0);
    let sharedChars = 0, sharedMessages = 0;
    // A changed tool list moves everything a chat template renders after it.
    if ((prior.tools as unknown[])[0] === toolMark[0]) {
      sharedChars = toolMark[1];
      while (sharedMessages < before.length && sharedMessages < marks.length && before[sharedMessages]![0] === marks[sharedMessages]![0]) { sharedChars += marks[sharedMessages]![1]; sharedMessages += 1; }
    }
    totals.requests += 1; totals.sharedChars += sharedChars; totals.totalChars += requestChars;
    if (previousChars > 0 && sharedChars < previousChars * BREAK_RATIO) totals.breaks += 1;
    Object.assign(stats, { prefixSharedChars: sharedChars, prefixPreviousChars: previousChars, prefixSharedMessages: sharedMessages });
  }
  Object.assign(stats, { prefixRequests: totals.requests, prefixBreaks: totals.breaks, prefixTotalSharedChars: totals.sharedChars, prefixTotalChars: totals.totalChars });
  return { trace: { providerKey, tools: toolMark, messages: marks.slice(0, MAX_TRACE_MESSAGES), ...totals }, stats };
}
