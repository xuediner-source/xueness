import React, { useEffect, useRef, useState } from 'react';
import { t as tr, messages } from '../../i18n';
import { loadComposerCatalog, canUseRuntimeProfile, type ComposerCatalog, type ComposerModel } from '../../xuenessComposer';
import type { RunChoices } from '../../xuenessBridge';
import { updatePaneRunOptions } from './paneRunOptions';
import type { PermissionMode } from './permissionModes';
import { normalizeReasoningLevels } from './ReasoningEffortSlider';
import { isImeComposingEvent } from '../../xuenessShortcutDisplay';

messages['远程连接未提供模型目录'] = 'This remote connection does not expose a model catalog';
messages['当前模型不可用，请重新选择'] = 'The selected model is unavailable. Choose another model.';
messages['分屏运行选项'] = 'Split conversation run options';
messages['默认推理'] = 'Default reasoning';
messages['守护执行'] = 'Guarded';

const permissionLabels: Record<PermissionMode, string> = { plan: '计划', build: '变更前确认', edit: '自动编辑', yolo: '完全访问', guarded: '守护执行' };

/** A remote pane must never inspect a local provider catalog. */
export async function loadPaneOptionCatalog(args: { enabled: boolean; providers: boolean; remote: boolean; root: string; sessionId: string | null; remoteLoad?: typeof loadComposerCatalog },
  signal: AbortSignal, load = loadComposerCatalog): Promise<ComposerCatalog | null> {
  if (!args.enabled || !args.providers || signal.aborted) return null;
  if (args.remote) return args.remoteLoad ? args.remoteLoad(undefined, args.sessionId ?? undefined, signal) : null;
  return load(args.root || undefined, args.sessionId ?? undefined, signal);
}
export function panePlanningAvailable(remote: boolean, catalog: ComposerCatalog | null, plugins?: ReadonlySet<string>): boolean {
  return remote ? catalog?.planningEnabled === true : plugins?.has('planning') === true;
}
export function selectedPaneModel(models: readonly ComposerModel[], choices: RunChoices): ComposerModel | undefined {
  return models.find(model => choices.provider_id !== undefined
    ? model.id === choices.provider_id && (!choices.model || model.model === choices.model)
    : !!choices.model && model.model === choices.model);
}
export function paneModelChoice(choices: RunChoices, model: ComposerModel): RunChoices {
  return updatePaneRunOptions(choices, { provider_id: model.id, model: model.model, reasoning_effort: undefined,
    ...(choices.runtime_profile === 'standard' && !canUseRuntimeProfile(model, 'standard') ? { runtime_profile: undefined } : {}) });
}
export function paneModelsNeedSetup(models: readonly ComposerModel[]): boolean {
  return !models.some(model => model.configured);
}
export function paneCatalogNeedsModelSetup(modelsEnabled: boolean, models: readonly ComposerModel[]): boolean {
  return modelsEnabled && paneModelsNeedSetup(models);
}
export function configurePaneModels(effectivePluginIds: ReadonlySet<string> | undefined, isCurrent: () => boolean, onConfigure?: () => void): void {
  if (isCurrent() && effectivePluginIds?.has('providers')) onConfigure?.();
}

export function PaneModelSetupAction({ onConfigure }: { onConfigure?: () => void }) {
  return <>
    <span role="status" className="xn-composer-toolbar__message" data-testid="pane-model-setup">{tr('暂无可用模型')}</span>
    {onConfigure && <button type="button" className="xn-composer-toolbar__tool" onClick={onConfigure}>{tr('配置模型')}</button>}
  </>;
}

/** Selection never persists a full-access acknowledgement or writes after a pane rebind. */
export async function choosePanePermission(value: PermissionMode, choices: RunChoices,
  ensure: PaneOptionToolbarProps['ensurePermission'], isCurrent: () => boolean, onChange: (choices: RunChoices) => void): Promise<boolean> {
  if (!isCurrent()) return false;
  const confirmed = await ensure(updatePaneRunOptions(choices, { permission_mode: value, acknowledge_yolo: false }), value === 'yolo' ? undefined : choices.permission_mode);
  if (!confirmed || !isCurrent()) return false;
  onChange({ ...confirmed, acknowledge_yolo: false });
  return true;
}

type Option = { id: string; label: string; description?: string; selected?: boolean; disabled?: boolean; checkbox?: boolean; choose(): void };
export function PaneOptionMenu({ label, action, disabled, options }: { label: string; action?: string; disabled?: boolean; options: Option[] }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => { if (!wrap.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  return <div ref={wrap} className="xn-composer-toolbar__model" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
  }}>
    <button type="button" ref={trigger} className="xn-composer-toolbar__model-trigger" disabled={disabled}
      data-shortcut-action={action} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}
      onKeyDown={event => { if (!isImeComposingEvent(event) && ['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); setOpen(true); } }}>{label}</button>
    {open && <div ref={menu} role="menu" aria-label={label} className="xn-composer-toolbar__popover" onKeyDown={event => {
      if (isImeComposingEvent(event)) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); return; }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }}>{options.map(option => <button key={option.id} type="button" role={option.checkbox ? "menuitemcheckbox" : "menuitemradio"} aria-checked={option.selected === true}
      className="xn-composer-toolbar__menu-row" disabled={disabled || option.disabled} onClick={() => {
        if (disabled || option.disabled) return;
        setOpen(false); trigger.current?.focus(); option.choose();
      }} title={option.description} aria-description={option.description}>{option.label}</button>)}</div>}
  </div>;
}

export type PaneOptionToolbarProps = {
  enabled: boolean; effectivePluginIds?: ReadonlySet<string>; remote: boolean; remoteCommands: boolean; remoteLoad?: typeof loadComposerCatalog;
  root: string; sessionId: string | null; choices: RunChoices; onChange(choices: RunChoices): void;
  onConfigureModels?: () => void;
  isCurrent(): boolean; ensurePermission(choices: RunChoices, savedMode?: PermissionMode): Promise<RunChoices | null>;
};
export function PaneOptionToolbar(props: PaneOptionToolbarProps) {
  const { enabled, effectivePluginIds, remote, remoteCommands, remoteLoad, root, sessionId, choices, onChange } = props;
  const providers = effectivePluginIds?.has('providers') === true;
  const sessions = enabled && effectivePluginIds?.has('sessions') === true;
  const [catalog, setCatalog] = useState<ComposerCatalog | null>(null), [error, setError] = useState('');
  const [loading, setLoading] = useState(false), [revision, reload] = useState(0), [confirming, setConfirming] = useState(false);
  const live = useRef(props); live.current = props;
  const liveCatalog = useRef(catalog); liveCatalog.current = catalog;
  useEffect(() => {
    const controller = new AbortController();
    setCatalog(null); setError('');
    setLoading(sessions && providers && (!remote || !!remoteLoad));
    void loadPaneOptionCatalog({ enabled: sessions, providers, remote, root, sessionId, remoteLoad }, controller.signal).then(value => {
      if (!controller.signal.aborted) setCatalog(value);
    }).catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : String(error)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [sessions, providers, remote, remoteLoad, root, sessionId, revision]);
  if (!sessions) return null;
  const current = () => live.current.enabled && live.current.effectivePluginIds?.has('sessions') === true && live.current.isCurrent();
  const change = (patch: Partial<RunChoices>, plugin: string) => { if (current() && live.current.effectivePluginIds?.has(plugin)) live.current.onChange(updatePaneRunOptions(live.current.choices, patch)); };
  const models = (!remote || !!remoteLoad) && providers ? catalog?.models ?? [] : [];
  const selected = selectedPaneModel(models, choices);
  const levels = normalizeReasoningLevels(selected?.reasoningLevels);
  const modelsEnabled = !loading && !error && catalog?.allowReal === true && providers && (!remote || !!remoteLoad);
  const modelsNeedSetup = paneCatalogNeedsModelSetup(modelsEnabled, models);
  const permission = choices.permission_mode ?? 'build';
  return <div className="xn-composer-toolbar" role="group" aria-label={tr('分屏运行选项')} data-testid="pane-option-toolbar">
    <div className="xn-composer-toolbar__left">
      <PaneOptionMenu label={tr(permissionLabels[permission])} action="open-mode-menu" disabled={confirming || (remote && !remoteCommands)} options={([
        'plan', 'build', 'edit', 'yolo', 'guarded',
      ] as PermissionMode[]).map<Option>(value => ({ id: value, label: tr(permissionLabels[value]), ...(value === 'guarded' ? { description: tr('常规命令自动执行，已识别危险命令每次确认。') } : {}), selected: permission === value, choose: () => {
        if (!current()) return;
        setConfirming(true);
        void choosePanePermission(value, live.current.choices, live.current.ensurePermission, current, next => live.current.onChange(next)).finally(() => { if (current()) setConfirming(false); });
      } })).concat(panePlanningAvailable(remote, catalog, effectivePluginIds) ? [{ id: 'planning', label: tr('计划模式'), checkbox: true, selected: choices.mode === 'plan',
        choose: () => { if (current() && panePlanningAvailable(live.current.remote, liveCatalog.current, live.current.effectivePluginIds)) live.current.onChange(updatePaneRunOptions(live.current.choices, { mode: live.current.choices.mode === 'plan' ? 'build' : 'plan' })); } }] : [])} />
    </div>
    <div className="xn-composer-toolbar__right">
      {remote && !remoteLoad ? <span role="status">{tr('远程连接未提供模型目录')}</span> : providers && <>
        <PaneOptionMenu label={selected?.name ?? choices.model ?? tr('选择模型')} action="open-model-menu" disabled={!modelsEnabled || modelsNeedSetup}
          options={models.map(model => ({ id: JSON.stringify([model.id, model.model]), label: model.name, selected: selected === model, disabled: !model.configured,
            choose: () => { if (current() && live.current.effectivePluginIds?.has('providers')) onChange(paneModelChoice(live.current.choices, model)); } }))} />
        {selected?.configured && levels.length > 0 && <PaneOptionMenu label={choices.reasoning_effort ?? tr('默认推理')} action="open-reasoning-menu" disabled={!modelsEnabled}
          options={[{ id: '', label: tr('默认推理'), selected: !choices.reasoning_effort, choose: () => change({ reasoning_effort: undefined }, 'providers') },
            ...levels.map(level => ({ id: level, label: level, selected: choices.reasoning_effort === level, choose: () => change({ reasoning_effort: level }, 'providers') }))]} />}
        {selected?.configured && <PaneOptionMenu label={tr((choices.runtime_profile ?? selected.runtimeProfile) === 'lightweight' ? '轻量模式' : '标准模式')} disabled={!modelsEnabled}
          options={(['standard', 'lightweight'] as const).map(profile => ({ id: profile, label: tr(profile === 'standard' ? '标准模式' : '轻量模式'),
            selected: (choices.runtime_profile ?? selected.runtimeProfile ?? 'standard') === profile, disabled: !canUseRuntimeProfile(selected, profile),
            choose: () => change({ runtime_profile: profile }, 'providers') }))} />}
        {loading && <span role="status">{tr('正在加载模型…')}</span>}
        {error && <><span role="alert">{error}</span><button type="button" onClick={() => { if (current()) reload(value => value + 1); }}>{tr('重试')}</button></>}
        {!loading && catalog && !catalog.allowReal && <span role="status">{tr('服务端已关闭模型请求。')}</span>}
        {modelsNeedSetup && <PaneModelSetupAction onConfigure={props.onConfigureModels && (() =>
          configurePaneModels(live.current.effectivePluginIds, current, live.current.onConfigureModels))} />}
        {!loading && catalog && !selected && (choices.model || choices.provider_id) && <span role="status">{tr('当前模型不可用，请重新选择')}</span>}
      </>}
    </div>
  </div>;
}
