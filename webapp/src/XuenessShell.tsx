import { t as tr, tf } from './i18n';
import React, { useEffect, useRef, useState } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy, TriangleAlert, X } from "lucide-react";
import { Badge } from "./ui/primitives";
import { IconBack, IconCheck, IconLoader, IconX, IconMenu, IconXuenessMark } from "./ui/icons";
import { CodeContent } from "./ui/CodeContent";
import type { CodeLanguage } from "./ui/CodePreview";
import { displayBinding, isImeComposingEvent } from "./xuenessShortcutDisplay";

export function shouldCloseNarrowSidebarOnEscape(event: {
  key: string;
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
  compositionActive?: boolean;
  defaultPrevented?: boolean;
}): boolean {
  return event.key === "Escape" && !event.defaultPrevented && !isImeComposingEvent(event);
}

/**
 * Application shell in the chat-workbench shape: a dark sidebar (nav actions,
 * task list, footer) plus a main area. The ordinary web layout has no top
 * brand bar; Electron can provide its native-aligned host bar through the
 * optional titlebar slot.
 */
export type ShellProps = {
  /** Optional host title bar. Web workbenches leave this unset. */
  titlebar?: React.ReactNode;
  /** Sidebar body: nav actions + task list. */
  sidebar: React.ReactNode;
  /** Sidebar footer: brand + settings entry. */
  sidebarFooter?: React.ReactNode;
  /** Navigation changes dismiss a narrow drawer, including keyboard actions. */
  navigationKey?: string;
  sidebarToggleToken?: number;
  /** Start with the sidebar collapsed on wide screens (e.g. the lightweight
   * profile's minimal layout); toggling still works and switching the request
   * back to false restores the previously collapsed/expanded choice. */
  initialSidebarCollapsed?: boolean;
  /** Task-history navigation, wired by the workbench container. */
  canGoBack?: boolean;
  canGoForward?: boolean;
  onGoBack?: () => void;
  onGoForward?: () => void;
  children: React.ReactNode;
};

export function Shell({
  titlebar,
  sidebar,
  sidebarFooter,
  navigationKey,
  sidebarToggleToken = 0,
  initialSidebarCollapsed = false,
  canGoBack = false,
  canGoForward = false,
  onGoBack,
  onGoForward,
  children,
}: ShellProps): React.JSX.Element {
  const [sidebarOpen, setSidebarOpen] = React.useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(initialSidebarCollapsed);
  const requestedCollapsed = React.useRef(initialSidebarCollapsed);
  const [narrow, setNarrow] = React.useState(() => typeof window === "undefined" || window.matchMedia("(max-width: 900px)").matches);
  const asideRef = React.useRef<HTMLElement>(null);
  const mainRef = React.useRef<HTMLElement>(null);
  const toggleRef = React.useRef<HTMLButtonElement>(null);
  const expanded = narrow ? sidebarOpen : !sidebarCollapsed;
  const previousNavigation = React.useRef(navigationKey);
  const previousToggleToken = React.useRef(sidebarToggleToken);
  React.useEffect(() => {
    if (previousToggleToken.current !== sidebarToggleToken) {
      if (narrow) setSidebarOpen(value => !value);
      else setSidebarCollapsed(value => !value);
    }
    previousToggleToken.current = sidebarToggleToken;
  }, [sidebarToggleToken, narrow]);
  React.useEffect(() => {
    // A profile switch re-requests the starting sidebar state without wiping a
    // collapse the user chose manually in the meantime.
    const requested = Boolean(initialSidebarCollapsed);
    if (requestedCollapsed.current === requested) return;
    requestedCollapsed.current = requested;
    if (narrow) setSidebarOpen(false);
    else setSidebarCollapsed(requested);
  }, [initialSidebarCollapsed, narrow]);
  const previousCollapsed = React.useRef(false);
  const previousDrawer = React.useRef(false);
  const drawerFocus = React.useRef<"main" | "toggle" | null>(null);
  const closeDrawer = React.useCallback(() => {
    drawerFocus.current = "toggle";
    setSidebarOpen(false);
  }, []);
  React.useEffect(() => {
    const media = window.matchMedia("(max-width: 900px)");
    const change = () => { setNarrow(media.matches); setSidebarOpen(false); };
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  React.useEffect(() => {
    if (previousNavigation.current !== navigationKey) setSidebarOpen(false);
    previousNavigation.current = navigationKey;
  }, [navigationKey]);
  React.useEffect(() => {
    if (!narrow && previousCollapsed.current !== sidebarCollapsed) {
      if (sidebarCollapsed) toggleRef.current?.focus();
      else asideRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    }
    previousCollapsed.current = sidebarCollapsed;
  }, [sidebarCollapsed, narrow]);
  React.useEffect(() => {
    if (narrow && previousDrawer.current && !sidebarOpen) {
      if (drawerFocus.current === "toggle") toggleRef.current?.focus();
      else if (drawerFocus.current === "main") mainRef.current?.focus();
      drawerFocus.current = null;
    }
    previousDrawer.current = sidebarOpen;
  }, [narrow, sidebarOpen]);
  React.useEffect(() => {
    if (!narrow || !sidebarOpen) return;
    const aside = asideRef.current;
    const focusable = () => Array.from(aside?.querySelectorAll<HTMLElement>("a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])") ?? []).filter(node => node.getAttribute("aria-hidden") !== "true" && node.getClientRects().length);
    const isOwnedSelectPortal = (target: EventTarget | null) => {
      if (!(target instanceof Element) || !aside) return false;
      const content = target.closest<HTMLElement>(".xn-select-menu[data-xn-select-portal-owner]");
      const owner = content?.dataset.xnSelectPortalOwner;
      if (!owner) return false;
      return Array.from(aside.querySelectorAll<HTMLElement>("[data-xn-select-portal-trigger]"))
        .some(trigger => trigger.dataset.xnSelectPortalTrigger === owner);
    };
    const activeModalOutsideDrawer = () => Array.from(document.querySelectorAll<HTMLElement>('[aria-modal="true"]'))
      .filter(activeModal => activeModal !== aside && !aside?.contains(activeModal))
      .at(-1) ?? null;
    (focusable()[0] ?? aside)?.focus();
    const key = (event: KeyboardEvent) => {
      // Nested controls such as Radix Select own their keyboard interaction.
      // Its portaled listbox is allowed only when its explicit owner trigger is
      // inside this drawer; unrelated body portals remain outside the scope.
      if (event.defaultPrevented || isOwnedSelectPortal(document.activeElement)) return;
      const outsideModal = activeModalOutsideDrawer();
      if (outsideModal?.contains(document.activeElement)) return;
      if (shouldCloseNarrowSidebarOnEscape(event)) { event.preventDefault(); closeDrawer(); return; }
      if (event.key !== "Tab") return;
      const items = focusable();
      const first = items[0], last = items[items.length - 1];
      if (!first || !last) { event.preventDefault(); aside?.focus(); return; }
      const activeIndex = items.indexOf(document.activeElement as HTMLElement);
      if (activeIndex < 0) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
      else if (event.shiftKey && activeIndex === 0) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && activeIndex === items.length - 1) { event.preventDefault(); first.focus(); }
    };
    const keepFocusInside = (event: FocusEvent) => {
      if (aside?.contains(event.target as Node)) return;
      if (isOwnedSelectPortal(event.target)) return;
      if (activeModalOutsideDrawer()?.contains(event.target as Node)) return;
      (focusable()[0] ?? aside)?.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", key);
    document.addEventListener("focusin", keepFocusInside, true);
    return () => {
      document.removeEventListener("keydown", key);
      document.removeEventListener("focusin", keepFocusInside, true);
    };
  }, [narrow, sidebarOpen, closeDrawer]);

  return (
    <div
      className={`xn-shell-layout ${titlebar ? "xn-shell-layout--desktop-titlebar" : ""} ${titlebar && !sidebar ? "xn-shell-layout--no-sidebar" : ""} ${narrow && sidebarOpen ? "xn-shell-layout--sidebar-open" : ""} ${!narrow && sidebarCollapsed ? "xn-shell-layout--sidebar-collapsed" : ""}`}
      data-testid="xn-shell"
      data-sidebar-open={sidebarOpen}
    >
      {titlebar && <div className="xn-shell-layout__titlebar" data-testid="xn-shell-titlebar-host">{titlebar}</div>}
      {sidebar && (
        <aside
          ref={asideRef}
          id="xn-shell-sidebar"
          tabIndex={narrow && sidebarOpen ? -1 : undefined}
          className="xn-shell-sidebar"
          data-testid="xn-shell-sidebar"
          aria-label={tr("侧边栏导航")}
          role={narrow && sidebarOpen ? "dialog" : undefined}
          aria-modal={narrow && sidebarOpen ? true : undefined}
          onClickCapture={(event) => {
            if (narrow && (event.target as HTMLElement).closest("[data-sidebar-navigate]")) {
              drawerFocus.current = "main";
              setSidebarOpen(false);
            }
          }}
        >
          {!titlebar && <div className="xn-shell-sidebar__head">
            <span className="xn-sidebar-brand">
              <IconXuenessMark size={18} className="xn-sidebar-brand__mark" />
              <span className="xn-sidebar-brand__word">Xueness</span>
            </span>
            <div className="xn-shell-sidebar__head-actions">
              <div className="xn-shell-history" role="group" aria-label={tr("任务导航")}>
                <button
                  type="button"
                  className="xn-shell-history__button"
                  aria-label={tr("后退")}
                  title={tr("后退")}
                  data-testid="xn-shell-history-back"
                  disabled={!canGoBack || !onGoBack}
                  onClick={onGoBack}
                >
                  <IconBack size={15} />
                </button>
                <button
                  type="button"
                  className="xn-shell-history__button"
                  aria-label={tr("前进")}
                  title={tr("前进")}
                  data-testid="xn-shell-history-forward"
                  disabled={!canGoForward || !onGoForward}
                  onClick={onGoForward}
                >
                  <IconBack size={15} className="xn-shell-history__forward-icon" />
                </button>
              </div>
              <button type="button" className="xn-sidebar-collapse" aria-label={tr("收起侧栏")}
                aria-expanded={expanded} aria-controls="xn-shell-sidebar"
                onClick={() => narrow ? closeDrawer() : setSidebarCollapsed(true)}>
                <IconMenu size={16} />
              </button>
            </div>
          </div>}
          <div className="xn-shell-sidebar__body">{sidebar}</div>
          {sidebarFooter && (
            <div className="xn-shell-sidebar__footer" data-testid="xn-shell-sidebar-footer">
              {sidebarFooter}
            </div>
          )}
        </aside>
      )}

      {sidebar && narrow && sidebarOpen && <button type="button" className="xn-shell-backdrop" aria-label={tr("收起侧栏")} tabIndex={-1} onClick={closeDrawer} />}

      <main id="xn-shell-main" ref={mainRef} tabIndex={-1} inert={Boolean(sidebar && narrow && sidebarOpen)} className="xn-shell-main" data-testid="xn-shell-main">
        {sidebar && !titlebar && (
          <button
            ref={toggleRef}
            type="button"
            className="xn-shell-sidebar-toggle"
            aria-label={expanded ? tr("收起侧栏") : tr("展开侧栏")}
            aria-expanded={expanded}
            aria-controls="xn-shell-sidebar"
            onClick={() => narrow ? setSidebarOpen((prev) => !prev) : setSidebarCollapsed((prev) => !prev)}
            data-testid="xn-shell-sidebar-toggle"
          >
            <IconMenu size={16} />
          </button>
        )}
        <div className="xn-shell-main__panel" data-testid="xn-shell-panel">
          {children}
        </div>
      </main>
    </div>
  );
}

/** Sidebar top actions with OS-aware Mod shortcut labels. */
export type SidebarAction = {
  id: string;
  /** Thin-line SVG node (see ui/icons); decorative — the label carries meaning. */
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
};

export function SidebarActions({ actions, platform }: { actions: SidebarAction[]; platform?: string }): React.JSX.Element {
  return (
    <div className="xn-sidebar-actions" data-testid="xn-sidebar-actions">
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          className="xn-sidebar-action"
          data-testid={`xn-sidebar-action-${action.id}`}
          onClick={action.onClick}
          data-sidebar-navigate="true"
        >
          <span className="xn-sidebar-action__icon" aria-hidden="true">
            {action.icon}
          </span>
          <span className="xn-sidebar-action__label">{action.label}</span>
          {action.shortcut && (
            <kbd className="xn-sidebar-action__shortcut">{displayBinding(action.shortcut, platform)}</kbd>
          )}
        </button>
      ))}
    </div>
  );
}

/**
 * Timeline message forms matching the chat-workbench shape:
 * user = right-aligned bubble, assistant = borderless prose, tool = compact
 * one-line entry with a status badge, completion/question = distinct cards.
 */
export type TimelineCardProps = {
  role: string;
  /** Tool name (role="tool"). */
  name?: string;
  /** Formatted tool subject, shown monospaced next to the name. */
  subject?: string;
  title?: string;
  status?: "ok" | "error" | "pending" | string;
  statusLabel?: string;
  /** 正文（纯文本；等宽显示当 mono 为真） */
  body: string;
  mono?: boolean;
  meta?: string;
  /** Measured duration only; omit when timing was not provided. */
  durationMs?: number;
  /** Renders safe, deliberately limited Markdown for prose (not tool output). */
  markdown?: boolean;
  seq?: number;
  detailsOpen?: boolean;
};

type ClipboardWriter = Pick<Clipboard, "writeText">;

/** Resolve clipboard failures as data so both message and code actions can show feedback. */
export async function copyTextToClipboard(
  text: string,
  clipboard?: ClipboardWriter,
): Promise<boolean> {
  let writer = clipboard;
  if (!writer) {
    try {
      writer = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    } catch {
      return false;
    }
  }
  if (!writer || typeof writer.writeText !== "function") return false;
  try {
    await writer.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function CopyFeedbackAction({
  text,
  testId,
  label,
}: {
  text: string;
  testId: string;
  label: string;
}): React.JSX.Element {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => () => {
    mountedRef.current = false;
    if (timerRef.current !== null) clearTimeout(timerRef.current);
  }, []);

  const copy = async () => {
    const copied = await copyTextToClipboard(text);
    if (!mountedRef.current) return;
    setState(copied ? "copied" : "failed");
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      if (mountedRef.current) setState("idle");
    }, copied ? 1200 : 2400);
  };

  return (
    <span className="xn-msg__copy-action">
      <button
        type="button"
        className="xn-msg__copy-button"
        aria-label={label}
        title={label}
        data-testid={testId}
        disabled={text.length === 0}
        onClick={() => void copy()}
      >
        {state === "copied" ? <Check size={14} aria-hidden="true" /> : state === "failed" ? <X size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      </button>
      <span className={`xn-msg__copy-feedback${state === "failed" ? " xn-msg__copy-feedback--error" : ""}`} role="status" aria-live="polite">
        {state === "copied" ? tr("已复制") : state === "failed" ? tr("复制失败") : ""}
      </span>
    </span>
  );
}

function statusToTone(status?: string): "ok" | "error" | "warn" | "neutral" {
  if (status === "ok") return "ok";
  if (status === "error") return "error";
  if (status === "pending" || status === "running" || status === "review") return "warn";
  return "neutral";
}

function ToolStatusIcon({ status, terminal = false }: { status?: string; terminal?: boolean }): React.JSX.Element {
  const tone = statusToTone(status);
  return (
    <span className={`xn-msg__tool-icon xn-msg__tool-icon--${tone}`} aria-hidden="true">
      {status === "ok" ? (
        <IconCheck size={13} />
      ) : status === "error" ? (
        <IconX size={13} />
      ) : status === "cancelled" ? (
        <span style={{ display: "inline-block", width: 8, height: 2, background: "currentColor", borderRadius: 1 }} />
      ) : terminal ? (
        <TriangleAlert size={13} />
      ) : (
        <IconLoader size={13} className="xn-spin" />
      )}
    </span>
  );
}

export const TimelineCard = React.memo(function TimelineCard({
  role,
  name,
  subject,
  title,
  status,
  statusLabel,
  body,
  mono,
  meta,
  durationMs,
  markdown = false,
  seq,
  detailsOpen = false,
}: TimelineCardProps): React.JSX.Element {
  const terminalStatus = role === 'completion' && (status === 'pending' || status === 'running') ? 'review' : status;
  const tone = statusToTone(terminalStatus);
  const duration = typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0
    ? durationMs < 1000 ? `${Math.round(durationMs)} ms` : `${(durationMs / 1000).toFixed(1)} s`
    : null;
  const seqTag = typeof seq === "number" ? { "data-seq": seq } : {};

  if (role === "user") {
    const copyTestId = typeof seq === "number" ? `xn-copy-user-${seq}` : "xn-copy-user";
    return (
      <div
        className="xn-msg xn-msg--user"
        data-testid="xn-timeline-card"
        data-role="user"
        {...seqTag}
      >
        <div className="xn-msg__body">
          <div className="xn-msg__bubble" data-testid="xn-card-body">
            {body}
          </div>
          <div className="xn-msg__actions" role="group" aria-label={tr("消息操作")}>
            <CopyFeedbackAction text={body} testId={copyTestId} label={tr("复制消息")} />
          </div>
        </div>
        <span className="xn-msg__avatar" aria-hidden="true">{tr("你")}</span>
      </div>
    );
  }

  if (role === "tool") {
    const label = name || title || "tool";
    const longSubject = Boolean(subject && subject.length > 96);
    const longError = status === "error" && body.length > 280;
    return (
      <div
        className={`xn-msg xn-msg--tool ${status ? `xn-msg--status-${tone}` : ""}`}
        data-testid="xn-timeline-card"
        data-role="tool"
        data-status={status}
        {...seqTag}
      >
        <div className="xn-msg__tool-line">
          <ToolStatusIcon status={status} />
          <span className="xn-msg__tool-name">{label}</span>
          {subject && (longSubject ? (
            <details className="xn-msg__tool-details" open={detailsOpen}>
              <summary className="xn-msg__tool-subject" title={subject}>{subject}</summary>
              <pre className="xn-msg__tool-detail-body">{subject}</pre>
            </details>
          ) : <span className="xn-msg__tool-subject" title={subject}>{subject}</span>)}
          <span className="xn-msg__tool-trailing">
            {meta && <span className="xn-card__meta">{meta}</span>}
            {duration && <span className="xn-card__duration" data-testid="xn-card-duration">{duration}</span>}
            {status && (
              <Badge tone={tone} data-testid="xn-card-status">
                {status}
              </Badge>
            )}
          </span>
        </div>
        {status === "error" && body && (
          longError ? (
            <details className="xn-msg__tool-error-details" open={detailsOpen}>
              <summary className="xn-msg__tool-error" data-testid="xn-card-body">{body.slice(0, 240)}…</summary>
              <pre className="xn-msg__tool-detail-body xn-msg__tool-detail-body--error">{body}</pre>
            </details>
          ) : <div className="xn-msg__tool-error" data-testid="xn-card-body">{body}</div>
        )}
      </div>
    );
  }

  if (role === "completion") {
    return (
      <div
        className={`xn-msg xn-msg--completion ${status ? `xn-msg--status-${tone}` : ""}`}
        data-testid="xn-timeline-card"
        data-role="completion"
        data-status={terminalStatus}
        {...seqTag}
      >
        <div className="xn-msg__tool-line">
          <ToolStatusIcon status={terminalStatus} terminal />
          <span className="xn-msg__tool-name">{title || tr("运行结束")}</span>
          <span className="xn-msg__tool-trailing">
            {status && (
              <Badge tone={tone} data-testid="xn-card-status">
                {statusLabel ?? tr('运行结束')}
              </Badge>
            )}
          </span>
        </div>
        {body && (
          <div className="xn-msg__prose" data-testid="xn-card-body">
            {markdown ? <SimpleMarkdown text={body} /> : body}
          </div>
        )}
      </div>
    );
  }

  if (role === "question") {
    return (
      <div
        className="xn-msg xn-msg--question"
        data-testid="xn-timeline-card"
        data-role="question"
        {...seqTag}
      >
        <div className="xn-msg__tool-line">
          <span className="xn-msg__tool-icon xn-msg__tool-icon--warn" aria-hidden="true">?</span>
          <span className="xn-msg__tool-name">{title || tr("等待回答")}</span>
        </div>
        <div className="xn-msg__prose" data-testid="xn-card-body">
          {body}
        </div>
      </div>
    );
  }

  // assistant and everything else: borderless prose.
  const copyTestId = typeof seq === "number" ? `xn-copy-assistant-${seq}` : "xn-copy-assistant";
  return (
    <div
      className="xn-msg xn-msg--assistant"
      data-testid="xn-timeline-card"
      data-role={role}
      {...seqTag}
    >
      <div className="xn-msg__prose" data-testid="xn-card-body">
        {markdown ? <SimpleMarkdown text={body} /> : body}
      </div>
      <div className="xn-msg__actions" role="group" aria-label={tr("消息操作")}>
        <CopyFeedbackAction text={body} testId={copyTestId} label={tr("复制消息")} />
      </div>
    </div>
  );
});

const MARKDOWN_CODE_LANGUAGES: Record<string, CodeLanguage> = {
  bash: "bash", sh: "bash", shell: "bash", zsh: "bash",
  c: "cpp", cpp: "cpp", cxx: "cpp", h: "cpp", hpp: "cpp",
  css: "css", diff: "diff", patch: "diff", go: "go", golang: "go",
  html: "html", xml: "html", js: "javascript", javascript: "javascript", mjs: "javascript",
  jsx: "jsx", json: "json", md: "markdown", markdown: "markdown",
  py: "python", python: "python", rs: "rust", rust: "rust", sql: "sql",
  ts: "typescript", typescript: "typescript", tsx: "tsx", yml: "yaml", yaml: "yaml",
};

function markdownCodeLanguage(info?: string): CodeLanguage | "text" {
  const language = info?.trim().split(/\s+/u)[0]?.toLowerCase().replace(/^\./u, "");
  return language ? MARKDOWN_CODE_LANGUAGES[language] ?? "text" : "text";
}

function markdownNodeText(value: React.ReactNode): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(markdownNodeText).join("");
  if (React.isValidElement<{ children?: React.ReactNode }>(value)) return markdownNodeText(value.props.children);
  return "";
}

function MarkdownCodeFence({
  text,
  info,
}: {
  text: string;
  info?: string;
}): React.JSX.Element {
  const options = React.useContext(MarkdownRenderOptionsContext);
  const language = markdownCodeLanguage(info);
  const languageLabel = info?.trim().split(/\s+/u)[0] || tr("纯文本");
  const testId = `xn-copy-code-${React.useId()}`;
  return (
    <div className="xn-md__code-fence" data-language={language} data-highlight={options.codeHighlightTiming}>
      <header className="xn-md__code-header">
        <span>{languageLabel}</span>
        <CopyFeedbackAction text={text} testId={testId} label={tr("复制代码")} />
      </header>
      <CodeContent text={text} language={language} highlightTiming={options.codeHighlightTiming} />
    </div>
  );
}

function safeMarkdownUrl(url: string): string {
  const safe = defaultUrlTransform(url);
  // Keep the library's conservative protocol allowlist explicit at our render boundary.
  if (!safe || /^(?:javascript|data|vbscript):/iu.test(safe.trim())) return "";
  return safe;
}

const markdownComponents: Components = {
  h1: ({ node: _node, children, ...props }) => <h1 className="xn-md__heading xn-md__heading--1" {...props}>{children}</h1>,
  h2: ({ node: _node, children, ...props }) => <h2 className="xn-md__heading xn-md__heading--2" {...props}>{children}</h2>,
  h3: ({ node: _node, children, ...props }) => <h3 className="xn-md__heading xn-md__heading--3" {...props}>{children}</h3>,
  h4: ({ node: _node, children, ...props }) => <h4 className="xn-md__heading xn-md__heading--4" {...props}>{children}</h4>,
  h5: ({ node: _node, children, ...props }) => <h5 className="xn-md__heading xn-md__heading--5" {...props}>{children}</h5>,
  h6: ({ node: _node, children, ...props }) => <h6 className="xn-md__heading xn-md__heading--6" {...props}>{children}</h6>,
  p: ({ node: _node, children, ...props }) => <p className="xn-md__paragraph" {...props}>{children}</p>,
  ul: ({ node: _node, children, className, ...props }) => <ul className={`xn-md__list xn-md__list--unordered ${className ?? ""}`.trim()} {...props}>{children}</ul>,
  ol: ({ node: _node, children, className, ...props }) => <ol className={`xn-md__list xn-md__list--ordered ${className ?? ""}`.trim()} {...props}>{children}</ol>,
  li: ({ node: _node, children, className, ...props }) => <li className={`xn-md__list-item ${className ?? ""}`.trim()} {...props}>{children}</li>,
  blockquote: ({ node: _node, children, ...props }) => <blockquote className="xn-md__blockquote" {...props}>{children}</blockquote>,
  table: ({ node: _node, children, ...props }) => <div className="xn-md__table-wrap"><table className="xn-md__table" {...props}>{children}</table></div>,
  thead: ({ node: _node, children, ...props }) => <thead {...props}>{children}</thead>,
  tbody: ({ node: _node, children, ...props }) => <tbody {...props}>{children}</tbody>,
  tr: ({ node: _node, children, ...props }) => <tr {...props}>{children}</tr>,
  th: ({ node: _node, children, ...props }) => <th className="xn-md__table-cell xn-md__table-cell--head" {...props}>{children}</th>,
  td: ({ node: _node, children, ...props }) => <td className="xn-md__table-cell" {...props}>{children}</td>,
  a: ({ node: _node, href, children, ...props }) => {
    const safeHref = href ? safeMarkdownUrl(href) : "";
    if (!safeHref) return <span>{children}</span>;
    const external = /^https?:\/\//iu.test(safeHref);
    return <a href={safeHref} {...props} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>{children}</a>;
  },
  img: ({ node: _node, src, alt, ...props }) => {
    const safeSrc = src ? safeMarkdownUrl(src) : "";
    return safeSrc ? <img src={safeSrc} alt={alt ?? ""} loading="lazy" className="xn-md__image" {...props} /> : null;
  },
  code: ({ node: _node, children, className, ...props }) => <code className={`xn-md__inline-code ${className ?? ""}`.trim()} {...props}>{children}</code>,
  strong: ({ node: _node, children, ...props }) => <strong className="xn-md__bold" {...props}>{children}</strong>,
  em: ({ node: _node, children, ...props }) => <em className="xn-md__italic" {...props}>{children}</em>,
  del: ({ node: _node, children, ...props }) => <del className="xn-md__strike" {...props}>{children}</del>,
  pre: ({ node: _node, children, ...props }) => {
    const child = React.Children.toArray(children)[0];
    if (React.isValidElement<{ children?: React.ReactNode; className?: string }>(child)) {
      const code = child.props;
      return <MarkdownCodeFence text={markdownNodeText(code.children).replace(/\n$/u, "")} info={code.className?.match(/language-([^\s]+)/u)?.[1]} />;
    }
    return <pre className="xn-md__code-block" {...props}>{children}</pre>;
  },
};

const REMARK_PLUGINS = [remarkGfm];

/** Entries kept in the content-keyed markdown element cache before the oldest is evicted. */
export const MARKDOWN_ELEMENT_CACHE_LIMIT = 240;
const markdownElementCache = new Map<string, React.JSX.Element>();

export type MarkdownHighlightTiming = "immediate" | "on-visible" | "after-stream";
export type MarkdownRenderOptions = {
  /** When markdown code fences may run syntax highlighting. */
  codeHighlightTiming: MarkdownHighlightTiming;
  /** Whether rendered output may populate the content-keyed element cache. */
  cacheParseResults: boolean;
};

/** Stream-aware render options for markdown prose. Default keeps historical
 * behavior: highlight immediately and always cache. Streaming transcriptions
 * provide `after-stream` (defer fence highlighting until the stream settles)
 * and disable caching so growing transient text never evicts real entries. */
export const MarkdownRenderOptionsContext = React.createContext<MarkdownRenderOptions>({
  codeHighlightTiming: "immediate",
  cacheParseResults: true,
});

function renderMarkdownElements(text: string): React.JSX.Element {
  return ReactMarkdown({
    children: text,
    remarkPlugins: REMARK_PLUGINS,
    components: markdownComponents,
    skipHtml: true,
    urlTransform: safeMarkdownUrl,
  });
}

/**
 * ReactMarkdown element tree for `text`, memoized by exact content: identical
 * markdown (virtual-window remounts, session switches, repeated renders of
 * unchanged history) parses and compiles once. `ReactMarkdown` is a pure
 * function without hooks (react-markdown v10 `Markdown`), so calling it
 * directly here yields the same element tree the JSX path would render.
 * With `cacheResults=false` the tree is rendered fresh and the cache is left
 * untouched (used for still-growing streaming text).
 */
export function cachedMarkdownElements(text: string, cacheResults = true): React.JSX.Element {
  if (!cacheResults) return renderMarkdownElements(text);
  const cached = markdownElementCache.get(text);
  if (cached) {
    // Re-insert so Map insertion order keeps this entry as most-recently used.
    markdownElementCache.delete(text);
    markdownElementCache.set(text, cached);
    return cached;
  }
  const elements = renderMarkdownElements(text);
  markdownElementCache.set(text, elements);
  if (markdownElementCache.size > MARKDOWN_ELEMENT_CACHE_LIMIT) {
    const oldest = markdownElementCache.keys().next().value;
    if (oldest !== undefined) markdownElementCache.delete(oldest);
  }
  return elements;
}

/** Markdown renderer for transcript prose. Raw HTML stays disabled; unsafe URL schemes are omitted. */
export const SimpleMarkdown = React.memo(function SimpleMarkdown({ text }: { text: string }): React.JSX.Element {
  const options = React.useContext(MarkdownRenderOptionsContext);
  return (
    <div className="xn-md" data-testid="xn-simple-markdown">
      {cachedMarkdownElements(text, options.cacheParseResults)}
    </div>
  );
});
