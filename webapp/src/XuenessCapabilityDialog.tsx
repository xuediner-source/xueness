import { t as tr, tf } from './i18n';
import React from "react";
import { ArrowLeft, ChevronRight } from "lucide-react";
import {
  CAPABILITY_FIELD_SPECS,
  CAPABILITY_LABELS,
  validateCapabilityId,
  validatePluginManifestDraft,
  type CapabilityFieldSpec,
  type CapabilityItem,
  type CapabilityKind,
} from "./xuenessCapabilities";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function shouldDismissCapabilityDialogOnEscape(
  event: { key: string; nativeEvent?: { isComposing?: boolean }; keyCode?: number },
  busy = false,
  hasCancel = true,
): boolean {
  if (event.key !== "Escape" || busy || !hasCancel) return false;
  if (event.nativeEvent?.isComposing || event.keyCode === 229) return false;
  return true;
}

export function trapCapabilityDialogTab(
  event: { key: string; shiftKey: boolean; preventDefault: () => void },
  activeElement: unknown,
  items: { focus: () => void }[],
  fallbackDialog?: { focus?: () => void } | null,
): boolean {
  if (event.key !== "Tab") return false;
  if (!items.length) {
    event.preventDefault();
    fallbackDialog?.focus?.();
    return true;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const activeIndex = items.indexOf(activeElement as { focus: () => void });
  if (activeIndex < 0) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
    return true;
  } else if (event.shiftKey && activeIndex === 0) {
    event.preventDefault();
    last.focus();
    return true;
  } else if (!event.shiftKey && activeIndex === items.length - 1) {
    event.preventDefault();
    first.focus();
    return true;
  }
  return false;
}

/**
 * Create/edit dialog for capability resources (Batch10).
 *
 * Presentational only — the container owns the IO (`createCapabilityItem` /
 * `patchResource`) and surfaces transport failures through `error`. The id is
 * dialog-owned: freely typed (and live-validated) in create mode, immutable in
 * edit mode. Field values seed from the item's top-level keys first, then its
 * `extra` payload, so round-tripped config stays editable.
 */
export type CapabilityDialogProps = {
  open: boolean;
  mode: "create" | "edit";
  kind: CapabilityKind;
  /** Edit-mode initial value; also re-seeds the draft whenever it changes. */
  initial?: CapabilityItem | null;
  busy?: boolean;
  error?: string;
  onCancel?: () => void;
  onSubmit?: (payload: { id: string; fields: Record<string, unknown> }) => void;
  /** Let the containing workbench header mirror the active detail breadcrumb. */
  onBreadcrumbChange?: (parts: string[] | null) => void;
};

/** Top-level then `extra` lookup for one spec key off the raw item. */
function readInitialRaw(initial: CapabilityItem | null, key: string): unknown {
  if (!initial) return undefined;
  const record = initial as unknown as Record<string, unknown>;
  if (key in record) return record[key];
  return initial.extra?.[key];
}

/** Normalise a spec key's initial value into the dialog's draft shape. */
function seedFieldValue(kind: CapabilityKind, spec: CapabilityFieldSpec, initial: CapabilityItem | null): unknown {
  const raw = readInitialRaw(initial, spec.key);
  if (spec.kind === "boolean") {
    // Resource manifests stay inert when first saved. Other new resources keep
    // their existing enabled-by-default behavior.
    if (raw === undefined || raw === null) return spec.key === "enabled" && !initial ? kind !== "plugins" : false;
    return raw === true;
  }
  if (spec.kind === "json") return raw == null ? "" : JSON.stringify(raw, null, 2);
  if (kind === "plugins" && spec.key === "apiVersion" && typeof raw === "number") return String(raw);
  return typeof raw === "string" ? raw : "";
}

function seedFields(kind: CapabilityKind, initial: CapabilityItem | null): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const spec of CAPABILITY_FIELD_SPECS[kind]) fields[spec.key] = seedFieldValue(kind, spec, initial);
  return fields;
}

export function XuenessCapabilityDialog({
  open,
  mode,
  kind,
  initial = null,
  busy = false,
  error,
  onCancel,
  onSubmit,
  onBreadcrumbChange,
}: CapabilityDialogProps): React.JSX.Element | null {
  const [draftId, setDraftId] = React.useState(() => (mode === "edit" ? initial?.id ?? "" : ""));
  const [fields, setFields] = React.useState<Record<string, unknown>>(() => seedFields(kind, initial));
  const dialogRef = React.useRef<HTMLElement | null>(null);

  // Re-seed whenever the dialog (re)opens or its source changes; SSR renders
  // from the lazy initializers above.
  React.useEffect(() => {
    if (open) {
      setDraftId(mode === "edit" ? initial?.id ?? "" : "");
      setFields(seedFields(kind, initial));
    }
  }, [open, mode, kind, initial]);

  const title = mode === "create" ? tf("新建{0}", [tr(CAPABILITY_LABELS[kind])]) : tf("编辑 {0}", [initial?.id ?? ""]);
  React.useEffect(() => {
    if (!open) {
      onBreadcrumbChange?.(null);
      return;
    }
    onBreadcrumbChange?.([tr("能力"), tr(CAPABILITY_LABELS[kind]), title]);
    return () => onBreadcrumbChange?.(null);
  }, [open, kind, title, onBreadcrumbChange]);

  React.useEffect(() => {
    if (!open) return;
    const keepFocusInside = (event: FocusEvent) => {
      if (!dialogRef.current?.contains(event.target as Node)) {
        const target = dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE);
        target?.focus({ preventScroll: true });
      }
    };
    document.addEventListener("focusin", keepFocusInside, true);
    return () => {
      document.removeEventListener("focusin", keepFocusInside, true);
    };
  }, [open]);

  if (!open) return null;

  const idError = mode === "create" ? validateCapabilityId(draftId.trim()) : "";
  const id = mode === "edit" ? initial?.id ?? "" : draftId.trim();
  const initialHasForbiddenPluginCode = kind === "plugins" && Boolean(
    readInitialRaw(initial, "entrypoint") || readInitialRaw(initial, "command"),
  );

  const missingRequired = CAPABILITY_FIELD_SPECS[kind].some(
    (spec) => spec.required === true && String(fields[spec.key] ?? "").trim() === "",
  );

  const invalidJson = CAPABILITY_FIELD_SPECS[kind].some(spec => {
    if (spec.kind !== "json" || !String(fields[spec.key] ?? "").trim()) return false;
    try {
      const value = JSON.parse(String(fields[spec.key]));
      if (spec.key === "capabilities") return !Array.isArray(value) || value.some(x => typeof x !== "string");
      return spec.key === "args" ? !Array.isArray(value) || value.some(x => typeof x !== "string") :
        !value || Array.isArray(value) || typeof value !== "object" || Object.values(value).some(x => typeof x !== "string");
    } catch { return true; }
  });
  const pluginValidationError = kind === "plugins" ? validatePluginManifestDraft(id, fields) : "";
  const buildFields = (): Record<string, unknown> => {
    if (kind === "plugins") {
      const capabilitiesValue = String(fields.capabilities ?? "").trim();
      return {
        name: String(fields.name ?? "").trim() || id,
        description: String(fields.description ?? "").trim(),
        version: String(fields.version ?? "").trim(),
        apiVersion: Number(fields.apiVersion),
        builtin: String(fields.builtin ?? "").trim(),
        capabilities: capabilitiesValue ? JSON.parse(capabilitiesValue) : [],
        enabled: fields.enabled === true,
      };
    }
    const payload: Record<string, unknown> = {};
    for (const spec of CAPABILITY_FIELD_SPECS[kind]) {
      const value = fields[spec.key];
      if (spec.kind === "boolean") {
        // Booleans always travel: an untouched checkbox is still a statement.
        payload[spec.key] = value === true;
        continue;
      }
      if (spec.kind === "json") {
        if (String(value ?? "").trim()) payload[spec.key] = JSON.parse(String(value));
        else if (mode === "edit" && seedFieldValue(kind, spec, initial)) payload[spec.key] = spec.key === "args" || spec.key === "capabilities" ? [] : {};
        continue;
      }
      if (mode === "create") {
        if (spec.key === "name" && !String(value ?? "").trim()) { payload[spec.key] = id; continue; }
        payload[spec.key] = value;
        continue;
      }
      if (value !== seedFieldValue(kind, spec, initial)) payload[spec.key] = value;
    }
    return payload;
  };

  const changedInEdit =
    mode === "edit" &&
    CAPABILITY_FIELD_SPECS[kind].some((spec) => {
      if (spec.kind === "boolean") return (fields[spec.key] === true) !== (seedFieldValue(kind, spec, initial) === true);
      return fields[spec.key] !== seedFieldValue(kind, spec, initial);
    });

  const canSubmit = Boolean(onSubmit) && !busy && !initialHasForbiddenPluginCode && idError === "" && !missingRequired && !invalidJson && !pluginValidationError && (mode === "create" || changedInEdit);

  const setField = (key: string, value: unknown) => setFields((prev) => ({ ...prev, [key]: value }));

  const submit = () => {
    if (!canSubmit) return;
    onSubmit?.({ id, fields: buildFields() });
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    // An IME composition's Enter/Esc belong to the composition, not the dialog.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (shouldDismissCapabilityDialogOnEscape(event, busy, Boolean(onCancel))) {
      event.preventDefault();
      onCancel?.();
      return;
    }
    if (event.key === "Enter") {
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "TEXTAREA") return; // Enter is a newline there
      event.preventDefault();
      submit();
      return;
    }
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const allItems = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter((item) => item.getAttribute("aria-hidden") !== "true");
    const visibleItems = allItems.filter((item) => item.getClientRects().length > 0);
    const items = visibleItems.length > 0 ? visibleItems : allItems;
    trapCapabilityDialogTab(event, document.activeElement, items, dialog);
  };

  return (
    <div className="xn-cap-detail" data-testid="xn-cap-detail">
      <section
        ref={dialogRef}
        tabIndex={-1}
        className="xn-cap-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid="xn-cap-dialog"
        onKeyDown={handleKeyDown}
      >
        <header className="xn-cap-detail__header">
          <nav className="xn-cap-detail__breadcrumb" aria-label={tr("面包屑")} data-testid="xn-cap-dialog-breadcrumb">
            {onCancel ? (
              <button type="button" className="xn-cap-detail__back" disabled={busy} onClick={onCancel}>
                <ArrowLeft size={15} aria-hidden="true" />{tr("能力")}
              </button>
            ) : <span>{tr("能力")}</span>}
            <ChevronRight size={14} aria-hidden="true" />
            <span>{tr(CAPABILITY_LABELS[kind])}</span>
            <ChevronRight size={14} aria-hidden="true" />
            <span aria-current="page">{mode === "create" ? tr("新建") : tr("编辑")}</span>
          </nav>
          <h2 className="xn-cap-detail__title">{title}</h2>
          <p className="xn-cap-detail__hint">{kind === "plugins"
            ? tr("编辑数据型插件清单。清单不会安装或执行外部代码，只能指向受信任的 Xueness 内置能力。")
            : tr("编辑能力资源的名称、说明和实际配置字段。")}</p>
        </header>
        <div className="xn-cap-detail__body">
        <div className="xn-cap-dialog__field">
          <label htmlFor="xn-cap-dialog-id-input">ID</label>
          <input
            id="xn-cap-dialog-id-input"
            className="xn-dialog__input xn-cap-dialog__id-input"
            data-testid="xn-cap-dialog-id"
            value={mode === "edit" ? initial?.id ?? "" : draftId}
            readOnly={mode === "edit"}
            autoFocus={mode === "create"}
            aria-invalid={idError ? true : undefined}
            onChange={(event) => setDraftId(event.target.value)}
            disabled={busy}
            placeholder={mode === "create" ? tr("字母、数字、点、下划线、连字符") : undefined}
          />
          {idError && (
            <p className="xn-cap-dialog__error" role="alert">
              {tr(idError)}
            </p>
          )}
        </div>
        {invalidJson && <p role="alert">{tr("JSON 配置格式无效")}</p>}
        {initialHasForbiddenPluginCode && <p className="xn-cap-dialog__error" role="alert" data-testid="xn-plugin-manifest-blocked">{tr("此清单含有被拒绝的可执行字段，不能编辑或启用；请删除后重新导入纯数据清单。")}</p>}
        {pluginValidationError && !invalidJson && <p className="xn-cap-dialog__error" role="alert" data-testid="xn-plugin-manifest-error">{tr(pluginValidationError)}</p>}
        {CAPABILITY_FIELD_SPECS[kind].map((spec) => {
          const fieldId = `xn-cap-field-${spec.key}`;
          const testid = `xn-cap-dialog-field-${spec.key}`;
          if (spec.kind === "boolean") {
            return (
              <div key={spec.key} className="xn-cap-dialog__field xn-cap-dialog__field--boolean">
                <input
                  id={fieldId}
                  type="checkbox"
                  data-testid={testid}
                  checked={fields[spec.key] === true}
                  disabled={busy}
                  onChange={(event) => setField(spec.key, event.target.checked)}
                />
                <label htmlFor={fieldId}>{tr(spec.label)}</label>
              </div>
            );
          }
          const value = String(fields[spec.key] ?? "");
          return (
            <div key={spec.key} className="xn-cap-dialog__field">
              <label htmlFor={fieldId}>{tr(spec.label)}</label>
              {(spec.kind === "textarea" || spec.kind === "json") ? (
                <textarea
                  id={fieldId}
                  className="xn-dialog__input xn-cap-dialog__textarea"
                  data-testid={testid}
                  rows={6}
                  value={value}
                  disabled={busy}
                  placeholder={spec.placeholder ? tr(spec.placeholder) : undefined}
                  onChange={(event) => setField(spec.key, event.target.value)}
                />
              ) : (
                <input
                  id={fieldId}
                  className="xn-dialog__input"
                  data-testid={testid}
                  value={value}
                  disabled={busy}
                  placeholder={spec.placeholder ? tr(spec.placeholder) : undefined}
                  onChange={(event) => setField(spec.key, event.target.value)}
                />
              )}
            </div>
          );
        })}
        {error && (
          <p className="xn-cap-dialog__error" role="alert">
            {error}
          </p>
        )}
        <div className="xn-cap-detail__actions">
          {onCancel && <button
            type="button"
            className="xn-btn xn-btn--md xn-btn--secondary"
            data-testid="xn-cap-dialog-cancel"
            disabled={busy}
            onClick={onCancel}
          >{tr("取消")}</button>}
          {onSubmit && <button
            type="button"
            className="xn-btn xn-btn--md xn-btn--primary"
            data-testid="xn-cap-dialog-submit"
            disabled={!canSubmit}
            onClick={submit}
          >
            {mode === "create" ? tr("创建") : tr("保存")}
          </button>}
        </div>
        </div>
      </section>
    </div>
  );
}
