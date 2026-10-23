import { isDict, pySlice, uuid4Hex } from "@xueness/contracts";
import type { StreamObservers, ToolSnapshot } from "@xueness/providers";
import { ProviderCancelled } from "@xueness/providers";
import { settleReasoningTiming } from "@xueness/sessions";
import type { AgentContext, Row } from "./types.ts";

const stamp = (): string => new Date().toISOString().replace(/Z$/, "+00:00");
export function closeReasoning(record: unknown): void {
  if (isDict(record) && record.reasoning_started_at && !record.reasoning_ended_at) record.reasoning_ended_at = stamp();
}
export function archiveStream(context: AgentContext, record: Row): void {
  if (!record.id) return;
  closeReasoning(record);
  if (!Array.isArray(context.session.stream_history)) context.session.stream_history = [];
  const history = context.session.stream_history as Row[];
  const index = history.findIndex((item) => isDict(item) && item.id === record.id);
  if (index < 0) history.push({ ...record });
  else if (record.status === "completed" && history[index]!.status !== "completed") history[index] = { ...record };
  history.splice(0, Math.max(0, history.length - 20));
}

/** One request's bounded progress; durable snapshots are serialized and coalesced. */
export class RequestStream {
  readonly record: Row;
  readonly #context: AgentContext;
  readonly #showReasoning: boolean;
  readonly #transform: ((accumulated: string) => string) | undefined;
  readonly #observe: ((text: string, reasoning: boolean) => void) | undefined;
  readonly #observeTool: ((snapshot: ToolSnapshot, streamId: string) => void) | undefined;
  #rawText = "";
  #timer: ReturnType<typeof setTimeout> | null = null;
  #saves: Promise<void> = Promise.resolve();
  #failure: unknown = null;
  #closed = false;
  #committed = false;
  #toolPrelude = new Map<string, ToolSnapshot>();
  readonly #observerStarted = performance.now();
  readonly #diagnostics: Row = { textChunks: 0, textChars: 0, reasoningChunks: 0, reasoningChars: 0, toolSnapshots: 0 };
  constructor(context: AgentContext, showReasoning: boolean, transform?: (accumulated: string) => string, observe?: (text: string, reasoning: boolean) => void, observeTool?: (snapshot: ToolSnapshot, streamId: string) => void) {
    this.#context = context; this.#showReasoning = showReasoning;
    this.#transform = transform;
    this.#observe = observe;
    this.#observeTool = observeTool;
    this.record = { id: uuid4Hex(), text: "", truncated: false, interrupted: false, status: "streaming" };
    if (showReasoning) this.record.reasoning = "";
  }
  async start(): Promise<void> {
    const previous = this.#context.session.streaming;
    if (isDict(previous) && previous.interrupted) archiveStream(this.#context, previous);
    delete this.#context.session.tool_activity;
    this.#context.session.streaming = this.record;
    await this.#context.save();
  }
  get committed(): boolean { return this.#committed; }
  get diagnostics(): Row { return { ...this.#diagnostics }; }
  #count(text: string, reasoning: boolean): void {
    const chunks = reasoning ? "reasoningChunks" : "textChunks", chars = reasoning ? "reasoningChars" : "textChars";
    this.#diagnostics[chunks] = Number(this.#diagnostics[chunks]) + 1;
    this.#diagnostics[chars] = Number(this.#diagnostics[chars]) + text.length;
    this.#diagnostics[reasoning ? "firstReasoningMs" : "firstTextMs"] ??= Math.max(0, performance.now() - this.#observerStarted);
  }
  #toolKey(snapshot: ToolSnapshot): string {
    if (snapshot.index !== null && snapshot.index !== undefined) return `index:${typeof snapshot.index}:${String(snapshot.index)}`;
    if (snapshot.call_id !== null && snapshot.call_id !== undefined) return `id:${String(snapshot.call_id)}`;
    return `anonymous:${this.#toolPrelude.size}`;
  }
  #deliverTool(snapshot: ToolSnapshot): void {
    this.#observeTool?.(snapshot, String(this.record.id)); this.#schedule();
  }
  #commit(): void {
    if (this.#committed) return;
    this.#committed = true;
    const snapshots = [...this.#toolPrelude.values()];
    this.#toolPrelude.clear();
    for (const snapshot of snapshots) this.#deliverTool(snapshot);
  }
  accept(response: Row): void {
    if (Array.isArray(response.tool_calls) && response.tool_calls.length > 0) this.#commit();
    else if (!this.#committed) this.discardPrelude();
  }
  discardPrelude(): void { this.#toolPrelude.clear(); }
  #schedule(): void {
    if (this.#timer || this.#closed) return;
    this.#timer = setTimeout(() => { this.#timer = null; this.#save(); }, 200);
    this.#timer.unref();
  }
  #save(): void {
    this.#saves = this.#saves.then(() => this.#context.save()).catch((error) => { this.#failure ??= error; });
  }
  observers(): StreamObservers {
    return {
      onToolDelta: (snapshot) => {
        if (this.#closed || this.#context.signal.aborted || this.#context.options.shouldStop?.()) return;
        this.#diagnostics.toolSnapshots = Number(this.#diagnostics.toolSnapshots) + 1;
        if (this.#committed) this.#deliverTool(snapshot);
        else this.#toolPrelude.set(this.#toolKey(snapshot), snapshot);
      },
      onDelta: (chunk) => {
        if (typeof chunk !== "string" || !chunk || this.#closed) return;
        this.#count(chunk, false);
        this.#commit();
        closeReasoning(this.record);
        this.#observe?.(chunk, false);
        const current = String(this.record.text ?? "");
        const available = Math.max(0, 24000 - Array.from(current).length);
        if (this.#transform) {
          this.#rawText += pySlice(chunk, Math.max(0, 24000 * 6 - Array.from(this.#rawText).length));
          this.record.text = pySlice(this.#transform(this.#rawText), 24000); this.record.text_format = "markdown";
        } else {
          this.record.text = current + pySlice(chunk, available);
          if (Array.from(chunk).length > available) this.record.truncated = true;
        }
        this.record.updated_at = stamp(); this.#schedule();
        const visible = String(this.record.text);
        if (!this.#transform || visible.startsWith(current) && visible.length > current.length) this.#context.emit({ type: "assistant_delta", text: this.#transform ? visible.slice(current.length) : chunk, stream_id: this.record.id });
        if (this.#context.signal.aborted || this.#context.options.shouldStop?.()) throw new ProviderCancelled("run stopped during provider stream");
      },
      onReasoningDelta: (chunk: unknown) => {
        if (typeof chunk !== "string" || !chunk || this.#closed) return;
        this.#count(chunk, true);
        this.#commit();
        if (!this.#showReasoning) {
          if (this.#context.signal.aborted || this.#context.options.shouldStop?.()) throw new ProviderCancelled("run stopped during provider reasoning stream");
          return;
        }
        if (!this.record.reasoning_started_at) this.record.reasoning_started_at = stamp();
        this.#observe?.(chunk, true);
        const current = String(this.record.reasoning ?? "");
        const available = Math.max(0, 32000 - Array.from(current).length);
        this.record.reasoning = current + pySlice(chunk, available);
        if (Array.from(chunk).length > available) this.record.reasoning_truncated = true;
        this.record.updated_at = stamp(); this.#schedule();
        this.#context.emit({ type: "reasoning_delta", text: pySlice(chunk, available), stream_id: this.record.id });
        if (this.#context.signal.aborted || this.#context.options.shouldStop?.()) throw new ProviderCancelled("run stopped during provider reasoning stream");
      },
    };
  }
  async flush(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    closeReasoning(this.record); this.#save(); await this.#saves;
    if (this.#failure !== null) throw this.#failure;
  }
  async interrupt(): Promise<void> {
    this.record.interrupted = true; this.record.status = "interrupted";
    this.record.interrupted_at ??= stamp();
    await this.flush();
  }
  async finish(messageIndex: number | null, interrupted = false): Promise<void> {
    await this.flush();
    this.record.status = interrupted ? "interrupted" : "completed";
    if (interrupted) this.record.interrupted = true;
    if (messageIndex !== null) this.record.final_message_index = messageIndex;
    this.record.completed_at = stamp(); archiveStream(this.#context, this.record);
    if (messageIndex !== null && typeof this.record.reasoning === "string" && this.record.reasoning) {
      if (!Array.isArray(this.#context.session.reasoning_history)) this.#context.session.reasoning_history = [];
      const history = this.#context.session.reasoning_history as Row[];
      history.push({ message_index: messageIndex, text: pySlice(this.record.reasoning, 32000) });
      history.splice(0, Math.max(0, history.length - 20));
    }
    delete this.#context.session.streaming; settleReasoningTiming(this.#context.session); await this.#context.save();
  }
}
