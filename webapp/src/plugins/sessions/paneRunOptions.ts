import { mergeRunChoices, type RunChoices } from '../../xuenessBridge';

export type PaneRunOptions = Readonly<RunChoices>;
export function copyPaneRunOptions(choices: PaneRunOptions): RunChoices { return { ...choices }; }
export function updatePaneRunOptions(current: PaneRunOptions, patch: Partial<RunChoices>): RunChoices {
  return mergeRunChoices({ ...current }, patch);
}
