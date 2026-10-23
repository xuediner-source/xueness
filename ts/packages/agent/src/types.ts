import type { MediaBinding, ModelRequestAdmission, ProviderCallOptions, StreamObservers, ToolSnapshot } from "@xueness/providers";
import type { Session, SessionStore } from "@xueness/sessions";
import type { ToolBridge, ToolCall } from "@xueness/tool-bridge";
import type { ModelRetryInfo, ModelRetrySettings } from "./model-retry.ts";

export type Row = Record<string, unknown>;
export type Awaitable<T> = T | Promise<T>;
/** Both shipped adapters implement this surface; local deterministic adapters may omit stream. */
export interface AgentProvider {
  readonly model?: string;
  readonly base?: string;
  /** A live model switch may be staged until the next physical call. */
  upcomingProvider?(): AgentProvider;
  readonly protocol?: string;
  readonly runtimeProfile?: string;
  readonly toolCalling?: string;
  readonly contextWindow?: number | null;
  readonly maxOutputTokens?: number | null;
  /** Declared model input kinds ("image", "pdf", "video"); see `modelInputOf`. */
  readonly capabilities?: ReadonlySet<string>;
  readonly acceptsPdfDocuments?: boolean;
  requestDeadline?: number | null;
  complete(messages: Row[], tools: Row[], options?: ProviderCallOptions): Promise<Row>;
  stream?(messages: Row[], tools: Row[], observers?: StreamObservers, options?: ProviderCallOptions): Promise<Row>;
}
export interface RunOptions {
  maxSteps?: number;
  maxChars?: number;
  maxTokens?: number | null;
  maxWallSeconds?: number;
  signal?: AbortSignal;
  shouldStop?: () => boolean;
  onStep?: (steps: number) => unknown;
  /** ZCode model retry policy; defaults follow ZCode (10 retries, 2 s doubling to 60 s) and `XUENESS_MODEL_RETRY_*`. */
  modelRetry?: ModelRetrySettings;
  modelRequestAdmission?: ModelRequestAdmission;
}
export interface AgentEvent extends Row { type: string }
export interface AgentContext {
  session: Session;
  store: SessionStore;
  provider: AgentProvider;
  stateDir: string;
  root: string;
  /** Host shutdown must close provider transport even when UI cancellation propagation is off. */
  hostSignal?: AbortSignal;
  signal: AbortSignal;
  deadline: number;
  options: RunOptions;
  save(): Promise<void>;
  enabled(id: string): boolean;
  emit(event: AgentEvent): void;
}
export interface ModelRequest { messages: Row[]; tools: Row[]; options: ProviderCallOptions; hostInstructions?: string[]; repair?: string | null; injected?: string[] }
export type RebuildRequest = (messages: Row[]) => Promise<ModelRequest>;
export interface RunLifecycle { stop?: boolean; deadlineSeconds?: number }
export interface RunDecision { action: "continue" | "stop"; prompt?: string; owner?: string; exclusive?: boolean }
/** Product hooks execute only while the declaring plugin remains effective. */
export interface AgentExtension {
  readonly id: string;
  readonly capabilities?: readonly string[];
  /** The plugin builds a bounded prompt view without rewriting the journal. */
  readonly preserveJournal?: boolean | ((context: AgentContext) => boolean);
  beforeRun?(context: AgentContext): Awaitable<RunLifecycle | void>;
  runStarted?(context: AgentContext): Awaitable<void>;
  beforeModelRequest?(context: AgentContext): Awaitable<void>;
  prepareRequest?(context: AgentContext, request: ModelRequest): Awaitable<ModelRequest>;
  retryRequest?(context: AgentContext, request: ModelRequest, error: unknown): Awaitable<ModelRequest | null>;
  /** Observational: a transient model failure will be retried after `info.delayMs`. */
  modelRetryScheduled?(context: AgentContext, info: ModelRetryInfo): Awaitable<void>;
  modelRequestStarted?(context: AgentContext, info: Row): Awaitable<void>;
  modelRequestQueued?(context: AgentContext, info: Row): Awaitable<void>;
  modelRequestAdmitted?(context: AgentContext, info: Row): Awaitable<void>;
  modelRequestPrepared?(context: AgentContext, request: ModelRequest, info: Row): Awaitable<void>;
  modelRequestCompleted?(context: AgentContext, info: Row): Awaitable<void>;
  modelRequestFailed?(context: AgentContext, info: Row): Awaitable<void>;
  /** The plugin compacts the journal itself; the driver skips its deterministic `compact()`. */
  ownsCompaction?(context: AgentContext): boolean;
  /**
   * Called once the request is fully prepared. Returns true after rewriting the journal;
   * the driver then rebuilds the request. `rebuild` prepares a request for any journal slice.
   */
  compactBeforeRequest?(context: AgentContext, request: ModelRequest, rebuild: RebuildRequest): Awaitable<boolean>;
  /** A context-overflow failure of the first attempt; true after compacting, so the driver rebuilds and retries. */
  compactAfterOverflow?(context: AgentContext, request: ModelRequest, error: unknown, rebuild: RebuildRequest): Awaitable<boolean>;
  streamText?(context: AgentContext, accumulated: string): string;
  observeDelta?(context: AgentContext, text: string, reasoning: boolean): void;
  observeToolDelta?(context: AgentContext, snapshot: ToolSnapshot, streamId: string): void;
  /** Durable event sinks run before observational callbacks; failures stop publication. */
  recordEvent?(context: AgentContext, event: AgentEvent): void;
  afterModelResponse?(context: AgentContext, response: Row): Awaitable<Row>;
  /** After the assistant step is durable; true continues this turn with newly admitted input. */
  beforeFinalResponse?(context: AgentContext, response: Row): Awaitable<boolean>;
  toolsScheduled?(context: AgentContext, calls: readonly Row[]): Awaitable<void>;
  toolExecutionStarted?(context: AgentContext, call: ToolCall): Awaitable<void>;
  toolResultRecorded?(context: AgentContext, call: ToolCall, result: Row): Awaitable<void>;
  permissionRequested?(context: AgentContext, callId: string): Awaitable<void>;
  beforeTool?(context: AgentContext, call: ToolCall): Awaitable<Row | null | void>;
  afterTool?(context: AgentContext, call: ToolCall, result: Row): Awaitable<Row>;
  toolFinished?(context: AgentContext, call: ToolCall, result: Row, seconds: number): void;
  completionInstructions?(context: AgentContext): Awaitable<string[]>;
  completionRequiresEvidence?(context: AgentContext, callIds: string[]): Awaitable<boolean>;
  completionChecks?(context: AgentContext, answer: string): Awaitable<Row>;
  completionGuidance?(context: AgentContext): Awaitable<string | null>;
  settleRun?(context: AgentContext, returned: boolean): Awaitable<void>;
  afterRun?(context: AgentContext): Awaitable<RunDecision | void>;
  /** A continuation owner may atomically append prepared input and its metadata. */
  appendTurn?(context: AgentContext, text: string): Awaitable<boolean>;
  close?(context: AgentContext): Awaitable<void>;
}
export interface AgentPluginHooks {
  /** Read persisted effective state every time; exceptions fail closed. */
  enabled(id: string): boolean;
  /** Unknown/unowned tools are refused before dispatch. */
  toolOwner(name: string): string | null;
  /** Fresh schemas from the live plugin registry at each model request. */
  tools(context: AgentContext): Awaitable<readonly Row[]>;
  /** True only for registry-declared pure reads with no interactive gate. */
  concurrencySafe?(name: string): boolean;
  extensions?: readonly AgentExtension[];
  showReasoning?(context: AgentContext): boolean;
  propagateCancellation?(context: AgentContext): boolean;
  /** Configured product features that must have a concrete TS extension. */
  requiredCapabilities?(session: Session): readonly string[];
}
export interface AgentRunnerOptions {
  store: SessionStore;
  provider: AgentProvider;
  toolBridge: Pick<ToolBridge, "call" | "callAll"> & Partial<Pick<ToolBridge, "permissions">>;
  hooks: AgentPluginHooks;
  stateDir?: string;
  /** Must be the same workspace root used by ToolBridge's environment. */
  root: string;
  hostSignal?: AbortSignal;
  onEvent?: (event: AgentEvent) => unknown;
  /** Providers-owned invocation scope for accepted media; always released. */
  bindPrompt?: (context: AgentContext, messages: Row[]) => Awaitable<{ messages: Row[]; media: MediaBinding; release(): Awaitable<void> }>;
  /** Testable monotonic seconds (same origin as provider adapters). */
  now?: () => number;
}
