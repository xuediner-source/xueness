/** Resolve subscription models through the same host-owned conversation seam (Python `subscriptions/provider.py`). */
import { isDict, PyValueError } from "@xueness/contracts";
import { explicitRequestDeadline, notifyStreamCallback, ProviderRequestError, reportedUsage, type ProviderCallOptions, type StreamObservers } from "@xueness/providers";
import { SubscriptionRequestError, type SubscriptionBroker } from "./broker.ts";
import { EntitlementClient, EntitlementTickets } from "./entitlements.ts";
import { definition } from "./state.ts";

type Row = Record<string, unknown>;

export class NativeProvider {
  /** Title and handoff calls copy this adapter like Python's `copy.copy`. */
  readonly hostAdapter = true;
  readonly accountId: string;
  readonly model: string;
  readonly base: string;
  readonly capabilities: ReadonlySet<string>;
  readonly runtimeProfile = "standard";
  readonly contextWindow: number | null;
  maxOutputTokens: number | null;
  readonly toolCalling = "native";
  readonly compatibility: Row = {};
  readonly lightweightOptions: Row = {};
  readonly protocol = "openai";
  sessionId: string | null = null;
  requestDeadline: number | null = null;
  readonly reasoningEffort: string | null;
  private readonly broker: SubscriptionBroker;
  private readonly requireAvailable: () => void;
  /** The user-authorized entitlement service for this account, when configured. */
  private readonly entitlement: EntitlementClient | null;
  private readonly tickets = new EntitlementTickets();
  constructor(broker: SubscriptionBroker, requireAvailable: () => void, record: Row, reasoningEffort: string | null = null) {
    this.broker = broker; this.requireAvailable = requireAvailable; this.reasoningEffort = reasoningEffort;
    this.accountId = String(record.subscriptionId); this.model = String(record.model); this.base = String(record.baseUrl);
    this.capabilities = new Set(Array.isArray(record.capabilities) ? record.capabilities.map(String) : []);
    this.contextWindow = typeof record.contextWindow === "number" ? record.contextWindow : null;
    this.maxOutputTokens = typeof record.maxOutputTokens === "number" ? record.maxOutputTokens : null;
    const configured = record.entitlement;
    const base = typeof configured === "object" && configured !== null && !Array.isArray(configured) ? (configured as Row).base : null;
    const token = typeof configured === "object" && configured !== null && !Array.isArray(configured) ? (configured as Row).token : null;
    this.entitlement = typeof base === "string" && base.trim() && typeof token === "string" && token.trim()
      ? new EntitlementClient({ base, token })
      : null;
  }

  complete(messages: Row[], tools: Row[], options: ProviderCallOptions = {}): Promise<Row> { return this.stream(messages, tools, {}, options); }

  async stream(messages: Row[], tools: Row[], observers: StreamObservers = {}, options: ProviderCallOptions = {}): Promise<Row> {
    this.requireAvailable();
    const emit = (chunk: unknown): void => {
      if (!isDict(chunk) || typeof chunk.text !== "string") return;
      const callback = chunk.type === "content" ? observers.onDelta : chunk.type === "reasoning" ? observers.onReasoningDelta : null;
      if (callback) notifyStreamCallback(callback, chunk.text);
    };
    let result: Row;
    try {
      const deadline = explicitRequestDeadline(this);
      // The real ticket path: when the account has a configured entitlement
      // service, every generate carries a freshly issued (cached-until-expiry)
      // ticket; without one the request runs exactly as before.
      let ticket: string | null = null;
      if (this.entitlement) {
        const issued = await this.tickets.get("generate:" + this.accountId, (scope) => this.entitlement!.ticket(scope));
        ticket = issued.ticket;
      }
      result = await this.broker.call("generate", this.accountId, { model: this.model, messages, tools: tools ?? [], sessionId: this.sessionId, reasoningEffort: this.reasoningEffort, maxTokens: this.maxOutputTokens, ...(ticket === null ? {} : { ticket }) },
        { onChunk: emit, requestDeadline: deadline, signal: options.signal ?? null });
    } catch (error) {
      if (error instanceof SubscriptionRequestError) throw new ProviderRequestError({ status: error.status, category: error.category, contextOverflow: error.category === "context_overflow", stage: "response", exceptionType: "SubscriptionRequestError" });
      throw error;
    }
    this.requireAvailable();
    if (!isDict(result) || typeof result.content !== "string" || !Array.isArray(result.tool_calls)) throw new ProviderRequestError({ category: "invalid_response", stage: "parse" });
    const usage = reportedUsage(result._usage);
    delete result._usage;
    if (Object.keys(usage).length) result._usage = usage;
    result._request_attempts = 1;
    return result;
  }
}

export function resolveSubscription(broker: SubscriptionBroker, requireAvailable: () => void, record: Row, model?: string | null, reasoningEffort?: string | null, runtimeProfile?: string | null): NativeProvider {
  requireAvailable();
  if (!definition(record.subscriptionId)) throw new PyValueError("subscription provider not found");
  if (model != null && model !== record.model) throw new PyValueError("select a subscription model from the catalog");
  if (runtimeProfile != null && runtimeProfile !== "standard") throw new PyValueError("subscription models use the standard runtime");
  if (reasoningEffort != null && !(Array.isArray(record.reasoningLevels) ? record.reasoningLevels : []).includes(reasoningEffort)) throw new PyValueError("subscription model does not declare this reasoning effort");
  return new NativeProvider(broker, requireAvailable, record, reasoningEffort ?? null);
}
