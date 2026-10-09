import React, { useEffect, useState } from "react";
import { get } from "../../xuenessApi";
import { Select } from "../../ui/Select";
import { t as tr } from "../../i18n";

export function preferredTerminalShell(value: string | undefined, shells: readonly { id: string }[]): string {
  // Preserve saved choices (including unavailable ones) for explicit repair.
  // An unset preference follows the host's discovery order on either OS.
  return value || shells[0]?.id || "";
}

export function XuenessTerminalShellSelect({ value, onChange, disabled }: { value?: string; onChange(value: string): void; disabled?: boolean }): React.JSX.Element {
  const [shells, setShells] = useState<{id:string;label:string}[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    get<{shells:typeof shells}>("/api/terminals/shells").then(result => { if (live) setShells(result.shells); })
      .catch(reason => { if (live) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { live = false; };
  }, []);
  const selected = preferredTerminalShell(value, shells);
  return <div className="xn-settings-select-wrap"><Select aria-label={tr("默认 Shell")} value={selected} disabled={disabled || !shells.length} onChange={event => onChange(event.target.value)}>
    {!shells.length && <option value={selected}>{error ? tr("终端不可用") : tr("正在加载…")}</option>}
    {shells.map(shell => <option key={shell.id} value={shell.id}>{shell.label}</option>)}
    {shells.length > 0 && value && !shells.some(shell => shell.id === value) && <option value={value}>{tr("已保存的 Shell 不可用")}</option>}
  </Select>{error && <small role="status">{error}</small>}</div>;
}

/**
 * 跨平台系统等宽字体栈：macOS 用 SF Mono/Menlo，Windows 用 Cascadia Mono/Consolas
 * （Chromium 在 Windows 上不支持 ui-monospace，旧栈会退到 Courier New），
 * 中文字符再回退到各平台的 CJK 字体，避免 Windows 上落到宋体。
 */
export const SYSTEM_MONOSPACE_STACK = 'ui-monospace, SFMono-Regular, Menlo, "Cascadia Mono", Consolas, "Liberation Mono", "Noto Sans Mono CJK SC", "PingFang SC", "Microsoft YaHei UI", monospace';

/** 选中的字体放最前；该字体不存在（例如在 Windows 上选了 Menlo）时回退到系统等宽栈。 */
export function terminalFontStack(value = "system"): string {
  if (value === "Menlo") return `Menlo, ${SYSTEM_MONOSPACE_STACK}`;
  if (value === "SFMono-Regular") return `SFMono-Regular, ${SYSTEM_MONOSPACE_STACK}`;
  if (value === "monospace") return "monospace";
  return SYSTEM_MONOSPACE_STACK;
}
