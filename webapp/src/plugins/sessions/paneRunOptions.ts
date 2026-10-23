import { mergeRunChoices, type RunChoices } from '../../xuenessBridge';
import type { PaneIdentity } from './paneIdentity';
import { paneBindingKey } from './paneIdentity';

export type PaneRunOptions = Readonly<RunChoices>;
export function copyPaneRunOptions(choices: PaneRunOptions): RunChoices { return { ...choices }; }
export function updatePaneRunOptions(current: PaneRunOptions, patch: Partial<RunChoices>): RunChoices {
  return mergeRunChoices({ ...current }, patch);
}
/** Snapshot identity at admission; every async boundary must still own it. */
export function paneBindingGuard(identity: PaneIdentity, current: () => PaneIdentity | null, enabled: () => boolean): () => boolean {
  const key = paneBindingKey(identity);
  return () => { const value = current(); return enabled() && value !== null && paneBindingKey(value) === key; };
}
