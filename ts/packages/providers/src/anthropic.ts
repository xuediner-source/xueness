/**
 * `AnthropicMessages`: the native Messages API adapter with normalized
 * tool-call output. Mirrors Python exactly, including which request-build
 * failures are classified (`ProviderRequestError`) and which propagate raw.
 */
import { pyDictGet, pyGetItem, pyJsonDumps, pyTruthy } from "@xueness/contracts";
import { completeAttempts, postSpec, streamAttempts, type AttemptContext } from "./attempts.ts";
import { ProviderConfigError, isLoopbackLiteral, loopbackHttpEnabled, pyUrlSplit, type SplitUrl } from "./endpoint.ts";
import { ProviderCancelled, ProviderRequestError, ProviderTransportError, isStreamStop, toProviderRequestError } from "./errors.ts";
import { anthropicMessage, anthropicMessages, type MediaBinding } from "./media.ts";
import { withRequestAttempts } from "./metadata.ts";
import type { ChatProvider, ProviderCallOptions } from "./openai.ts";
import { explicitRequestDeadline, lightweightRequestSettings, transportAttempts } from "./openai.ts";
import { loadsBody, readBody } from "./sse.ts";
import { resolveModelStreamIdleTimeoutMs } from "./stream-idle-timeout.ts";
import { readAnthropicStream, type StreamObservers } from "./streams.ts";
import { isAnthropicFirstPartyModelId, toStrictToolSchema } from "./strict-tool-schema.ts";
import { projectAnthropicHistory, withReasoningMetadata } from "./reasoning-metadata.ts";
import { hasRequestMedia } from "./media.ts";
import { normalizeNative } from "./tool-protocol.ts";
import { DeadlineExpired, HttpStatusError, SYSTEM_CLOCK, openChecked, openWithRetry, raiseIfCancelled, type ProviderClock } from "./transport.ts";

type Dict = Record<string, unknown>;

const ALLOWED = ["image", "pdf", "video"];

export interface AnthropicInit {
  base?: string | null;
  model?: string | null;
  key?: string | null;
  allowLoopbackHttp?: boolean | null;
  maxTokens?: number;
  capabilities?: Iterable<string> | null;
  /** Assigned by the profile resolver after construction (not validated here, as in Python). */
  runtimeProfile?: string;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  toolCalling?: string;
  compatibility?: Dict;
  lightweightOptions?: unknown;
  env?: NodeJS.ProcessEnv;
  clock?: ProviderClock;
}

/** Errors Python classifies as `(http.client.HTTPException, ValueError, KeyError, ...)`. */
function isPassThrough(error: unknown): boolean {
  return error instanceof ProviderRequestError || error instanceof ProviderCancelled || isStreamStop(error);
}

export class AnthropicMessages implements ChatProvider {
  readonly protocol = "anthropic";
  readonly base: string;
  readonly model: string;
  readonly key: string;
  readonly maxTokens: number;
  readonly capabilities: ReadonlySet<string>;
  /** Messages API document blocks: the one shipped protocol that accepts PDFs. */
  readonly acceptsPdfDocuments = true;
  readonly runtimeProfile: string;
  readonly contextWindow: number | null;
  readonly maxOutputTokens: number | null;
  readonly toolCalling: string;
  readonly compatibility: Dict;
  readonly lightweightOptions: unknown;
  requestDeadline: number | null = null;
  readonly clock: ProviderClock;
  readonly #url: SplitUrl;

  constructor(init: AnthropicInit = {}) {
    const env = init.env ?? process.env;
    this.clock = init.clock ?? SYSTEM_CLOCK;
    this.base = init.base || (env["ANTHROPIC_BASE_URL"] ?? "https://api.anthropic.com/v1");
    this.model = init.model || env["XUENESS_MODEL"] || "";
    this.key = init.key ?? env["ANTHROPIC_API_KEY"] ?? env["XUENESS_API_KEY"] ?? "";
    this.maxTokens = init.maxTokens ?? 4096;
    const url = pyUrlSplit(this.base);
    if (url.username || url.password || url.query || url.fragment || !url.hostname) {
      throw new ProviderConfigError("Anthropic base URL must be an HTTPS origin/path without credentials or query");
    }
    if (url.scheme === "http") {
      if (!loopbackHttpEnabled(init.allowLoopbackHttp, env) || !isLoopbackLiteral(url.hostname)) {
        throw new ProviderConfigError("Anthropic HTTP requires explicit loopback IP opt-in");
      }
    } else if (url.scheme !== "https") {
      throw new ProviderConfigError("Anthropic base URL must use HTTPS");
    }
    if (!this.model || !this.key) throw new ProviderConfigError("ANTHROPIC_API_KEY and XUENESS_MODEL must be set");
    const configured = init.capabilities === null || init.capabilities === undefined ? null : new Set(init.capabilities);
    this.capabilities = new Set(ALLOWED.filter((item) => configured === null || configured.has(item)));
    this.runtimeProfile = init.runtimeProfile ?? "standard";
    this.contextWindow = init.contextWindow ?? null;
    this.maxOutputTokens = init.maxOutputTokens ?? null;
    this.toolCalling = init.toolCalling ?? "native";
    this.compatibility = init.compatibility ?? {};
    this.lightweightOptions = init.lightweightOptions ?? {};
    this.#url = pyUrlSplit(`${this.base.replace(/\/+$/u, "")}/messages`);
  }

  /** `_request`: the Messages body (built per call; may raise for media). */
  requestBody(messages: Dict[], tools: Dict[], stream: boolean, media: MediaBinding | null, maxTokens: number | null = null, historyNormalized = false): Uint8Array {
    const history = historyNormalized ? messages : projectAnthropicHistory(messages, this, hasRequestMedia);
    const [system, converted] = anthropicMessages(history, this, media);
    const body: Dict = { model: this.model, max_tokens: maxTokens ?? this.maxTokens, messages: converted, stream };
    if (system) body["system"] = system;
    if (pyTruthy(tools)) {
      body["tools"] = tools.map((tool) => {
        const fn = pyGetItem(tool, "function");
        const schema = pyDictGet(fn, "parameters", { type: "object", properties: {} });
        const strict = pyDictGet(fn, "strict") === true && isAnthropicFirstPartyModelId(this.model) ? toStrictToolSchema(schema as Dict) : undefined;
        return {
          name: pyGetItem(fn, "name"), description: pyDictGet(fn, "description", ""),
          input_schema: strict ?? schema, ...strict ? { strict: true } : {},
        };
      });
    }
    return Buffer.from(pyJsonDumps(body, { ensureAscii: true }), "utf8");
  }

  #spec(body: Uint8Array, timeout: number, deadline: number | null, signal: AbortSignal | null | undefined) {
    const headers = { "x-api-key": this.key, "anthropic-version": "2023-06-01", "Content-Type": "application/json" };
    return postSpec({
      url: this.#url, headers, body, timeout, deadline, clock: this.clock, signal,
      ...(isLoopbackLiteral(this.#url.hostname) ? { proxy: null } : {}),
    });
  }

  async complete(messages: Dict[], tools: Dict[], options: ProviderCallOptions = {}): Promise<Dict> {
    const { signal } = options;
    const media = options.media ?? null;
    if (this.runtimeProfile === "lightweight") {
      try {
        const body = this.requestBody(messages, tools, false, media, null, options.reasoningHistoryNormalized);
        const [deadline, attempts] = lightweightRequestSettings(this, this.clock);
        return await this.#completeLightweight(body, deadline, attempts, signal);
      } catch (error) {
        throw this.#classifyComplete(error, signal);
      }
    }
    const deadline = explicitRequestDeadline(this);
    if (deadline !== null) return this.#completeLightweight(this.requestBody(messages, tools, false, media, null, options.reasoningHistoryNormalized), deadline, 1, signal);
    try {
      const response = await openChecked(this.#spec(this.requestBody(messages, tools, false, media, null, options.reasoningHistoryNormalized), 40, null, signal));
      let raw: Buffer;
      try {
        raw = await readBody(response);
      } finally {
        response.close();
      }
      return this.#result(withRequestAttempts(anthropicMessage(loadsBody(raw)), 1));
    } catch (error) {
      throw this.#classifyComplete(error, signal);
    }
  }

  /** The `except` ladder shared by the single-shot and lightweight `complete()` paths. */
  #classifyComplete(error: unknown, signal: AbortSignal | null | undefined): unknown {
    if (isPassThrough(error)) return error;
    if (error instanceof DeadlineExpired) return new ProviderRequestError({ category: "timeout", stage: "deadline", exceptionType: "TimeoutError" });
    if (error instanceof HttpStatusError) {
      return toProviderRequestError(error, {
        status: error.status, retryAfter: error.delay, contextOverflow: error.contextOverflow, stage: "response",
        category: error.quotaExhausted ? "quota_exhausted" : null, quotaResetAt: error.quotaResetAt,
        providerCode: error.providerCode, retryAfterMs: error.retryAfterMs,
      });
    }
    raiseIfCancelled(signal);
    return toProviderRequestError(error, { stage: error instanceof ProviderTransportError ? "read" : "parse" });
  }

  #completeLightweight(body: Uint8Array, deadline: number, attempts: number, signal: AbortSignal | null | undefined): Promise<Dict> {
    return completeAttempts({
      attempts, deadline, clock: this.clock, signal,
      run: async ({ attempt, remaining }) => {
        const response = await openWithRetry(this.#spec(body, remaining as number, deadline, signal));
        let raw: Buffer;
        try {
          raw = await readBody(response);
        } finally {
          response.close();
        }
        return this.#result(withRequestAttempts(anthropicMessage(loadsBody(raw)), attempt + 1));
      },
    });
  }

  async stream(messages: Dict[], tools: Dict[], observers: StreamObservers = {}, options: ProviderCallOptions = {}): Promise<Dict> {
    const media = options.media ?? null;
    let deadline: number | null = null;
    let attempts = transportAttempts(options);
    let body: Uint8Array | null = null;
    if (this.runtimeProfile === "lightweight") {
      body = this.requestBody(messages, tools, true, media, null, options.reasoningHistoryNormalized);
      [deadline, attempts] = lightweightRequestSettings(this, this.clock);
    } else {
      deadline = explicitRequestDeadline(this);
      if (deadline !== null) body = this.requestBody(messages, tools, true, media, null, options.reasoningHistoryNormalized);
    }
    return streamAttempts({
      attempts, deadline, clock: this.clock, signal: options.signal,
      // The standard path rebuilds the body inside each attempt, so a media
      // failure there is classified as a parse error, exactly like Python.
      run: (context) => this.#streamAttempt(
        body ?? this.requestBody(messages, tools, true, media, null, options.reasoningHistoryNormalized), deadline, context, observers,
        options.signal, options.streamIdleTimeoutMs,
      ),
    });
  }

  async #streamAttempt(body: Uint8Array, deadline: number | null, context: AttemptContext, observers: StreamObservers,
    signal: AbortSignal | null | undefined, streamIdleTimeoutMs?: number): Promise<Dict> {
    const response = await openWithRetry(this.#spec(body, context.remaining ?? 40, deadline, signal), context.delivered);
    try {
      const effectiveStreamTimeoutMs = resolveModelStreamIdleTimeoutMs({
        baseTimeoutMs: streamIdleTimeoutMs, retryNumber: context.attempt,
      });
      if (effectiveStreamTimeoutMs > 0) response.setIdleTimeout(Math.max(40_000, effectiveStreamTimeoutMs));
      const metadata: Dict = {};
      const { text, calls, usage } = await readAnthropicStream(response, {
        ...observers, markDelivered: context.markDelivered, finishMetadata: metadata,
        idleTimeoutMs: effectiveStreamTimeoutMs, signal,
      });
      const result: Dict = { content: text, tool_calls: calls, ...metadata };
      if (usage && Object.keys(usage).length) result["_usage"] = usage;
      return this.#result(withRequestAttempts(result, context.attempt + 1));
    } finally {
      response.close();
    }
  }
  #result(response: Dict): Dict { return withReasoningMetadata(normalizeNative(response) as Dict, this); }
}
