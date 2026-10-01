"""Bounded, declarative tuning for local model requests and prompt views."""
import math

DEFAULTS = {
    'optionalContextChars': 1800, 'toolResultChars': 1400, 'initialTools': 'auto',
    'maxDiscoveredTools': 6, 'toolSearchResults': 3, 'resultPageChars': 1200,
    'fileReadChars': 4000, 'overflowRetry': True, 'overflowRetryRatio': 0.6,
    'jsonRepairAttempts': 1, 'stepLimit': 64, 'requestTimeoutSeconds': 120, 'transportRetries': 0,
}
INTEGER_RANGES = {
    'reserveTokens': (0, 8192), 'optionalContextChars': (0, 6000),
    'toolResultChars': (400, 12000), 'maxDiscoveredTools': (0, 12),
    'toolSearchResults': (1, 6), 'resultPageChars': (128, 4000),
    'fileReadChars': (128, 12000), 'jsonRepairAttempts': (0, 2),
    'stepLimit': (1, 64), 'wallTimeSeconds': (1, 3600), 'seed': (0, 2147483647),
    'requestTimeoutSeconds': (1, 300), 'transportRetries': (0, 2),
}
FLOAT_RANGES = {'overflowRetryRatio': (0.25, 0.85), 'temperature': (0, 2), 'topP': (0, 1)}
KEYS = frozenset(INTEGER_RANGES) | frozenset(FLOAT_RANGES) | {'initialTools', 'overflowRetry'}
SAMPLING_KEYS = frozenset({'temperature', 'topP', 'seed'})


def validate_options(value, protocol='openai'):
    if not isinstance(value, dict) or set(value) - KEYS:
        raise ValueError('lightweightOptions must contain supported options only')
    if protocol != 'openai' and SAMPLING_KEYS & set(value):
        raise ValueError('lightweight sampling options require an OpenAI-compatible provider')
    clean = {}
    for key, item in value.items():
        if key in INTEGER_RANGES:
            low, high = INTEGER_RANGES[key]
            if type(item) is not int or not low <= item <= high:
                raise ValueError(f'lightweightOptions.{key} must be an integer from {low} to {high}')
        elif key in FLOAT_RANGES:
            low, high = FLOAT_RANGES[key]
            if (type(item) not in (int, float) or not low <= item <= high
                    or not math.isfinite(item) or key == 'topP' and item == 0):
                raise ValueError(f'lightweightOptions.{key} is outside the supported range')
        elif key == 'initialTools':
            if not isinstance(item, str) or item not in ('auto', 'minimal', 'core'):
                raise ValueError('lightweightOptions.initialTools must be auto, minimal or core')
        elif type(item) is not bool:
            raise ValueError('lightweightOptions.overflowRetry must be a boolean')
        clean[key] = item
    return clean


def effective_options(provider=None, *, value=None, context=None, output=None):
    raw = value if value is not None else getattr(provider, 'lightweight_options', {})
    options = {**DEFAULTS, **validate_options(raw)}
    context = context or getattr(provider, 'context_window', None) or 8192
    output = output or getattr(provider, 'max_output_tokens', None) or min(1024, context // 4)
    options.setdefault('reserveTokens', 128 if context < 4096 else 512)
    if context - output - options['reserveTokens'] < 256:
        raise ValueError('lightweightOptions.reserveTokens leaves fewer than 256 input tokens')
    return options


def session_options(session):
    if (session or {}).get('runtime_profile') != 'lightweight':
        return {}
    return {**DEFAULTS, **validate_options((session or {}).get('lightweight_options', {}))}
