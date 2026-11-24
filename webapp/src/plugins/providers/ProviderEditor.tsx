import React, { useEffect, useState } from 'react';
import { Check, Cpu, Eye, EyeOff, KeyRound, LoaderCircle, Radio, RefreshCw, Trash2 } from 'lucide-react';
import type { ProviderCompatibilityCheckRecord, ProviderCompatibilityDiagnosticGroup, ProviderCompatibilityTest, ProviderCompatibilityTestMode, ProviderConnectionTest, ProviderDiscoveredModel, ProviderSummary } from '../../xuenessApi';
import { Select } from '../../ui/Select';
import { t as tr, tf } from '../../i18n';
import { LocalRuntimeProbe } from './LocalRuntimeProbe';
import { ProviderCompatibilitySettings } from './ProviderCompatibilitySettings';
import { ProviderLightweightAdvanced } from './ProviderLightweightAdvanced';
import { ProviderSetupGuide } from './ProviderPanels';
import {
  adjustedLightweightOutput, CAPABILITIES, draftsEqual, isLoopbackHttpEndpoint, isLoopbackIpLiteral, LIGHTWEIGHT_DEFAULT_CONTEXT,
  LIGHTWEIGHT_DEFAULT_OUTPUT, LOCAL_ENDPOINTS, MAX_CONTEXT_WINDOW, MIN_CONTEXT_WINDOW, newProviderDraftChanged, providerDraftFromSummary,
  providerDraftWithEndpoint, providerDraftWithLocalEndpoint, REASONING_LEVELS, UNSAVED_ACTIONS_HELP_ID, validateProviderDraft,
} from './providerDraft';
import type { ProviderDraft } from './providerDraft';

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
  const changed = isNew ? newProviderDraftChanged(draft) : !draftsEqual(draft, providerDraftFromSummary(original));
  const locked = busy || testing || compatibilityTesting || adoptingCompatibility;
  const canSave = !locked && changed && !validationError;
  const update = <K extends keyof ProviderDraft>(field: K, value: ProviderDraft[K]) => onDraftChange(
    field === 'baseUrl'
      ? providerDraftWithEndpoint(draft, value as string)
      : { ...draft, [field]: value },
  );
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

  useEffect(() => { setKeyVisible(false); }, [draft.id, isNew]);

  // 轻量设置页的「高级」分组：只调整展示，字段、取值和保存行为保持不变。
  const advancedRuntimeSettings = (
    <>
      {draft.protocol === 'openai' && <ProviderCompatibilitySettings
        draft={draft} original={original} isNew={isNew} locked={locked} runtimeProfile={runtimeProfile} onDraftChange={onDraftChange}
        compatibilityMode={compatibilityMode} compatibilityResult={compatibilityResult} compatibilityError={compatibilityError}
        compatibilityTesting={compatibilityTesting} compatibilityTestReady={compatibilityTestReady} compatibilityHistory={compatibilityHistory}
        compatibilityGroups={compatibilityGroups} compatibilityAdoptionReady={compatibilityAdoptionReady} adoptingCompatibility={adoptingCompatibility}
        onCompatibilityModeChange={onCompatibilityModeChange} onCompatibilityTest={onCompatibilityTest}
        onAdoptCompatibility={onAdoptCompatibility} onLoadCompatibilityCandidate={onLoadCompatibilityCandidate}
      />}
      {draft.protocol === 'anthropic' && <p className="xn-provider-hint">{tr('stream_usage 与 JSON 工具模式仅适用于 OpenAI-compatible API。')}</p>}

      {runtimeProfile === 'lightweight' && <ProviderLightweightAdvanced
        draft={draft} locked={locked} runtimeProfile={runtimeProfile} advancedOpen={advancedOpen} onAdvancedToggle={setAdvancedOpen}
        runtimeMonitorEnabled={runtimeMonitorEnabled} onDraftChange={onDraftChange}
      />}
    </>
  );

  return <form className="xn-provider-editor" onSubmit={onSave} data-testid="model-provider-editor">
    <header className="xn-provider-editor__header">
      <div className="xn-provider-editor__title-row">
        <span className="xn-provider-editor__icon"><Cpu size={19} aria-hidden="true" /></span>
        <div className="xn-provider-editor__title-copy">
          <h3 title={isNew ? tr('新建配置') : (draft.name || original.name)}>{isNew ? tr('新建配置') : (draft.name || original.name)}</h3>
          <p>{isNew ? tr('配置一个可用于当前运行的模型服务商。') : `${tr('自定义模型服务商')} · ${original.id}`}</p>
        </div>
      </div>
      {!isNew && <div className="xn-provider-editor__header-actions">
        <button type="button" className="xn-provider-button" disabled={locked || changed} title={changed ? tr('请先保存更改，再测试或使用此配置。') : undefined} aria-describedby={changed ? UNSAVED_ACTIONS_HELP_ID : undefined} onClick={onTest}>
          {testing ? <LoaderCircle size={14} className="xn-provider-spin" aria-hidden="true" /> : <Radio size={14} aria-hidden="true" />}
          {tr(testing ? '正在测试连接' : '测试对话')}
        </button>
        <button type="button" className="xn-provider-button" disabled={locked || changed} title={changed ? tr('请先保存更改，再测试或使用此配置。') : undefined} aria-describedby={changed ? UNSAVED_ACTIONS_HELP_ID : undefined} onClick={onUse}>{tr('用于当前运行')}</button>
        <button type="button" className="xn-provider-icon-button xn-provider-icon-button--danger" disabled={busy || testing} aria-label={tr('删除配置')} title={tr('删除配置')} onClick={onDelete}><Trash2 size={16} aria-hidden="true" /></button>
      </div>}
    </header>
    {original && changed && <p className="xn-provider-hint" id={UNSAVED_ACTIONS_HELP_ID} role="status">{tr('请先保存更改，再测试或使用此配置。')}</p>}
    {isNew && <ProviderSetupGuide />}
    {!isNew && <p className="xn-provider-test-note">{tr('对话测试只检查一次简短文本回复，不验证工具调用；服务商可能收取少量费用。')}</p>}
    {testResult && <p className="xn-provider-test-feedback" role="status"><Check size={15} aria-hidden="true" />{tf('对话测试成功，响应时间 {0} ms（未验证工具）', [testResult.latencyMs])}</p>}{testResult && original && !changed && <LocalRuntimeProbe providerId={original.id} runKey={testResult} disabled={busy || locked} onApply={s => onDraftChange({ ...draft, ...(s.contextWindow ? { contextWindow: s.contextWindow, maxOutputTokens: runtimeProfile === 'lightweight' ? adjustedLightweightOutput(s.contextWindow, draft.maxOutputTokens) : draft.maxOutputTokens } : {}), ...(s.toolCalling ? { toolCalling: s.toolCalling } : {}) })} />}
    {testError && <p className="xn-provider-test-feedback xn-provider-test-feedback--error" role="alert"><Radio size={15} aria-hidden="true" />{tr('连接测试失败：')}{testError}</p>}

    <section className="xn-provider-section">
      <div className="xn-provider-section__heading"><h4>{tr('基本信息')}</h4><p>{tr(isNew ? '填写显示名称；配置 ID 已自动生成，通常无需修改。' : '为配置指定稳定的 ID 和显示名称。')}</p></div>
      <div className="xn-provider-fields xn-provider-fields--identity">
        <label className="xn-provider-field">
          <span>{tr('显示名称')}</span>
          <input autoComplete="off" disabled={locked} value={draft.name} onChange={event => update('name', event.currentTarget.value)} required aria-label={tr('显示名称')} />
        </label>
        <label className="xn-provider-field">
          <span>{tr('配置 ID')}</span>
          <input autoComplete="off" disabled={locked || !isNew} value={draft.id} onChange={event => update('id', event.currentTarget.value)} required aria-label={tr('配置 ID')} spellCheck={false} />
          <small>{tr(isNew ? '自动生成的 ID 可手动修改；保存后不能修改。' : '配置 ID 不能修改。')}</small>
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
      {isLoopbackHttpEndpoint(draft.baseUrl) && <fieldset className="xn-provider-option-list xn-provider-loopback-http" disabled={locked} data-testid="provider-loopback-http-opt-in">
        <legend>{tr('本机 HTTP 安全授权')}</legend>
        <label>
          <input type="checkbox" checked={draft.allowLoopbackHttp} onChange={event => update('allowLoopbackHttp', event.currentTarget.checked)} aria-describedby="provider-loopback-http-help" />
          <span>{tr('允许此配置通过未加密 HTTP 连接到本机回环地址')}</span>
        </label>
        <small id="provider-loopback-http-help">{tr('仅适用于 127.0.0.0/8 或 ::1 等回环 IP 字面地址，不适用于 localhost、域名或远程 HTTP。此授权只作用于当前配置；标准档仍需要 API 密钥。')}</small>
      </fieldset>}
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
          placeholder={tr(isNew ? '粘贴服务商提供的 API 密钥' : '留空保留已有密钥')}
          aria-label={tr('API 密钥')}
          spellCheck={false}
        />
        <button type="button" className="xn-provider-icon-button" disabled={locked} aria-label={tr(keyVisible ? '隐藏密钥' : '显示密钥')} title={tr(keyVisible ? '隐藏密钥' : '显示密钥')} onClick={() => setKeyVisible(value => !value)}>
          {keyVisible ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
        </button>
      </div>
      {runtimeProfile === 'lightweight' && draft.protocol === 'openai' && isLoopbackIpLiteral(draft.baseUrl) && <p className="xn-provider-hint">{tr('本地 127.0.0.1 或 ::1 服务可将密钥留空；留空仍会保留已保存的密钥。')}</p>}
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
          <input type="number" inputMode="numeric" min={MIN_CONTEXT_WINDOW} max={MAX_CONTEXT_WINDOW} step={1} disabled={locked} value={draft.contextWindow ?? ''} placeholder={runtimeProfile === 'lightweight' ? String(LIGHTWEIGHT_DEFAULT_CONTEXT) : tr('留空使用服务默认')}
            onChange={event => changeContextWindow(event.currentTarget.value === '' ? undefined : event.currentTarget.valueAsNumber)} aria-label={tr('上下文窗口（tokens）')} />
          <small>{tr('按实际部署的模型填写，范围 16384–262144；轻量留空时按 16384。')}</small>
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
      <details className="xn-provider-advanced" data-testid="provider-advanced-settings">
        <summary>{tr('高级')}</summary>
        <p className="xn-provider-advanced__intro">{tr('高级项默认折叠；展开后的字段、取值和保存行为保持不变。')}</p>
        {advancedRuntimeSettings}
      </details>
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
        {original && <button type="button" className="xn-provider-button" disabled={locked || changed} title={changed ? tr('请先保存更改，再测试或使用此配置。') : undefined} aria-describedby={changed ? UNSAVED_ACTIONS_HELP_ID : undefined} onClick={onUse}>{tr('用于当前运行')}</button>}
        {changed && <button type="button" className="xn-provider-button" disabled={locked} onClick={onCancelEdit}>{tr(isNew ? '取消' : '放弃更改')}</button>}
        <button type="submit" className="xn-provider-button xn-provider-button--primary" disabled={!canSave}>
          {busy ? <LoaderCircle size={15} className="xn-provider-spin" aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}
          {tr(busy ? '正在保存' : '保存配置')}
        </button>
      </div>
    </footer>
  </form>;
}
