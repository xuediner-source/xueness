import React, { useEffect, useRef, useState } from 'react';
import type { Terminal } from '@xterm/xterm';
import { get, post } from '../../xuenessApi';
import { IconTerminal } from '../../ui/icons';
import { t as tr } from '../../i18n';
import { OperationHeader, OperationStatus } from '../shared';
import '../../styles/operations.css';
import { terminalFontStack } from './XuenessTerminalPreferences';
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function nextTerminalBackoff(currentBackoff: number): number {
  return Math.min(currentBackoff * 2, 1000);
}

export function terminalResizePayload(cols: number, rows: number): { cols: number; rows: number } | null {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) return null;
  return { cols, rows };
}

export function decodeTerminalData(data: string): Uint8Array | null {
  try {
    // The server emits canonical RFC 4648 base64. `atob` accepts some malformed
    // or unpadded strings, which can otherwise advance the terminal cursor with
    // bytes the server never sent.
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
      throw new Error('invalid base64');
    }
    const decoded = atob(data);
    if (btoa(decoded) !== data) throw new Error('non-canonical base64');
    return Uint8Array.from(decoded, c => c.charCodeAt(0));
  } catch (decodeErr) {
    console.error('Failed to decode terminal output:', decodeErr);
    return null;
  }
}

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
  const mounted = useRef(false);
  const lifecycleGeneration = useRef(0);
  const currentSessionId = useRef(sessionId);
  const currentTerminalId = useRef(id);
  currentSessionId.current = sessionId;
  currentTerminalId.current = id;
  useEffect(() => {
    mounted.current = true;
    lifecycleGeneration.current += 1;
    return () => { mounted.current = false; lifecycleGeneration.current += 1; };
  }, []);
  useEffect(() => { setId(''); setClosed(false); setError(''); }, [sessionId]);
  useEffect(() => {
    let live = true;
    void get<{terminals: typeof existing}>('/api/terminals')
      .then(r => { if (live) setExisting(r.terminals); })
      .catch(e => { if (live) setError(errorText(e)); });
    return () => { live = false; };
  }, [sessionId, id]);
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
      const input = terminal.onData(text => {
        sending = sending.then(async () => {
          if (!live) return;
          await post(`/api/terminals/${id}/input`, { text });
        }).catch(e => { if (live) setError(errorText(e)); });
      });
      const resize = () => {
        fit.fit();
        const size = terminalResizePayload(terminal.cols, terminal.rows);
        if (!live || !size) return;
        void post(`/api/terminals/${id}/resize`, size).catch(e => { if (live) setError(errorText(e)); });
      };
      resizeRef.current = resize;
      const observer = new ResizeObserver(resize); observer.observe(host.current); resize();
      dispose = () => { terminalRef.current = null; resizeRef.current = null; observer.disconnect(); input.dispose(); terminal.dispose(); };
      let backoff = 150;
      const poll = async () => {
        try {
          const r = await get<{data: string; cursor: number; truncated: boolean; closed: boolean}>(`/api/terminals/${id}?cursor=${cursor}`);
          if (!live) return;
          backoff = 150;
          if (r.truncated) terminal.write('\r\n[older output truncated]\r\n');
          const bytes = decodeTerminalData(r.data);
          if (bytes) terminal.write(bytes);
          cursor = r.cursor;
          setClosed(r.closed);
          if (!r.closed || r.data) timer = setTimeout(() => { void poll(); }, 150);
        } catch (e) {
          if (live) {
            setError(errorText(e));
            timer = setTimeout(() => { void poll(); }, backoff);
            backoff = nextTerminalBackoff(backoff);
          }
        }
      };
      void poll();
    })().catch(e => { if (live) setError(errorText(e)); });
    return () => { live = false; clearTimeout(timer); dispose(); };
  }, [id]);
  return <section className="xn-operations xn-terminal-page">
    <OperationHeader icon={<IconTerminal size={22} />} title={tr("交互式终端")} description={tr("打开后直接在工作区执行命令，终端输入不会经过 Agent 的逐次审批。")} />
    {error && <p role="alert">{error}</p>}
    <div className="xn-terminal-frame"><div className="xn-terminal-toolbar"><span><IconTerminal />{id ? id.slice(0, 8) : tr('工作区 Shell')}</span><OperationStatus status={id ? closed ? 'closed' : 'running' : 'pending'} /><div className="xn-operations-actions">
    <button className="xn-operation-primary" disabled={!sessionId || Boolean(id && !closed)} onClick={() => {
      const targetSessionId = sessionId;
      if (!targetSessionId) return;
      const generation = lifecycleGeneration.current;
      void post<{ id: string }>('/api/terminals', { session_id: targetSessionId, open: true }).then(r => {
        if (!mounted.current || lifecycleGeneration.current !== generation || currentSessionId.current !== targetSessionId) return;
        setId(r.id); setClosed(false); setError('');
      }).catch(e => { if (mounted.current && lifecycleGeneration.current === generation && currentSessionId.current === targetSessionId) setError(errorText(e)); });
    }}>{tr("打开工作区终端")}</button>
    {existing.filter(t => t.session_id === sessionId && !t.closed && t.id !== id).map(t => <button key={t.id} onClick={() => { setId(t.id); setClosed(false); }}>{tr("连接终端")} · {t.id.slice(0, 8)}</button>)}
    <button disabled={!id || closed} onClick={() => {
      const closingId = id;
      const generation = lifecycleGeneration.current;
      void post(`/api/terminals/${closingId}/close`, {}).then(() => {
        if (mounted.current && lifecycleGeneration.current === generation && currentTerminalId.current === closingId) setClosed(true);
      }).catch(e => {
        if (mounted.current && lifecycleGeneration.current === generation && currentTerminalId.current === closingId) setError(errorText(e));
      });
    }}>{tr("关闭终端")}</button>
    </div></div><div className="xn-terminal-canvas"><div className="xn-terminal-host" ref={host} />
    {!id && <div className="xn-terminal-empty"><IconTerminal size={36} /><h3>{sessionId ? tr('终端已就绪') : tr('请先选择一个会话')}</h3><p>{sessionId ? tr('打开终端，开始在当前工作区操作。') : tr('终端会使用所选会话的工作区目录。')}</p></div>}
    </div><footer className="xn-terminal-footer"><span>{tr('交互输入 · 自适应尺寸 · 会话内重连')}</span><kbd>Ctrl + C</kbd></footer></div>
  </section>;
}
