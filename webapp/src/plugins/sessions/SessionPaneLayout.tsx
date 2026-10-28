import React, { lazy, Suspense } from 'react';
import { t as tr } from '../../i18n';
import { paneLayoutIsSplitVisible, type PaneSplit } from './paneLayout';
import type { SessionPaneSplit } from './SessionPaneSplit';

// The closed/single layout never imports the split UI, pointer handlers or CSS.
const LazyPaneSplit = lazy(() => import('./SessionPaneSplit').then(module => ({ default: module.SessionPaneSplit })));

export function PaneSplitControls({ split, onSplitRight, onSplitDown }: {
  split: PaneSplit | null;
  onSplitRight: () => void;
  onSplitDown: () => void;
}) {
  return <>
    <button type="button" className="xn-conv-header__action" data-testid="xn-pane-split-right"
      aria-pressed={split === 'row'} title={tr('向右分屏')} onClick={onSplitRight}>{tr('向右分屏')}</button>
    <button type="button" className="xn-conv-header__action" data-testid="xn-pane-split-down"
      aria-pressed={split === 'column'} title={tr('向下分屏')} onClick={onSplitDown}>{tr('向下分屏')}</button>
  </>;
}

export function SessionPaneLayout(props: React.ComponentProps<typeof SessionPaneSplit>) {
  if (!paneLayoutIsSplitVisible(props.layout, props.wide, props.enabled ?? true)) return props.children;
  return <Suspense fallback={props.children}><LazyPaneSplit {...props} /></Suspense>;
}
