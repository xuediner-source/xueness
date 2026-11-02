import React from 'react';
import { Select } from '../../ui/Select';
import { t as tr } from '../../i18n';
import './session-header.css';

export function WorkbenchViewSwitcher<T extends string>({ value, options, onChange }: {
  value: T; options: { id: T; label: string }[]; onChange(value: T): void;
}) {
  const navRef = React.useRef<HTMLElement>(null);
  const [compact, setCompact] = React.useState(true);
  React.useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      // Keep the current layout while a pane hovers around the old 520px boundary.
      setCompact(current => width < 500 ? true : width > 540 ? false : current);
    });
    observer.observe(nav);
    return () => observer.disconnect();
  }, []);
  const order = ['chat', 'context-lens', 'subagents', 'files', 'git', 'terminal'];
  const primary = options.filter(option => (compact ? ['chat', 'files', 'terminal'] : order).includes(option.id)).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const more = options.filter(option => !primary.includes(option));
  return <nav ref={navRef} className="xn-session-tabs" aria-label={tr('会话视图')}>
    <div className="xn-session-tabs__primary">{primary.map(option => <button type="button" key={option.id} title={option.label} aria-current={value === option.id ? 'page' : undefined}
      onClick={() => onChange(option.id)}>{option.id === 'chat' ? tr('对话') : option.label}</button>)}</div>
    {more.length > 0 && <Select menuPosition="popper" className="xn-view-switcher xn-session-tabs__more" aria-label={tr('切换视图')} value={primary.some(option => option.id === value) ? '' : value} onChange={event => onChange(event.target.value as T)}>
      <option value="" disabled>{tr('更多')}</option>{more.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
    </Select>}
  </nav>;
}
