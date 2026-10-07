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

export function terminalFontStack(value = "system"): string {
  return value === "Menlo" ? 'Menlo, monospace' : value === "SFMono-Regular" ? 'SFMono-Regular, Menlo, monospace' : value === "monospace" ? 'monospace' : 'ui-monospace, SFMono-Regular, Menlo, monospace';
}
