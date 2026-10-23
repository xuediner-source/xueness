import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, CornerDownRight, MessageSquareText, Undo2 } from 'lucide-react';
import { messages, t as tr } from '../../i18n';
import { isModKeyPressed } from '../../xuenessShortcutDisplay';
import './CurrentTurnInput.css';

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

function focusOutsideMenu(trigger: HTMLElement | null, menu: HTMLElement | null, backwards: boolean): boolean {
  if (!trigger) return false;
  const candidates = Array.from(document.querySelectorAll<HTMLElement>(
    'a[href], area[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), iframe, [tabindex], [contenteditable="true"]',
  )).filter(element => element.tabIndex >= 0 && !menu?.contains(element)
    && !element.closest('[hidden], [inert]') && getComputedStyle(element).visibility !== 'hidden'
    && element.getClientRects().length > 0);
  const index = candidates.indexOf(trigger);
  const next = candidates[index + (backwards ? -1 : 1)];
  if (!next) return false;
  next.focus();
  return true;
}

messages['后续输入方式'] = 'Follow-up input behavior';
messages['引导'] = 'Guide';
messages['排队'] = 'Queue';
messages['当前轮引导'] = 'Guide the current turn';
messages['引导当前轮'] = 'Guide current turn';
messages['立即发送'] = 'Send now';
messages['在下一步模型请求前处理，不中断正在执行的工具。'] = 'Apply before the next model request, without interrupting an executing tool.';
messages['当前轮结束后执行。'] = 'Run after the current turn finishes.';
messages['等待当前轮就绪后可引导。'] = 'Guidance becomes available when the current turn is ready.';
messages['撤回到输入框'] = 'Withdraw to composer';
messages['待处理引导'] = 'Pending guidance';
messages['目标轮次已结束，请撤回后重新发送。'] = 'The target turn has ended. Withdraw this input to send it again.';
messages['原附件或上下文不会恢复，请重新添加。'] = 'Original attachments or context are not restored. Add them again before sending.';

export type FollowupMode = 'guide' | 'queue';
export type InputDelivery = FollowupMode | 'startNow';

/** Resolve the composer action for its selected mode and optional reversal. */
export function followupDelivery(mode: FollowupMode, reverse = false): InputDelivery {
  return reverse ? oppositeFollowupDelivery(mode) : mode;
}

/** Same one-shot reversal as the reference composer: guide→queue, queue→now. */
export function oppositeFollowupDelivery(mode: FollowupMode): InputDelivery {
  return mode === 'guide' ? 'queue' : 'startNow';
}

export function followupPointerDelivery(mode: FollowupMode,
  event: { metaKey?: boolean; ctrlKey?: boolean }, platform?: string): InputDelivery | undefined {
  return isModKeyPressed(event, platform) ? followupDelivery(mode, true) : undefined;
}

export function CurrentTurnInput({ mode, onChange, disabled = false, canGuide = true }: {
  mode: FollowupMode;
  onChange: (mode: FollowupMode) => void;
  disabled?: boolean;
  canGuide?: boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [portalReady, setPortalReady] = useState(false);
  const [menuPosition, setMenuPosition] = useState<React.CSSProperties | null>(null);
  const menuId = `xn-current-turn-input-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const openingKey = useRef<'selected' | 'first' | 'last'>('selected');
  const current = mode === 'guide'
    ? { label: '引导', Icon: CornerDownRight, description: '在下一步模型请求前处理，不中断正在执行的工具。' }
    : { label: '排队', Icon: MessageSquareText, description: '当前轮结束后执行。' };

  const closeMenu = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  };
  const openMenu = (focus: 'selected' | 'first' | 'last' = 'selected') => {
    openingKey.current = focus;
    setOpen(true);
  };

  useEffect(() => setPortalReady(true), []);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => {
    if (!open) return;
    const options = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]:not(:disabled)') ?? []);
    const preferred = openingKey.current === 'selected'
      ? options.find(option => option.getAttribute('aria-checked') === 'true')
      : openingKey.current === 'first' ? options[0] : options.at(-1);
    openingKey.current = 'selected';
    (preferred ?? options[0])?.focus();
  }, [open]);
  useIsomorphicLayoutEffect(() => {
    if (!open) {
      setMenuPosition(null);
      return;
    }
    const placeMenu = () => {
      const trigger = triggerRef.current;
      const menu = menuRef.current;
      if (!trigger || !menu) return;
      const rect = trigger.getBoundingClientRect();
      const margin = 12;
      const gap = 6;
      const viewportWidth = Math.max(1, document.documentElement.clientWidth || window.innerWidth);
      const viewportHeight = Math.max(1, document.documentElement.clientHeight || window.innerHeight);
      const width = Math.min(menu.getBoundingClientRect().width || 280, Math.max(1, viewportWidth - margin * 2));
      const left = Math.max(margin, Math.min(rect.left, viewportWidth - width - margin));
      const above = Math.max(0, rect.top - gap - margin);
      const below = Math.max(0, viewportHeight - rect.bottom - gap - margin);
      const naturalHeight = menu.scrollHeight;
      const opensUp = above >= naturalHeight || above >= below;
      const availableHeight = opensUp ? above : below;
      const height = Math.min(naturalHeight, availableHeight);
      const top = opensUp ? Math.max(margin, rect.top - gap - height)
        : Math.min(viewportHeight - margin - height, rect.bottom + gap);
      setMenuPosition({ position: 'fixed', top, left, width, maxHeight: height,
        overflowY: naturalHeight > height ? 'auto' : 'visible', visibility: 'visible' });
    };
    placeMenu();
    window.addEventListener('resize', placeMenu);
    window.addEventListener('scroll', placeMenu, true);
    return () => {
      window.removeEventListener('resize', placeMenu);
      window.removeEventListener('scroll', placeMenu, true);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const dismissOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) closeMenu();
    };
    document.addEventListener('pointerdown', dismissOutside);
    return () => document.removeEventListener('pointerdown', dismissOutside);
  }, [open]);

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu(true);
      return;
    }
    if (event.key === 'Tab') {
      closeMenu();
      if (focusOutsideMenu(triggerRef.current, menuRef.current, event.shiftKey)) event.preventDefault();
      return;
    }
    const options = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]:not(:disabled)'));
    const currentIndex = options.indexOf(document.activeElement as HTMLButtonElement);
    let nextIndex: number | undefined;
    if (event.key === 'ArrowDown') nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % options.length;
    else if (event.key === 'ArrowUp') nextIndex = currentIndex < 0 ? options.length - 1 : (currentIndex - 1 + options.length) % options.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = options.length - 1;
    if (nextIndex !== undefined && options.length) {
      event.preventDefault();
      options[nextIndex]?.focus();
    }
  };
  const choose = (next: FollowupMode) => {
    onChange(next);
    closeMenu(true);
  };
  const CurrentIcon = current.Icon;
  const menu = <div id={menuId} ref={menuRef} className="xn-current-turn-input__menu" role="menu"
    aria-label={tr('后续输入方式')} hidden={!open} style={menuPosition ?? { visibility: 'hidden' }}
    data-testid="current-turn-input-menu" onKeyDown={onMenuKeyDown}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) closeMenu(); }}>
    <button type="button" role="menuitemradio" aria-checked={mode === 'guide'} disabled={!canGuide}
      data-testid="current-turn-input-guide" onClick={() => choose('guide')}>
      <CornerDownRight size={16} aria-hidden="true" />
      <span className="xn-current-turn-input__option-copy"><strong>{tr('引导')}</strong>
        <small>{tr('在下一步模型请求前处理，不中断正在执行的工具。')}</small></span>
      {mode === 'guide' && <Check size={15} aria-hidden="true" />}
    </button>
    <button type="button" role="menuitemradio" aria-checked={mode === 'queue'}
      data-testid="current-turn-input-queue" onClick={() => choose('queue')}>
      <MessageSquareText size={16} aria-hidden="true" />
      <span className="xn-current-turn-input__option-copy"><strong>{tr('排队')}</strong>
        <small>{tr('当前轮结束后执行。')}</small></span>
      {mode === 'queue' && <Check size={15} aria-hidden="true" />}
    </button>
  </div>;

  return <div className="xn-current-turn-input" ref={rootRef} data-testid="current-turn-input">
    <button ref={triggerRef} type="button" className="xn-current-turn-input__trigger"
      aria-label={tr('后续输入方式')} aria-haspopup="menu" aria-expanded={open} aria-controls={menuId}
      title={tr(current.description)} disabled={disabled} data-testid="current-turn-input-trigger"
      onClick={() => open ? closeMenu() : openMenu()}
      onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          openMenu(event.key === 'ArrowDown' ? 'first' : 'last');
        }
      }}>
      <CurrentIcon size={15} aria-hidden="true" />
      <span>{tr(current.label)}</span>
      <ChevronDown size={13} aria-hidden="true" className="xn-current-turn-input__chevron" />
    </button>
    {portalReady && typeof document !== 'undefined' ? createPortal(menu, document.body) : menu}
  </div>;
}

export type PendingGuidance = {
  id: string; text: string; status: 'queued' | 'running' | 'paused' | 'completed' | 'needs_review' | 'failed' | 'cancelled';
  targetTurnId?: string; pause_reason?: string; delivery?: 'guide'; position?: number;
  has_attachments?: boolean; has_context?: boolean;
};

export function PendingGuidancePanel({ items, onWithdraw, busyId, disabled = false }: {
  items: PendingGuidance[];
  onWithdraw?: (id: string) => void;
  busyId?: string | null;
  disabled?: boolean;
}): React.JSX.Element | null {
  if (!items.length) return null;
  return <section className="xn-pending-guidance" aria-label={tr('待处理引导')} data-testid="pending-guidance-panel">
    <ol className="xn-pending-guidance__items">{items.map(item => <li key={item.id}
      className="xn-pending-guidance__item" data-status={item.status} data-testid={`pending-guidance-row-${item.id}`}>
      <span className="xn-pending-guidance__leading" aria-hidden="true"><MessageSquareText size={15} /></span>
      <div className="xn-pending-guidance__copy"><p>{item.text}</p>
        {item.status === 'paused' && <small>{tr('目标轮次已结束，请撤回后重新发送。')}</small>}
        {(item.has_attachments || item.has_context) && <small>{tr('原附件或上下文不会恢复，请重新添加。')}</small>}</div>
      <span className="xn-pending-guidance__mode"><CornerDownRight size={14} aria-hidden="true" />{tr('引导')}</span>
      {onWithdraw && (item.status === 'queued' || item.status === 'paused') && <button type="button"
        className="xn-pending-guidance__withdraw" aria-label={tr(busyId === item.id ? '正在取消…' : '撤回到输入框')}
        title={tr(busyId === item.id ? '正在取消…' : '撤回到输入框')} disabled={disabled || Boolean(busyId)}
        onClick={() => onWithdraw(item.id)}><Undo2 size={15} aria-hidden="true" /></button>}
    </li>)}</ol>
  </section>;
}
