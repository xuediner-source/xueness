/**
 * `OpenAICompatible`: chat-completions adapter with Python's validation,
 * payload, retry, deadline and parse semantics (`provider.py`).
 * Profile tests, compatibility tests and model discovery stay on the Python
 * side until the providers routes move.
 */
import { pyCasefold, pyGetItem, pyJsonDumps } from "@xueness/contracts";
import { completeAttempts, postSpec, streamAttempts, type AttemptContext } from "./attempts.ts";
import { ProviderConfigError, isLoopbackLiteral, loopbackHttpEnabled, pyUrlSplit, type SplitUrl } from "./endpoint.ts";
import { openAiMessages, providerCapabilities, type MediaBinding } from "./media.ts";
import { withReportedUsage, withRequestAttempts } from "./metadata.ts";
import { buildOpenAiPayload, effectiveOptions, knownReasoningLevels, resolveRuntimeOptions } from "./options.ts";
import { MAX_PROVIDER_RESPONSE_BYTES, loadsBody, readBody } from "./sse.ts";
import { resolveModelStreamIdleTimeoutMs } from "./stream-idle-timeout.ts";
import { readOpenAiStream, type StreamObservers } from "./streams.ts";
import { normalizeNative } from "./tool-protocol.ts";
import { normalizeOpenAiCompatibleSystemMessages } from "./system-message-compat.ts";
import type { ModelRequestAdmission } from "./request-admission.ts";
import { DeadlineExpired, SYSTEM_CLOCK, openWithRetry, type ProviderClock } from "./transport.ts";

type Dict = Record<string, unknown>;

export const REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

export interface ProviderCallOptions {
  /** Cooperative cancellation: settles as `ProviderCancelled` (a user stop). */
  signal?: AbortSignal | null;
  /** Invocation-scoped media authority for `_media_refs` messages. */
  media?: MediaBinding | null;
  /** Standard-profile HTTP attempts (default 3); the agent's ZCode model retry sets 1 and owns retries. */
  transportAttempts?: number;
  /** Idle time allowed between complete stream data payloads. */
  streamIdleTimeoutMs?: number;
  /** A providers extension has already projected reasoning history once for this logical request. */
  reasoningHistoryNormalized?: boolean;
  /** Runtime-only per-attempt admission port, installed by the providers plugin. */
  modelRequestAdmission?: ModelRequestAdmission;
}

/** A caller's standard-profile attempt count, bounded to 1..3. */
export function transportAttempts(options: ProviderCallOptions): number {
  const value = options.transportAttempts;
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 3 ? value : 3;
}

/** Shared adapter surface used by the agent loop. */
export interface ChatProvider {
  readonly model: string;
  readonly capabilities: ReadonlySet<string>;
  readonly runtimeProfile: string;
  readonly contextWindow: number | null;
  readonly maxOutputTokens: number | null;
  readonly toolCalling: string;
  /** Absolute run-loop deadline (monotonic seconds on the adapter clock). */
  requestDeadline: number | null;
  complete(messages: Dict[], tools: Dict[], options?: ProviderCallOptions): Promise<Dict>;
  stream(messages: Dict[], tools: Dict[], observers?: StreamObservers, options?: ProviderCallOptions): Promise<Dict>;
}

/** `_explicit_request_deadline`. */
export function explicitRequestDeadline(provider: { requestDeadline: unknown }): number | null {
  const deadline = provider.requestDeadline;
  if (deadline === null || deadline === undefined) return null;
  if (typeof deadline !== "number" || !Number.isFinite(deadline)) throw new ProviderConfigError("invalid provider request deadline");
  return deadline;
}

export interface LightweightFields {
  lightweightOptions: unknown;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  requestDeadline: unknown;
}

/** `_lightweight_request_settings`: one inference's total deadline and attempt count. */
export function lightweightRequestSettings(provider: LightweightFields, clock: ProviderClock): [number, number] {
  const options = effectiveOptions({ value: provider.lightweightOptions, context: provider.contextWindow, output: provider.maxOutputTokens });
  const now = clock.now();
  let deadline = now + (options["requestTimeoutSeconds"] as number);
  const runDeadline = explicitRequestDeadline(provider);
  if (runDeadline !== null) deadline = Math.min(deadline, runDeadline);
  if (deadline <= now) throw new DeadlineExpired();
  return [deadline, 1 + (options["transportRetries"] as number)];
}

export interface OpenAiInit {
  base?: string | null;
  model?: string | null;
  key?: string | null;
  allowLoopbackHttp?: boolean | null;
  capabilities?: Iterable<string> | null;
  reasoningEffort?: string | null;
  runtimeProfile?: unknown;
  contextWindow?: unknown;
  maxOutputTokens?: unknown;
  toolCalling?: unknown;
  compatibility?: unknown;
  allowEmptyKey?: boolean | null;
  lightweightOptions?: unknown;
  env?: NodeJS.ProcessEnv;
  clock?: ProviderClock;
}

export class OpenAICompatible implements ChatProvider {
  readonly protocol = "openai";
  readonly base: string;
  readonly model: string;
  readonly key: string;
  readonly runtimeProfile: string;
  readonly contextWindow: number | null;
  readonly maxOutputTokens: number | null;
  readonly toolCalling: string;
  readonly compatibility: Dict;
  readonly lightweightOptions: Dict;
  readonly reasoningEffort: string | null;
  readonly capabilities: ReadonlySet<string>;
  /**
   * Chat Completions carries a PDF as a base64 `file` part. A gateway that
   * rejects it answers 400, which the attempt loop reports as a request error;
   * the declaration is what makes Read attach the document in the first place.
   */
  readonly acceptsPdfDocuments = true;
  requestDeadline: number | null = null;
  readonly clock: ProviderClock;
  readonly #url: SplitUrl;

  constructor(init: OpenAiInit = {}) {
    const env = init.env ?? process.env;
    this.clock = init.clock ?? SYSTEM_CLOCK;
    this.base = init.base || env["XUENESS_API_BASE"] || "";
    this.model = init.model || env["XUENESS_MODEL"] || "";
    this.key = init.key ?? env["XUENESS_API_KEY"] ?? "";
    const record: Dict = {
      runtimeProfile: init.runtimeProfile ?? "standard", toolCalling: init.toolCalling ?? "native",
      compatibility: init.compatibility ?? {}, lightweightOptions: init.lightweightOptions ?? {},
    };
    if (init.contextWindow !== undefined && init.contextWindow !== null) record["contextWindow"] = init.contextWindow;
    if (init.maxOutputTokens !== undefined && init.maxOutputTokens !== null) record["maxOutputTokens"] = init.maxOutputTokens;
    const options = resolveRuntimeOptions(record);
    this.runtimeProfile = options.runtime_profile;
    this.contextWindow = options.context_window;
    this.maxOutputTokens = options.max_output_tokens;
    this.toolCalling = options.tool_calling;
    this.compatibility = options.compatibility;
    this.lightweightOptions = options.lightweight_options;
    let allowLoopback = init.allowLoopbackHttp ?? null;
    let allowEmptyKey = init.allowEmptyKey ?? null;
    // Choosing the local runtime profile is an explicit opt-in for a loopback endpoint.
    if (this.runtimeProfile === "lightweight") {
      allowLoopback ??= true;
      allowEmptyKey ??= true;
    }
    const url = pyUrlSplit(this.base);
    const shape = "XUENESS_API_BASE must be an HTTPS origin/path without credentials or query";
    if (url.username || url.password || url.query || url.fragment || !url.hostname) throw new ProviderConfigError(shape);
    if (url.scheme === "http") {
      if (!loopbackHttpEnabled(allowLoopback, env)) throw new ProviderConfigError("XUENESS_API_BASE HTTP requires explicit loopback opt-in (see README)");
      if (!isLoopbackLiteral(url.hostname)) throw new ProviderConfigError("XUENESS_API_BASE HTTP allows only loopback IP literals (e.g. 127.0.0.1, ::1)");
    } else if (url.scheme !== "https") {
      throw new ProviderConfigError(shape);
    }
    if (!this.model) throw new ProviderConfigError("XUENESS_MODEL and XUENESS_API_KEY must be set");
    if (!this.key) {
      const optedIn = allowEmptyKey ?? loopbackHttpEnabled(allowLoopback, env);
      if (!optedIn || !isLoopbackLiteral(url.hostname)) {
        throw new ProviderConfigError("an empty API key is allowed only for an opted-in loopback IP endpoint");
      }
    }
    const effort = init.reasoningEffort ?? null;
    if (effort !== null && !REASONING_EFFORTS.has(effort)) throw new ProviderConfigError("unsupported reasoning effort");
    this.reasoningEffort = effort;
    this.capabilities = providerCapabilities(this.model, init.capabilities);
    this.#url = pyUrlSplit(`${this.base.replace(/\/+$/u, "")}/chat/completions`);
  }

  /** Current OpenAI reasoning families use `max_completion_tokens`. */
  defaultMaxTokensField(): string {
    return knownReasoningLevels(this.model).length ? "max_completion_tokens" : "max_tokens";
  }

  #body(messages: Dict[], tools: Dict[], stream: boolean, media: MediaBinding | null): Uint8Array {
    const body = buildOpenAiPayload({
      model: this.model, messages: normalizeOpenAiCompatibleSystemMessages(openAiMessages(messages, this, media)), tools, runtimeProfile: this.runtimeProfile,
      contextWindow: this.contextWindow, maxOutputTokens: this.maxOutputTokens, toolCalling: this.toolCalling,
      compatibility: this.compatibility, stream, reasoningEffort: this.reasoningEffort,
      defaultMaxTokensField: this.defaultMaxTokensField(), lightweightOptions: this.lightweightOptions,
    });
    return Buffer.from(pyJsonDumps(body, { ensureAscii: true }), "utf8");
  }

  #spec(body: Uint8Array, timeout: number, deadline: number | null, signal: AbortSignal | null | undefined) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.key) headers["Authorization"] = `Bearer ${this.key}`;
    return postSpec({
      url: this.#url, headers, body, timeout, deadline, clock: this.clock, signal,
      ...(isLoopbackLiteral(this.#url.hostname) ? { proxy: null } : {}),
    });
  }

  async complete(messages: Dict[], tools: Dict[], options: ProviderCallOptions = {}): Promise<Dict> {
    const body = this.#body(messages, tools, false, options.media ?? null);
    if (this.runtimeProfile === "lightweight") {
      const [deadline, attempts] = lightweightRequestSettings(this, this.clock);
      return this.requestJson(body, { attempts, absoluteDeadline: deadline, signal: options.signal });
    }
    const deadline = explicitRequestDeadline(this);
    return this.requestJson(body, { attempts: transportAttempts(options), absoluteDeadline: deadline, signal: options.signal });
  }

  /** `_request_json`: bounded attempts for a non-streamed completion. */
  async requestJson(body: Uint8Array, input: {
    timeout?: number; attempts?: number; totalTimeout?: number | null; absoluteDeadline?: number | null;
    maxResponseBytes?: number; signal?: AbortSignal | null;
  }): Promise<Dict> {
    const timeout = input.timeout ?? 40;
    const absolute = input.absoluteDeadline ?? null;
    let deadline = input.totalTimeout !== undefined && input.totalTimeout !== null ? this.clock.now() + input.totalTimeout : absolute;
    if (absolute !== null) deadline = deadline !== null ? Math.min(deadline, absolute) : absolute;
    const maxBytes = input.maxResponseBytes ?? MAX_PROVIDER_RESPONSE_BYTES;
    return completeAttempts({
      attempts: input.attempts ?? 3, deadline, clock: this.clock, signal: input.signal,
      run: async ({ attempt, remaining }) => {
        const openTimeout = remaining === null ? timeout : Math.min(timeout, remaining);
        const response = await openWithRetry(this.#spec(body, openTimeout, deadline, input.signal));
        let raw: Buffer;
        try {
          raw = await readBody(response, maxBytes);
        } finally {
          response.close();
        }
        const parsed = loadsBody(raw);
        return normalizeNative(withRequestAttempts(withReportedUsage(pyGetItem(pyGetItem(pyGetItem(parsed, "choices"), 0), "message"), parsed), attempt + 1)) as Dict;
      },
    });
  }

  async stream(messages: Dict[], tools: Dict[], observers: StreamObservers = {}, options: ProviderCallOptions = {}): Promise<Dict> {
    const body = this.#body(messages, tools, true, options.media ?? null);
    let deadline: number | null;
    let attempts = transportAttempts(options);
    if (this.runtimeProfile === "lightweight") [deadline, attempts] = lightweightRequestSettings(this, this.clock);
    else deadline = explicitRequestDeadline(this);
    return streamAttempts({
      attempts, deadline, clock: this.clock, signal: options.signal,
      run: (context) => this.#streamAttempt(body, deadline, context, observers, options.signal, options.streamIdleTimeoutMs),
    });
  }

  async #streamAttempt(body: Uint8Array, deadline: number | null, context: AttemptContext, observers: StreamObservers,
    signal: AbortSignal | null | undefined, streamIdleTimeoutMs?: number): Promise<Dict> {
    const timeout = context.remaining ?? 40;
    const response = await openWithRetry(this.#spec(body, timeout, deadline, signal), context.delivered);
    try {
      const effectiveStreamTimeoutMs = resolveModelStreamIdleTimeoutMs({
        baseTimeoutMs: streamIdleTimeoutMs, retryNumber: context.attempt,
      });
      if (effectiveStreamTimeoutMs > 0) response.setIdleTimeout(Math.max(40_000, effectiveStreamTimeoutMs));
      const contentType = response.header("content-type") ?? "";
      if (!pyCasefold(contentType).includes("text/event-stream")) {
        const payload = loadsBody(await readBody(response));
        return normalizeNative(withRequestAttempts(withReportedUsage(pyGetItem(pyGetItem(pyGetItem(payload, "choices"), 0), "message"), payload), context.attempt + 1)) as Dict;
      }
      const metadata: Dict = {};
      const { text, calls, usage } = await readOpenAiStream(response, {
        ...observers, markDelivered: context.markDelivered, finishMetadata: metadata,
        idleTimeoutMs: effectiveStreamTimeoutMs, signal,
      });
      const result: Dict = { content: text, tool_calls: calls, ...metadata };
      if (usage && Object.keys(usage).length) result["_usage"] = usage;
      return normalizeNative(withRequestAttempts(result, context.attempt + 1)) as Dict;
    } finally {
      response.close();
    }
  }
}
