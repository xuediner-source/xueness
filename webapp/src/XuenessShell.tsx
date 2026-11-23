export { prepareStreamingMarkdown } from './ui/StreamingCommitGate';
import { t as tr } from './i18n';
import { useSidebarPreference } from './plugins/sessions/sidebarPreference';
import React, { useEffect, useState } from "react";
import { IconBack, IconMenu, IconXuenessMark } from "./ui/icons";
import { displayBinding, isImeComposingEvent } from "./xuenessShortcutDisplay";
import { proseWithoutVisualizations, splitVisualizations, VisualizationFrame } from "./plugins/sessions/Visualizations";

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
  /** Optional presentation slots. A real rail keeps navigation outside the
   * scrolling task sheet without changing any navigation capability. */
  sidebarRail?: React.ReactNode;
  sidebarHeader?: React.ReactNode;
  /** Plugin-owned resize control and selected width; shell only lays them out. */
  sidebarResize?: React.ReactNode;
  sidebarWidth?: number;
  /** Navigation changes dismiss a narrow drawer, including keyboard actions. */
  navigationKey?: string;
  sidebarToggleToken?: number;
  /** Start with the sidebar collapsed on wide screens (e.g. the lightweight
   * profile's minimal layout); toggling still works and switching the request
   * back to false restores the previously collapsed/expanded choice. */
  initialSidebarCollapsed?: boolean;
  sidebarPersistenceEnabled?: boolean;
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
  sidebarRail,
  sidebarHeader,
  sidebarResize,
  sidebarWidth,
  navigationKey,
  sidebarToggleToken = 0,
  initialSidebarCollapsed = false,
  sidebarPersistenceEnabled = false,
  canGoBack = false,
  canGoForward = false,
  onGoBack,
  onGoForward,
  children,
}: ShellProps): React.JSX.Element {
  const [sidebarOpen, setSidebarOpen] = React.useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useSidebarPreference(initialSidebarCollapsed, sidebarPersistenceEnabled);
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
  // Fetch the markdown parser right after the first paint (passive effects run after it),
  // in parallel with the first session reads, so a transcript rarely waits for it.
  React.useEffect(() => { void loadMarkdownRenderer().catch(() => undefined); }, []);
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
      style={sidebarWidth === undefined ? undefined : { '--xn-shell-sidebar-width': `${sidebarWidth}px` } as React.CSSProperties}
    >
      {titlebar && <div className="xn-shell-layout__titlebar" data-testid="xn-shell-titlebar-host">{titlebar}</div>}
      {sidebar && (
        <aside
          ref={asideRef}
          id="xn-shell-sidebar"
          tabIndex={narrow && sidebarOpen ? -1 : undefined}
          className={`xn-shell-sidebar${sidebarRail ? " xn-shell-sidebar--with-rail" : ""}`}
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
          {sidebarRail && <div className="xn-shell-sidebar__rail" data-testid="xn-sidebar-rail">
            <div className="xn-shell-sidebar__rail-actions">{sidebarRail}</div>
            {sidebarFooter && <div className="xn-shell-sidebar__rail-footer" data-testid="xn-shell-sidebar-footer">{sidebarFooter}</div>}
          </div>}
          <div className={sidebarRail ? "xn-shell-sidebar__sheet" : "xn-shell-sidebar__classic-sheet"}>
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
          {sidebarHeader}
          <div className="xn-shell-sidebar__body">{sidebar}</div>
          {!sidebarRail && sidebarFooter && (
            <div className="xn-shell-sidebar__footer" data-testid="xn-shell-sidebar-footer">
              {sidebarFooter}
            </div>
          )}
          </div>
          {!narrow && expanded && sidebarResize}
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
            <kbd className="xn-sidebar-action__shortcut">{displayBinding(action.shortcut.split('|')[0].trim(), platform)}</kbd>
          )}
        </button>
      ))}
    </div>
  );
}

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

type MarkdownRendererModule = typeof import("./plugins/sessions/markdownRenderer");
let markdownRenderer: MarkdownRendererModule | undefined;
let markdownRendererLoading: Promise<MarkdownRendererModule> | undefined;

/** The markdown parser (react-markdown + GFM) is not part of the startup bundle.
 * The shell starts this load once the first paint is idle; a failed load is
 * retried by the next caller. */
export function loadMarkdownRenderer(): Promise<MarkdownRendererModule> {
  return markdownRendererLoading ??= import("./plugins/sessions/markdownRenderer").then(module => {
    markdownRenderer = module;
    return module;
  }, error => {
    markdownRendererLoading = undefined;
    throw error;
  });
}

function useMarkdownRenderer(): MarkdownRendererModule | undefined {
  const [, setLoaded] = useState(markdownRenderer !== undefined);
  useEffect(() => {
    if (markdownRenderer) return;
    let live = true;
    void loadMarkdownRenderer().then(() => { if (live) setLoaded(true); }, () => undefined);
    return () => { live = false; };
  }, []);
  return markdownRenderer;
}

/**
 * Markdown renderer for transcript prose. Raw HTML stays disabled; unsafe URL schemes are omitted.
 * `::visualize{...}` reference lines become sandboxed visualization frames once the text settles.
 * Until the parser has loaded, the prose shows as plain text in the same container.
 */
export const SimpleMarkdown = React.memo(function SimpleMarkdown({ text }: { text: string }): React.JSX.Element {
  const options = React.useContext(MarkdownRenderOptionsContext);
  const renderer = useMarkdownRenderer();
  const streaming = options.codeHighlightTiming === "after-stream";
  const segments = splitVisualizations(text);
  const prose = segments.length === 1 && segments[0]!.kind === "markdown";
  if (!renderer) {
    return (
      <div className="xn-md" data-testid="xn-simple-markdown" data-md-pending="true">
        <p className="xn-md__paragraph xn-md__paragraph--pending">{prose ? text : proseWithoutVisualizations(segments)}</p>
      </div>
    );
  }
  const { cachedMarkdownElements } = renderer;
  if (prose) {
    return (
      <div className="xn-md" data-testid="xn-simple-markdown">
        {cachedMarkdownElements(text, options.cacheParseResults, streaming)}
      </div>
    );
  }
  return (
    <div className="xn-md" data-testid="xn-simple-markdown">
      {streaming
        ? cachedMarkdownElements(proseWithoutVisualizations(segments), options.cacheParseResults, true)
        : segments.map((segment, index) => segment.kind === "markdown"
          ? <React.Fragment key={index}>{cachedMarkdownElements(segment.text, options.cacheParseResults, false)}</React.Fragment>
          : <VisualizationFrame key={index} reference={segment.reference} label={tr("可视化")} />)}
    </div>
  );
});
