import React, { useEffect, useMemo, useRef, useState } from "react";
import { Keyboard, Pencil, RotateCcw, Search, Trash2, X } from "lucide-react";
import { t as tr } from "../../i18n";
import {
  filterShortcutCommands,
  findShortcutConflictIn,
  recordShortcutEvent,
  resolveShortcutBinding,
  restoreShortcutDefault,
  SHORTCUT_COMMANDS,
  type ShortcutCommandDefinition,
} from "../../xuenessShortcutCommands";
import { shortcutScopeLabel } from "../sessions/scopedCommands";
import { displayBindingParts } from "../../xuenessShortcutDisplay";

export type XuenessShortcutsPanelProps = {
  bindings?: Record<string, string>;
  /** Defaults to the always-on global and composer table. Sessions passes the
   * registered catalog when both sessions and settings are effective. */
  commands?: readonly ShortcutCommandDefinition[];
  disabled?: boolean;
  onChange: (bindings: Record<string, string>) => void | Promise<unknown>;
};

function recordingError(reason: "modifier-required" | "unsupported-key" | "reserved", conflictLabel?: string): string {
  if (reason === "modifier-required") return tr("请同时按下至少一个修饰键。")
  if (reason === "unsupported-key") return tr("此按键目前不能用作快捷键。")
  if (conflictLabel) return `${tr("此快捷键已分配给")} ${conflictLabel}。`;
  return tr("此按键由浏览器或系统保留。")
}

export function XuenessShortcutsPanel({
  bindings = {},
  commands = SHORTCUT_COMMANDS,
  disabled = false,
  onChange,
}: XuenessShortcutsPanelProps): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [appendBinding, setAppendBinding] = useState(false);
  const [preview, setPreview] = useState("");
  const [error, setError] = useState("");
  const recorderRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const commandButtonRefs = useRef<Partial<Record<string, HTMLButtonElement | null>>>({});
  const bindingsRef = useRef(bindings);
  const onChangeRef = useRef(onChange);
  bindingsRef.current = bindings;
  onChangeRef.current = onChange;
  const restoreCommandFocus = (commandId: string) => {
    window.requestAnimationFrame(() => {
      const target = commandButtonRefs.current[commandId];
      if (target && !target.disabled) target.focus();
      else searchRef.current?.focus();
    });
  };

  const visibleCommands = useMemo(() => filterShortcutCommands(commands, bindings, query), [bindings, commands, query]);

  useEffect(() => {
    if (!recordingId) return;
    const handleRecording = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat || event.isComposing) return;
      if (event.key === "Escape") {
        setRecordingId(null);
        setPreview("");
        setError("");
        restoreCommandFocus(recordingId);
        return;
      }
      if (event.key === "Backspace") {
        void onChangeRef.current({ ...bindingsRef.current, [recordingId]: "" });
        setRecordingId(null);
        setPreview("");
        setError("");
        restoreCommandFocus(recordingId);
        return;
      }
      const recorded = recordShortcutEvent(event, undefined, commands.find(command => command.id === recordingId)?.scope);
      if (recorded.kind === "pending") {
        setPreview(recorded.preview);
        setError("");
        return;
      }
      if (recorded.kind === "invalid") {
        setPreview("");
        setError(recordingError(recorded.reason));
        return;
      }
      const conflictId = findShortcutConflictIn(recorded.binding, recordingId, bindingsRef.current, commands);
      if (conflictId) {
        setPreview(recorded.binding);
        setError(recordingError("reserved", tr(commands.find((command) => command.id === conflictId)?.label ?? conflictId)));
        return;
      }
      const previous = resolveShortcutBinding(recordingId, bindingsRef.current, commands.find(command => command.id === recordingId)?.defaultBinding);
      const choices = previous.split('|').map(value => value.trim()).filter(Boolean);
      if (appendBinding && (choices.includes(recorded.binding) || choices.length >= 4)) { setError(tr("最多四个不同的快捷键。")); return; }
      void onChangeRef.current({ ...bindingsRef.current, [recordingId]: appendBinding && previous ? `${previous} | ${recorded.binding}` : recorded.binding });
      setRecordingId(null);
      setPreview("");
      setError("");
      restoreCommandFocus(recordingId);
    };
    window.addEventListener("keydown", handleRecording, true);
    const frame = window.requestAnimationFrame(() => recorderRef.current?.focus());
    return () => {
      window.removeEventListener("keydown", handleRecording, true);
      window.cancelAnimationFrame(frame);
    };
  }, [commands, recordingId, appendBinding]);

  const startRecording = (commandId: string, append = false) => {
    setAppendBinding(append);
    setError("");
    setPreview("");
    setRecordingId(commandId);
  };

  const restoreAll = () => {
    if (disabled) return;
    setRecordingId(null);
    setPreview("");
    setError("");
    void onChange({});
  };

  return (
    <section className="xn-shortcuts" data-testid="xn-shortcuts-panel">
      <div className="xn-shortcuts__toolbar">
        <label className="xn-shortcuts__search">
          <Search size={16} aria-hidden="true" />
          <input
            ref={searchRef}
            type="search"
            aria-label={tr("搜索快捷键")}
            placeholder={tr("搜索快捷键")}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            data-testid="xn-shortcuts-search"
          />
          {query && <button type="button" aria-label={tr("清除搜索")} onClick={() => setQuery("")}><X size={14} aria-hidden="true" /></button>}
        </label>
        <button
          type="button"
          className="xn-shortcuts__reset-all"
          disabled={disabled || !Object.keys(bindings).length}
          onClick={restoreAll}
          data-testid="xn-shortcuts-reset-all"
        >
          <RotateCcw size={14} aria-hidden="true" />{tr("全部恢复默认")}
        </button>
      </div>
      <div className="xn-shortcuts__table" role="table" aria-label={tr("快捷键") }>
        <div className="xn-shortcuts__head" role="row">
          <span role="columnheader">{tr("命令")}</span>
          <span role="columnheader">{tr("按键绑定")}</span>
          <span role="columnheader">{tr("作用域")}</span>
          <span role="columnheader">{tr("操作")}</span>
        </div>
        {visibleCommands.map((command) => {
          const binding = resolveShortcutBinding(command.id, bindings, command.defaultBinding);
          const active = recordingId === command.id;
          const overridden = Object.hasOwn(bindings, command.id);
          return (
            <div className="xn-shortcuts__row" role="row" key={command.id} data-testid={`xn-shortcut-row-${command.id}`}>
              <span className="xn-shortcuts__command" role="cell">
                <strong>{tr(command.label)}</strong>
                <small>{tr(command.description)}</small>
              </span>
              <span className="xn-shortcuts__binding" role="cell">
                {active ? (
                  <span className="xn-shortcuts__recorder">
                    <button ref={recorderRef} type="button" className="xn-shortcuts__recording" aria-label={tr("正在录制快捷键") } aria-live="polite">
                      <Keyboard size={15} aria-hidden="true" />{preview || tr("按下组合键…")}
                    </button>
                    {error && <small role="alert">{error}</small>}
                    {!error && <small>{tr("按 Escape 取消；按 Backspace 清除绑定。")}</small>}
                  </span>
                ) : (
                  <button
                    type="button"
                    className={`xn-shortcuts__binding-button${overridden ? " is-custom" : ""}`}
                    disabled={disabled}
                    aria-label={`${tr("重新录制")}：${tr(command.label)}`}
                    onClick={() => startRecording(command.id)}
                    data-testid={`xn-shortcut-record-${command.id}`}
                  >
                    {(binding ? displayBindingParts(binding) : [tr("未设置")]).map((part, index) => <kbd key={`${part}-${index}`}>{part}</kbd>)}
                  </button>
                )}
              </span>
              <span className="xn-shortcuts__scope" role="cell">{shortcutScopeLabel(command.scope)}</span>
              <span className="xn-shortcuts__actions" role="cell">
                <button type="button" disabled={disabled || active} aria-label={`${tr("添加备用快捷键")}：${tr(command.label)}`} onClick={() => startRecording(command.id, true)}>+</button>
                <button ref={(node) => { commandButtonRefs.current[command.id] = node; }} type="button" title={tr("重新录制")} aria-label={`${tr("重新录制")}：${tr(command.label)}`} disabled={disabled || active} onClick={() => startRecording(command.id)} data-testid={`xn-shortcut-edit-${command.id}`}><Pencil size={14} aria-hidden="true" /></button>
                <button type="button" title={tr("清除绑定")} aria-label={`${tr("清除绑定")}：${tr(command.label)}`} disabled={disabled || !binding || active} onClick={() => { setRecordingId(null); void onChange({ ...bindings, [command.id]: "" }); }} data-testid={`xn-shortcut-clear-${command.id}`}><Trash2 size={14} aria-hidden="true" /></button>
                <button type="button" title={tr("恢复默认")} aria-label={`${tr("恢复默认")}：${tr(command.label)}`} disabled={disabled || !overridden || active} onClick={() => { setRecordingId(null); void onChange(restoreShortcutDefault(bindings, command.id)); }} data-testid={`xn-shortcut-default-${command.id}`}><RotateCcw size={14} aria-hidden="true" /></button>
              </span>
            </div>
          );
        })}
        {visibleCommands.length === 0 && <div className="xn-shortcuts__empty" role="row" data-testid="xn-shortcuts-empty">{tr("没有匹配的快捷键")}</div>}
      </div>
    </section>
  );
}
