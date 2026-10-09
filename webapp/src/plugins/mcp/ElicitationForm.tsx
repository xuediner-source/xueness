import React, { useEffect, useState } from "react";
import { get, post } from "../../xuenessApi";
import { isImeComposingEvent } from "../../xuenessShortcutDisplay";
import { t as tr, tf } from "../../i18n";
import "./ElicitationForm.css";

export function shouldDismissElicitationOnEscape(event: {
  key: string;
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
  compositionActive?: boolean;
  target?: unknown;
}): boolean {
  if (event.key !== "Escape" || isImeComposingEvent(event)) return false;
  if (typeof HTMLSelectElement !== "undefined" && event.target instanceof HTMLSelectElement) return false;
  if ((event.target as { tagName?: string } | null)?.tagName?.toUpperCase() === "SELECT") return false;
  return true;
}

const MAX_PROPERTIES = 16;
const MAX_STRING = 4000;
const MAX_ENUM = 32;
const MAX_MESSAGE = 2000;
const PASSWORD_TOKENS = new Set(["password", "secret", "token", "credential", "apikey", "passwd", "passphrase"]);

export type ElicitationAction = "accept" | "decline" | "cancel";

export type ElicitationField = {
  type: "string" | "number" | "integer" | "boolean";
  title?: string;
  description?: string;
  format?: "email" | "uri" | "date" | "date-time";
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  enum?: string[];
  enumNames?: string[];
};

export type ElicitationSchema = {
  type: "object";
  properties: Record<string, ElicitationField>;
  required: string[];
  title?: string;
  description?: string;
};

export type ElicitationPending = {
  id: string | number;
  serverId: string;
  serverName: string;
  message: string;
  requestedSchema: ElicitationSchema;
  expiresAt: number;
};

export type ElicitationFormState = Record<string, string | boolean>;

export type ElicitationSubmission = {
  id: string | number;
  action: ElicitationAction;
  content?: Record<string, string | number | boolean>;
};

export type ElicitationValidation =
  | { ok: true; content: Record<string, string | number | boolean> }
  | { ok: false; code: string; field: string | null };

function passwordLike(value: string): boolean {
  const folded = value.toLowerCase();
  const token = folded.replace(/[\s_-]/g, "");
  if (PASSWORD_TOKENS.has(token) || PASSWORD_TOKENS.has(folded)) return true;
  return folded.includes("password") || folded.includes("passwd") || folded.includes("passphrase");
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "boolean" || typeof value !== "number" || !Number.isFinite(value)) return null;
  if (Math.abs(value) > 1e12) return null;
  return value;
}

/** Python's len(str) counts Unicode code points, while JavaScript string.length counts UTF-16 units. */
function codePointLength(value: string): number {
  return Array.from(value).length;
}

/** Flat 2025-06-18 schema, or null when the form must not be shown. */
export function normalizeRequestedSchema(value: unknown): ElicitationSchema | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const schema = value as Record<string, unknown>;
  const allowed = new Set(["type", "properties", "required", "additionalProperties", "title", "description"]);
  if (Object.keys(schema).some(key => !allowed.has(key))) return null;
  if (schema.type !== "object") return null;
  if ("additionalProperties" in schema && schema.additionalProperties !== false) return null;
  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return null;
  const entries = Object.entries(properties as Record<string, unknown>);
  if (entries.length > MAX_PROPERTIES) return null;
  const normalized: Record<string, ElicitationField> = {};
  for (const [name, raw] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(name) || passwordLike(name)) return null;
    const field = normalizeField(raw);
    if (!field) return null;
    normalized[name] = field;
  }
  const requiredRaw = schema.required ?? [];
  if (!Array.isArray(requiredRaw) || requiredRaw.length > entries.length) return null;
  const required: string[] = [];
  for (const item of requiredRaw) {
    if (typeof item !== "string" || !(item in normalized) || required.includes(item)) return null;
    required.push(item);
  }
  const result: ElicitationSchema = { type: "object", properties: normalized, required };
  for (const key of ["title", "description"] as const) {
    if (!(key in schema)) continue;
    const text = schema[key];
    if (typeof text !== "string" || !text.trim() || text.length > (key === "title" ? 120 : 400)) return null;
    result[key] = text;
  }
  return result;
}

function normalizeField(value: unknown): ElicitationField | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const spec = value as Record<string, unknown>;
  if (typeof spec.title === "string" && passwordLike(spec.title)) return null;
  if (spec.type === "string" && "enum" in spec) return normalizeEnum(spec);
  if (spec.type === "string") return normalizeString(spec);
  if (spec.type === "number" || spec.type === "integer") return normalizeNumber(spec, spec.type);
  if (spec.type === "boolean") return normalizeBoolean(spec);
  return null;
}

function sharedText(spec: Record<string, unknown>, allowed: Set<string>): { title?: string; description?: string } | null {
  if (Object.keys(spec).some(key => !allowed.has(key))) return null;
  const extra: { title?: string; description?: string } = {};
  for (const key of ["title", "description"] as const) {
    if (!(key in spec)) continue;
    const text = spec[key];
    const limit = key === "title" ? 120 : 400;
    if (typeof text !== "string" || !text.trim() || text.length > limit) return null;
    extra[key] = text;
  }
  return extra;
}

function normalizeString(spec: Record<string, unknown>): ElicitationField | null {
  const extra = sharedText(spec, new Set(["type", "title", "description", "format", "minLength", "maxLength"]));
  if (!extra) return null;
  const field: ElicitationField = { type: "string", ...extra };
  if ("format" in spec) {
    const format = spec.format;
    if (typeof format !== "string" || passwordLike(format)) return null;
    if (format !== "email" && format !== "uri" && format !== "date" && format !== "date-time") return null;
    field.format = format;
  }
  const bounds = lengthBounds(spec);
  if (!bounds) return null;
  return { ...field, ...bounds };
}

function lengthBounds(spec: Record<string, unknown>): { minLength?: number; maxLength?: number } | null {
  const bounds: { minLength?: number; maxLength?: number } = {};
  for (const key of ["minLength", "maxLength"] as const) {
    if (!(key in spec)) continue;
    const value = spec[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_STRING) return null;
    bounds[key] = value;
  }
  if ((bounds.minLength ?? 0) > (bounds.maxLength ?? MAX_STRING)) return null;
  return bounds;
}

function normalizeEnum(spec: Record<string, unknown>): ElicitationField | null {
  const extra = sharedText(spec, new Set(["type", "title", "description", "enum", "enumNames"]));
  if (!extra) return null;
  const values = spec.enum;
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_ENUM) return null;
  const clean: string[] = [];
  for (const item of values) {
    if (typeof item !== "string" || !item || item.length > 200 || clean.includes(item)) return null;
    if ([...item].some(ch => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)) return null;
    clean.push(item);
  }
  const field: ElicitationField = { type: "string", enum: clean, ...extra };
  if ("enumNames" in spec) {
    const names = spec.enumNames;
    if (!Array.isArray(names) || names.length !== clean.length) return null;
    const labels: string[] = [];
    for (const item of names) {
      if (typeof item !== "string" || !item.trim() || item.length > 200) return null;
      labels.push(item);
    }
    field.enumNames = labels;
  }
  return field;
}

function normalizeNumber(spec: Record<string, unknown>, kind: "number" | "integer"): ElicitationField | null {
  const extra = sharedText(spec, new Set(["type", "title", "description", "minimum", "maximum"]));
  if (!extra) return null;
  const field: ElicitationField = { type: kind, ...extra };
  for (const key of ["minimum", "maximum"] as const) {
    if (!(key in spec)) continue;
    const number = finiteNumber(spec[key]);
    if (number === null) return null;
    field[key] = number;
  }
  if (field.minimum !== undefined && field.maximum !== undefined && field.minimum > field.maximum) return null;
  return field;
}

function normalizeBoolean(spec: Record<string, unknown>): ElicitationField | null {
  const extra = sharedText(spec, new Set(["type", "title", "description"]));
  if (!extra) return null;
  return { type: "boolean", ...extra };
}

export function parsePending(body: unknown): ElicitationPending | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const pending = (body as { pending?: unknown }).pending;
  if (pending == null) return null;
  if (!pending || typeof pending !== "object" || Array.isArray(pending)) return null;
  const row = pending as Record<string, unknown>;
  const id = row.id;
  if (typeof id !== "string" && (typeof id !== "number" || !Number.isFinite(id))) return null;
  if (typeof row.serverId !== "string" || typeof row.serverName !== "string" || typeof row.message !== "string") return null;
  if (!row.message.trim() || row.message.length > MAX_MESSAGE) return null;
  if (typeof row.expiresAt !== "number" || !Number.isFinite(row.expiresAt)) return null;
  const requestedSchema = normalizeRequestedSchema(row.requestedSchema);
  if (!requestedSchema) return null;
  return { id, serverId: row.serverId, serverName: row.serverName, message: row.message, requestedSchema, expiresAt: row.expiresAt };
}

function formatOk(format: string, value: string): boolean {
  if (!value) return false;
  if (format === "email") {
    if (value.length > 254 || /\s/.test(value) || value.split("@").length !== 2) return false;
    const [local, domain] = value.split("@");
    return Boolean(local && domain && domain.includes(".") && !domain.startsWith(".") && !domain.endsWith("."));
  }
  if (format === "uri") {
    if (/\s/.test(value)) return false;
    try {
      const url = new URL(value);
      return /^[A-Za-z][A-Za-z0-9+.-]*$/.test(url.protocol.replace(":", "")) && Boolean(url.hostname || url.pathname);
    } catch {
      return false;
    }
  }
  if (format === "date") return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value + "T00:00:00Z"));
  if (format === "date-time") {
    const text = value.endsWith("Z") ? value.slice(0, -1) + "+00:00" : value;
    return !Number.isNaN(Date.parse(text));
  }
  return false;
}

export function valuesFromFormState(schema: ElicitationSchema, raw: ElicitationFormState): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(schema.properties)) {
    const value = raw[name];
    if (spec.type === "boolean") {
      content[name] = value === true;
      continue;
    }
    const text = typeof value === "string" ? value : "";
    if (text === "") continue;
    if (spec.enum) {
      content[name] = text;
      continue;
    }
    if (spec.type === "integer") {
      content[name] = /^-?\d+$/.test(text) ? Number(text) : text;
      continue;
    }
    if (spec.type === "number") {
      const number = Number(text);
      content[name] = text.trim() !== "" && Number.isFinite(number) ? number : text;
      continue;
    }
    content[name] = text;
  }
  return content;
}

export function validateElicitationContent(schema: ElicitationSchema, content: unknown): ElicitationValidation {
  if (!content || typeof content !== "object" || Array.isArray(content)) return { ok: false, code: "type", field: null };
  const record = content as Record<string, unknown>;
  const clean: Record<string, string | number | boolean> = {};
  for (const [name, spec] of Object.entries(schema.properties)) {
    if (!(name in record)) {
      if (schema.required.includes(name)) return { ok: false, code: "required", field: name };
      continue;
    }
    const value = record[name];
    if (spec.enum) {
      if (typeof value !== "string" || !spec.enum.includes(value)) return { ok: false, code: "enum", field: name };
      clean[name] = value;
      continue;
    }
    if (spec.type === "string") {
      if (typeof value !== "string" || value.includes("\u0000")) return { ok: false, code: "type", field: name };
      if (codePointLength(value) < (spec.minLength ?? 0) || codePointLength(value) > (spec.maxLength ?? MAX_STRING)) return { ok: false, code: "length", field: name };
      if (spec.format && !formatOk(spec.format, value)) return { ok: false, code: "format", field: name };
      clean[name] = value;
      continue;
    }
    if (spec.type === "number" || spec.type === "integer") {
      if (typeof value === "boolean" || typeof value !== "number" || !Number.isFinite(value)) return { ok: false, code: "type", field: name };
      if (spec.type === "integer" && !Number.isInteger(value)) return { ok: false, code: "type", field: name };
      if (spec.minimum !== undefined && value < spec.minimum) return { ok: false, code: "range", field: name };
      if (spec.maximum !== undefined && value > spec.maximum) return { ok: false, code: "range", field: name };
      clean[name] = value;
      continue;
    }
    if (typeof value !== "boolean") return { ok: false, code: "type", field: name };
    clean[name] = value;
  }
  const extra = Object.keys(record).find(key => !(key in schema.properties));
  if (extra) return { ok: false, code: "unexpected", field: extra.length <= 64 ? extra : null };
  return { ok: true, content: clean };
}

/** What the submit, decline, and cancel controls send. Invalid input never calls `onSubmit`. */
export function handleElicitationAction(
  action: ElicitationAction,
  pending: ElicitationPending,
  raw: ElicitationFormState,
  onSubmit: (body: ElicitationSubmission) => void,
  onInvalid: (field: string | null, code: string) => void,
): void {
  if (action !== "accept") {
    onSubmit({ id: pending.id, action });
    return;
  }
  const validated = validateElicitationContent(pending.requestedSchema, valuesFromFormState(pending.requestedSchema, raw));
  if (!validated.ok) {
    onInvalid(validated.field, validated.code);
    return;
  }
  onSubmit({ id: pending.id, action: "accept", content: validated.content });
}

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
}: {
  pending: ElicitationPending;
  values: ElicitationFormState;
  error?: string;
  errorField?: string | null;
  onChange: (name: string, value: string | boolean) => void;
  onResolve: (body: ElicitationSubmission) => void;
  onInvalid?: (field: string | null, code: string) => void;
}): React.JSX.Element | null {
  const schema = normalizeRequestedSchema(pending.requestedSchema);
  if (!schema) return null;
  const titleId = "xn-mcp-elicitation-title";
  const submit = (action: ElicitationAction) => {
    handleElicitationAction(action, { ...pending, requestedSchema: schema }, values, onResolve, (field, code) => onInvalid?.(field, code));
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLFormElement>) => {
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
        <button type="submit" className="xn-mcp-elicitation__submit">{tr("提交")}</button>
        <button type="button" onClick={() => submit("decline")}>{tr("拒绝")}</button>
        <button type="button" onClick={() => submit("cancel")}>{tr("取消")}</button>
      </div>
    </form>
  );
}

/** Polls the session elicitation route and mounts the form. Renders nothing while idle. */
export function McpElicitation({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const [pending, setPending] = useState<ElicitationPending | null>(null);
  const [values, setValues] = useState<ElicitationFormState>({});
  const [error, setError] = useState("");
  const [errorField, setErrorField] = useState<string | null>(null);
  useEffect(() => {
    if (!sessionId) return undefined;
    let stopped = false;
    let timer = 0;
    const tick = async () => {
      if (stopped) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        timer = window.setTimeout(() => void tick(), 1500);
        return;
      }
      try {
        const body = await get<unknown>(`/api/sessions/${encodeURIComponent(sessionId)}/elicitation`);
        if (!stopped) setPending(parsePending(body));
      } catch {
        if (!stopped) setPending(null);
      }
      if (!stopped) timer = window.setTimeout(() => void tick(), 1200);
    };
    void tick();
    const onVisible = () => { if (document.visibilityState === "visible") void tick(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
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
      onChange={(name, value) => setValues(current => ({ ...current, [name]: value }))}
      onInvalid={(field, code) => { setErrorField(field); setError(fieldError(code, field)); }}
      onResolve={body => {
        setError("");
        setErrorField(null);
        void post(`/api/sessions/${encodeURIComponent(sessionId)}/elicitation`, body).then(() => setPending(null)).catch(() => {
          setError(tr("没能提交这次回答，请重试。"));
        });
      }}
    />
  );
}
