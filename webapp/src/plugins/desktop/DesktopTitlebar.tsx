import React, { useEffect } from "react";
import { ArrowLeft, ArrowRight, CircleHelp, PanelLeft, Terminal } from "lucide-react";
import { t as tr } from "../../i18n";
import { isMacPlatform } from "../../xuenessShortcutDisplay";
import { IconXuenessMark } from "../../ui/icons";
import "./desktop-titlebar.css";

export type DesktopTitlebarPlatform = "macos" | "windows" | "other";

/** Resolve the browser's native platform string for host-specific titlebar insets. */
export function resolveDesktopTitlebarPlatform(platform?: string): DesktopTitlebarPlatform {
  const nativePlatform = platform ?? (typeof navigator === "undefined" ? "" : navigator.platform);
  if (isMacPlatform(nativePlatform)) return "macos";
  if (nativePlatform.toLowerCase().includes("win")) return "windows";
  return "other";
}

export type DesktopTitlebarProps = {
  desktopEnabled?: boolean;
  platform?: string;
  canGoBack: boolean;
  canGoForward: boolean;
  onGoBack?: () => void;
  onGoForward?: () => void;
  hasSidebar: boolean;
  onToggleSidebar?: () => void;
  terminalEnabled: boolean;
  onOpenTerminal?: () => void;
  helpContent?: React.ReactNode;
};

/**
 * Workbench controls rendered in Electron's native title bar safe area. The
 * surrounding window is host infrastructure and stays draggable when the
 * desktop feature is disabled; each action is supplied only while its owning
 * frontend feature is effective.
 */
export function DesktopTitlebar({
  desktopEnabled = false,
  platform,
  canGoBack,
  canGoForward,
  onGoBack,
  onGoForward,
  hasSidebar,
  onToggleSidebar,
  terminalEnabled,
  onOpenTerminal,
  helpContent,
}: DesktopTitlebarProps): React.JSX.Element {
  const nativePlatform = resolveDesktopTitlebarPlatform(platform);
  useEffect(() => {
    document.documentElement.setAttribute('data-xn-desktop-enabled', String(desktopEnabled));
    return () => document.documentElement.setAttribute('data-xn-desktop-enabled', 'false');
  }, [desktopEnabled]);
  return <div className="xn-desktop-titlebar" data-platform={nativePlatform} data-testid="xn-desktop-titlebar">
    <div className="xn-desktop-titlebar__brand" aria-label="Xueness">
      <IconXuenessMark size={17} className="xn-desktop-titlebar__mark" />
      <span>Xueness</span>
    </div>
    <div className="xn-desktop-titlebar__history" role="group" aria-label={tr("任务导航")}>
      <button type="button" aria-label={tr("后退")} title={tr("后退")} disabled={!canGoBack || !onGoBack}
        onClick={onGoBack} data-testid="xn-desktop-titlebar-back">
        <ArrowLeft size={15} aria-hidden="true" />
      </button>
      <button type="button" aria-label={tr("前进")} title={tr("前进")} disabled={!canGoForward || !onGoForward}
        onClick={onGoForward} data-testid="xn-desktop-titlebar-forward">
        <ArrowRight size={15} aria-hidden="true" />
      </button>
    </div>
    <div className="xn-desktop-titlebar__spacer" aria-hidden="true" />
    <div className="xn-desktop-titlebar__actions">
      <details className="xn-desktop-titlebar__help">
        <summary aria-label={tr("工作台")} title={tr("工作台")} data-testid="xn-desktop-titlebar-help">
          <CircleHelp size={16} aria-hidden="true" />
        </summary>
        {helpContent && <div className="xn-desktop-titlebar__menu">{helpContent}</div>}
      </details>
      {terminalEnabled && onOpenTerminal && <button type="button" aria-label={tr("打开工作区终端")}
        title={tr("打开工作区终端")} onClick={onOpenTerminal} data-testid="xn-desktop-titlebar-terminal">
        <Terminal size={16} aria-hidden="true" />
      </button>}
      {hasSidebar && onToggleSidebar && <button type="button" aria-label={tr("切换侧栏")} title={tr("切换侧栏")}
        onClick={onToggleSidebar} data-testid="xn-desktop-titlebar-sidebar">
        <PanelLeft size={16} aria-hidden="true" />
      </button>}
    </div>
  </div>;
}
