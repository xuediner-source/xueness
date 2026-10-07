import React, { useEffect, useState } from "react";
import { get } from "../../xuenessApi";
import { t as tr } from "../../i18n";
import { IconXuenessMark } from "../../ui/icons";
import "./desktop-about.css";

type AppInfo = { version: string; dataDirectory: string };

export function DesktopAboutDetails({ version, dataDirectory }: AppInfo): React.JSX.Element {
  return <>
    <header className="xn-desktop-about__brand">
      <IconXuenessMark size={36} />
      <div><h3>Xueness</h3><span>{tr("版本")} {version}</span></div>
    </header>
    <div className="xn-desktop-about__data">
      <h4>{tr("数据位置")}</h4>
      <p>{tr("会话、模型配置及插件设置保存在此目录。")}</p>
      <code data-testid="desktop-data-directory">{dataDirectory}</code>
    </div>
  </>;
}

/** Desktop metadata belongs to the desktop plugin, wherever settings mounts it. */
export function DesktopAbout({ enabled = true, onboardingEnabled = false }: { enabled?: boolean; onboardingEnabled?: boolean }): React.JSX.Element | null {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const abort = new AbortController();
    setInfo(null); setError(false);
    void get<AppInfo>("/api/desktop/status", abort.signal).then(value => {
      if (abort.signal.aborted) return;
      if (typeof value.version !== "string" || !value.version || typeof value.dataDirectory !== "string" || !value.dataDirectory) {
        throw new Error("Invalid application info");
      }
      setInfo(value);
    }).catch(() => { if (!abort.signal.aborted) setError(true); });
    return () => abort.abort();
  }, [enabled]);
  if (!enabled) return null;
  return <section className="xn-desktop-about" data-testid="desktop-about">
    {info ? <DesktopAboutDetails {...info} /> : error ? <p role="alert">{tr("无法读取应用信息。")}</p>
      : <p role="status">{tr("正在读取应用信息…")}</p>}
    {onboardingEnabled && typeof window !== "undefined" && new URLSearchParams(window.location.search).get("xuenessDesktop") === "1" &&
      <div className="xn-desktop-about__permissions">
        <div><h4>{tr("系统权限")}</h4><p>{tr("查看当前系统支持的权限，可随时跳过。")}</p></div>
        <button type="button" data-testid="desktop-permissions-reopen"
          onClick={() => window.dispatchEvent(new CustomEvent("xueness:permissions-open"))}>{tr("查看权限引导")}</button>
      </div>}
  </section>;
}
