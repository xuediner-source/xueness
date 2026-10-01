import React, { useEffect, useRef, useState } from 'react';
import type { Terminal } from '@xterm/xterm';
import { get, post } from '../../xuenessApi';
import { IconTerminal } from '../../ui/icons';
import { t as tr } from '../../i18n';
import { OperationHeader, OperationStatus } from '../shared';
import '../../styles/operations.css';
import { terminalFontStack } from '../../XuenessTerminalPreferences';
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
export function TerminalPanel({ sessionId, fontSize = 13, fontFamily = "system" }: { sessionId: string | null; fontSize?: number; fontFamily?: string }) {
  const textSize = Number.isFinite(fontSize) ? Math.max(10, Math.min(24, Math.round(fontSize))) : 13;
  const terminalRef = useRef<Terminal | null>(null);
  const resizeRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (terminalRef.current) { terminalRef.current.options.fontSize = textSize; resizeRef.current?.(); }
  }, [textSize]);
  useEffect(() => {
    if (terminalRef.current) { terminalRef.current.options.fontFamily = terminalFontStack(fontFamily); resizeRef.current?.(); }
  }, [fontFamily]);
  const host = useRef<HTMLDivElement>(null);
  const [id, setId] = useState('');
  const [error, setError] = useState('');
  const [closed, setClosed] = useState(false);
  const [existing, setExisting] = useState<{id: string; session_id: string; closed: boolean}[]>([]);
  useEffect(() => { setId(''); setClosed(false); setError(''); }, [sessionId]);
  useEffect(() => { void get<{terminals: typeof existing}>('/api/terminals').then(r => setExisting(r.terminals)).catch(e => setError(errorText(e))); }, [sessionId, id]);
  useEffect(() => {
    if (!id || !host.current) return;
    let live = true, timer: ReturnType<typeof setTimeout>;
    let dispose = () => {};
    void (async () => {
      const { Terminal } = await import('@xterm/xterm');
      const { FitAddon } = await import('@xterm/addon-fit');
      if (!live || !host.current) return;
      const terminal = new Terminal({ cursorBlink: true, convertEol: false, fontSize: textSize, fontFamily: terminalFontStack(fontFamily), theme: { background: '#161616', foreground: '#d4d4d4', cursor: '#d4d4d4', selectionBackground: '#ffffff25' } });
      terminalRef.current = terminal;
      const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(host.current); fit.fit(); terminal.focus();
      let cursor = 0, sending = Promise.resolve();
      const input = terminal.onData(text => { sending = sending.then(async () => { await post(`/api/terminals/${id}/input`, { text }); }).catch(e => { if (live) setError(errorText(e)); }); });
      const resize = () => { fit.fit(); void post(`/api/terminals/${id}/resize`, { cols: terminal.cols, rows: terminal.rows }).catch(e => { if (live) setError(errorText(e)); }); };
      resizeRef.current = resize;
      const observer = new ResizeObserver(resize); observer.observe(host.current); resize();
      dispose = () => { terminalRef.current = null; resizeRef.current = null; observer.disconnect(); input.dispose(); terminal.dispose(); };
      const poll = async () => {
        try {
          const r = await get<{data: string; cursor: number; truncated: boolean; closed: boolean}>(`/api/terminals/${id}?cursor=${cursor}`);
          if (!live) return;
          if (r.truncated) terminal.write('\r\n[older output truncated]\r\n');
          terminal.write(Uint8Array.from(atob(r.data), c => c.charCodeAt(0))); cursor = r.cursor;
          setClosed(r.closed);
          if (!r.closed || r.data) timer = setTimeout(() => { void poll(); }, 150);
        } catch (e) { if (live) setError(errorText(e)); }
      };
      void poll();
    })().catch(e => { if (live) setError(errorText(e)); });
    return () => { live = false; clearTimeout(timer); dispose(); };
  }, [id]);
  return <section className="xn-operations xn-terminal-page">
    <OperationHeader icon={<IconTerminal size={22} />} title={tr("交互式终端")} description={tr("打开后直接在工作区执行命令，终端输入不会经过 Agent 的逐次审批。")} />
    {error && <p role="alert">{error}</p>}
    <div className="xn-terminal-frame"><div className="xn-terminal-toolbar"><span><IconTerminal />{id ? id.slice(0, 8) : tr('工作区 Shell')}</span><OperationStatus status={id ? closed ? 'closed' : 'running' : 'pending'} /><div className="xn-operations-actions">
    <button className="xn-operation-primary" disabled={!sessionId || Boolean(id && !closed)} onClick={() => { void post<{ id: string }>('/api/terminals', { session_id: sessionId, open: true }).then(r => { setId(r.id); setClosed(false); setError(''); }).catch(e => setError(errorText(e))); }}>{tr("打开工作区终端")}</button>
    {existing.filter(t => t.session_id === sessionId && !t.closed && t.id !== id).map(t => <button key={t.id} onClick={() => { setId(t.id); setClosed(false); }}>{tr("连接终端")} · {t.id.slice(0, 8)}</button>)}
    <button disabled={!id || closed} onClick={() => void post(`/api/terminals/${id}/close`, {}).then(() => setClosed(true)).catch(e => setError(errorText(e)))}>{tr("关闭终端")}</button>
    </div></div><div className="xn-terminal-canvas"><div className="xn-terminal-host" ref={host} />
    {!id && <div className="xn-terminal-empty"><IconTerminal size={36} /><h3>{sessionId ? tr('终端已就绪') : tr('请先选择一个会话')}</h3><p>{sessionId ? tr('打开终端，开始在当前工作区操作。') : tr('终端会使用所选会话的工作区目录。')}</p></div>}
    </div><footer className="xn-terminal-footer"><span>{tr('交互输入 · 自适应尺寸 · 会话内重连')}</span><kbd>Ctrl + C</kbd></footer></div>
  </section>;
}
