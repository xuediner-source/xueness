/**
 * Execution-scoped temporary model selection with declarative failure fallback
 * (ZCode `turn-execution-fallback.ts`, `turn-model.ts`): a run may carry a
 * temporary selection that never rewrites the session's own model. While that
 * selection points at the provider a fallback is declared for, the request gets
 * a SingleAttempt budget; a matching request failure settles what the stream
 * already accepted, then continues the turn on the original/session model.
 */
import { randomBytes } from "node:crypto";
import { AcceptedCallLedger, settleStreamToolCalls } from "./accepted-call-ledger.ts";
import { classifyModelFailure, ModelErrorCode, ModelFailureReason, ModelRetryBudget, ProviderRequestError, ProviderTransportError } from "@xueness/providers";
import type { RequestStream } from "./stream.ts";
import type { AgentContext, AgentProvider, Row } from "./types.ts";

export interface ExecutionModelSelection { providerId: string | null; modelId: string | null; reasoningEffort?: string | null }
export interface SelectionFallbackRule { reason: string; providerErrorCode?: string }
/** Declarative fallback for the execution selection's provider; consumed once per run. */
export interface SelectionFallbackDeclaration {
  providerId: string;
  rules: readonly SelectionFallbackRule[];
  /** The submitter's own selection, preferred over the session-resident one. */
  target?: ExecutionModelSelection;
  /**
   * A same-provider fallback (F13.01) retargets the declared provider's other
   * model instead of another provider; only then may a fallback candidate
   * share the failed selection's provider.
   */
  sameProvider?: boolean;
}
export interface ExecutionModelScope {
  readonly selection: ExecutionModelSelection;
  readonly fallback?: SelectionFallbackDeclaration;
  /** Registry lookup selection → adapter; failures reject before any model request. */
  resolveProvider(selection: ExecutionModelSelection): AgentProvider;
}

/** Pre-request class only: the provider/model registry could not resolve a selection. */
export class ModelSelectionLookupError extends Error {
  override name = "ModelSelectionLookupError";
  readonly selection: ExecutionModelSelection;
  constructor(message: string, selection: ExecutionModelSelection) { super(message); this.selection = selection; }
}

export type ExecutionFallbackCandidateSource = "declared_target" | "session_selection";
export interface ExecutionFallbackCandidate { source: ExecutionFallbackCandidateSource; selection: ExecutionModelSelection }
export interface ExecutionSelectionFallbackMatch { reason: string; providerErrorCode?: string; statusCode?: number }

/**
 * Stable identity of one run's model-selection episode: every model request,
 * retry and execution fallback the run performs carries it, so one execution
 * stays reconstructable even where request IDs change (a fallback continuation
 * mints a new request). One ID per agent context — the session selection and
 * an execution-scoped selection each get their run's own; a fallback switches
 * provider/model under the same ID and records the move as from/to.
 */
const runSelectionIds = new WeakMap<AgentContext, string>();
export function selectionIdOf(context: AgentContext): string {
  let id = runSelectionIds.get(context);
  if (id === undefined) { id = randomBytes(8).toString("hex"); runSelectionIds.set(context, id); }
  return id;
}

/** A declared fallback forces one physical attempt: the failure must surface for the fallback route. */
export function resolveExecutionModelRetryBudget(input: {
  selection: ExecutionModelSelection | undefined; selectionFallback: SelectionFallbackDeclaration | undefined;
}): ModelRetryBudget | undefined {
  if (!input.selection || !input.selectionFallback) return undefined;
  return input.selection.providerId === input.selectionFallback.providerId ? ModelRetryBudget.SingleAttempt : undefined;
}

const selectionKey = (selection: ExecutionModelSelection): string =>
  `${selection.providerId ?? ""}/${selection.modelId ?? ""}$${selection.reasoningEffort ?? ""}`;

/** Fallback targets in priority order: the declared target first, then the session-resident selection. */
export function resolveExecutionFallbackCandidates(input: {
  declaredTarget: ExecutionModelSelection | undefined;
  executionProviderId: string | null;
  executionModelId?: string | null;
  allowSameProvider?: boolean;
  sessionSelection: ExecutionModelSelection | undefined;
}): ExecutionFallbackCandidate[] {
  const candidates: ExecutionFallbackCandidate[] = [];
  const seen = new Set<string>();
  const executionModelId = input.executionModelId ?? null;
  const push = (source: ExecutionFallbackCandidateSource, selection: ExecutionModelSelection | undefined): void => {
    if (!selection) return;
    // Returning to the failed execution selection would only fail once more; a
    // declared same-provider fallback (F13.01) may swap in the provider's
    // other model, so only an identical selection stays excluded there.
    if (selection.providerId === input.executionProviderId) {
      if (input.allowSameProvider !== true || selection.modelId === executionModelId) return;
    }
    const key = selectionKey(selection);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ source, selection });
  };
  push("declared_target", input.declaredTarget);
  push("session_selection", input.sessionSelection);
  return candidates;
}

/**
 * Whether this model request failure hits the execution selection's fallback
 * declaration. Only failures raised at the provider request boundary qualify;
 * user stops and context-window overflow keep their own paths, and local
 * runtime errors never trigger a second model request.
 */
export function matchExecutionSelectionFallback(input: {
  error: unknown;
  executionProviderId: string | null;
  selectionFallback: SelectionFallbackDeclaration | undefined;
  turnAborted: boolean;
}): ExecutionSelectionFallbackMatch | undefined {
  const fallback = input.selectionFallback;
  if (!fallback || input.turnAborted) return undefined;
  if (input.executionProviderId !== fallback.providerId) return undefined;
  if (!(input.error instanceof ProviderRequestError || input.error instanceof ProviderTransportError)) return undefined;
  const failure = classifyModelFailure(input.error);
  // Cancellation settles as a stop; context overflow belongs to reactive compaction —
  // the same window on the declared provider would only overflow again.
  if (failure.reason === ModelFailureReason.Cancelled || failure.code === ModelErrorCode.ModelContextExceeded) return undefined;
  // Rules match in declaration order; one without a code matches any provider failure.
  const rule = fallback.rules.find((candidate) => candidate.providerErrorCode === undefined || candidate.providerErrorCode === failure.providerCode);
  if (!rule) return undefined;
  return {
    reason: rule.reason,
    ...(failure.providerCode !== undefined ? { providerErrorCode: failure.providerCode } : {}),
    ...(failure.statusCode !== undefined ? { statusCode: failure.statusCode } : {}),
  };
}

export interface ExecutionModelState {
  readonly scope: ExecutionModelScope;
  /** The session binding this run started with; restored when the scope ends. */
  readonly sessionProvider: AgentProvider;
  provider: AgentProvider;
  fallback: SelectionFallbackDeclaration | undefined;
  budget: ModelRetryBudget | undefined;
}
/** One scope serves one run; sequential reuse re-installs, concurrent runs need separate scopes. */
const executionStates = new WeakMap<ExecutionModelScope, ExecutionModelState>();

function sessionModelSelection(session: Row): ExecutionModelSelection | undefined {
  const raw = session.model_selection;
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Row;
  const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;
  const providerId = text(record.provider_id), modelId = text(record.model);
  if (!providerId && !modelId) return undefined;
  return { providerId, modelId, reasoningEffort: text(record.reasoning_effort) };
}

/**
 * Installs the run's execution-scoped selection. Registry resolution is the
 * pre-request decision: its failures (selection failures) end the run before
 * any model call, and the session's own selection is never touched.
 */
export function installExecutionModel(context: AgentContext): ExecutionModelState | undefined {
  const scope = context.options.executionModel;
  if (!scope) return undefined;
  const provider = scope.resolveProvider(scope.selection);
  const state: ExecutionModelState = {
    scope,
    sessionProvider: context.provider,
    provider,
    fallback: scope.fallback,
    budget: resolveExecutionModelRetryBudget({ selection: scope.selection, selectionFallback: scope.fallback }),
  };
  context.provider = provider;
  executionStates.set(scope, state);
  return state;
}

/** The execution scope owned its provider only for this run; the session binding returns untouched. */
export function restoreExecutionModel(context: AgentContext, state: ExecutionModelState | undefined): void {
  if (!state) return;
  context.provider = state.sessionProvider;
  if (Object.hasOwn(context.session, "runtime_profile")) context.session.runtime_profile = state.sessionProvider.runtimeProfile ?? "standard";
  if (Object.hasOwn(context.session, "tool_calling")) context.session.tool_calling = state.sessionProvider.toolCalling ?? "native";
  executionStates.delete(state.scope);
}

export function executionModelOf(context: AgentContext): ExecutionModelState | undefined {
  const scope = context.options.executionModel;
  return scope ? executionStates.get(scope) : undefined;
}

/** SingleAttempt override while the declared execution provider is still active. */
export function executionRetryBudgetOverride(context: AgentContext): ModelRetryBudget | undefined {
  return executionModelOf(context)?.budget;
}

export interface ExecutionFallbackSettlement { streamId: string | null; textChars: number; reasoningChars: number; toolSnapshots: number; truncated: boolean }

const RECEIVED_STREAM_FACTS = "receivedStreamFacts";

function factsOf(stream: RequestStream): ExecutionFallbackSettlement {
  const diagnostics = stream.diagnostics;
  return {
    streamId: typeof stream.record.id === "string" ? stream.record.id : null,
    textChars: Number(diagnostics.textChars ?? 0),
    reasoningChars: Number(diagnostics.reasoningChars ?? 0),
    toolSnapshots: Number(diagnostics.toolSnapshots ?? 0),
    truncated: stream.record.truncated === true,
  };
}

/**
 * The failed attempt's stream dies inside `performModelRequest`; its received facts
 * ride on the thrown error (non-enumerable, invisible to failure classification) so
 * the driver's settlement can still account for what that attempt already delivered.
 */
export function attachReceivedStreamFacts(error: unknown, stream: RequestStream): void {
  if (!(error instanceof Error)) return;
  Object.defineProperty(error, RECEIVED_STREAM_FACTS, { value: factsOf(stream), enumerable: false, configurable: true, writable: true });
}

export function receivedStreamFactsOf(error: unknown): ExecutionFallbackSettlement | undefined {
  if (!(error instanceof Error)) return undefined;
  const facts = (error as Error & { receivedStreamFacts?: unknown }).receivedStreamFacts;
  return typeof facts === "object" && facts !== null ? facts as ExecutionFallbackSettlement : undefined;
}

export interface ModelAttemptFacts { requestId: string; attemptId: string; attempt: number; selectionId: string; modelId?: string; providerKind?: string }

const MODEL_ATTEMPT_FACTS = "modelAttemptFacts";

/**
 * The failed attempt's trace identity rides on the thrown error (non-enumerable,
 * invisible to failure classification) so the driver's fallback route can tie its
 * record to the exact request/attempt that failed — the continuation's own events
 * already share the selection ID.
 */
export function attachModelAttemptFacts(error: unknown, facts: ModelAttemptFacts): void {
  if (!(error instanceof Error)) return;
  Object.defineProperty(error, MODEL_ATTEMPT_FACTS, { value: facts, enumerable: false, configurable: true, writable: true });
}

export function modelAttemptFactsOf(error: unknown): ModelAttemptFacts | undefined {
  if (!(error instanceof Error)) return undefined;
  const facts = (error as Error & { modelAttemptFacts?: unknown }).modelAttemptFacts;
  return typeof facts === "object" && facts !== null ? facts as ModelAttemptFacts : undefined;
}

/**
 * Settles what the failed attempt's stream already accepted: the interrupted record
 * and its received facts are made durable exactly once, and through the F03.02
 * accepted-call ledger every accepted tool call settles exactly once (interrupted
 * at this fallback boundary) while unaccepted prelude fragments are discarded and
 * never executed — the fallback step rebuilds from the journal, which never held
 * them.
 */
export async function settleAcceptedStreamCalls(stream: RequestStream | null, error: unknown,
  ledger?: { ledger: AcceptedCallLedger; session: Row; turnId: string }): Promise<ExecutionFallbackSettlement> {
  if (!stream) return receivedStreamFactsOf(error) ?? { streamId: null, textChars: 0, reasoningChars: 0, toolSnapshots: 0, truncated: false };
  if (ledger) {
    settleStreamToolCalls({
      streamId: typeof stream.record.id === "string" ? stream.record.id : null,
      turnId: ledger.turnId,
      committed: stream.committed,
      acceptedCalls: stream.acceptedToolCalls(),
      preludeFragments: stream.discardedPreludeFragments(),
      cause: "execution_fallback",
      ledger: ledger.ledger,
      session: ledger.session,
    });
  }
  const settlement = factsOf(stream);
  await stream.interrupt();
  return settlement;
}

const FALLBACK_HISTORY_LIMIT = 20;
const stamp = (): string => new Date().toISOString().replace(/Z$/, "+00:00");

async function recordExecutionFallback(context: AgentContext, entry: Row): Promise<void> {
  const history = Array.isArray(context.session.execution_model_fallbacks) ? context.session.execution_model_fallbacks as Row[] : [];
  history.push({ at: stamp(), selectionId: selectionIdOf(context), ...entry });
  context.session.execution_model_fallbacks = history.slice(-FALLBACK_HISTORY_LIMIT);
  context.emit({ type: entry.applied === true ? "model_execution_fallback" : "model_execution_fallback_unavailable", selectionId: selectionIdOf(context), ...entry });
  await context.save();
}

export interface ExecutionFallbackOutcome { matched: boolean; applied: boolean }

/**
 * Request-failure route for the execution selection. A matching failure settles
 * the accepted stream first, then resolves fallback candidates (declared target,
 * session selection, the run's own session binding) — registry lookup errors
 * only skip a candidate — and continues the turn on the first resolvable one.
 * Applied at most once; with no target the original error terminates the turn.
 */
export async function applyExecutionSelectionFallback(context: AgentContext, error: unknown,
  input: { stream: RequestStream | null; stopped: boolean; ledger?: { ledger: AcceptedCallLedger; session: Row; turnId: string } }): Promise<ExecutionFallbackOutcome> {
  const state = executionModelOf(context);
  const match = state
    ? matchExecutionSelectionFallback({
      error, executionProviderId: state.scope.selection.providerId, selectionFallback: state.fallback, turnAborted: input.stopped,
    })
    : undefined;
  if (!state || !match) return { matched: false, applied: false };
  // Whether the turn can continue on another model and what the failed attempt already
  // delivered are separate decisions: settle the accepted stream exactly once either way.
  const settled = await settleAcceptedStreamCalls(input.stream, error, input.ledger);
  const skipped: Array<{ source: ExecutionFallbackCandidateSource; providerId: string | null; modelId: string | null; error: string }> = [];
  let resolved: { candidate: ExecutionFallbackCandidate; provider: AgentProvider } | undefined;
  for (const candidate of resolveExecutionFallbackCandidates({
    declaredTarget: state.fallback?.target,
    executionProviderId: state.scope.selection.providerId,
    executionModelId: state.scope.selection.modelId,
    allowSameProvider: state.fallback?.sameProvider === true,
    sessionSelection: sessionModelSelection(context.session),
  })) {
    try {
      resolved = { candidate, provider: state.scope.resolveProvider(candidate.selection) };
      break;
    } catch (candidateError) {
      // An unresolvable target (pre-request lookup) only skips to the next candidate; it
      // must not replace the model failure the run is actually recovering from.
      skipped.push({
        source: candidate.source, providerId: candidate.selection.providerId, modelId: candidate.selection.modelId,
        error: candidateError instanceof Error ? candidateError.message : String(candidateError),
      });
    }
  }
  // The run's own session binding is the already-resolved session model — the final
  // candidate whenever no declared target or registry selection could produce one.
  if (!resolved && state.sessionProvider !== state.provider) {
    resolved = {
      candidate: { source: "session_selection", selection: { providerId: null, modelId: state.sessionProvider.model ?? null } },
      provider: state.sessionProvider,
    };
  }
  const from = { providerId: state.scope.selection.providerId, modelId: state.scope.selection.modelId };
  const attribution = {
    ...(match.providerErrorCode !== undefined ? { providerErrorCode: match.providerErrorCode } : {}),
    ...(match.statusCode !== undefined ? { statusCode: match.statusCode } : {}),
  };
  // Correlate the record with the exact attempt that failed; the continuation
  // shares the selection ID, closing the loop across the fallback boundary.
  const attempt = modelAttemptFactsOf(error);
  const failed = attempt ? { requestId: attempt.requestId, attemptId: attempt.attemptId, attempt: attempt.attempt } : {};
  if (!resolved) {
    await recordExecutionFallback(context, { applied: false, from, reason: match.reason, settled, skipped, ...failed, ...attribution });
    return { matched: true, applied: false };
  }
  await recordExecutionFallback(context, {
    applied: true, from, reason: match.reason, settled,
    to: { providerId: resolved.candidate.selection.providerId, modelId: resolved.candidate.selection.modelId },
    toSource: resolved.candidate.source,
    ...(skipped.length ? { skipped } : {}),
    ...failed, ...attribution,
  });
  state.provider = resolved.provider;
  context.provider = resolved.provider;
  context.session.runtime_profile = resolved.provider.runtimeProfile ?? "standard";
  context.session.tool_calling = resolved.provider.toolCalling ?? "native";
  // One fallback per execution scope: the fallback model runs under the ordinary
  // budget and its own failures end the turn with their real error.
  state.fallback = undefined;
  state.budget = undefined;
  return { matched: true, applied: true };
}
