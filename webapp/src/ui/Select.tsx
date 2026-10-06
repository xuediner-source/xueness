/** Accessible select using the same Radix interaction primitive as upstream.
 * Styling follows the v3.14.3 input/menu tokens; see NOTICE.md.
 */
import React from 'react';
import * as R from '@radix-ui/react-select';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import './select.css';
type Props = Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'multiple' | 'size'>;
type Entry = { value: string; label: React.ReactNode; disabled: boolean; group?: string };
const encode = (value: string) => value === '' ? '__xn_empty_value__' : `v:${value}`;
const decode = (value: string) => value === '__xn_empty_value__' ? '' : value.slice(2);
function entries(children: React.ReactNode, group?: string): Entry[] {
  return React.Children.toArray(children).flatMap(child => {
    if (!React.isValidElement(child)) return [];
    const props = child.props as { children?: React.ReactNode; value?: string | number; disabled?: boolean; label?: string };
    if (child.type === 'optgroup' || child.type === React.Fragment) return entries(props.children, props.label ?? group);
    if (child.type !== 'option') return [];
    return [{ value: String(props.value ?? props.children ?? ''), label: props.children, disabled: props.disabled === true, group }];
  });
}
export function Select({ children, value, defaultValue, onChange, className = '', style, disabled, required, name, id, title, ...rest }: Props) {
  const items = entries(children);
  const portalOwner = React.useId().replace(/:/gu, '');
  const [localValue, setLocalValue] = React.useState(String(defaultValue ?? items[0]?.value ?? ''));
  const selected = String(value ?? localValue);
  const aria = Object.fromEntries(Object.entries(rest).filter(([key]) => key.startsWith('aria-') || key.startsWith('data-')));
  return <R.Root value={encode(selected)} onValueChange={next => {
    // Radix's hidden form select can emit an unencoded empty value while async
    // options change. That is not a user choice and must not reset a workspace.
    if (next !== '__xn_empty_value__' && !next.startsWith('v:')) return;
    const publicValue = decode(next); setLocalValue(publicValue);
    onChange?.({ target: { value: publicValue }, currentTarget: { value: publicValue } } as React.ChangeEvent<HTMLSelectElement>);
  }} disabled={disabled} required={required} name={name}>
    <R.Trigger id={id} title={title} className={`xn-select ${className}`} style={style} {...aria} data-xn-select-portal-trigger={portalOwner}>
      <R.Value>{items.find(item => item.value === selected)?.label ?? selected}</R.Value>
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
