"""Bounded provider measurements and termination, never inferred success."""

TOKEN_KEYS = frozenset({
    'prompt_tokens', 'completion_tokens', 'total_tokens', 'input_tokens',
    'output_tokens', 'cached_tokens', 'cache_read_input_tokens',
    'cache_creation_input_tokens', 'reasoning_tokens',
})
DETAIL_KEYS = frozenset({'cached_tokens', 'reasoning_tokens', 'accepted_prediction_tokens',
                         'rejected_prediction_tokens', 'audio_tokens'})
FINISH_REASONS = frozenset({'stop', 'length', 'tool_calls', 'content_filter',
                            'context_limit', 'paused', 'unknown'})


def token_count(value):
    return type(value) is int and 0 <= value <= 1_000_000_000


def reported_usage(raw):
    if not isinstance(raw, dict):
        return {}
    result = {key: value for key, value in raw.items()
              if key in TOKEN_KEYS and token_count(value)}
    for key in ('prompt_tokens_details', 'completion_tokens_details'):
        detail = raw.get(key)
        if isinstance(detail, dict):
            clean = {k: v for k, v in detail.items() if k in DETAIL_KEYS and token_count(v)}
            if clean:
                result[key] = clean
    # Anthropic input_tokens excludes cache reads/creation. A cache hit still
    # occupies context; keep the original billing counters alongside the sum.
    if 'prompt_tokens' not in result and 'input_tokens' in result:
        total = sum(result.get(k, 0) for k in ('input_tokens', 'cache_read_input_tokens',
                                             'cache_creation_input_tokens'))
        if token_count(total):
            result['prompt_tokens'] = total
    if 'completion_tokens' not in result and 'output_tokens' in result:
        result['completion_tokens'] = result['output_tokens']
    return result


def finish_reason(raw):
    aliases = {'end_turn': 'stop', 'stop_sequence': 'stop', 'tool_use': 'tool_calls',
               'function_call': 'tool_calls', 'max_tokens': 'length',
               'pause_turn': 'paused', 'refusal': 'content_filter',
               'context_length': 'context_limit', 'context_length_exceeded': 'context_limit'}
    if not isinstance(raw, str):
        return None
    value = aliases.get(raw, raw)
    return value if value in FINISH_REASONS else 'unknown'


def incomplete_reason(reason, usage, provider):
    """Length alone does not distinguish output exhaustion from full context."""
    if reason in (None, 'stop', 'tool_calls'):
        return None  # Legacy adapters without metadata remain compatible.
    if reason != 'length':
        return {'context_limit': 'context_limit', 'content_filter': 'provider_filtered',
                'paused': 'provider_paused'}.get(reason, 'unknown_termination')
    usage = reported_usage(usage)
    inputs, outputs = usage.get('prompt_tokens'), usage.get('completion_tokens')
    limit = getattr(provider, 'max_output_tokens', None)
    window = getattr(provider, 'context_window', None)
    if token_count(outputs) and token_count(limit) and outputs >= limit:
        return 'output_limit'
    if (token_count(inputs) and token_count(outputs) and token_count(window)
            and token_count(limit) and inputs + limit > window
            and inputs + outputs >= window - 32):
        return 'context_limit'
    return 'generation_limit'


def pause_message(reason):
    return {
        'context_limit': '上下文容量已耗尽，回答尚未完成。再次续写前将重新整理请求历史；若用户输入本身过长，请缩短输入或新建会话。',
        'output_limit': '本次生成达到输出上限，回答尚未完成。已有正文已保留，可发送“继续”补写；输出预算包含模型思考。',
        'generation_limit': '模型因生成限制停止，回答尚未完成。服务未提供足够信息区分输出上限与上下文限制；已有正文已保留。',
        'provider_filtered': '模型服务过滤了本次响应，回答尚未完成。',
        'provider_paused': '模型服务暂停了本次响应，回答尚未完成。',
        'unknown_termination': '模型返回了无法识别的结束原因，尚不能确认回答完整。',
    }[reason]
