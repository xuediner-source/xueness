import React, { useEffect, useRef, useState } from "react";
import { post } from "../../xuenessApi";
import { subscribeElicitation } from './elicitationSubscription';
import { isImeComposingEvent } from "../../xuenessShortcutDisplay";
import { t as tr, tf } from "../../i18n";
import {
  elicitationIdentity,
  ElicitationPendingTracker,
  handleElicitationAction,
  normalizeRequestedSchema,
  shouldDismissElicitationOnEscape,
  type ElicitationAction,
  type ElicitationFormState,
  type ElicitationPending,
  type ElicitationSubmission,
} from "./elicitationSchema";
import "./ElicitationForm.css";

export {
  shouldDismissElicitationOnEscape,
  normalizeRequestedSchema,
  parsePending,
  parsePendingSnapshot,
  RESOLVED_ELICITATION_LIMIT,
  elicitationIdentity,
  ElicitationPendingTracker,
  valuesFromFormState,
  validateElicitationContent,
  handleElicitationAction,
  type ElicitationAction,
  type ElicitationField,
  type ElicitationSchema,
  type ElicitationPending,
  type ElicitationFormState,
  type ElicitationSubmission,
  type ElicitationValidation,
} from "./elicitationSchema";

function fieldError(code: string, field: string | null): string {
  if (code === "required") return field ? tf("请填写「{0}」", [field]) : tr("请填写必填项");
  return field ? tf("「{0}」不符合要求", [field]) : tr("这一项不符合要求");
}

export function ElicitationForm({
  pending,
  values,
  error = "",
  errorField = null,
  onChange,
  onResolve,
  onInvalid,
  submitting = false,
}: {
  pending: ElicitationPending;
  values: ElicitationFormState;
  error?: string;
  errorField?: string | null;
  onChange: (name: string, value: string | boolean) => void;
  onResolve: (body: ElicitationSubmission) => void;
  onInvalid?: (field: string | null, code: string) => void;
  submitting?: boolean;
}): React.JSX.Element | null {
  const schema = normalizeRequestedSchema(pending.requestedSchema);
  if (!schema) return null;
  const titleId = "xn-mcp-elicitation-title";
  const submit = (action: ElicitationAction) => {
    if (submitting) return;
    handleElicitationAction(action, { ...pending, requestedSchema: schema }, values, onResolve, (field, code) => onInvalid?.(field, code));
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLFormElement>) => {
    if (event.key === "Enter" && isImeComposingEvent(event)) {
      event.preventDefault();
      return;
    }
    if (!shouldDismissElicitationOnEscape(event)) return;
    event.preventDefault();
    submit("cancel");
  };
  return (
    <form className="xn-mcp-elicitation" aria-labelledby={titleId} data-testid="mcp-elicitation" onSubmit={event => { event.preventDefault(); submit("accept"); }} onKeyDown={onKeyDown}>
      <h3 id={titleId} className="xn-mcp-elicitation__title">{tr("MCP 询问")}</h3>
      <p className="xn-mcp-elicitation__source">
        <span className="xn-mcp-elicitation__source-label">{tr("来源服务器")}</span>
        <span>{pending.serverName}</span>
      </p>
      <p className="xn-mcp-elicitation__warning" role="note">{tr("不要在这里填写密码或密钥。")}</p>
      <p className="xn-mcp-elicitation__message">{pending.message}</p>
      {schema.description && <p className="xn-mcp-elicitation__hint">{schema.description}</p>}
      <div className="xn-mcp-elicitation__fields">
        {Object.entries(schema.properties).map(([name, spec]) => {
          const fieldId = `xn-mcp-elicitation-${name}`;
          const required = schema.required.includes(name);
          const label = spec.title || name;
          const describedBy = spec.description ? `${fieldId}-hint` : undefined;
          const invalid = errorField === name;
          if (spec.type === "boolean") {
            const checked = values[name] === true;
            return (
              <div key={name} className="xn-mcp-elicitation__field">
                <input id={fieldId} className="xn-mcp-elicitation__switch" type="checkbox" role="switch" aria-checked={checked} aria-required={required} aria-invalid={invalid || undefined} aria-describedby={describedBy} checked={checked} onChange={event => onChange(name, event.target.checked)} />
                <label htmlFor={fieldId}>{label}</label>
                {spec.description && <span id={`${fieldId}-hint`} className="xn-mcp-elicitation__hint">{spec.description}</span>}
              </div>
            );
          }
          if (spec.enum) {
            const current = typeof values[name] === "string" ? values[name] : "";
            return (
              <div key={name} className="xn-mcp-elicitation__field">
                <label htmlFor={fieldId}>{label}</label>
                <select id={fieldId} value={current} aria-required={required} aria-invalid={invalid || undefined} aria-describedby={describedBy} onChange={event => onChange(name, event.target.value)}>
                  <option value="">{tr("请选择")}</option>
                  {spec.enum.map((item, index) => <option key={item} value={item}>{spec.enumNames?.[index] || item}</option>)}
                </select>
                {spec.description && <span id={`${fieldId}-hint`} className="xn-mcp-elicitation__hint">{spec.description}</span>}
              </div>
            );
          }
          const current = typeof values[name] === "string" ? values[name] : "";
          const inputType = spec.format === "email" ? "email" : spec.format === "uri" ? "url" : spec.format === "date" ? "date" : "text";
          // Native maxlength is measured in UTF-16 units. Allow two units per code point
          // so a valid supplementary-plane character (for example an emoji) can be entered;
          // submit validation above enforces the exact code-point limit.
          const nativeMaxLength = spec.maxLength === undefined
            ? undefined
            : Math.min(spec.maxLength * 2, 32767);
          return (
            <div key={name} className="xn-mcp-elicitation__field">
              <label htmlFor={fieldId}>{label}</label>
              <input id={fieldId} type={inputType} inputMode={spec.type === "string" ? "text" : "decimal"} autoComplete="off" spellCheck={false} value={current} maxLength={nativeMaxLength} aria-required={required} aria-invalid={invalid || undefined} aria-describedby={describedBy} onChange={event => onChange(name, event.target.value)} />
              {spec.description && <span id={`${fieldId}-hint`} className="xn-mcp-elicitation__hint">{spec.description}</span>}
            </div>
          );
        })}
      </div>
      {error && <p id="xn-mcp-elicitation-error" className="xn-mcp-elicitation__error" role="alert">{error}</p>}
      <div className="xn-mcp-elicitation__actions">
        <button type="submit" disabled={submitting} className="xn-mcp-elicitation__submit">{tr(submitting ? "提交中…" : "提交")}</button>
        <button type="button" disabled={submitting} onClick={() => submit("decline")}>{tr("拒绝")}</button>
        <button type="button" disabled={submitting} onClick={() => submit("cancel")}>{tr("取消")}</button>
      </div>
    </form>
  );
}

/** A session key fences both read and submit completions after switching tasks. */
export function McpElicitation({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  return <SessionElicitation key={sessionId} sessionId={sessionId} />;
}

function SessionElicitation({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const [pending, setPending] = useState<ElicitationPending | null>(null);
  const [values, setValues] = useState<ElicitationFormState>({});
  const [error, setError] = useState("");
  const [errorField, setErrorField] = useState<string | null>(null);
  const [submittingIds, setSubmittingIds] = useState<ReadonlySet<string>>(() => new Set());
  const submittingIdsRef = useRef(new Set<string>());
  const pendingTracker = useRef(new ElicitationPendingTracker());
  const refreshSubscription = useRef<(() => void) | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!sessionId) return undefined;
    const subscription = subscribeElicitation({ sessionId, accept: body => {
      const update = pendingTracker.current.receive(body);
      if (update.accepted) setPending(update.pending);
    } });
    refreshSubscription.current = subscription.refresh;
    return () => {
      if (refreshSubscription.current === subscription.refresh) refreshSubscription.current = null;
      subscription();
    };
  }, [sessionId]);
  useEffect(() => {
    setValues({});
    setError("");
    setErrorField(null);
  }, [pending?.id]);
  if (!pending) return null;
  return (
    <ElicitationForm
      pending={pending}
      values={values}
      error={error}
      errorField={errorField}
      submitting={submittingIds.has(elicitationIdentity(pending.id))}
      onChange={(name, value) => setValues(current => ({ ...current, [name]: value }))}
      onInvalid={(field, code) => { setErrorField(field); setError(fieldError(code, field)); }}
      onResolve={body => {
        const identity = elicitationIdentity(body.id);
        if (submittingIdsRef.current.has(identity) || pendingTracker.current.pending?.id !== body.id) return;
        submittingIdsRef.current.add(identity);
        setSubmittingIds(new Set(submittingIdsRef.current));
        setError("");
        setErrorField(null);
        void post(`/api/sessions/${encodeURIComponent(sessionId)}/elicitation`, body).then(() => {
          if (mounted.current) setPending(pendingTracker.current.completeSubmission(body.id));
        }).catch(() => {
          if (mounted.current && pendingTracker.current.shouldShowSubmissionError(body.id)) {
            setError(tr("没能提交这次回答，请重试。"));
          }
        }).finally(() => {
          submittingIdsRef.current.delete(identity);
          if (mounted.current) {
            setSubmittingIds(new Set(submittingIdsRef.current));
            // A read may have captured an older pending snapshot before this write settled.
            // Replace it immediately so that stale data cannot resurrect a resolved form.
            refreshSubscription.current?.();
          }
        });
      }}
    />
  );
}
