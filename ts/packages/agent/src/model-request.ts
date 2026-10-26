/** Physical model attempts, retry-safe stream prelude, recovery and status events. */
import { admitAttempt, ProviderCancelled, reasoningOrigin, resolveModelStreamIdleTimeoutMs, type AttemptAdmission } from "@xueness/providers";
import { ModelRetry } from "./model-retry.ts";
import { attachModelAttemptFacts, attachReceivedStreamFacts, executionRetryBudgetOverride } from "./execution-selection.ts";
import { RequestStream } from "./stream.ts";
import { isModelContextExceededError } from "./compact/index.ts";
import { EmptyModelCompletionError, isSuspiciousEmptyCompletion, isZeroOutputCompletion } from "./empty-completion.ts";
import { effectiveExtensions } from "./finalize.ts";
import { validateMessage } from "./messages.ts";
import { ProviderRequestError } from "@xueness/providers";
import type { AgentContext, AgentRunnerOptions, ModelRequest, RebuildRequest, Row } from "./types.ts";

export async function performModelRequest(context: AgentContext, runner: AgentRunnerOptions, initial: ModelRequest,
  rebuild: RebuildRequest, now: () => number, stopped: () => boolean): Promise<{ response: Row; stream: RequestStream | null; request: ModelRequest }> {
  const extensions = runner.hooks.extensions ?? [], active = () => effectiveExtensions(context, extensions);
  const propagate = context.enabled("sessions") && runner.hooks.propagateCancellation?.(context) === true;
  const finiteDeadline = Number.isFinite(context.deadline);
  const timeout = finiteDeadline ? AbortSignal.timeout(Math.ceil(Math.max(0, (context.deadline - now()) * 1000))) : undefined;
  const signal = AbortSignal.any([timeout, propagate ? context.signal : undefined, context.hostSignal].filter((item): item is AbortSignal => !!item));
  const oldDeadline = context.provider.requestDeadline;
  if (finiteDeadline) context.provider.requestDeadline = context.deadline;
  // A declared execution fallback resolves to SingleAttempt: the failure must reach the
  // driver's fallback route instead of being retried on the same provider.
  const executionBudget = executionRetryBudgetOverride(context);
  const retry = new ModelRetry(context, now, executionBudget);
  let request = initial, stream: RequestStream | null = null, recovered = false;
  try {
    for (;;) {
      if (!context.enabled("providers")) throw new Error("providers plugin disabled");
      let binding: Awaited<ReturnType<NonNullable<AgentRunnerOptions["bindPrompt"]>>> | undefined;
      let admission: AttemptAdmission | undefined;
      const release = async (): Promise<void> => {
        admission?.release();
        const held = binding; binding = undefined;
        await held?.release();
      };
      let recorded = false;
      // Reading the facade method applies a pending selection; retain this bound call while queued.
      const invokeStream = context.provider.stream?.bind(context.provider);
      const invokeComplete = invokeStream ? undefined : context.provider.complete.bind(context.provider);
      const model = reasoningOrigin({ model: context.provider.model, base: context.provider.base });
      retry.begin({ ...context.provider.model ? { modelId: context.provider.model.slice(0, 160) } : {},
        ...context.provider.protocol ? { providerKind: context.provider.protocol } : {} });
      try {
        const port = context.options.modelRequestAdmission ?? request.options.modelRequestAdmission;
        const watch = new AbortController();
        const timer = port ? setInterval(() => { if (stopped() || !context.enabled("providers")) watch.abort(); }, 250) : undefined;
        timer?.unref();
        try {
          admission = await admitAttempt({ admission: port, model, signal: AbortSignal.any([signal, context.signal, watch.signal]),
            onQueued: () => retry.queued(context, active()), onAdmitted: (ms) => retry.admitted(context, ms, active()) });
        } finally { if (timer) clearInterval(timer); }
        retry.ticket(admission.ticket);
        if (stopped() || !context.enabled("providers")) throw new ProviderCancelled();
        await retry.started(context, active());
        const options = { ...request.options, signal, streamIdleTimeoutMs: resolveModelStreamIdleTimeoutMs({ baseTimeoutMs: context.options.modelRetry?.streamIdleTimeoutMs, retryNumber: retry.retries }),
          ...retry.transportAttempts ? { transportAttempts: retry.transportAttempts } : {},
          ...executionBudget ? { transportAttempts: 1 } : {} };
        binding = await runner.bindPrompt?.(context, request.messages);
        const messages = binding?.messages ?? request.messages;
        if (binding) options.media = binding.media;
        for (const extension of active()) { try { await extension.modelRequestPrepared?.(context, { ...request, messages, options }, retry.facts(context)); } catch { /* diagnostics never change request execution */ } }
        let response: Row;
        if (invokeStream) {
          const transform = active().find((extension) => extension.streamText)?.streamText;
          stream = new RequestStream(context, context.enabled("sessions") && runner.hooks.showReasoning?.(context) === true,
            transform ? (text) => transform(context, text) : undefined,
            (text, reasoning) => { for (const extension of active()) { try { extension.observeDelta?.(context, text, reasoning); } catch { /* activity cannot change execution */ } } },
            (snapshot, streamId) => { for (const extension of active()) { try { extension.observeToolDelta?.(context, snapshot, streamId); } catch { /* snapshots carry no execution authority */ } } });
          await stream.start();
          response = await invokeStream(messages, request.tools, stream.observers(), options);
        } else response = await invokeComplete!(messages, request.tools, options);
        retry.diagnostics(stream?.diagnostics);
        const empty = isZeroOutputCompletion(response, stream?.committed ?? false);
        if (empty && retry.canRetryEmpty) {
          recorded = true;
          if (await retry.next(context, new EmptyModelCompletionError(), signal, stopped, active(), { empty: true, beforeWait: release })) {
            if (stream) { stream.discardPrelude(); await stream.finish(null, true); stream = null; }
            continue;
          }
          throw new EmptyModelCompletionError();
        }
        try { validateMessage(response, Object.keys(context.session.results as Row)); }
        catch { throw new ProviderRequestError({ category: "invalid_response", stage: "parse", exceptionType: "ValueError" }); }
        stream?.accept(response);
        await retry.completed(context, response, active());
        if (isSuspiciousEmptyCompletion(response)) {
          recorded = true;
          await retry.next(context, new EmptyModelCompletionError(), signal, stopped, active(), { empty: true, committed: true });
          throw new EmptyModelCompletionError();
        }
        if (retry.retries) response = { ...response, _request_attempts: (typeof response._request_attempts === "number" ? response._request_attempts : 1) + retry.retries };
        if (stream) await stream.flush();
        return { response, stream, request };
      } catch (error) {
        retry.diagnostics(stream?.diagnostics);
        if (recorded) throw error;
        if (!stream?.committed && !recovered) {
          // Reactive compaction may issue its own model call; the failed attempt no longer owns capacity.
          if (isModelContextExceededError(error)) admission?.release();
          let compacted = false;
          for (const extension of active()) if (!compacted && extension.compactAfterOverflow) compacted = await extension.compactAfterOverflow(context, request, error, rebuild);
          let repaired: ModelRequest | null = null;
          if (!compacted) for (const extension of active()) repaired ||= await extension.retryRequest?.(context, request, error) ?? null;
          if (compacted || repaired) {
            recovered = true;
            await retry.failed(context, error, signal, active(), false);
            if (stream) { stream.discardPrelude(); await stream.finish(null, true); stream = null; }
            request = repaired ?? await rebuild(context.session.messages as Row[]);
            continue;
          }
        }
        if (!await retry.next(context, error, signal, stopped, active(), { committed: stream?.committed ?? false, beforeWait: release })) throw error;
        if (stream) { stream.discardPrelude(); await stream.finish(null, true); stream = null; }
      } finally { await release(); }
    }
  } catch (error) {
    // The escaping error carries the failed attempt's trace identity so the driver's
    // fallback route can correlate its record; classification never sees it.
    attachModelAttemptFacts(error, retry.attemptFacts(context));
    if (stream) { attachReceivedStreamFacts(error, stream); stream.discardPrelude(); await stream.interrupt(); }
    throw error;
  } finally { context.provider.requestDeadline = oldDeadline ?? null; }
}
