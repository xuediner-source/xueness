/** Accessible select using the same Radix interaction primitive as upstream.
 * Styling follows the v3.14.3 input/menu tokens; see NOTICE.md.
 *
 * The Radix primitive is not part of the startup bundle. Until it has loaded,
 * a select renders the same trigger markup (button > value span + chevron), so
 * nothing moves when it arrives; a click or key press in that moment opens the
 * menu as soon as it is ready, and keyboard focus stays on the trigger.
 */
import React from 'react';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import './select.css';
type Props = Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'multiple' | 'size'>;
type Entry = { value: string; label: React.ReactNode; disabled: boolean; group?: string };
type RadixSelect = typeof import('@radix-ui/react-select');
const encode = (value: string) => value === '' ? '__xn_empty_value__' : `v:${value}`;
const decode = (value: string) => value === '__xn_empty_value__' ? '' : value.slice(2);
const OPEN_KEYS = new Set([' ', 'Enter', 'ArrowDown', 'ArrowUp']);
function entries(children: React.ReactNode, group?: string): Entry[] {
  return React.Children.toArray(children).flatMap(child => {
    if (!React.isValidElement(child)) return [];
    const props = child.props as { children?: React.ReactNode; value?: string | number; disabled?: boolean; label?: string };
    if (child.type === 'optgroup' || child.type === React.Fragment) return entries(props.children, props.label ?? group);
    if (child.type !== 'option') return [];
    return [{ value: String(props.value ?? props.children ?? ''), label: props.children, disabled: props.disabled === true, group }];
  });
}

let radixSelect: RadixSelect | undefined;
let radixSelectLoading: Promise<RadixSelect> | undefined;

/** Load the shared Radix select primitive. A failed load is retried by the next caller. */
export function loadSelectPrimitive(): Promise<RadixSelect> {
  return radixSelectLoading ??= import('@radix-ui/react-select').then(module => {
    radixSelect = module;
    return module;
  }, error => {
    radixSelectLoading = undefined;
    throw error;
  });
}

export function Select({ children, value, defaultValue, onChange, className = '', style, disabled, required, name, id, title, ...rest }: Props) {
  const items = entries(children);
  const portalOwner = React.useId().replace(/:/gu, '');
  const [localValue, setLocalValue] = React.useState(String(defaultValue ?? items[0]?.value ?? ''));
  const [R, setR] = React.useState<RadixSelect | undefined>(radixSelect);
  const [openWhenReady, setOpenWhenReady] = React.useState(false);
  const focused = React.useRef(false);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    if (R) return;
    let live = true;
    void loadSelectPrimitive().then(module => { if (live) setR(module); }, () => undefined);
    return () => { live = false; };
  }, [R]);
  React.useEffect(() => {
    // The Radix trigger replaces the placeholder button; keep keyboard focus on it.
    if (R && focused.current) triggerRef.current?.focus({ preventScroll: true });
  }, [R]);
  const selected = String(value ?? localValue);
  const aria = Object.fromEntries(Object.entries(rest).filter(([key]) => key.startsWith('aria-') || key.startsWith('data-')));
  const label = items.find(item => item.value === selected)?.label ?? selected;
  if (!R) {
    const requestOpen = () => { if (!disabled) setOpenWhenReady(true); };
    return <>
      <button type="button" id={id} title={title} className={`xn-select ${className}`} style={style} {...aria}
        role="combobox" aria-expanded={false} aria-autocomplete="none" aria-required={required} disabled={disabled}
        data-state="closed" data-disabled={disabled ? '' : undefined} data-xn-select-portal-trigger={portalOwner}
        onClick={requestOpen}
        onKeyDown={event => { if (OPEN_KEYS.has(event.key)) { event.preventDefault(); requestOpen(); } }}
        onFocus={() => { focused.current = true; }} onBlur={() => { focused.current = false; }}>
        <span style={{ pointerEvents: 'none' }}>{label}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {name !== undefined && <input type="hidden" name={name} value={selected} />}
    </>;
  }
  return <R.Root defaultOpen={openWhenReady} value={encode(selected)} onValueChange={next => {
    // Radix's hidden form select can emit an unencoded empty value while async
    // options change. That is not a user choice and must not reset a workspace.
    if (next !== '__xn_empty_value__' && !next.startsWith('v:')) return;
    const publicValue = decode(next); setLocalValue(publicValue);
    onChange?.({ target: { value: publicValue }, currentTarget: { value: publicValue } } as React.ChangeEvent<HTMLSelectElement>);
  }} disabled={disabled} required={required} name={name}>
    <R.Trigger ref={triggerRef} id={id} title={title} className={`xn-select ${className}`} style={style} {...aria} data-xn-select-portal-trigger={portalOwner}>
      <R.Value>{label}</R.Value>
      <R.Icon asChild><ChevronDown size={14} /></R.Icon>
    </R.Trigger>
    <R.Portal><R.Content className="xn-select-menu" data-xn-select-portal-owner={portalOwner} position="item-aligned">
      <R.ScrollUpButton className="xn-select-scroll"><ChevronUp size={14} /></R.ScrollUpButton>
      <R.Viewport className="xn-select-viewport">
        {items.map((item, index) => <React.Fragment key={`${item.value}-${index}`}>
          {item.group && item.group !== items[index-1]?.group && <div className="xn-select-group-label" role="presentation">{item.group}</div>}
          <R.Item className="xn-select-option" value={encode(item.value)} disabled={item.disabled}>
            <R.ItemText>{item.label}</R.ItemText><R.ItemIndicator className="xn-select-check"><Check size={16} /></R.ItemIndicator>
          </R.Item>
        </React.Fragment>)}
      </R.Viewport>
      <R.ScrollDownButton className="xn-select-scroll"><ChevronDown size={14} /></R.ScrollDownButton>
    </R.Content></R.Portal>
  </R.Root>;
}
