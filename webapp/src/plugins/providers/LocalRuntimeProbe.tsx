/**
 * After a successful connection test on a loopback endpoint: ask the server
 * what the local runtime is really running (context window, native tool
 * support), compare it with the saved profile, and offer the suggested
 * values. Applying only edits the draft; the person still saves.
 */
import React, { useEffect, useState } from 'react';
import { Cpu, TriangleAlert } from 'lucide-react';
import { post } from '../../xuenessApi';
import { t as tr, tf } from '../../i18n';

type Finding = { code: string; configured?: number; runtime?: number; maximum?: number; minimum?: number };
export type RuntimeSuggestion = { contextWindow?: number; toolCalling?: 'native' | 'json' };
type Probe = { local: boolean; runtime: 'ollama' | 'llama.cpp' | 'lmstudio' | null; findings: Finding[]; suggestion: RuntimeSuggestion };

const RUNTIME_NAMES = { ollama: 'Ollama', 'llama.cpp': 'llama.cpp', lmstudio: 'LM Studio' } as const;
const WARNINGS = new Set(['context_exceeds_runtime', 'context_exceeds_model', 'runtime_context_too_small', 'ollama_default_context', 'native_tools_unsupported']);

function findingText(finding: Finding): string {
  const { configured, runtime, maximum, minimum } = finding;
  switch (finding.code) {
    case 'context_matches_runtime': return tf('服务实际上下文窗口为 {0} tokens，与配置一致。', [runtime]);
    case 'context_exceeds_runtime': return tf('配置的上下文窗口 {0} 大于服务实际运行的 {1} tokens，超出的部分会被服务端截断。', [configured, runtime]);
    case 'context_below_runtime': return tf('服务实际上下文窗口为 {1} tokens，配置为 {0}，可以调高。', [configured, runtime]);
    case 'context_not_configured': return tf('服务实际上下文窗口为 {0} tokens，配置中尚未填写。', [runtime]);
    case 'runtime_context_too_small': return tf('服务实际上下文窗口只有 {0} tokens，低于最小值 {1}。请在推理服务中调大后再使用。', [runtime, minimum]);
    case 'ollama_default_context': return maximum
      ? tf('Ollama 没有为这个模型设置 num_ctx，将使用服务默认值，通常远小于模型上限 {0} tokens。请在 Ollama 中把 num_ctx 设为不小于这里配置的上下文窗口。', [maximum])
      : tr('Ollama 没有为这个模型设置 num_ctx，将使用服务默认值。请在 Ollama 中把 num_ctx 设为不小于这里配置的上下文窗口。');
    case 'runtime_context_unreported': return maximum ? tf('服务没有报告实际上下文窗口；模型上限为 {0} tokens。', [maximum]) : tr('服务没有报告实际上下文窗口。');
    case 'context_exceeds_model': return tf('配置的上下文窗口 {0} 超过模型上限 {1} tokens。', [configured, maximum]);
    case 'model_not_loaded': return tr('模型当前未加载，实际上下文窗口要在加载后才能确认。');
    case 'native_tools_unsupported': return tr('服务报告这个模型不支持原生工具调用。');
    case 'native_tools_available': return tr('服务报告这个模型支持原生工具调用，可以不使用 JSON 工具协议。');
    case 'runtime_not_recognised': return tr('没有识别出本地推理服务类型，无法核对上下文窗口。');
    default: return finding.code;
  }
}

export function LocalRuntimeProbe({ providerId, runKey, disabled, onApply }: { providerId: string; runKey: unknown; disabled?: boolean; onApply(suggestion: RuntimeSuggestion): void }) {
  const [probe, setProbe] = useState<Probe | null>(null);
  const [applied, setApplied] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setProbe(null); setApplied(false);
    // The probe is advisory: a failure shows nothing rather than an error next to a successful test.
    post<Probe>('/api/providers/probe', { id: providerId }, controller.signal).then(result => { if (!controller.signal.aborted) setProbe(result); }).catch(() => {});
    return () => controller.abort();
  }, [providerId, runKey]);
  if (!probe?.local || !Array.isArray(probe.findings) || !probe.findings.length) return null;
  const suggestion = probe.suggestion ?? {};
  const parts = [
    ...(suggestion.contextWindow ? [tf('上下文窗口 {0}', [suggestion.contextWindow])] : []),
    ...(suggestion.toolCalling === 'json' ? [tr('JSON 工具协议')] : []),
  ];
  return <div className="xn-provider-runtime-probe" data-testid="local-runtime-probe">
    {probe.runtime && <p className="xn-provider-test-feedback" role="status"><Cpu size={15} aria-hidden="true" />{tf('已识别本地推理服务：{0}', [RUNTIME_NAMES[probe.runtime]])}</p>}
    {probe.findings.map(finding => WARNINGS.has(finding.code)
      ? <p key={finding.code} className="xn-provider-test-feedback xn-provider-test-feedback--error" role="alert"><TriangleAlert size={15} aria-hidden="true" />{findingText(finding)}</p>
      : <p key={finding.code} className="xn-provider-hint">{findingText(finding)}</p>)}
    {parts.length > 0 && <p className="xn-provider-hint">
      <button type="button" className="xn-provider-button" disabled={disabled || applied} onClick={() => { onApply(suggestion); setApplied(true); }}>
        {applied ? tr('已填入，保存后生效') : tf('采用建议：{0}', [parts.join('、')])}</button></p>}
  </div>;
}
