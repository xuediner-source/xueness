import React from 'react';
import { Check, LoaderCircle, Radio } from 'lucide-react';
import type { ProviderCompatibilityCheckRecord, ProviderCompatibilityDiagnosticGroup, ProviderCompatibilityTest, ProviderCompatibilityTestMode, ProviderSummary } from '../../xuenessApi';
import { Select } from '../../ui/Select';
import { t as tr, tf } from '../../i18n';
import type { ProviderDraft } from './providerDraft';

export function ProviderCompatibilitySettings({
  draft, original, isNew, locked, runtimeProfile, onDraftChange,
  compatibilityMode, compatibilityResult, compatibilityError, compatibilityTesting, compatibilityTestReady,
  compatibilityHistory, compatibilityGroups, compatibilityAdoptionReady, adoptingCompatibility,
  onCompatibilityModeChange, onCompatibilityTest, onAdoptCompatibility, onLoadCompatibilityCandidate,
}: {
  draft: ProviderDraft;
  original: ProviderSummary | null;
  isNew: boolean;
  locked: boolean;
  runtimeProfile: 'standard' | 'lightweight';
  onDraftChange: (draft: ProviderDraft) => void;
  compatibilityMode: ProviderCompatibilityTestMode;
  compatibilityResult: ProviderCompatibilityTest | null;
  compatibilityError: string;
  compatibilityTesting: boolean;
  compatibilityTestReady: boolean;
  compatibilityHistory: ProviderCompatibilityCheckRecord[];
  compatibilityGroups: ProviderCompatibilityDiagnosticGroup[];
  compatibilityAdoptionReady: boolean;
  adoptingCompatibility: boolean;
  onCompatibilityModeChange: (mode: ProviderCompatibilityTestMode) => void;
  onCompatibilityTest: () => void;
  onAdoptCompatibility: () => void;
  onLoadCompatibilityCandidate: (compatibility: NonNullable<ProviderSummary['compatibility']>) => void;
}) {
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
  return (
    <>
        <fieldset className="xn-provider-option-list" disabled={locked}>
          <legend>{tr('API 兼容设置')}</legend>
          <label>
            <input type="checkbox" checked={draft.compatibility?.streamUsage ?? true} onChange={event => onDraftChange({ ...draft, compatibility: { ...draft.compatibility, streamUsage: event.currentTarget.checked } })} />
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
                <option value="json_tool_roundtrip" disabled={runtimeProfile !== 'lightweight'}>{tr('工具结果续轮（json，两次请求）')}</option>
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
    </>
  );
}
