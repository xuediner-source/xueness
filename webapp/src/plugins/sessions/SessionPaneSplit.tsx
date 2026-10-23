import React, { useCallback, useEffect, useRef, useState } from 'react';
import { t as tr, messages } from '../../i18n';
import {
  acceptsPaneDrag, boundPaneRatio, paneLayoutIsSplitVisible, paneWorkspaceLabel, readPaneDrop,
  PANE_RATIO_MIN, PANE_RATIO_MAX,
  type PaneBinding, type PaneId, type PaneLayoutState, type PaneSplit,
} from './paneLayout';
import { startPaneResize } from './paneResize';
import './pane-layout.css';

messages['关闭分屏'] = 'Close split view';
messages['分屏会话'] = 'Split conversation';
messages['主会话'] = 'Primary conversation';
messages['把侧栏会话拖到这里'] = 'Drag a sidebar session here';
messages['等待拖入'] = 'Waiting for a session';
messages['调整分屏尺寸'] = 'Resize split panes';

type PaneDrag = {
  pointerId: number;
  resize: ReturnType<typeof startPaneResize>;
  handle: HTMLDivElement;
};

/** Only CSS changes during a drag; both conversation subtrees stay mounted.
 * Commit once on pointerup. Cancellation and lifecycle changes discard a preview. */
function PaneDivider({ containerRef, direction, ratio, onResize }: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  direction: PaneSplit;
  ratio: number;
  onResize?: (ratio: number) => void;
}) {
  const dragRef = useRef<PaneDrag | null>(null);
  const row = direction === 'row';
  const paint = (value: number, handle?: HTMLDivElement) => {
    containerRef.current?.style.setProperty('--xn-pane-ratio', String(value));
    handle?.setAttribute('aria-valuenow', String(Math.round(value * 100)));
  };
  const release = (drag: PaneDrag) => {
    dragRef.current = null;
    drag.handle.dataset.dragging = 'false';
    if (drag.handle.hasPointerCapture(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId);
  };
  useEffect(() => {
    containerRef.current?.style.setProperty('--xn-pane-ratio', String(ratio));
    return () => {
      const drag = dragRef.current;
      if (drag) { drag.resize.cancel(false); release(drag); }
    };
  }, [containerRef, direction, ratio]);
  const cancel = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    release(drag);
    drag.resize.cancel();
  };
  return <div className="xn-pane-divider" data-testid="xn-pane-divider" data-dragging="false"
    role="separator" aria-label={tr('调整分屏尺寸')} aria-orientation={row ? 'vertical' : 'horizontal'}
    aria-valuemin={PANE_RATIO_MIN * 100} aria-valuemax={PANE_RATIO_MAX * 100} aria-valuenow={Math.round(ratio * 100)}
    tabIndex={0}
    onPointerDown={event => {
      if (event.button !== 0 || dragRef.current || !onResize || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const handleRect = event.currentTarget.getBoundingClientRect();
      const extent = row ? rect.width - handleRect.width : rect.height - handleRect.height;
      if (extent <= 0) return;
      event.preventDefault();
      event.stopPropagation();
      const handle = event.currentTarget;
      try { handle.setPointerCapture(event.pointerId); } catch { return; }
      const client = row ? event.clientX : event.clientY;
      dragRef.current = { pointerId: event.pointerId, handle, resize: startPaneResize({
        ratio, startClient: client, extent, preview: value => paint(value, handle), commit: onResize,
        isEnabled: () => Boolean(containerRef.current?.isConnected),
      }) };
      handle.dataset.dragging = 'true';
    }}
    onPointerMove={event => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      drag.resize.move(row ? event.clientX : event.clientY);
    }}
    onPointerUp={event => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      release(drag);
      drag.resize.finish(row ? event.clientX : event.clientY);
    }}
    onPointerCancel={cancel} onLostPointerCapture={cancel}
    onKeyDown={event => {
      if (!onResize || dragRef.current || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      let next: number;
      if (event.key === 'Home') next = PANE_RATIO_MIN;
      else if (event.key === 'End') next = PANE_RATIO_MAX;
      else if (event.key === (row ? 'ArrowLeft' : 'ArrowUp')) next = ratio - 0.05;
      else if (event.key === (row ? 'ArrowRight' : 'ArrowDown')) next = ratio + 0.05;
      else return;
      event.preventDefault();
      event.stopPropagation();
      onResize(boundPaneRatio(next));
    }} />;
}

export function SessionPaneSplit({ enabled = true, wide, layout, onFocus, onClose, onDropSession, onResize,
  secondary, secondaryTitle, secondaryWorkspace, children }: {
  enabled?: boolean;
  wide: boolean;
  layout: PaneLayoutState;
  onFocus: (pane: PaneId) => void;
  onClose: () => void;
  onDropSession: (binding: PaneBinding) => void;
  onResize?: (ratio: number) => void;
  secondary: React.ReactNode;
  secondaryTitle: string;
  secondaryWorkspace: string;
  children: React.ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dropActive, setDropActive] = useState(false);
  const visible = paneLayoutIsSplitVisible(layout, wide, enabled);
  const onDragOver = useCallback((event: React.DragEvent<HTMLElement>) => {
    if (!acceptsPaneDrag(event.dataTransfer.types)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDropActive(true);
  }, []);
  const onDrop = useCallback((event: React.DragEvent<HTMLElement>) => {
    setDropActive(false);
    const binding = readPaneDrop(event.dataTransfer);
    if (!binding) return;
    event.preventDefault();
    event.stopPropagation();
    onDropSession(binding);
  }, [onDropSession]);
  if (!visible) return children;
  const workspace = layout.secondary ? (paneWorkspaceLabel(secondaryWorkspace) || tr('未指定工作区')) : tr('等待拖入');
  return <div ref={containerRef} style={{ '--xn-pane-ratio': layout.ratio } as React.CSSProperties} className="xn-pane-layout" data-testid="xn-pane-layout" data-orientation={layout.split ?? 'single'} data-focus={layout.focus}>
    <section className="xn-pane" data-testid="xn-pane-primary" data-pane="primary" data-focused={layout.focus === 'primary'}
      role="region" aria-label={tr('主会话')} onPointerDown={() => onFocus('primary')}>
      <div className="xn-pane__body">{children}</div>
    </section>
    <PaneDivider containerRef={containerRef} direction={layout.split!} ratio={layout.ratio} onResize={onResize} />
    <section className="xn-pane xn-pane--secondary" data-testid="xn-pane-secondary" data-pane="secondary"
      data-focused={layout.focus === 'secondary'} data-bound={layout.secondary ? 'true' : 'false'} data-drop={dropActive ? 'true' : 'false'}
      role="region" aria-label={tr('分屏会话')} onPointerDown={() => onFocus('secondary')}
      onDragEnter={onDragOver} onDragOver={onDragOver} onDragLeave={() => setDropActive(false)} onDrop={onDrop}>
      <header className="xn-pane__chrome">
        <span className="xn-pane__title">{layout.secondary ? (secondaryTitle || layout.secondary.sessionId) : tr('分屏会话')}</span>
        <span className="xn-pane__workspace" title={secondaryWorkspace || undefined}>{workspace}</span>
        <button type="button" className="xn-conv-header__action" data-testid="xn-pane-close" onClick={event => { event.stopPropagation(); onClose(); }}>{tr('关闭分屏')}</button>
      </header>
      <div className="xn-pane__body">
        {layout.secondary ? secondary : <p className="xn-pane__drop" data-testid="xn-pane-drop">{tr('把侧栏会话拖到这里')}</p>}
      </div>
    </section>
  </div>;
}
