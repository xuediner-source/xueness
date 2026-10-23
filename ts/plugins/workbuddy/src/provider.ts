/**
 * The composer-facing adapter for one pool model. It is a host adapter: the
 * agent treats `contextWindow` and `maxOutputTokens` as budgeting hints, while
 * the gateway keeps its own larger limits.
 *
 * `OpenAICompatible` refuses a context window above 262144, so the pool's
 * million-token windows stay on this wrapper and the inner client is built
 * without one. The inner client also omits `max_tokens` unless a naming or
 * summarizer handoff capped it, which lets the gateway apply the model's own
 * default instead of a fixed ceiling.
 */
import { OpenAICompatible, type ChatProvider, type ProviderCallOptions, type StreamObservers } from "@xueness/providers";
import type { Gateway } from "./gateway.ts";
import type { WorkbuddyModel } from "./models.ts";

type Dict = Record<string, unknown>;

/** `maxOutputTokens` bound enforced by `resolveRuntimeOptions`. */
export const ADAPTER_OUTPUT_CAP = 32_768;

export class WorkbuddyProvider implements ChatProvider {
  /** Bounded naming and summarizer handoffs reuse host adapters. */
  readonly hostAdapter = true;
  readonly protocol = "openai";
  readonly model: string;
  readonly capabilities: ReadonlySet<string> = new Set<string>();
  readonly runtimeProfile = "standard";
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly toolCalling = "native";
  requestDeadline: number | null = null;
  private readonly gateway: Gateway;
  private readonly definition: WorkbuddyModel;
  private readonly reasoningEffort: string | null;

  constructor(gateway: Gateway, definition: WorkbuddyModel, reasoningEffort: string | null = null) {
    this.gateway = gateway;
    this.definition = definition;
    this.reasoningEffort = reasoningEffort;
    this.model = definition.id;
    this.contextWindow = definition.contextWindow;
    this.maxOutputTokens = definition.maxOutputTokens;
  }

  /** A client bound to the running gateway; the gateway starts on first use. */
  private async client(): Promise<OpenAICompatible> {
    await this.gateway.ensure();
    const capped = this.maxOutputTokens < this.definition.maxOutputTokens ? Math.min(this.maxOutputTokens, ADAPTER_OUTPUT_CAP) : null;
    const client = new OpenAICompatible({
      base: this.gateway.baseUrl, model: this.definition.id, key: this.gateway.key, allowLoopbackHttp: true,
      runtimeProfile: "standard", toolCalling: "native", maxOutputTokens: capped,
      capabilities: [], reasoningEffort: this.reasoningEffort,
    });
    // The run loop's deadline belongs to the outer adapter; the inner client is
    // rebuilt per request and would otherwise lose it.
    client.requestDeadline = this.requestDeadline;
    return client;
  }

  async complete(messages: Dict[], tools: Dict[], options: ProviderCallOptions = {}): Promise<Dict> {
    return (await this.client()).complete(messages, tools, options);
  }

  async stream(messages: Dict[], tools: Dict[], observers: StreamObservers = {}, options: ProviderCallOptions = {}): Promise<Dict> {
    return (await this.client()).stream(messages, tools, observers, options);
  }
}
