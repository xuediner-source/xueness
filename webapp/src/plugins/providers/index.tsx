import React, { useEffect, useMemo, useState } from 'react';
import {
  Check,
  ChevronRight,
  Cpu,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  Plus,
  Radio,
  RefreshCw,
  Server,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { adoptProviderCompatibility, deleteProvider, discoverProviderModels, listProviders, saveProvider, testProviderCompatibility, testProviderConnection } from '../../xuenessApi';
import type { ProviderCompatibilityCheckRecord, ProviderCompatibilityDiagnosticGroup, ProviderCompatibilityTest, ProviderCompatibilityTestMode, ProviderConnectionTest, ProviderDiscoveredModel, ProviderLightweightOptions, ProviderSummary } from '../../xuenessApi';
import { Select } from '../../ui/Select';
import { t as tr, tf } from '../../i18n';
import { OperationHeader } from '../shared';
import { SettingsEmptyState } from '../settings/SettingsPrimitives';
import { LocalRuntimeMonitor } from './LocalRuntimeMonitor';
import '../../styles/operations.css';
import '../../styles/model-parity.css';

const ENVIRONMENT_KEY = '__environment__';
const NEW_PROVIDER_KEY = '__new_provider__';
const REASONING_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const LIGHTWEIGHT_DEFAULT_CONTEXT = 8192;
const LIGHTWEIGHT_DEFAULT_OUTPUT = 1024;
const LOCAL_ENDPOINTS = [
  { label: 'Ollama', url: 'http://127.0.0.1:11434/v1' },
  { label: 'LM Studio', url: 'http://127.0.0.1:1234/v1' },
  { label: 'llama.cpp', url: 'http://127.0.0.1:8080/v1' },
  { label: 'vLLM', url: 'http://127.0.0.1:8000/v1' },
] as const;
const CAPABILITIES = [
  { id: 'image', label: '图片' },
  { id: 'pdf', label: 'PDF 文档' },
  { id: 'video', label: '视频帧' },
] as const;

export type ProviderDraft = {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  protocol: 'openai' | 'anthropic';
  capabilities: string[];
  reasoningLevels: string[];
  runtimeProfile?: 'standard' | 'lightweight';
  contextWindow?: number;
  maxOutputTokens?: number;
  toolCalling?: 'native' | 'json';
  compatibility?: NonNullable<ProviderSummary['compatibility']>;
  lightweightOptions?: ProviderLightweightOptions;
};

type NumericLightweightOptionKey = {
  [K in keyof ProviderLightweightOptions]-?: Exclude<ProviderLightweightOptions[K], undefined> extends number ? K : never
}[keyof ProviderLightweightOptions];

export const emptyProviderDraft = (): ProviderDraft => ({
  id: '', name: '', baseUrl: '', model: '', apiKey: '', protocol: 'openai',
  capabilities: [], reasoningLevels: [],
});

/** Create an editor draft from the public summary. API keys are intentionally never copied. */
export function providerDraftFromSummary(provider: ProviderSummary): ProviderDraft {
  return {
    ...emptyProviderDraft(),
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    model: provider.model,
    protocol: provider.protocol ?? 'openai',
    capabilities: [...(provider.capabilities ?? [])],
    reasoningLevels: [...(provider.reasoningLevels ?? [])],
    ...(provider.runtimeProfile ? { runtimeProfile: provider.runtimeProfile } : {}),
    ...(provider.contextWindow !== undefined ? { contextWindow: provider.contextWindow } : {}),
    ...(provider.maxOutputTokens !== undefined ? { maxOutputTokens: provider.maxOutputTokens } : {}),
    ...(provider.toolCalling ? { toolCalling: provider.toolCalling } : {}),
    ...(provider.compatibility ? { compatibility: { ...provider.compatibility } } : {}),
    ...(provider.lightweightOptions ? { lightweightOptions: { ...provider.lightweightOptions } } : {}),
  };
}

export function validateProviderDraft(draft: ProviderDraft): string | null {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(draft.id)) return '配置 ID 必须由 1–64 个英文字母、数字、点、下划线或连字符组成。';
  if (!draft.name.trim()) return '显示名称不能为空。';
  if (!draft.model.trim()) return '模型名称不能为空。';
  try {
    const url = new URL(draft.baseUrl.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'API 地址必须使用 HTTP 或 HTTPS。';
  } catch {
    return '请输入有效的 API 地址。';
  }
  const profile = draft.runtimeProfile ?? 'standard';
  if (draft.runtimeProfile !== undefined && !['standard', 'lightweight'].includes(draft.runtimeProfile)) return '运行配置无效。';
  if (draft.contextWindow !== undefined && (!Number.isInteger(draft.contextWindow) || draft.contextWindow < 2048 || draft.contextWindow > 262144)) {
    return '上下文窗口必须是 2048–262144 之间的整数。';
  }
  if (draft.maxOutputTokens !== undefined && (!Number.isInteger(draft.maxOutputTokens) || draft.maxOutputTokens < 128 || draft.maxOutputTokens > 32768)) {
    return '最大输出必须是 128–32768 之间的整数。';
  }
  if (draft.contextWindow !== undefined && draft.maxOutputTokens !== undefined && draft.maxOutputTokens > draft.contextWindow / 2) {
    return '最大输出不能超过上下文窗口的一半。';
  }
  const optionError = validateLightweightOptions(draft);
  if (optionError) return optionError;
  if (draft.toolCalling !== undefined && !['native', 'json'].includes(draft.toolCalling)) return '工具调用模式无效。';
  if (draft.toolCalling === 'json' && (profile !== 'lightweight' || draft.protocol !== 'openai')) {
    return 'JSON 工具模式仅适用于 OpenAI-compatible 本地轻量配置。';
  }
  const compatibility = draft.compatibility ?? {};
  const allowedCompatibility = new Set(['streamUsage', 'parallelToolCalls', 'maxTokensField', 'toolChoice', 'think']);
  if (Object.keys(compatibility).some(key => !allowedCompatibility.has(key))) return '兼容设置包含当前服务端不支持的选项，请先刷新配置。';
  if ((compatibility.streamUsage !== undefined && typeof compatibility.streamUsage !== 'boolean')
    || (compatibility.parallelToolCalls !== undefined && typeof compatibility.parallelToolCalls !== 'boolean')) {
    return '兼容开关必须是布尔值。';
  }
  if ('maxTokensField' in compatibility && !['max_tokens', 'max_completion_tokens'].includes(String(compatibility.maxTokensField))) {
    return '最大输出字段设置无效。';
  }
  if ('toolChoice' in compatibility && !['auto', 'required'].includes(String(compatibility.toolChoice))) {
    return 'tool_choice 设置无效。';
  }
  if ('think' in compatibility && typeof compatibility.think !== 'boolean') return 'think 必须是布尔值。';
  return null;
}

const INTEGER_LIGHTWEIGHT_OPTIONS: [keyof ProviderLightweightOptions, number, number][] = [
  ['reserveTokens', 0, 8192], ['optionalContextChars', 0, 6000], ['toolResultChars', 400, 12000],
  ['maxDiscoveredTools', 0, 12], ['toolSearchResults', 1, 6], ['resultPageChars', 128, 4000],
  ['fileReadChars', 128, 12000], ['jsonRepairAttempts', 0, 2], ['stepLimit', 1, 64],
  ['wallTimeSeconds', 1, 3600], ['requestTimeoutSeconds', 1, 300], ['transportRetries', 0, 2], ['seed', 0, 2147483647],
];

export function lightweightBudgetPreview(draft: ProviderDraft) {
  const contextWindow = draft.contextWindow ?? LIGHTWEIGHT_DEFAULT_CONTEXT;
  const outputTokens = draft.maxOutputTokens ?? LIGHTWEIGHT_DEFAULT_OUTPUT;
  const reserveTokens = draft.lightweightOptions?.reserveTokens ?? (contextWindow < 4096 ? 128 : 512);
  return { contextWindow, outputTokens, reserveTokens, inputTokens: contextWindow - outputTokens - reserveTokens };
}

function validateLightweightOptions(draft: ProviderDraft): string | null {
  const options = draft.lightweightOptions ?? {};
  for (const [key, minimum, maximum] of INTEGER_LIGHTWEIGHT_OPTIONS) {
    const value = options[key];
    if (value !== undefined && (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum)) {
      return tf('轻量选项 {0} 必须是 {1} 到 {2} 之间的整数。', [key, minimum, maximum]);
    }
  }
  for (const [key, minimum, maximum] of [['overflowRetryRatio', 0.25, 0.85], ['temperature', 0, 2], ['topP', 0, 1]] as const) {
    const value = options[key];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum || key === 'topP' && value === 0)) {
      return tf('轻量选项 {0} 必须在 {1} 到 {2} 之间。', [key, minimum, maximum]);
    }
  }
  if (options.initialTools !== undefined && !['auto', 'minimal', 'core'].includes(options.initialTools)) return '轻量选项 initialTools 无效。';
  if (options.overflowRetry !== undefined && typeof options.overflowRetry !== 'boolean') return '轻量选项 overflowRetry 必须是布尔值。';
  if ((draft.runtimeProfile ?? 'standard') === 'lightweight') {
    const budget = lightweightBudgetPreview(draft);
    if (budget.inputTokens < 256) return '轻量配置至少需要保留 256 个输入 tokens；请增加上下文、减少输出或降低预留值。';
  }
  return null;
}

/** Keep API keys outbound-only and omit OpenAI-only reasoning fields for Anthropic. */
export function providerSavePayload(draft: ProviderDraft): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    id: draft.id.trim(),
    name: draft.name.trim(),
    baseUrl: draft.baseUrl.trim(),
    model: draft.model.trim(),
    protocol: draft.protocol,
    capabilities: [...draft.capabilities],
    ...(draft.protocol === 'openai' ? { reasoningLevels: [...draft.reasoningLevels] } : {}),
    ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
  };
  const profile = draft.runtimeProfile ?? 'standard';
  if (profile === 'lightweight') {
    payload.runtimeProfile = 'lightweight';
    payload.contextWindow = draft.contextWindow ?? LIGHTWEIGHT_DEFAULT_CONTEXT;
    payload.maxOutputTokens = draft.maxOutputTokens ?? LIGHTWEIGHT_DEFAULT_OUTPUT;
    payload.toolCalling = draft.toolCalling ?? 'native';
  } else {
    // Keep legacy standard profiles on their original request shape unless the
    // user has explicitly stored one of the new runtime settings.
    if (draft.runtimeProfile !== undefined) payload.runtimeProfile = draft.runtimeProfile;
    if (draft.contextWindow !== undefined) payload.contextWindow = draft.contextWindow;
    if (draft.maxOutputTokens !== undefined) payload.maxOutputTokens = draft.maxOutputTokens;
    if (draft.toolCalling !== undefined) payload.toolCalling = draft.toolCalling;
  }
  if (profile === 'lightweight' || draft.lightweightOptions !== undefined) {
    const lightweightOptions = { ...(draft.lightweightOptions ?? {}) };
    if (draft.protocol === 'anthropic') {
      delete lightweightOptions.temperature;
      delete lightweightOptions.topP;
      delete lightweightOptions.seed;
    }
    payload.lightweightOptions = lightweightOptions;
  }
  if (draft.protocol === 'openai' && draft.compatibility !== undefined) {
    payload.compatibility = { ...draft.compatibility };
  } else if (draft.protocol === 'anthropic' && draft.compatibility !== undefined) {
    // Switching protocols must explicitly clear OpenAI-only compatibility data.
    payload.compatibility = {};
  }
  return payload;
}

export function adjustedLightweightOutput(contextWindow: number | undefined, currentOutput: number | undefined): number | undefined {
  if (contextWindow === undefined) return currentOutput;
  return Math.min(currentOutput ?? LIGHTWEIGHT_DEFAULT_OUTPUT, Math.floor(contextWindow / 4));
}

export function providerDraftWithLocalEndpoint(draft: ProviderDraft, baseUrl: string): ProviderDraft {
  return {
    ...draft,
    baseUrl,
    protocol: 'openai',
    reasoningLevels: [],
    runtimeProfile: 'lightweight',
    contextWindow: draft.contextWindow ?? LIGHTWEIGHT_DEFAULT_CONTEXT,
    maxOutputTokens: draft.maxOutputTokens ?? LIGHTWEIGHT_DEFAULT_OUTPUT,
    toolCalling: draft.toolCalling === 'json' ? 'json' : 'native',
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameValues(left: string[], right: string[]): boolean {
  return [...left].sort().join('\0') === [...right].sort().join('\0');
}

function draftsEqual(left: ProviderDraft, right: ProviderDraft): boolean {
  return left.id === right.id && left.name === right.name && left.baseUrl === right.baseUrl
    && left.model === right.model && left.apiKey === right.apiKey && left.protocol === right.protocol
    && sameValues(left.capabilities, right.capabilities)
    && sameValues(left.reasoningLevels, right.reasoningLevels)
    && left.runtimeProfile === right.runtimeProfile
    && left.contextWindow === right.contextWindow
    && left.maxOutputTokens === right.maxOutputTokens
    && left.toolCalling === right.toolCalling
    && JSON.stringify(left.compatibility ?? {}) === JSON.stringify(right.compatibility ?? {})
    && JSON.stringify(left.lightweightOptions ?? {}) === JSON.stringify(right.lightweightOptions ?? {});
}

export function canTestProviderCompatibility(draft: ProviderDraft, original: ProviderSummary | null): boolean {
  if (!original || original.protocol === 'anthropic' || draft.protocol !== 'openai' || draft.apiKey) return false;
  const savedDraft = providerDraftFromSummary(original);
  return draftsEqual({ ...draft, compatibility: savedDraft.compatibility }, savedDraft);
}

function compatibilityOptionsKey(value: NonNullable<ProviderSummary['compatibility']> | undefined): string {
  return JSON.stringify(Object.entries(value ?? {}).sort(([left], [right]) => left.localeCompare(right)));
}

function requiredCompatibilityModes(draft: ProviderDraft): ProviderCompatibilityTestMode[] {
  return ['conversation', 'stream', draft.toolCalling === 'json' ? 'json_tool_call' : 'tool_roundtrip'];
}

export function canAdoptProviderCompatibility(draft: ProviderDraft, original: ProviderSummary | null): boolean {
  if (!canTestProviderCompatibility(draft, original)) return false;
  const candidateKey = compatibilityOptionsKey(draft.compatibility);
  const group = original?.compatibilityDiagnostics?.find(item =>
    compatibilityOptionsKey(item.compatibility) === candidateKey);
  return Boolean(group && requiredCompatibilityModes(draft).every(mode =>
    group.checks.some(check => check.mode === mode && check.ok)));
}

function isLoopbackLiteral(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
  } catch {
    return false;
  }
}

export function ModelProviderNavigation({
  providers,
  selectedKey,
  loading,
  busy,
  onSelect,
  onAdd,
}: {
  providers: ProviderSummary[];
  selectedKey: string;
  loading: boolean;
  busy: boolean;
  onSelect: (key: string) => void;
  onAdd: () => void;
}) {
  return <nav className="xn-provider-nav" aria-label={tr('模型服务商 (Providers)')} data-testid="model-provider-navigation">
    <div className="xn-provider-nav__group">
      <div className="xn-provider-nav__heading">{tr('内置')}</div>
      <button
        type="button"
        className="xn-provider-nav__item"
        data-state={selectedKey === ENVIRONMENT_KEY ? 'selected' : 'idle'}
        aria-current={selectedKey === ENVIRONMENT_KEY ? 'page' : undefined}
        aria-label={tr('环境模型')}
        title={tr('环境模型')}
        disabled={busy}
        onClick={() => onSelect(ENVIRONMENT_KEY)}
      >
        <Server size={16} aria-hidden="true" />
        <span className="xn-provider-nav__label">{tr('环境模型')}</span>
        {selectedKey === ENVIRONMENT_KEY && <ChevronRight size={14} className="xn-provider-nav__current" aria-hidden="true" />}
      </button>
    </div>
    <div className="xn-provider-nav__group xn-provider-nav__group--custom">
      <div className="xn-provider-nav__heading">
        <span>{tr('自定义')}</span>
        <span className="xn-provider-nav__count">{providers.length}</span>
      </div>
      {loading && providers.length === 0 && <div className="xn-provider-nav__loading"><LoaderCircle size={14} className="xn-provider-spin" />{tr('加载中…')}</div>}
      {providers.map(provider => <button
        type="button"
        key={provider.id}
        className="xn-provider-nav__item"
        data-state={selectedKey === provider.id ? 'selected' : 'idle'}
        aria-current={selectedKey === provider.id ? 'page' : undefined}
        aria-label={provider.name}
        title={`${provider.name} · ${provider.model}`}
        disabled={busy}
        onClick={() => onSelect(provider.id)}
      >
        <Cpu size={16} aria-hidden="true" />
        <span className="xn-provider-nav__provider-copy">
          <span className="xn-provider-nav__label">{provider.name}</span>
          <span className="xn-provider-nav__model">{provider.model}</span>
        </span>
        <span className="xn-provider-nav__key-indicator" data-configured={provider.hasKey} aria-label={provider.hasKey ? tr('已配置密钥') : tr('未配置密钥')} title={provider.hasKey ? tr('已配置密钥') : tr('未配置密钥')} />
      </button>)}
      {!loading && providers.length === 0 && <p className="xn-provider-nav__empty">{tr('添加第一个模型配置')}</p>}
      <button type="button" className="xn-provider-nav__add" title={tr('添加配置')} aria-label={tr('添加配置')} disabled={busy} onClick={onAdd}>
        <Plus size={15} aria-hidden="true" /><span>{tr('添加配置')}</span>
      </button>
    </div>
  </nav>;
}

/** First-run state for the model list; the settings plugin owns the presentation. */
export function ProviderEmptyState({ onAdd, busy = false }: { onAdd: () => void; busy?: boolean }) {
  return <SettingsEmptyState
    icon={<Cpu size={22} strokeWidth={1.6} />}
    title={tr('还没有自定义模型配置')}
    description={tr('添加一个 API 配置后，可随时切换当前运行使用的模型。')}
    actionLabel={tr('添加配置')}
    actionDisabled={busy}
    onAction={onAdd}
  />;
}

function EnvironmentProviderDetail({ onSelect }: { onSelect: () => void }) {
  return <div className="xn-provider-environment" data-testid="model-provider-environment-detail">
    <div className="xn-provider-detail__eyebrow"><Server size={15} aria-hidden="true" />{tr('服务器默认值')}</div>
    <h3>{tr('环境模型')}</h3>
    <p>{tr('使用服务器环境中的默认模型配置')}</p>
    <div className="xn-provider-environment__note">
      <ShieldCheck size={18} aria-hidden="true" />
      <span>{tr('此选项由服务端环境提供；环境变量和密钥不会在浏览器中读取或显示。')}</span>
    </div>
    <button type="button" className="xn-provider-button xn-provider-button--primary" onClick={onSelect}>{tr('用于当前运行')}</button>
  </div>;
}

export function ProviderEditor({
  draft,
  original,
  hasKey,
  busy,
  testing,
  testResult,
  testError,
  compatibilityMode = 'conversation',
  compatibilityResult = null,
  compatibilityError = '',
  compatibilityTesting = false,
  compatibilityTestReady = false,
  compatibilityHistory = [],
  compatibilityGroups = [],
  compatibilityAdoptionReady = false,
  adoptingCompatibility = false,
  onCompatibilityModeChange = () => undefined,
  onCompatibilityTest = () => undefined,
  onAdoptCompatibility = () => undefined,
  onLoadCompatibilityCandidate = () => undefined,
  discovering = false,
  discoveredModels = null,
  discoveryError = '',
  deleting,
  onDraftChange,
  runtimeMonitorEnabled = false,
  onSave,
  onUse,
  onTest,
  onDiscover = () => undefined,
  onSelectDiscoveredModel = () => undefined,
  onDelete,
  onCancelDelete,
  onCancelEdit,
}: {
  draft: ProviderDraft;
  original: ProviderSummary | null;
  hasKey: boolean;
  busy: boolean;
  testing: boolean;
  testResult: ProviderConnectionTest | null;
  testError: string;
  compatibilityMode?: ProviderCompatibilityTestMode;
  compatibilityResult?: ProviderCompatibilityTest | null;
  compatibilityError?: string;
  compatibilityTesting?: boolean;
  compatibilityTestReady?: boolean;
  compatibilityHistory?: ProviderCompatibilityCheckRecord[];
  compatibilityGroups?: ProviderCompatibilityDiagnosticGroup[];
  compatibilityAdoptionReady?: boolean;
  adoptingCompatibility?: boolean;
  onCompatibilityModeChange?: (mode: ProviderCompatibilityTestMode) => void;
  onCompatibilityTest?: () => void;
  onAdoptCompatibility?: () => void;
  onLoadCompatibilityCandidate?: (compatibility: NonNullable<ProviderSummary['compatibility']>) => void;
  discovering?: boolean;
  discoveredModels?: ProviderDiscoveredModel[] | null;
  discoveryError?: string;
  deleting: boolean;
  onDraftChange: (draft: ProviderDraft) => void;
  runtimeMonitorEnabled?: boolean;
  onSave: (event: React.FormEvent<HTMLFormElement>) => void;
  onUse: () => void;
  onTest: () => void;
  onDiscover?: () => void;
  onSelectDiscoveredModel?: (model: string) => void;
  onDelete: () => void;
  onCancelDelete: () => void;
  onCancelEdit: () => void;
}) {
  const [keyVisible, setKeyVisible] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const validationError = validateProviderDraft(draft);
  const isNew = original === null;
  const changed = isNew ? !draftsEqual(draft, emptyProviderDraft()) : !draftsEqual(draft, providerDraftFromSummary(original));
  const locked = busy || testing || compatibilityTesting || adoptingCompatibility;
  const canSave = !locked && changed && !validationError;
  const update = <K extends keyof ProviderDraft>(field: K, value: ProviderDraft[K]) => onDraftChange({ ...draft, [field]: value });
  const runtimeProfile = draft.runtimeProfile ?? 'standard';
  const changeRuntimeProfile = (value: 'standard' | 'lightweight') => {
    if (value === 'standard' && draft.toolCalling === 'json') return;
    onDraftChange({
      ...draft,
      runtimeProfile: value,
      ...(value === 'lightweight' ? {
        contextWindow: draft.contextWindow ?? LIGHTWEIGHT_DEFAULT_CONTEXT,
        maxOutputTokens: draft.maxOutputTokens ?? LIGHTWEIGHT_DEFAULT_OUTPUT,
        toolCalling: draft.toolCalling ?? 'native',
      } : {}),
    });
  };
  const chooseLocalEndpoint = (baseUrl: string) => onDraftChange(providerDraftWithLocalEndpoint(draft, baseUrl));
  const changeContextWindow = (value: number | undefined) => {
    const next: ProviderDraft = { ...draft, contextWindow: value };
    if (runtimeProfile === 'lightweight') next.maxOutputTokens = adjustedLightweightOutput(value, draft.maxOutputTokens);
    onDraftChange(next);
  };
  const updateLightweightOption = <K extends keyof ProviderLightweightOptions>(field: K, value: ProviderLightweightOptions[K] | undefined) => {
    const options = { ...(draft.lightweightOptions ?? {}) };
    if (value === undefined) delete options[field];
    else options[field] = value;
    onDraftChange({ ...draft, lightweightOptions: options });
  };
  const lightweightNumberField = (
    field: NumericLightweightOptionKey,
    label: string,
    minimum: number,
    maximum: number,
    step: number | 'any',
    placeholder: string,
    hint: string,
  ) => {
    const value = draft.lightweightOptions?.[field];
    const unsupportedSampling = draft.protocol !== 'openai' && ['temperature', 'topP', 'seed'].includes(field);
    return <label className="xn-provider-field" key={field}>
      <span>{tr(label)}</span>
      <input type="number" inputMode={step === 'any' || step < 1 ? 'decimal' : 'numeric'} min={minimum} max={maximum} step={step} disabled={locked || unsupportedSampling}
        value={!unsupportedSampling && typeof value === 'number' ? value : ''} placeholder={tr(placeholder)}
        onChange={event => {
          if (event.currentTarget.value === '') updateLightweightOption(field, undefined);
          else {
            const number = event.currentTarget.valueAsNumber;
            updateLightweightOption(field, Number.isFinite(number) ? number : undefined);
          }
        }} aria-label={tr(label)} />
      <small>{tr(hint)}</small>
    </label>;
  };
  const resetCompatibility = () => onDraftChange({ ...draft, compatibility: {} });
  const updateCompatibility = <K extends keyof NonNullable<ProviderDraft['compatibility']>>(
    field: K,
    value: NonNullable<ProviderDraft['compatibility']>[K] | undefined,
  ) => {
    const compatibility = { ...(draft.compatibility ?? {}) };
    if (value === undefined) delete compatibility[field];
    else compatibility[field] = value;
    onDraftChange({ ...draft, compatibility });
  };
  const compatibilityConfigured = Object.keys(draft.compatibility ?? {}).length > 0;
  const budgetPreview = lightweightBudgetPreview(draft);

  useEffect(() => { setKeyVisible(false); }, [draft.id, isNew]);

  // 轻量设置页的「高级」分组：只调整展示，字段、取值和保存行为保持不变。
  const advancedRuntimeSettings = (
    <>
      {draft.protocol === 'openai' && <>
        <fieldset className="xn-provider-option-list" disabled={locked}>
          <legend>{tr('API 兼容设置')}</legend>
          <label>
            <input type="checkbox" checked={draft.compatibility?.streamUsage ?? (runtimeProfile === 'standard')} onChange={event => onDraftChange({ ...draft, compatibility: { ...draft.compatibility, streamUsage: event.currentTarget.checked } })} />
            <span>{tr('在流式请求中发送 stream_options.include_usage')}</span>
          </label>
        </fieldset>
        <div className="xn-provider-compatibility-fields">
          <label className="xn-provider-field">
            <span>{tr('parallel_tool_calls')}</span>
            <Select aria-label={tr('parallel_tool_calls')} disabled={locked}
              value={draft.compatibility?.parallelToolCalls === undefined ? '__omit__' : String(draft.compatibility.parallelToolCalls)}
              onChange={event => updateCompatibility('parallelToolCalls', event.currentTarget.value === '__omit__' ? undefined : event.currentTarget.value === 'true')}>
              <option value="__omit__">{tr('省略此字段')}</option>
              <option value="false">{tr('发送 false')}</option>
              <option value="true">{tr('发送 true')}</option>
            </Select>
            <small>{tr('本地接口可能不接受此参数；省略会从请求中移除它。')}</small>
          </label>
          <label className="xn-provider-field">
            <span>{tr('tool_choice')}</span>
            <Select aria-label={tr('tool_choice')} disabled={locked}
              value={draft.compatibility?.toolChoice ?? '__omit__'}
              onChange={event => updateCompatibility('toolChoice', event.currentTarget.value === '__omit__' ? undefined : event.currentTarget.value as 'auto' | 'required')}>
              <option value="__omit__">{tr('省略此字段')}</option>
              <option value="auto">auto</option>
              <option value="required">required</option>
            </Select>
            <small>{tr('仅原生工具诊断和实际工具请求会发送；plain/JSON 诊断会省略。')}</small>
          </label>
          <label className="xn-provider-field">
            <span>{tr('think')}</span>
            <Select aria-label={tr('think')} disabled={locked}
              value={draft.compatibility?.think === undefined ? '__omit__' : String(draft.compatibility.think)}
              onChange={event => updateCompatibility('think', event.currentTarget.value === '__omit__' ? undefined : event.currentTarget.value === 'true')}>
              <option value="__omit__">{tr('省略此字段')}</option>
              <option value="false">{tr('发送 false')}</option>
              <option value="true">{tr('发送 true')}</option>
            </Select>
            <small>{tr('明确选择后发送 think 布尔值，并省略 reasoning_effort。')}</small>
          </label>
          <label className="xn-provider-field">
            <span>{tr('最大输出字段')}</span>
            <Select aria-label={tr('最大输出字段')} disabled={locked} value={draft.compatibility?.maxTokensField ?? '__service_default__'} onChange={event => {
              const value = event.currentTarget.value;
              if (value === '__service_default__') updateCompatibility('maxTokensField', undefined);
              else updateCompatibility('maxTokensField', value as 'max_tokens' | 'max_completion_tokens');
            }}>
              <option value="__service_default__">{tr('服务默认')}</option>
              <option value="max_tokens">max_tokens</option>
              <option value="max_completion_tokens">max_completion_tokens</option>
            </Select>
            <small>{tr('选择服务默认只省略 max_tokens 字段覆盖。')}</small>
          </label>
          <button type="button" className="xn-provider-button" disabled={locked || !compatibilityConfigured} onClick={resetCompatibility}>{tr('恢复 API 兼容默认')}</button>
        </div>
        <p className="xn-provider-hint">{tr('未选择的兼容字段会省略；只有服务商文档确认支持时才启用。明确设置后，实际请求会发送所选参数。')}</p>
        <section className="xn-provider-section" data-testid="provider-compatibility-diagnostics">
          <div className="xn-provider-section__heading">
            <h4>{tr('本地接口兼容诊断')}</h4>
            <p>{tr('每次只运行所选检查，不会自动回退或重试，也不会保存草稿或切换当前运行配置。')}</p>
          </div>
          <div className="xn-provider-fields">
            <label className="xn-provider-field xn-provider-runtime-select">
              <span>{tr('诊断项目')}</span>
              <Select aria-label={tr('诊断项目')} disabled={locked}
                value={compatibilityMode}
                onChange={event => onCompatibilityModeChange(event.currentTarget.value as ProviderCompatibilityTestMode)}>
                <option value="conversation">{tr('普通对话（plain）')}</option>
                <option value="native_tool_call">{tr('原生工具调用（native）')}</option>
                <option value="json_tool_call" disabled={runtimeProfile !== 'lightweight'}>{tr('JSON 工具调用（json）')}</option>
                <option value="stream">{tr('SSE 流式 delta + done（plain）')}</option>
                <option value="tool_roundtrip">{tr('工具结果续轮（native，两次请求）')}</option>
              </Select>
            </label>
            <button type="button" className="xn-provider-button xn-provider-button--primary"
              disabled={locked || !compatibilityTestReady}
              onClick={onCompatibilityTest}>
              {compatibilityTesting ? <LoaderCircle size={14} className="xn-provider-spin" aria-hidden="true" /> : <Radio size={14} aria-hidden="true" />}
              {tr(compatibilityTesting ? '正在执行所选诊断' : '运行所选诊断')}
            </button>
          </div>
          <p className="xn-provider-test-note">
            {tr('诊断使用已保存的 API 地址、模型和密钥，并只覆盖本草稿中的兼容参数；每个请求最多 96 个输出 tokens，工具结果续轮最多发送两次请求。fixture 只在进程内计算 3+4，不访问文件或命令。服务商可能收费。诊断会保存安全结果，不会更改运行参数；完整通过后可明确采用已验证参数。')}
          </p>
          {compatibilityHistory.length > 0 && <div className="xn-provider-test-feedback" data-testid="provider-compatibility-history">
            <strong>{tr('已保存的兼容诊断历史')}</strong>
            {compatibilityHistory.map(check => <span key={check.mode}>
              {tf('{0}：{1}（{2} 次请求，{3}）', [check.mode, check.ok ? tr('通过') : tr('失败'), check.requestCount, check.testedAt])}
              {check.error ? ` ${tr(check.error)}` : ''}
            </span>)}
          </div>}
          {compatibilityGroups.map(group => <div className="xn-provider-test-feedback" key={group.optionsHash}
            data-testid="provider-compatibility-candidate-history">
            <strong>{tf('已保存候选 {0}：{1}', [group.optionsHash.slice(0, 12), JSON.stringify(group.compatibility)])}</strong>
            {group.checks.map(check => <span key={check.mode}>
              {tf('{0}：{1}（{2} 次请求，{3}）', [check.mode, check.ok ? tr('通过') : tr('失败'), check.requestCount, check.testedAt])}
            </span>)}
            <button type="button" className="xn-provider-button" disabled={locked}
              onClick={() => onLoadCompatibilityCandidate(group.compatibility)}>
              {tr('载入这组已测试参数到草稿')}
            </button>
          </div>)}
          {original?.compatibilityVerification && <p className="xn-provider-test-feedback" data-testid="provider-compatibility-verification">
            {tf('当前参数已于 {0} 通过兼容验证并保存。', [original.compatibilityVerification.verifiedAt])}
          </p>}
          <button type="button" className="xn-provider-button xn-provider-button--primary"
            data-testid="provider-adopt-verified-compatibility"
            disabled={locked || !compatibilityAdoptionReady}
            onClick={onAdoptCompatibility}>
            {adoptingCompatibility ? <LoaderCircle size={14} className="xn-provider-spin" aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
            {tr(adoptingCompatibility ? '正在保存已验证参数' : '采用已验证兼容参数')}
          </button>
          {!compatibilityTestReady && <p className="xn-provider-hint">
            {tr(isNew ? '先保存此配置，再用已保存的服务地址和密钥测试兼容参数。' : '只有端点、模型和其它运行字段与已保存配置一致时才能测试；请先保存这些更改。')}
          </p>}
          {compatibilityError && <p className="xn-provider-test-feedback xn-provider-test-feedback--error" role="alert">{tr('兼容诊断失败：')}{compatibilityError}</p>}
          {compatibilityResult && <div className={`xn-provider-test-feedback${compatibilityResult.ok ? '' : ' xn-provider-test-feedback--error'}`}
            role={compatibilityResult.ok ? 'status' : 'alert'} data-testid={`provider-check-${compatibilityResult.details.mode}`}>
            <strong>{tf('{0}：{1}', [compatibilityResult.details.mode, compatibilityResult.ok ? tr('通过') : tr('失败')])}</strong>
            <span>{tf('实际请求 {0} 次，耗时 {1} ms。', [compatibilityResult.details.requestCount, compatibilityResult.latencyMs])}</span>
            {!compatibilityResult.ok && compatibilityResult.error && <span>{tr(compatibilityResult.error)}</span>}
            {!compatibilityResult.ok && compatibilityResult.details.httpStatus && <span>{tf('HTTP 状态：{0}', [compatibilityResult.details.httpStatus])}</span>}
            {compatibilityResult.details.failedStep && <span>{tf('失败步骤：{0}', [compatibilityResult.details.failedStep])}</span>}
            {compatibilityResult.details.requests?.map(request => <span key={request.step}>
              {tf('{0} 请求字段：{1}', [request.step, request.fields.join(', ') || tr('无')])}
            </span>)}
          </div>}
        </section>
      </>}
      {draft.protocol === 'anthropic' && <p className="xn-provider-hint">{tr('stream_usage 与 JSON 工具模式仅适用于 OpenAI-compatible API。')}</p>}

      {runtimeProfile === 'lightweight' && <details className="xn-provider-advanced" data-testid="provider-lightweight-advanced" open={advancedOpen} onToggle={event => setAdvancedOpen(event.currentTarget.open)}>
        <summary>{tr('轻量配置高级选项')}</summary>
        <p className="xn-provider-advanced__intro">{tr('这些上限控制提示上下文、工具结果、运行恢复和采样参数；不会改变模型本身或硬件能力。')}</p>
        <section className="xn-provider-advanced__group">
          <h5>{tr('上下文与预算')}</h5>
          <div className="xn-provider-fields">
            {lightweightNumberField('reserveTokens', '预留上下文 tokens', 0, 8192, 1, String(budgetPreview.contextWindow < 4096 ? 128 : 512), '允许范围 0–8192；默认小于 4096 上下文时为 128，否则为 512。')}
            {lightweightNumberField('optionalContextChars', '可选上下文字符上限', 0, 6000, 1, '1800', '允许范围 0–6000；默认 1800。')}
          </div>
          <p className={`xn-provider-budget${budgetPreview.inputTokens < 256 ? ' xn-provider-budget--error' : ''}`} role={budgetPreview.inputTokens < 256 ? 'alert' : 'status'}>
            {tf('估算输入预算：{0} − {1} 输出 − {2} 预留 = {3} tokens；至少需要 256。', [budgetPreview.contextWindow, budgetPreview.outputTokens, budgetPreview.reserveTokens, budgetPreview.inputTokens])}
          </p>
        </section>
        <section className="xn-provider-advanced__group">
          <h5>{tr('工具与文件结果')}</h5>
          <div className="xn-provider-fields">
            {lightweightNumberField('toolResultChars', '工具结果字符上限', 400, 12000, 1, '1400', '允许范围 400–12000；默认 1400。')}
            {lightweightNumberField('maxDiscoveredTools', '可发现工具数量上限', 0, 12, 1, '6', '允许范围 0–12；默认 6，设为 0 会隐藏 tool_search。')}
            {lightweightNumberField('toolSearchResults', '工具搜索结果数量', 1, 6, 1, '3', '允许范围 1–6；默认 3。')}
            {lightweightNumberField('resultPageChars', '分页结果字符上限', 128, 4000, 1, '1200', '允许范围 128–4000；默认 1200。')}
            {lightweightNumberField('fileReadChars', '文件读取字符上限', 128, 12000, 1, '4000', '允许范围 128–12000；默认 4000。')}
          </div>
          <label className="xn-provider-field xn-provider-runtime-select">
            <span>{tr('初始工具集')}</span>
            <Select aria-label={tr('初始工具集')} disabled={locked} value={draft.lightweightOptions?.initialTools ?? '__default__'} onChange={event => updateLightweightOption('initialTools', event.currentTarget.value === '__default__' ? undefined : event.currentTarget.value as NonNullable<ProviderLightweightOptions['initialTools']>)}>
              <option value="__default__">{tr('auto（根据上下文选择）')}</option><option value="auto">auto</option><option value="minimal">minimal</option><option value="core">core</option>
            </Select>
            <small>{tr('默认 auto：小于 4096 上下文时选择 minimal，否则选择 core。')}</small>
          </label>
        </section>
        <section className="xn-provider-advanced__group">
          <h5>{tr('恢复与运行上限')}</h5>
          <fieldset className="xn-provider-option-list" disabled={locked}>
            <label><input type="checkbox" checked={draft.lightweightOptions?.overflowRetry ?? true} onChange={event => updateLightweightOption('overflowRetry', event.currentTarget.checked)} /><span>{tr('发生上下文溢出时重试一次')}</span></label>
          </fieldset>
          <div className="xn-provider-fields">
            {lightweightNumberField('overflowRetryRatio', '溢出后上下文缩减比例', 0.25, 0.85, 'any', '0.6', '允许范围 0.25–0.85；默认 0.6。')}
            {lightweightNumberField('jsonRepairAttempts', 'JSON 修复额外重试次数', 0, 2, 1, '1', '允许范围 0–2；默认 1 次额外重试，设为 0 后无效响应立即结束。')}
            {lightweightNumberField('stepLimit', '最大执行步数', 1, 64, 1, '64', '允许范围 1–64；作为调用方步数上限的进一步限制，默认 64。')}
            {lightweightNumberField('wallTimeSeconds', '协作式运行时长（秒）', 1, 3600, 1, '沿用调用方', '允许范围 1–3600；留空沿用调用方限制。运行时长在工具调用边界检查；单次 HTTP 请求另受请求截止时间约束。')}
            {lightweightNumberField('requestTimeoutSeconds', '单次请求总截止时间（秒）', 1, 300, 1, '120', '允许范围 1–300；默认 120 秒，涵盖响应头、响应体和全部传输重试，本地冷启动也计入。')}
            {lightweightNumberField('transportRetries', '无输出时的传输重试次数', 0, 2, 1, '0', '允许范围 0–2；默认 0。仅在没有任何可见输出时重试；一旦有输出，绝不重放请求。')}
          </div>
        </section>
        <section className="xn-provider-advanced__group">
          <h5>{tr('采样参数')}</h5>
          {draft.protocol !== 'openai' && <p className="xn-provider-hint">{tr('Anthropic Messages 不接受本产品的温度、top_p 或 seed 采样参数。')}</p>}
          <div className="xn-provider-fields">
            {lightweightNumberField('temperature', 'temperature', 0, 2, 'any', '服务默认', '允许范围 0–2；留空使用服务默认。')}
            {lightweightNumberField('topP', 'top_p', 0, 1, 'any', '服务默认', '允许范围大于 0 且不超过 1；留空使用服务默认。')}
            {lightweightNumberField('seed', 'seed', 0, 2147483647, 1, '服务默认', '允许范围 0–2147483647；留空使用服务默认。')}
          </div>
        </section>
        <button type="button" className="xn-provider-button" disabled={locked || Object.keys(draft.lightweightOptions ?? {}).length === 0} onClick={() => onDraftChange({ ...draft, lightweightOptions: {} })}>{tr('恢复轻量配置默认值')}</button>
        {advancedOpen && runtimeMonitorEnabled && <LocalRuntimeMonitor lightweight={runtimeProfile === 'lightweight'} session={null} />}
      </details>}
    </>
  );

  return <form className="xn-provider-editor" onSubmit={onSave} data-testid="model-provider-editor">
    <header className="xn-provider-editor__header">
      <div className="xn-provider-editor__title-row">
        <span className="xn-provider-editor__icon"><Cpu size={19} aria-hidden="true" /></span>
        <div className="xn-provider-editor__title-copy">
          <h3>{isNew ? tr('新建配置') : (draft.name || original.name)}</h3>
          <p>{isNew ? tr('配置一个可用于当前运行的模型服务商。') : `${tr('自定义模型服务商')} · ${original.id}`}</p>
        </div>
      </div>
      {!isNew && <div className="xn-provider-editor__header-actions">
        <button type="button" className="xn-provider-button" disabled={busy || testing || compatibilityTesting} onClick={onTest}>
          {testing ? <LoaderCircle size={14} className="xn-provider-spin" aria-hidden="true" /> : <Radio size={14} aria-hidden="true" />}
          {tr(testing ? '正在测试连接' : '测试对话')}
        </button>
        <button type="button" className="xn-provider-button" disabled={busy} onClick={onUse}>{tr('用于当前运行')}</button>
        <button type="button" className="xn-provider-icon-button xn-provider-icon-button--danger" disabled={busy || testing} aria-label={tr('删除配置')} title={tr('删除配置')} onClick={onDelete}><Trash2 size={16} aria-hidden="true" /></button>
      </div>}
    </header>
    {!isNew && <p className="xn-provider-test-note">{tr('对话测试只检查一次简短文本回复，不验证工具调用；服务商可能收取少量费用。')}</p>}
    {testResult && <p className="xn-provider-test-feedback" role="status"><Check size={15} aria-hidden="true" />{tf('对话测试成功，响应时间 {0} ms（未验证工具）', [testResult.latencyMs])}</p>}
    {testError && <p className="xn-provider-test-feedback xn-provider-test-feedback--error" role="alert"><Radio size={15} aria-hidden="true" />{tr('连接测试失败：')}{testError}</p>}

    <section className="xn-provider-section">
      <div className="xn-provider-section__heading"><h4>{tr('基本信息')}</h4><p>{tr('为配置指定稳定的 ID 和显示名称。')}</p></div>
      <div className="xn-provider-fields xn-provider-fields--identity">
        <label className="xn-provider-field">
          <span>{tr('显示名称')}</span>
          <input autoComplete="off" disabled={locked} value={draft.name} onChange={event => update('name', event.currentTarget.value)} required aria-label={tr('显示名称')} />
        </label>
        <label className="xn-provider-field">
          <span>{tr('配置 ID')}</span>
          <input autoComplete="off" disabled={locked || !isNew} value={draft.id} onChange={event => update('id', event.currentTarget.value)} required aria-label={tr('配置 ID')} spellCheck={false} />
          <small>{tr(isNew ? '保存后不能修改此 ID。' : '配置 ID 不能修改。')}</small>
        </label>
      </div>
    </section>

    <section className="xn-provider-section">
      <div className="xn-provider-section__heading"><h4>{tr('连接设置')}</h4><p>{tr('指定兼容协议和服务 API 地址。')}</p></div>
      <div className="xn-provider-fields">
        <label className="xn-provider-field">
          <span>{tr('接口协议')}</span>
          <Select aria-label={tr('接口协议')} disabled={locked} value={draft.protocol} onChange={event => onDraftChange({
            ...draft,
            protocol: event.currentTarget.value as ProviderDraft['protocol'],
            reasoningLevels: [],
            ...(event.currentTarget.value === 'anthropic' && draft.toolCalling === 'json' ? { toolCalling: 'native' as const } : {}),
          })}>
            <option value="openai">OpenAI-compatible</option>
            <option value="anthropic">Anthropic Messages</option>
          </Select>
        </label>
        <label className="xn-provider-field">
          <span>{tr('API 地址')}</span>
          <input autoComplete="off" disabled={locked} value={draft.baseUrl} onChange={event => update('baseUrl', event.currentTarget.value)} placeholder="https://api.example.com/v1" required aria-label={tr('API 地址')} spellCheck={false} />
        </label>
      </div>
      <div className="xn-provider-local-endpoints" role="group" aria-label={tr('本地服务地址模板')}>
        <span>{tr('本地服务地址模板')}</span>
        <div>{LOCAL_ENDPOINTS.map(endpoint => <button key={endpoint.label} type="button" className="xn-provider-button" disabled={locked} onClick={() => chooseLocalEndpoint(endpoint.url)} title={endpoint.url}>{endpoint.label}</button>)}</div>
        <small>{tr('只填入地址并切换到本地轻量；不会填写模型名称或发送请求。')}</small>
      </div>
    </section>

    <section className="xn-provider-section">
      <div className="xn-provider-section__heading xn-provider-section__heading--split">
        <div><h4>{tr('API 密钥')}</h4><p>{tr('留空保留已有密钥；服务器不会返回或回显密钥。')}</p></div>
        <span className="xn-provider-key-status" data-configured={hasKey}>
          <span aria-hidden="true" />{hasKey ? tr('已配置密钥') : tr('未配置密钥')}
        </span>
      </div>
      <div className="xn-provider-key-input">
        <input
          autoComplete="new-password"
          disabled={locked}
          type={keyVisible ? 'text' : 'password'}
          value={draft.apiKey}
          onChange={event => update('apiKey', event.currentTarget.value)}
          placeholder={tr('留空保留已有密钥')}
          aria-label={tr('API 密钥')}
          spellCheck={false}
        />
        <button type="button" className="xn-provider-icon-button" disabled={locked} aria-label={tr(keyVisible ? '隐藏密钥' : '显示密钥')} title={tr(keyVisible ? '隐藏密钥' : '显示密钥')} onClick={() => setKeyVisible(value => !value)}>
          {keyVisible ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
        </button>
      </div>
      {runtimeProfile === 'lightweight' && draft.protocol === 'openai' && isLoopbackLiteral(draft.baseUrl) && <p className="xn-provider-hint">{tr('本地 127.0.0.1 或 ::1 服务可将密钥留空；留空仍会保留已保存的密钥。')}</p>}
    </section>

    <section className="xn-provider-section">
      <div className="xn-provider-section__heading"><h4>{tr('模型')}</h4><p>{tr('每个自定义配置对应一个模型 ID。')}</p></div>
      <label className="xn-provider-field">
        <span>{tr('模型名称')}</span>
        <input autoComplete="off" disabled={locked} value={draft.model} onChange={event => update('model', event.currentTarget.value)} required aria-label={tr('模型名称')} spellCheck={false} />
      </label>
      <div className="xn-provider-discovery" data-testid="provider-model-discovery">
        <div className="xn-provider-discovery__actions">
          <button type="button" className="xn-provider-button" disabled={locked || discovering || !original || draft.protocol !== 'openai' || changed} onClick={onDiscover}>
            {discovering ? <LoaderCircle size={14} className="xn-provider-spin" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}
            {tr(discovering ? '正在发现模型' : '发现模型')}
          </button>
          <span>{tr('只读取已保存配置的模型列表，不会发送聊天请求。')}</span>
        </div>
        {!original && <p className="xn-provider-hint">{tr('请先保存配置，再发现模型。')}</p>}
        {original && draft.protocol !== 'openai' && <p className="xn-provider-hint">{tr('模型发现暂不支持 Anthropic 配置。')}</p>}
        {original && draft.protocol === 'openai' && changed && <p className="xn-provider-hint">{tr('当前更改尚未保存；请先保存配置，再发现模型。')}</p>}
        {discovering && <p className="xn-provider-hint" role="status">{tr('正在读取服务商提供的模型列表…')}</p>}
        {discoveryError && <p className="xn-provider-feedback xn-provider-feedback--error" role="alert">{discoveryError}</p>}
        {!discovering && discoveredModels && discoveredModels.length === 0 && !discoveryError && <p className="xn-provider-hint" role="status">{tr('服务商没有返回可用模型。')}</p>}
        {discoveredModels && discoveredModels.length > 0 && <ul className="xn-provider-discovery__list" aria-label={tr('发现的模型')}>
          {discoveredModels.map(model => <li key={model.id}>
            <button type="button" className="xn-provider-discovery__model" data-selected={draft.model === model.id} disabled={locked} onClick={() => onSelectDiscoveredModel(model.id)}>
              <span>{model.id}</span>
              {(model.ownedBy || model.created !== undefined) && <small>{[model.ownedBy, model.created !== undefined ? String(model.created) : ''].filter(Boolean).join(' · ')}</small>}
            </button>
          </li>)}
        </ul>}
      </div>
    </section>

    <section className="xn-provider-section" data-testid="provider-runtime-settings">
      <div className="xn-provider-section__heading"><h4>{tr('运行配置')}</h4><p>{tr('轻量配置为本地或小上下文模型限制输入预算与输出长度。')}</p></div>
      {runtimeProfile === 'lightweight' && <p className="xn-provider-common__label">{tr('常用')}</p>}
      <fieldset className="xn-provider-option-list" disabled={locked}>
        <legend>{tr('运行档位')}</legend>
        <label>
          <input type="radio" name={`provider-runtime-${draft.id || 'new'}`} value="standard" checked={runtimeProfile === 'standard'} disabled={draft.toolCalling === 'json'} onChange={() => changeRuntimeProfile('standard')} />
          <span>{tr('标准')}</span>
        </label>
        <label>
          <input type="radio" name={`provider-runtime-${draft.id || 'new'}`} value="lightweight" checked={runtimeProfile === 'lightweight'} onChange={() => changeRuntimeProfile('lightweight')} />
          <span>{tr('本地轻量')}</span>
        </label>
      </fieldset>
      {draft.toolCalling === 'json' && <p className="xn-provider-hint">{tr('JSON 工具模式仅适用于 OpenAI-compatible 本地轻量配置；先切回原生工具调用，才能选择标准。')}</p>}
      <div className="xn-provider-fields xn-provider-runtime-fields">
        <label className="xn-provider-field">
          <span>{tr('上下文窗口（tokens）')}</span>
          <input type="number" inputMode="numeric" min={2048} max={262144} step={1} disabled={locked} value={draft.contextWindow ?? ''} placeholder={runtimeProfile === 'lightweight' ? String(LIGHTWEIGHT_DEFAULT_CONTEXT) : tr('留空使用服务默认')}
            onChange={event => changeContextWindow(event.currentTarget.value === '' ? undefined : event.currentTarget.valueAsNumber)} aria-label={tr('上下文窗口（tokens）')} />
          <small>{tr('有效范围 2048–262144；轻量默认 8192。')}</small>
        </label>
        <label className="xn-provider-field">
          <span>{tr('最大输出（tokens）')}</span>
          <input type="number" inputMode="numeric" min={128} max={32768} step={1} disabled={locked} value={draft.maxOutputTokens ?? ''} placeholder={runtimeProfile === 'lightweight' ? String(LIGHTWEIGHT_DEFAULT_OUTPUT) : tr('留空不额外限制')}
            onChange={event => update('maxOutputTokens', event.currentTarget.value === '' ? undefined : event.currentTarget.valueAsNumber)} aria-label={tr('最大输出（tokens）')} />
          <small>{tr('有效范围 128–32768；轻量默认 1024，且不超过上下文的一半。')}</small>
        </label>
      </div>
      {draft.protocol === 'openai' && <>
        <label className="xn-provider-field xn-provider-runtime-select">
          <span>{tr('工具调用')}</span>
          <Select aria-label={tr('工具调用')} disabled={locked} value={draft.toolCalling ?? 'native'} onChange={event => update('toolCalling', event.currentTarget.value as NonNullable<ProviderDraft['toolCalling']>)}>
            <option value="native">{tr('原生工具调用')}</option>
            <option value="json" disabled={runtimeProfile !== 'lightweight'}>{tr('JSON 工具模式')}</option>
          </Select>
        </label>
        {runtimeProfile !== 'lightweight' && <p className="xn-provider-hint">{tr('JSON 工具模式仅适用于 OpenAI-compatible 本地轻量配置。')}</p>}
      </>}
      {runtimeProfile === 'lightweight' ? <details className="xn-provider-advanced" data-testid="provider-advanced-settings">
        <summary>{tr('高级')}</summary>
        <p className="xn-provider-advanced__intro">{tr('高级项默认折叠；展开后的字段、取值和保存行为保持不变。')}</p>
        {advancedRuntimeSettings}
      </details> : advancedRuntimeSettings}
      {runtimeProfile !== 'lightweight' && Boolean(draft.lightweightOptions && Object.keys(draft.lightweightOptions).length > 0) && <p className="xn-provider-hint">{tr('已保存的轻量选项会保留；标准运行配置不会应用这些选项。')}</p>}
    </section>

    <section className="xn-provider-section">
      <div className="xn-provider-section__heading"><h4>{tr('模型能力')}</h4><p>{tr('只声明此模型和服务端确实支持的输入类型。')}</p></div>
      <fieldset className="xn-provider-option-list" disabled={locked}>
        <legend>{tr('支持的附件类型')}</legend>
        {CAPABILITIES.map(capability => <label key={capability.id}>
          <input type="checkbox" checked={draft.capabilities.includes(capability.id)} onChange={event => update('capabilities', event.currentTarget.checked ? [...draft.capabilities, capability.id] : draft.capabilities.filter(value => value !== capability.id))} />
          <span>{tr(capability.label)}</span>
        </label>)}
      </fieldset>
      {draft.protocol === 'openai' && <fieldset className="xn-provider-option-list" disabled={locked}>
        <legend>{tr('支持的推理等级')}</legend>
        {REASONING_LEVELS.map(level => <label key={level}>
          <input type="checkbox" checked={draft.reasoningLevels.includes(level)} onChange={event => update('reasoningLevels', event.currentTarget.checked ? [...draft.reasoningLevels, level] : draft.reasoningLevels.filter(value => value !== level))} />
          <span>{level}</span>
        </label>)}
      </fieldset>}
      {draft.protocol === 'anthropic' && <p className="xn-provider-hint">{tr('当前 API 不接受 Anthropic 推理等级声明。')}</p>}
    </section>

    {validationError && changed && <p className="xn-provider-validation" role="status">{tr(validationError)}</p>}
    {deleting && <div className="xn-provider-delete-confirm" role="alertdialog" aria-modal="false" aria-label={tr('确认删除配置')}>
      <div><strong>{tf('删除 {0}？', [original?.name ?? draft.id])}</strong><p>{tr('删除后不能恢复此模型配置。')}</p></div>
      <div><button type="button" className="xn-provider-button" disabled={busy} onClick={onCancelDelete}>{tr('取消')}</button><button type="button" className="xn-provider-button xn-provider-button--danger" disabled={busy} onClick={onDelete}>{busy ? tr('正在删除') : tr('确认删除')}</button></div>
    </div>}
    <footer className="xn-provider-editor__footer">
      {original && <span className="xn-provider-save-note"><KeyRound size={14} aria-hidden="true" />{tr('密钥留空保留已有值，服务器不会回显密钥。')}</span>}
      <div className="xn-provider-editor__footer-actions">
        {changed && <button type="button" className="xn-provider-button" disabled={locked} onClick={onCancelEdit}>{tr(isNew ? '取消' : '放弃更改')}</button>}
        <button type="submit" className="xn-provider-button xn-provider-button--primary" disabled={!canSave}>
          {busy ? <LoaderCircle size={15} className="xn-provider-spin" aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}
          {tr(busy ? '正在保存' : '保存配置')}
        </button>
      </div>
    </footer>
  </form>;
}

export function ModelManager({ onSelect, runtimeMonitorEnabled = false }: {
  onSelect: (id: string) => void;
  runtimeMonitorEnabled?: boolean;
}) {
  const [items, setItems] = useState<ProviderSummary[]>([]);
  const [selectedKey, setSelectedKey] = useState(ENVIRONMENT_KEY);
  const [draft, setDraft] = useState<ProviderDraft>(emptyProviderDraft);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pendingSelection, setPendingSelection] = useState<string | null>(null);
  const [testingProviderId, setTestingProviderId] = useState('');
  const [connectionTest, setConnectionTest] = useState<{ id: string; result?: ProviderConnectionTest; error?: string } | null>(null);
  const [compatibilityMode, setCompatibilityMode] = useState<ProviderCompatibilityTestMode>('conversation');
  const [compatibilityTestingMode, setCompatibilityTestingMode] = useState<ProviderCompatibilityTestMode | ''>('');
  const [adoptingCompatibility, setAdoptingCompatibility] = useState(false);
  const [compatibilityChecks, setCompatibilityChecks] = useState(new Map<string, {
    compatibilityKey: string;
    result?: ProviderCompatibilityTest;
    error?: string;
  }>());
  const [discovery, setDiscovery] = useState<{ id: string; models: ProviderDiscoveredModel[]; error?: string } | null>(null);
  const [discoveringProviderId, setDiscoveringProviderId] = useState('');
  const discoveryRequest = React.useRef(0);

  const currentProvider = useMemo(() => items.find(provider => provider.id === selectedKey) ?? null, [items, selectedKey]);
  const isNew = selectedKey === NEW_PROVIDER_KEY;
  const currentConnectionTest = connectionTest?.id === currentProvider?.id ? connectionTest : null;
  const compatibilityKey = compatibilityOptionsKey(draft.compatibility);
  const currentCompatibilityCheck = currentProvider
    ? compatibilityChecks.get(`${currentProvider.id}\0${compatibilityMode}`)
    : undefined;
  const currentCompatibilityResult = currentCompatibilityCheck?.compatibilityKey === compatibilityKey
    ? currentCompatibilityCheck.result ?? null
    : null;
  const currentCompatibilityError = currentCompatibilityCheck?.compatibilityKey === compatibilityKey
    ? currentCompatibilityCheck.error ?? ''
    : '';
  const currentCompatibilityGroup = currentProvider?.compatibilityDiagnostics?.find(group =>
    compatibilityOptionsKey(group.compatibility) === compatibilityKey);
  const currentCompatibilityHistory = currentCompatibilityGroup?.checks ?? [];
  const compatibilityAdoptionReady = canAdoptProviderCompatibility(draft, currentProvider);
  const currentDiscovery = discovery?.id === currentProvider?.id ? discovery : null;
  const discoveryStillApplies = Boolean(currentProvider && draftsEqual(
    { ...draft, model: providerDraftFromSummary(currentProvider).model },
    providerDraftFromSummary(currentProvider),
  ) && !draft.apiKey);
  const currentDraftChanged = isNew
    ? !draftsEqual(draft, emptyProviderDraft())
    : (currentProvider !== null && !draftsEqual(draft, providerDraftFromSummary(currentProvider)));

  const refresh = async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError('');
    try {
      const result = await listProviders();
      setItems(result.providers);
      if (selectedKey !== ENVIRONMENT_KEY && selectedKey !== NEW_PROVIDER_KEY && !result.providers.some(provider => provider.id === selectedKey)) {
        setSelectedKey(ENVIRONMENT_KEY);
        setDraft(emptyProviderDraft());
      } else if (selectedKey !== ENVIRONMENT_KEY && selectedKey !== NEW_PROVIDER_KEY && !currentDraftChanged) {
        const provider = result.providers.find(item => item.id === selectedKey);
        if (provider) setDraft(providerDraftFromSummary(provider));
      }
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      if (!quiet) setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, []);

  const commitNavigationItem = (key: string) => {
    setPendingSelection(null);
    setSelectedKey(key);
    setError('');
    setNotice('');
    setConfirmDelete(false);
    setConnectionTest(null);
    setDiscovery(null);
    const provider = items.find(item => item.id === key);
    setDraft(provider ? providerDraftFromSummary(provider) : emptyProviderDraft());
  };

  const requestNavigationItem = (key: string) => {
    if (key === selectedKey) return;
    if (currentDraftChanged) {
      setPendingSelection(key);
      return;
    }
    commitNavigationItem(key);
  };

  const addProvider = () => requestNavigationItem(NEW_PROVIDER_KEY);
  const discardEditorChanges = () => {
    if (isNew) {
      commitNavigationItem(ENVIRONMENT_KEY);
      return;
    }
    if (currentProvider) setDraft(providerDraftFromSummary(currentProvider));
    setError('');
    setNotice('');
  };
  const chooseForRun = (id: string, label: string) => {
    onSelect(id);
    setNotice(tf('已选择 {0}', [label]));
    setError('');
  };

  const runConnectionTest = async (id: string) => {
    setTestingProviderId(id);
    setConnectionTest({ id });
    setError('');
    try {
      const result = await testProviderConnection(id);
      setConnectionTest({ id, result });
    } catch (reason) {
      const message = errorText(reason);
      setConnectionTest({ id, error: message.includes('details suppressed')
        ? tr('请检查 API 地址、密钥和模型名称。')
        : message.includes('real model requests are disabled') ? tr('服务端已关闭模型请求。')
        : message });
    } finally {
      setTestingProviderId('');
    }
  };

  const runCompatibilityTest = async () => {
    if (!currentProvider || !canTestProviderCompatibility(draft, currentProvider)
      || busy || testingProviderId || compatibilityTestingMode) return;
    const { id } = currentProvider;
    const mode = compatibilityMode;
    const compatibilityCandidate = { ...(draft.compatibility ?? {}) };
    const candidateKey = compatibilityOptionsKey(compatibilityCandidate);
    const checkKey = `${id}\0${mode}`;
    setCompatibilityTestingMode(mode);
    setCompatibilityChecks(previous => {
      const next = new Map(previous);
      next.set(checkKey, { compatibilityKey: candidateKey });
      return next;
    });
    setError('');
    try {
      const result = await testProviderCompatibility(id, mode, compatibilityCandidate);
      setCompatibilityChecks(previous => {
        const next = new Map(previous);
        next.set(checkKey, { compatibilityKey: candidateKey, result });
        return next;
      });
      setItems(previous => previous.map(provider => provider.id === id
        ? { ...provider, compatibilityDiagnostics: result.providerCompatibilityDiagnostics }
        : provider));
    } catch (reason) {
      setCompatibilityChecks(previous => {
        const next = new Map(previous);
        next.set(checkKey, { compatibilityKey: candidateKey, error: errorText(reason) });
        return next;
      });
    } finally {
      setCompatibilityTestingMode('');
    }
  };

  const runAdoptCompatibility = async () => {
    if (!currentProvider || !compatibilityAdoptionReady || !currentCompatibilityGroup
      || busy || testingProviderId || compatibilityTestingMode || adoptingCompatibility) return;
    setAdoptingCompatibility(true);
    setError('');
    setNotice('');
    try {
      const result = await adoptProviderCompatibility(currentProvider.id, currentCompatibilityGroup.optionsHash);
      setItems(previous => [...previous.filter(provider => provider.id !== result.provider.id), result.provider]
        .sort((left, right) => left.id.localeCompare(right.id)));
      setSelectedKey(result.provider.id);
      setDraft(providerDraftFromSummary(result.provider));
      setNotice(tr('已采用通过全部兼容诊断的参数；当前运行模型选择未更改。'));
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setAdoptingCompatibility(false);
    }
  };

  const runModelDiscovery = async (id: string) => {
    if (!currentProvider || currentProvider.id !== id || currentProvider.protocol === 'anthropic'
      || draft.protocol !== 'openai' || currentDraftChanged || busy || testingProviderId) return;
    const requestId = ++discoveryRequest.current;
    setDiscoveringProviderId(id);
    setDiscovery({ id, models: [] });
    setError('');
    try {
      const result = await discoverProviderModels(id);
      if (discoveryRequest.current === requestId) setDiscovery({ id, models: result.models });
    } catch (reason) {
      const message = errorText(reason);
      if (discoveryRequest.current === requestId) setDiscovery({ id, models: [], error: message.includes('real model requests are disabled')
        ? tr('服务端已关闭模型请求。')
        : message.includes('not supported for Anthropic')
          ? tr('模型发现暂不支持 Anthropic 配置。')
          : message.includes('details suppressed')
            ? tr('发现模型失败，请检查 API 地址、密钥和服务商响应。')
            : message });
    } finally {
      if (discoveryRequest.current === requestId) setDiscoveringProviderId('');
    }
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const validationError = validateProviderDraft(draft);
    if (validationError) { setError(validationError); return; }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await saveProvider(providerSavePayload(draft));
      const provider = result.provider;
      setItems(previous => [...previous.filter(item => item.id !== provider.id), provider].sort((a, b) => a.id.localeCompare(b.id)));
      setSelectedKey(provider.id);
      setDraft(providerDraftFromSummary(provider));
      setConfirmDelete(false);
      setConnectionTest(null);
      setDiscovery(null);
      setCompatibilityChecks(previous => {
        const next = new Map(previous);
        for (const key of next.keys()) if (key.startsWith(`${provider.id}\0`)) next.delete(key);
        return next;
      });
      setNotice(tr('配置已保存'));
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const removeProvider = async () => {
    if (!currentProvider) return;
    if (!confirmDelete) { setConfirmDelete(true); return; }
    setBusy(true);
    setError('');
    try {
      await deleteProvider(currentProvider.id);
      setItems(previous => previous.filter(provider => provider.id !== currentProvider.id));
      setSelectedKey(ENVIRONMENT_KEY);
      setDraft(emptyProviderDraft());
      setConfirmDelete(false);
      setConnectionTest(null);
      setDiscovery(null);
      setNotice(tr('模型配置已删除'));
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  return <section className="xn-operations xn-provider-settings" data-testid="model-provider-settings">
    <OperationHeader icon={<Cpu size={21} />} title={tr('模型配置')} description={tr('保存常用模型，随时切换当前运行的配置。')} />
    <div className="xn-provider-resource-intro">
      <p>{tr('管理服务器默认模型和自定义 API 配置。更改仅在保存后生效。')}</p>
      <div className="xn-provider-resource-actions">
        <button type="button" className="xn-provider-button" disabled={loading || busy} onClick={() => void refresh()}>
          <RefreshCw size={14} aria-hidden="true" className={loading ? 'xn-provider-spin' : undefined} />{tr(loading ? '正在刷新' : '刷新')}
        </button>
        <button type="button" className="xn-provider-button xn-provider-button--primary" disabled={busy} onClick={addProvider}>
          <Plus size={15} aria-hidden="true" />{tr('添加配置')}
        </button>
      </div>
    </div>
    {error && <p className="xn-provider-feedback xn-provider-feedback--error" role="alert">{error}</p>}
    {notice && <p className="xn-provider-feedback" role="status"><Check size={15} aria-hidden="true" />{notice}</p>}
    <div className="xn-provider-split" data-model-provider-split-panel="true" data-testid="model-provider-split-panel">
          <ModelProviderNavigation providers={items} selectedKey={selectedKey} loading={loading} busy={busy || Boolean(testingProviderId) || Boolean(compatibilityTestingMode) || adoptingCompatibility} onSelect={requestNavigationItem} onAdd={addProvider} />
      <main className="xn-provider-detail" data-model-provider-detail-scroll="true">
        {pendingSelection !== null && <div className="xn-provider-unsaved" role="alertdialog" aria-modal="false" aria-label={tr('未保存的更改')}>
          <div><strong>{tr('有未保存的更改')}</strong><p>{tr('切换配置会放弃当前表单中的更改。')}</p></div>
          <div><button type="button" className="xn-provider-button" onClick={() => setPendingSelection(null)}>{tr('继续编辑')}</button><button type="button" className="xn-provider-button xn-provider-button--danger" disabled={busy} onClick={() => commitNavigationItem(pendingSelection)}>{tr('放弃更改并切换')}</button></div>
        </div>}
        {selectedKey === ENVIRONMENT_KEY ? <>
          {!loading && items.length === 0 && <ProviderEmptyState onAdd={addProvider} busy={busy} />}
          <EnvironmentProviderDetail onSelect={() => chooseForRun('', tr('环境模型'))} />
        </> : <ProviderEditor
          key={selectedKey}
          draft={draft}
          original={currentProvider}
          hasKey={Boolean(currentProvider?.hasKey)}
          busy={busy}
          testing={testingProviderId === currentProvider?.id}
          testResult={currentConnectionTest?.result ?? null}
          testError={currentConnectionTest?.error ?? ''}
          compatibilityMode={compatibilityMode}
          compatibilityResult={currentCompatibilityResult}
          compatibilityError={currentCompatibilityError}
          compatibilityTesting={compatibilityTestingMode === compatibilityMode}
          compatibilityTestReady={canTestProviderCompatibility(draft, currentProvider)}
          compatibilityHistory={currentCompatibilityHistory}
          compatibilityGroups={currentProvider?.compatibilityDiagnostics ?? []}
          compatibilityAdoptionReady={compatibilityAdoptionReady}
          adoptingCompatibility={adoptingCompatibility}
          onCompatibilityModeChange={setCompatibilityMode}
          onCompatibilityTest={() => void runCompatibilityTest()}
          onAdoptCompatibility={() => void runAdoptCompatibility()}
          onLoadCompatibilityCandidate={compatibility => setDraft(current => ({ ...current, compatibility: { ...compatibility } }))}
          discovering={discoveringProviderId === currentProvider?.id}
          discoveredModels={discoveryStillApplies ? currentDiscovery?.models ?? null : null}
          discoveryError={discoveryStillApplies ? currentDiscovery?.error ?? '' : ''}
          deleting={confirmDelete}
          onDraftChange={setDraft}
          runtimeMonitorEnabled={runtimeMonitorEnabled}
          onSave={submit}
          onUse={() => currentProvider && chooseForRun(currentProvider.id, currentProvider.name)}
          onTest={() => currentProvider && void runConnectionTest(currentProvider.id)}
          onDiscover={() => currentProvider && void runModelDiscovery(currentProvider.id)}
          onSelectDiscoveredModel={model => setDraft(current => ({ ...current, model }))}
          onDelete={removeProvider}
          onCancelDelete={() => setConfirmDelete(false)}
          onCancelEdit={discardEditorChanges}
        />}
      </main>
    </div>
  </section>;
}
