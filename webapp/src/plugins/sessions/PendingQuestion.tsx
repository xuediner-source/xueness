import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { t as tr, tf } from "../../i18n";
import { answerQuestion, loadQuestion, type PendingQuestionRecord, type QuestionResponse, type AnswerResponse } from "./questionApi";
import { evaluatePendingQuestionKey } from "../shared";
import { deferCompositionEnd } from "../../xuenessShortcutDisplay";
import "./PendingQuestion.css";

type QuestionTransport = {
  load: (sessionId: string, signal?: AbortSignal) => Promise<QuestionResponse>;
  answer: (sessionId: string, questionId: string, answer: string) => Promise<AnswerResponse>;
};
type QuestionState = { sessionId: string; question: PendingQuestionRecord | null; draft: string; loading: boolean; saving: boolean; error: string };
const emptyState = (): QuestionState => ({ sessionId: "", question: null, draft: "", loading: false, saving: false, error: "" });

/** Request ownership stays with this plugin, including late completions after a switch or disable. */
export class PendingQuestionModel {
  private state = emptyState();
  private listeners = new Set<() => void>();
  private generation = 0;
  private enabled = false;
  private abort?: AbortController;
  private drafts = new Map<string, string>();
  constructor(private transport: QuestionTransport = { load: loadQuestion, answer: answerQuestion }) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private update(patch: Partial<QuestionState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(listener => listener());
  }
  private draftKey(question = this.state.question) { return `${this.state.sessionId}:${question?.id ?? ""}`; }
  setDraft(draft: string) {
    if (!this.enabled || this.state.saving) return;
    this.drafts.set(this.draftKey(), draft);
    this.update({ draft });
  }
  async activate(sessionId: string, enabled: boolean) {
    const generation = ++this.generation;
    this.abort?.abort();
    this.enabled = enabled;
    this.update({ ...emptyState(), sessionId, loading: enabled });
    if (!enabled) return;
    const abort = this.abort = new AbortController();
    try {
      const response = await this.transport.load(sessionId, abort.signal);
      if (generation !== this.generation || !this.enabled) return;
      this.enabled = response.enabled;
      const question = response.enabled ? response.question : null;
      this.update({ question, draft: question ? this.drafts.get(`${sessionId}:${question.id}`) ?? "" : "", loading: false });
    } catch (error) {
      if (generation !== this.generation || !this.enabled || abort.signal.aborted) return;
      this.update({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  deactivate() { this.enabled = false; ++this.generation; this.abort?.abort(); }
  async submit(): Promise<boolean> {
    const { sessionId, question, draft, saving } = this.state;
    const answer = draft.trim();
    if (!this.enabled || !question || saving || !answer || Array.from(answer).length > 5000) return false;
    const generation = this.generation;
    this.update({ saving: true, error: "" });
    try {
      await this.transport.answer(sessionId, question.id, answer);
      if (generation !== this.generation || !this.enabled) return false;
      this.drafts.delete(this.draftKey(question));
      this.update({ saving: false, question: null, draft: "" });
      return true;
    } catch (error) {
      if (generation !== this.generation || !this.enabled) return false;
      // An uncertain network result is deliberately not retried. The stable question ID makes a user retry idempotent.
      this.update({ saving: false, error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }
}

export function PendingQuestion({ sessionId, pendingQuestion, enabled, disabled = false, onSubmitted }: {
  sessionId: string; pendingQuestion?: string | null; enabled: boolean; disabled?: boolean;
  onSubmitted: (sessionId: string, continueRun: boolean, isCurrent: () => boolean) => Promise<unknown>;
}): React.ReactElement | null {
  const [model] = useState(() => new PendingQuestionModel());
  const state = useSyncExternalStore(model.subscribe, model.snapshot, model.snapshot);
  const [continuingError, setContinuingError] = useState("");
  const context = React.useRef({ sessionId, enabled });
  context.current = { sessionId, enabled };
  const compositionActiveRef = useRef(false);
  useEffect(() => () => { context.current.enabled = false; }, []);
  useEffect(() => {
    setContinuingError("");
    void model.activate(sessionId, enabled && Boolean(pendingQuestion));
    return () => model.deactivate();
  }, [model, sessionId, enabled, pendingQuestion]);
  if (!enabled || !pendingQuestion) return null;
  const current = state.sessionId === sessionId;
  const busy = disabled || !current || state.loading || state.saving;
  const count = Array.from(state.draft.trim()).length;
  const submit = async (continueRun: boolean) => {
    if (busy || !context.current.enabled || context.current.sessionId !== sessionId) return;
    if (await model.submit()) {
      if (!context.current.enabled || context.current.sessionId !== sessionId) return;
      try { await onSubmitted(sessionId, continueRun, () => context.current.enabled && context.current.sessionId === sessionId); }
      catch (error) { if (context.current.sessionId === sessionId && context.current.enabled) setContinuingError(error instanceof Error ? error.message : String(error)); }
    }
  };
  if (current && !state.loading && !state.question && !state.error) return <section className="xn-pending-question" role="status">
    <p>{tr("问题状态已变更，请刷新会话。")}</p>
    <button type="button" className="xn-btn xn-btn--secondary xn-btn--sm" disabled={disabled}
      onClick={() => {
        const isCurrent = () => context.current.enabled && context.current.sessionId === sessionId;
        if (!isCurrent()) return;
        void onSubmitted(sessionId, false, isCurrent).catch(error => {
          if (isCurrent()) setContinuingError(error instanceof Error ? error.message : String(error));
        });
      }}>{tr("刷新会话")}</button>
    {continuingError && <p role="alert">{tf("答复操作失败：{0}", [continuingError])}</p>}
  </section>;
  return <section className="xn-pending-question" aria-labelledby={`question-heading-${sessionId}`} data-testid="pending-question">
    <header><h3 id={`question-heading-${sessionId}`}>{tr("需要你的答复")}</h3><span>{tr("等待答复")}</span></header>
    <p className="xn-pending-question__text">{current && state.question ? state.question.text : pendingQuestion}</p>
    <label className="xn-pending-question__label" htmlFor={`question-answer-${sessionId}`}>{tr("你的答复")}</label>
    <textarea id={`question-answer-${sessionId}`} value={current ? state.draft : ""} disabled={busy || !state.question}
      placeholder={tr("填写答复，或补充任务所需的信息…")} rows={3} maxLength={10000}
      onChange={event => model.setDraft(event.currentTarget.value)}
      onCompositionStart={(event) => {
        compositionActiveRef.current = true;
        event.currentTarget.setAttribute("data-composing", "true");
      }}
      onCompositionEnd={(event) => {
        const el = event.currentTarget;
        deferCompositionEnd(() => {
          compositionActiveRef.current = false;
          el?.removeAttribute("data-composing");
        });
      }}
      onKeyDown={event => {
        const action = evaluatePendingQuestionKey({ ...event, compositionActive: compositionActiveRef.current });
        if (action === "submit") {
          event.preventDefault();
          void submit(true);
        }
      }} />
    {(state.error || continuingError) && <p role="alert">{tf("答复操作失败：{0}", [state.error || continuingError])}</p>}
    <footer><small aria-live="polite">{state.loading ? tr("正在加载问题…") : count > 5000 ? tr("答复不能超过 5000 个字符。") : tr("提交答复不会批准工具操作。")}</small>
      <div>{state.error && <button type="button" className="xn-btn xn-btn--secondary xn-btn--sm" disabled={busy} onClick={() => void model.activate(sessionId, enabled)}>{tr("刷新问题")}</button>}
      <button type="button" className="xn-btn xn-btn--secondary xn-btn--sm" disabled={busy || !state.question || count < 1 || count > 5000} onClick={() => void submit(false)}>{tr("仅保存答复")}</button>
      <button type="button" className="xn-btn xn-btn--primary xn-btn--sm" disabled={busy || !state.question || count < 1 || count > 5000} onClick={() => void submit(true)}>{tr("答复并继续")}</button></div>
    </footer>
  </section>;
}

/** Explicit resume remains available after save-only or reopening a paused conversation. */
export function QuestionResume({ enabled, resumeBudgetEnabled = false, pauseCode, status, pendingQuestion, disabled, onResume }: {
  /** Existing opt-in for resuming a saved answer-only pause. */
  enabled: boolean;
  /** Budget-paused turns are resumable whenever the sessions plugin is active. */
  resumeBudgetEnabled?: boolean;
  pauseCode?: string | null;
  status: string;
  pendingQuestion?: string | null;
  disabled: boolean;
  onResume: () => Promise<unknown>;
}): React.ReactElement | null {
  const budgetPausedTurn = pauseCode === "step_limit_reached" || pauseCode === "wall_time_limit_reached";
  const canResumeBudgetPause = resumeBudgetEnabled && budgetPausedTurn;
  if ((!enabled && !canResumeBudgetPause) || status !== "paused" || pendingQuestion) return null;
  const label = canResumeBudgetPause ? tr("继续本轮") : tr("继续任务");
  return <div className="xn-question-resume"><button type="button" className="xn-btn xn-btn--secondary xn-btn--sm" disabled={disabled}
    onClick={() => { void onResume(); }}>{label}</button></div>;
}
