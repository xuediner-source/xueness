import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { t as tr, tf } from "../../i18n";
import { answerQuestion, answerQuestionCards, loadQuestion, questionCardsComplete, type QuestionCardAnswer, type QuestionCardAnswers, type PendingQuestionRecord, type QuestionResponse, type AnswerResponse } from "./questionApi";
import { evaluatePendingQuestionKey } from "../shared";
import { deferCompositionEnd } from "../../xuenessShortcutDisplay";
import "./PendingQuestion.css";

type QuestionTransport = {
  load: (sessionId: string, signal?: AbortSignal) => Promise<QuestionResponse>;
  answer: (sessionId: string, questionId: string, answer: string) => Promise<AnswerResponse>;
  answerCards?: (sessionId: string, questionId: string, answers: QuestionCardAnswers) => Promise<AnswerResponse>;
};
type QuestionState = { sessionId: string; question: PendingQuestionRecord | null; draft: string; answers: QuestionCardAnswers; available: boolean; loading: boolean; saving: boolean; error: string };
const emptyState = (): QuestionState => ({ sessionId: "", question: null, draft: "", answers: {}, available: false, loading: false, saving: false, error: "" });

/** Request ownership stays with this plugin, including late completions after a switch or disable. */
export class PendingQuestionModel {
  private state = emptyState();
  private listeners = new Set<() => void>();
  private generation = 0;
  private enabled = false;
  private abort?: AbortController;
  private drafts = new Map<string, string>();
  private cardDrafts = new Map<string, QuestionCardAnswers>();
  constructor(private transport: QuestionTransport = { load: loadQuestion, answer: answerQuestion, answerCards: answerQuestionCards }) {}
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
  setCardAnswer(id: string, answer: QuestionCardAnswer) {
    if (!this.enabled || this.state.saving || !this.state.question?.questions?.some(card => card.id === id)) return;
    const answers = { ...this.state.answers, [id]: { selected: [...answer.selected], text: answer.text } };
    this.cardDrafts.set(this.draftKey(), answers);
    this.update({ answers });
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
      this.update({ question, available: response.enabled,
        draft: question ? this.drafts.get(`${sessionId}:${question.id}`) ?? "" : "",
        answers: question ? this.cardDrafts.get(`${sessionId}:${question.id}`) ?? {} : {}, loading: false });
    } catch (error) {
      if (generation !== this.generation || !this.enabled || abort.signal.aborted) return;
      this.update({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  deactivate() { this.enabled = false; ++this.generation; this.abort?.abort(); }
  async submit(): Promise<boolean> {
    const { sessionId, question, draft, answers, saving } = this.state;
    const answer = draft.trim();
    const cards = question?.questions;
    if (!this.enabled || !question || saving) return false;
    if (cards ? !questionCardsComplete(cards, answers) || !this.transport.answerCards : !answer || Array.from(answer).length > 5000) return false;
    const generation = this.generation;
    this.update({ saving: true, error: "" });
    try {
      if (cards) await this.transport.answerCards!(sessionId, question.id, answers);
      else await this.transport.answer(sessionId, question.id, answer);
      if (generation !== this.generation || !this.enabled) return false;
      this.drafts.delete(this.draftKey(question));
      this.cardDrafts.delete(this.draftKey(question));
      this.update({ saving: false, question: null, draft: "", answers: {} });
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
  const [customChoices, setCustomChoices] = useState<Record<string, boolean>>({});
  const context = React.useRef({ sessionId, enabled });
  context.current = { sessionId, enabled };
  const compositionActiveRef = useRef(false);
  useEffect(() => () => { context.current.enabled = false; }, []);
  useEffect(() => {
    setContinuingError("");
    setCustomChoices({});
    void model.activate(sessionId, enabled && Boolean(pendingQuestion));
    return () => model.deactivate();
  }, [model, sessionId, enabled, pendingQuestion]);
  if (!enabled || !pendingQuestion) return null;
  const current = state.sessionId === sessionId;
  const busy = disabled || !current || state.loading || state.saving;
  const count = Array.from(state.draft.trim()).length;
  const cards = current ? state.question?.questions : undefined;
  const complete = cards ? questionCardsComplete(cards, state.answers) : count >= 1 && count <= 5000;
  const submit = async (continueRun: boolean) => {
    if (busy || !context.current.enabled || context.current.sessionId !== sessionId) return;
    if (await model.submit()) {
      if (!context.current.enabled || context.current.sessionId !== sessionId) return;
      try { await onSubmitted(sessionId, continueRun, () => context.current.enabled && context.current.sessionId === sessionId); }
      catch (error) { if (context.current.sessionId === sessionId && context.current.enabled) setContinuingError(error instanceof Error ? error.message : String(error)); }
    }
  };
  if (current && !state.loading && !state.available && !state.error) return null;
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
    {cards ? <div className="xn-question-cards">{cards.map(card => {
      const answer = state.answers[card.id] ?? { selected: [], text: "" };
      const updateChoice = (label: string, checked: boolean) => {
        setCustomChoices(current => ({ ...current, [card.id]: false }));
        const selected = card.multiSelect ? checked ? [...answer.selected, label] : answer.selected.filter(value => value !== label) : checked ? [label] : [];
        model.setCardAnswer(card.id, { ...answer, selected });
      };
      return <fieldset key={card.id} disabled={busy} className="xn-question-card">
        <legend><span>{card.header}</span>{card.question}</legend>
        {card.options.length > 0 && <div className="xn-question-card__options">{card.options.map(option => <label key={option.label} className="xn-question-card__choice" data-selected={answer.selected.includes(option.label)}>
          <input type={card.multiSelect ? "checkbox" : "radio"} name={`question-${sessionId}-${card.id}`} checked={answer.selected.includes(option.label)} onChange={event => updateChoice(option.label, event.currentTarget.checked)} />
          <span><strong>{option.label}</strong>{option.description && <span>{option.description}</span>}</span>
        </label>)}{!card.multiSelect && <label className="xn-question-card__choice" data-selected={customChoices[card.id] || (answer.selected.length === 0 && Boolean(answer.text.trim()))}>
          <input type="radio" name={`question-${sessionId}-${card.id}`} checked={Boolean(customChoices[card.id] || (answer.selected.length === 0 && answer.text.trim()))}
            onChange={() => {
              setCustomChoices(current => ({ ...current, [card.id]: true }));
              model.setCardAnswer(card.id, { selected: [], text: answer.text });
              document.getElementById(`question-custom-${sessionId}-${card.id}`)?.focus();
            }} /><span><strong>{tr("自行填写")}</strong></span>
        </label>}</div>}
        <label htmlFor={`question-custom-${sessionId}-${card.id}`}>{tr(card.options.length ? "补充或自定义答复" : "你的答复")}</label>
        <textarea id={`question-custom-${sessionId}-${card.id}`} value={answer.text} rows={2} maxLength={2000}
          placeholder={tr("填写答复，或补充任务所需的信息…")} onChange={event => model.setCardAnswer(card.id, { ...answer, text: event.currentTarget.value })} />
        {Array.from(answer.text.trim()).length > 1000 && <small role="alert">{tr("每项答复不能超过 1000 个字符。")}</small>}
      </fieldset>;
    })}</div> : <><label className="xn-pending-question__label" htmlFor={`question-answer-${sessionId}`}>{tr("你的答复")}</label>
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
      }} /></>}
    {(state.error || continuingError) && <p role="alert">{tf("答复操作失败：{0}", [state.error || continuingError])}</p>}
    <footer><small aria-live="polite">{state.loading ? tr("正在加载问题…") : count > 5000 ? tr("答复不能超过 5000 个字符。") : tr("提交答复不会批准工具操作。")}</small>
      <div>{state.error && <button type="button" className="xn-btn xn-btn--secondary xn-btn--sm" disabled={busy} onClick={() => void model.activate(sessionId, enabled)}>{tr("刷新问题")}</button>}
      <button type="button" className="xn-btn xn-btn--secondary xn-btn--sm" disabled={busy || !state.question || !complete} onClick={() => void submit(false)}>{tr("仅保存答复")}</button>
      <button type="button" className="xn-btn xn-btn--primary xn-btn--sm" disabled={busy || !state.question || !complete} onClick={() => void submit(true)}>{tr("答复并继续")}</button></div>
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
