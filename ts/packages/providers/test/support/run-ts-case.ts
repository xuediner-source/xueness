/** Run one differential case against the TypeScript adapters, mirroring `provider_oracle.py`. */
import { PyValueError } from "@xueness/contracts";
import {
  AnthropicMessages, OpenAICompatible, ProviderCallbackError, ProviderRequestError, exceptionTypeName,
  type ChatProvider, type ProviderClock, type StreamObservers,
} from "../../src/index.ts";
import type { CallbackMode, ProviderCase } from "./http-fixtures.ts";

export interface CaseOutcome {
  id: string;
  result: unknown;
  error: Record<string, unknown> | null;
  calls: unknown[];
  sleeps: number[];
}

class StreamStopped extends Error {
  override name = "StreamStopped";
  readonly xuenessStreamControl = "stop";
}

function describe(error: unknown): Record<string, unknown> {
  if (error instanceof ProviderRequestError) {
    const { trace_id: _trace, ...rest } = error.toJSON();
    return { type: "ProviderRequestError", ...rest };
  }
  if (error instanceof ProviderCallbackError) {
    return { type: "ProviderCallbackError", exception_type: error.exceptionType, stage: error.stage };
  }
  if (error instanceof StreamStopped) return { type: "StreamStopped" };
  return { type: exceptionTypeName(error), message: error instanceof Error ? error.message : String(error) };
}

function observer(kind: string, mode: CallbackMode | undefined, calls: unknown[]): ((value: unknown) => void) | undefined {
  if (mode === "none") return undefined;
  return (value: unknown) => {
    calls.push([kind, value]);
    if (mode === "raise") throw new PyValueError("private callback detail");
    if (mode === "stop") throw new StreamStopped();
  };
}

const camel = (name: string) => name.replace(/_([a-z])/gu, (_match, letter: string) => letter.toUpperCase());

function camelize(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [camel(key), value]));
}

function build(c: ProviderCase, base: string, clock: ProviderClock): ChatProvider {
  const init: Record<string, unknown> = { ...(c.init ?? {}) };
  if (c.method !== "construct") {
    init["base"] ??= base;
    if (!("allow_loopback_http" in init)) init["allow_loopback_http"] = true;
  }
  if (!("model" in init)) init["model"] = "test-model";
  if (!("key" in init)) init["key"] = "test-key";
  const { request_deadline: badDeadline, ...attrs } = c.attrs ?? {};
  const options = { ...camelize(init), env: {}, clock };
  const provider = c.provider === "openai"
    ? new OpenAICompatible(options as never)
    : new AnthropicMessages({ ...options, ...camelize(attrs) } as never);
  if (badDeadline !== undefined) provider.requestDeadline = badDeadline as never;
  if (c.deadline !== undefined) provider.requestDeadline = clock.now() + c.deadline;
  return provider;
}

function summary(provider: ChatProvider): Record<string, unknown> {
  const fields = provider as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = { model: provider.model, capabilities: [...provider.capabilities].sort() };
  // Python's AnthropicMessages gains runtime attributes only from the profile
  // resolver (callers read them with getattr defaults); TypeScript has the defaults.
  const names = provider instanceof AnthropicMessages ? ["maxTokens"]
    : ["runtimeProfile", "contextWindow", "maxOutputTokens", "toolCalling", "compatibility", "lightweightOptions", "reasoningEffort"];
  for (const name of names) out[name.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`)] = fields[name];
  return out;
}

export async function runTsCase(c: ProviderCase, base: string): Promise<CaseOutcome> {
  const sleeps: number[] = [];
  const clock: ProviderClock = { now: () => performance.now() / 1000, sleep: async (seconds) => void sleeps.push(seconds) };
  const calls: unknown[] = [];
  const outcome: CaseOutcome = { id: c.id, result: null, error: null, calls, sleeps };
  try {
    const provider = build(c, base, clock);
    const messages = (c.messages ?? []) as Record<string, unknown>[];
    const tools = (c.tools ?? []) as Record<string, unknown>[];
    if (c.method === "construct") outcome.result = summary(provider);
    else if (c.method === "complete") outcome.result = await provider.complete(messages, tools);
    else {
      const modes = c.callbacks ?? {};
      const observers: StreamObservers = {
        onDelta: observer("delta", modes.delta, calls), onReasoningDelta: observer("reasoning", modes.reasoning, calls),
        onToolDelta: observer("tool", modes.tool, calls),
      };
      outcome.result = await provider.stream(messages, tools, observers);
    }
  } catch (error) {
    outcome.error = describe(error);
  }
  return outcome;
}
