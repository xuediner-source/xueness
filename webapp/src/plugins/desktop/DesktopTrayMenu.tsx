import React, { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import './desktop-tray-menu.css';

export type TraySession = { id: string; title: string; project: string; status: string; pinned: boolean; updatedAt: string };
export type TraySnapshot = { sessions: TraySession[]; sessionsEnabled: boolean; busy: boolean; activeId: string | null;
  locale: 'zh' | 'en'; dark: boolean; loading: boolean; failed: boolean };
export type TrayAction = { kind: 'session'; id: string } | { kind: 'new' | 'feedback' | 'quit' };
export type TrayApi = { subscribe: (callback: (snapshot: TraySnapshot) => void) => () => void;
  ready: () => void; select: (action: TrayAction) => void; resize: (height: number) => void; dismiss: () => void };

export function groupTraySessions(sessions: TraySession[]) {
  const running = sessions.filter(session => session.status === 'running').slice(0, 3);
  const pinned = sessions.filter(session => session.pinned).slice(0, 3);
  const recent = sessions.slice(0, 3);
  const visible = new Set([...running, ...pinned, ...recent].map(session => session.id));
  return { running, pinned, recent, more: sessions.filter(session => !visible.has(session.id)) };
}

export function DesktopTrayMenu({ snapshot, api }: { snapshot: TraySnapshot; api?: TrayApi }) {
  const [more, setMore] = useState(false);
  const root = useRef<HTMLElement>(null);
  const text = (zh: string, en: string) => snapshot.locale === 'en' ? en : zh;
  const groups = groupTraySessions(snapshot.sessions);
  useEffect(() => { if (snapshot.loading) setMore(false); }, [snapshot.loading]);
  useEffect(() => {
    const focus = () => root.current?.focus();
    focus(); window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
  }, []);
  useEffect(() => {
    if (!root.current || !api) return;
    const resize = () => api.resize(Math.ceil(root.current!.getBoundingClientRect().height) + 2);
    const observer = new ResizeObserver(resize); observer.observe(root.current); resize();
    return () => observer.disconnect();
  }, [api]);
  const select = (action: TrayAction) => api?.select(action);
  const row = (session: TraySession) => <button type="button" role="menuitem" className="xn-tray-menu__session" key={session.id}
    disabled={!snapshot.sessionsEnabled || (snapshot.busy && session.id !== snapshot.activeId)}
    onClick={() => select({ kind: 'session', id: session.id })} title={session.title}>
    <span className="xn-tray-menu__title">{session.title}</span><span className="xn-tray-menu__project">{session.project}</span>
  </button>;
  const section = (title: string, sessions: TraySession[]) => <section className="xn-tray-menu__group" aria-label={title}>
    <div className="xn-tray-menu__heading">{title}</div>
    {sessions.length ? sessions.map(row) : <div className="xn-tray-menu__empty">{text('暂无会话', 'No chats')}</div>}
  </section>;
  return <main ref={root} role="menu" aria-label={text('Xueness 托盘菜单', 'Xueness tray menu')} className="xn-tray-menu" data-theme={snapshot.dark ? 'dark' : 'light'} tabIndex={-1}
    onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); if (more) setMore(false); else api?.dismiss(); }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const buttons = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)') ?? []);
        if (!buttons.length) return;
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : event.key === 'ArrowDown' ? (index + 1) % buttons.length : (index < 0 ? buttons.length - 1 : (index - 1 + buttons.length) % buttons.length);
        buttons[next].focus();
      }
    }}>
    {!snapshot.sessionsEnabled && <p className="xn-tray-menu__notice">{text('会话功能已关闭', 'Chats are disabled')}</p>}
    {snapshot.loading && <p className="xn-tray-menu__notice" role="status">{text('正在读取会话…', 'Loading chats…')}</p>}
    {snapshot.failed && <p className="xn-tray-menu__notice" role="status">{text('会话列表暂时不可用', 'Chats are temporarily unavailable')}</p>}
    {more ? <section className="xn-tray-menu__group">
      <button type="button" role="menuitem" className="xn-tray-menu__back" onClick={() => setMore(false)}><ChevronLeft size={14} />{text('返回', 'Back')}</button>
      <div className="xn-tray-menu__heading">{text('更多会话', 'More chats')}</div><div className="xn-tray-menu__more-list">{groups.more.map(row)}</div>
    </section> : <>
      {section(text('运行中', 'Running'), groups.running)}
      {section(text('已固定', 'Pinned'), groups.pinned)}
      <div className="xn-tray-menu__recent">{section(text('最近', 'Recent'), groups.recent)}
        <button type="button" role="menuitem" className="xn-tray-menu__more" disabled={!groups.more.length || !snapshot.sessionsEnabled} onClick={() => setMore(true)}>
          <span>{text('更多', 'More')}</span><ChevronRight size={14} />
        </button>
      </div>
    </>}
    <section className="xn-tray-menu__actions">
      <button type="button" role="menuitem" disabled={!snapshot.sessionsEnabled || snapshot.busy} onClick={() => select({ kind: 'new' })}>{text('新建会话', 'New Chat')}</button>
      <button type="button" role="menuitem" onClick={() => select({ kind: 'feedback' })}>{text('发送反馈', 'Send Feedback')}</button>
    </section>
    <section className="xn-tray-menu__exit"><button type="button" role="menuitem" onClick={() => select({ kind: 'quit' })}>{text('退出 Xueness', 'Exit')}</button></section>
  </main>;
}
