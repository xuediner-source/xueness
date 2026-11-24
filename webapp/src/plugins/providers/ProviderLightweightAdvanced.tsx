import React from 'react';
import type { ProviderLightweightOptions } from '../../xuenessApi';
import { Select } from '../../ui/Select';
import { t as tr, tf } from '../../i18n';
import { LocalRuntimeMonitor } from './LocalRuntimeMonitor';
import { lightweightBudgetPreview } from './providerDraft';
import type { NumericLightweightOptionKey, ProviderDraft } from './providerDraft';

export function ProviderLightweightAdvanced({ draft, locked, runtimeProfile, advancedOpen, onAdvancedToggle, runtimeMonitorEnabled, onDraftChange }: {
  draft: ProviderDraft;
  locked: boolean;
  runtimeProfile: 'standard' | 'lightweight';
  advancedOpen: boolean;
  onAdvancedToggle: (open: boolean) => void;
  runtimeMonitorEnabled: boolean;
  onDraftChange: (draft: ProviderDraft) => void;
}) {
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
  const budgetPreview = lightweightBudgetPreview(draft);

  return <details className="xn-provider-advanced" data-testid="provider-lightweight-advanced" open={advancedOpen} onToggle={event => onAdvancedToggle(event.currentTarget.open)}>
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
      </details>;
}
