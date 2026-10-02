import React, { useEffect, useState } from "react";
import { get } from "../../xuenessApi";
import { useLocale } from "../../i18n";

type DesktopStatus = { desktop: boolean; platform: string; version: string; frozen: boolean;
  dataDirectory: string; nativeDirectoryPicker: boolean };

export function DesktopSettings({ enabled = true }: { enabled?: boolean }): React.JSX.Element {
  const locale = useLocale();
  const text = (zh: string, en: string) => locale === "en" ? en : zh;
  const [status, setStatus] = useState<DesktopStatus | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    get<DesktopStatus>("/api/desktop/status").then(value => { if (!disposed) setStatus(value); })
      .catch(e => { if (!disposed) setError(e instanceof Error ? e.message : String(e)); });
    return () => { disposed = true; };
  }, [enabled]);
  return <section data-testid="desktop-settings" className="xn-diagnostics">
    <header><div><h3>{text("桌面端", "Desktop")}</h3><p>{text("Windows 与 macOS 使用同一套插件、模型配置和会话运行时。", "Windows and macOS share the same plugins, model configuration and session runtime.")}</p></div></header>
    {!enabled ? <p>{text("桌面集成已关闭，可在插件管理中恢复。", "Desktop integration is disabled. Restore it in plugin management.")}</p> : error ? <p role="alert">{error}</p> : status ? <>
      <dl><dt>{text("运行方式", "Host")}</dt><dd>{status.desktop ? text("桌面应用", "Desktop application") : text("Web 工作台", "Web workbench")}</dd>
        <dt>{text("平台", "Platform")}</dt><dd>{status.platform}</dd><dt>{text("版本", "Version")}</dt><dd>{status.version}</dd>
        <dt>{text("内置运行时", "Bundled runtime")}</dt><dd>{status.frozen ? text("已内置，无需安装 Python", "Bundled; no Python installation needed") : text("开发运行时", "Development runtime")}</dd>
        <dt>{text("数据位置", "Data directory")}</dt><dd style={{ overflowWrap: "anywhere" }}>{status.dataDirectory}</dd>
        <dt>{text("原生目录选择", "Native folder picker")}</dt><dd>{status.nativeDirectoryPicker ? text("可用", "Available") : text("使用工作区目录浏览", "Use workspace directory browsing")}</dd></dl>
      <p>{text("应用升级会保留数据。桌面端与 CLI 共享数据时，为 CLI 指定相同的 state 目录。", "Application upgrades preserve data. To share data with the CLI, select the same state directory.")}</p>
      {status.desktop && status.platform === 'win32' && <p>{text("关闭窗口后仍在系统托盘后台运行，任务会继续。右键托盘图标可打开运行中、已固定或最近会话，也可新建会话、发送反馈。点击图标恢复窗口；要完全退出，请使用「退出 Xueness」。", "Closing the window keeps Xueness and its tasks running in the system tray. Right-click its icon to open running, pinned or recent chats, create a chat or send feedback. Click the icon to restore the window; choose Quit Xueness to exit completely.")}</p>}
    </> : <p role="status">{text("正在读取桌面状态…", "Reading desktop status…")}</p>}
  </section>;
}
