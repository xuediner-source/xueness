"""Resolve saved profiles into runtime clients without exposing stored keys."""
import os
from ...provider import AnthropicMessages, OpenAICompatible
from ... import providers_api
from .runtime_options import resolve_runtime_options


CONFIGURATION_GUIDANCE = (
    'Configure a model with `xueness providers save ID --base-url URL --model MODEL '
    '--key-env ENV`, or set XUENESS_API_BASE, XUENESS_MODEL, and XUENESS_API_KEY '
    '(Anthropic also accepts ANTHROPIC_API_KEY with XUENESS_PROVIDER=anthropic).'
)


def configuration_error(error):
    """Return an actionable, credential-safe explanation for model setup errors."""
    detail = str(error).strip() or 'model provider is not configured'
    if CONFIGURATION_GUIDANCE in detail:
        return detail
    if ('XUENESS_MODEL and XUENESS_API_KEY must be set' in detail
            or 'ANTHROPIC_API_KEY and XUENESS_MODEL must be set' in detail):
        detail = 'no model provider is configured'
    return f'{detail}. {CONFIGURATION_GUIDANCE}'


def is_legacy_fake_session(session):
    """Recognize sessions written by the retired public offline demo provider.

    The explicit marker covers newer internal fixtures. Historic runs predate
    that marker, so their stable demo tool-call IDs are also checked.
    """
    if not isinstance(session, dict):
        return False
    if session.get('provider_mode') in ('fake', 'demo', 'offline'):
        return True
    selection = session.get('model_selection')
    if isinstance(selection, dict) and selection.get('provider_id') in ('fake', 'demo'):
        return True
    for message in session.get('messages', []):
        if not isinstance(message, dict):
            continue
        call_id = message.get('tool_call_id')
        if isinstance(call_id, str) and (call_id == 'demo-write' or call_id.startswith('demo-read')):
            return True
        for call in message.get('tool_calls') or ():
            if not isinstance(call, dict):
                continue
            call_id = call.get('id')
            if isinstance(call_id, str) and (call_id == 'demo-write' or call_id.startswith('demo-read')):
                return True
    return False


def reject_legacy_fake_session(session):
    if is_legacy_fake_session(session):
        raise ValueError(
            'This session was run with the retired offline demo provider and cannot be resumed with a real model. '
            'Start a new session to continue with a configured model.'
        )


def _validate_reasoning_effort(model, configured, effort):
    if effort is None:
        return
    if effort not in providers_api.REASONING_LEVELS:
        raise ValueError('invalid reasoning effort')
    supported = configured if configured is not None else providers_api.known_reasoning_levels(model)
    if effort not in supported:
        raise ValueError('selected model does not declare support for reasoning effort ' + effort)


def resolve(state_dir, provider_id=None, model=None, reasoning_effort=None, runtime_profile=None):
    if provider_id:
        with providers_api.PROVIDER_STORE_LOCK:
            if not providers_api._valid_id(provider_id):
                raise ValueError('invalid provider id')
            directory = providers_api._providers_dir({'state_dir': state_dir})
            path = providers_api._path_for(directory, provider_id)
            record = providers_api._read_record(path) if path else None
            if not record:
                raise ValueError('provider profile not found')
            protocol = record.get('protocol', 'openai')
            effective_record = record
            if runtime_profile is not None:
                effective_record = dict(record)
                effective_record['runtimeProfile'] = runtime_profile
            runtime_options = resolve_runtime_options(effective_record, protocol)
            # A per-session prompt/tool choice does not revoke the operator's
            # saved local transport opt-in. Literal IP checks still happen in
            # the adapter; this never authorizes remote plaintext or keyless.
            local_opt_in = (record.get('runtimeProfile') == 'lightweight'
                            or runtime_options['runtime_profile'] == 'lightweight')
            capabilities = record.get('capabilities')
            if capabilities is not None and (not isinstance(capabilities, list)
                                             or any(item not in ('image', 'pdf', 'video') for item in capabilities)):
                raise ValueError('provider profile has invalid model capabilities')
            declared_levels = record.get('reasoningLevels')
            if declared_levels is not None and (
                    not isinstance(declared_levels, list)
                    or any(item not in providers_api.REASONING_LEVELS for item in declared_levels)
                    or len(set(declared_levels)) != len(declared_levels)):
                raise ValueError('provider profile has invalid reasoning capabilities')
            if protocol == 'anthropic':
                if declared_levels is not None:
                    raise ValueError('Anthropic provider cannot declare reasoning levels')
                if reasoning_effort is not None:
                    raise ValueError('Anthropic provider does not declare reasoning-effort support')
                anthropic = AnthropicMessages(
                    base=record.get('baseUrl'), model=model or record.get('model'),
                    key=record.get('apiKey', ''), capabilities=capabilities,
                    max_tokens=(runtime_options['max_output_tokens']
                                if runtime_options['max_output_tokens'] is not None else 4096),
                    allow_loopback_http=(True if local_opt_in else None),
                )
                anthropic.runtime_profile = runtime_options['runtime_profile']
                anthropic.context_window = runtime_options['context_window']
                anthropic.max_output_tokens = runtime_options['max_output_tokens']
                anthropic.tool_calling = runtime_options['tool_calling']
                anthropic.compatibility = runtime_options['compatibility']
                anthropic.lightweight_options = runtime_options['lightweight_options']
                return anthropic
            if protocol != 'openai':
                raise ValueError('provider profile uses an unsupported protocol')
            selected_model = model or record.get('model')
            _validate_reasoning_effort(selected_model, declared_levels, reasoning_effort)
            return OpenAICompatible(base=record.get('baseUrl'), model=model or record.get('model'),
                                    key=record.get('apiKey', ''), capabilities=capabilities,
                                    reasoning_effort=reasoning_effort,
                                    runtime_profile=runtime_options['runtime_profile'],
                                    context_window=runtime_options['context_window'],
                                    max_output_tokens=runtime_options['max_output_tokens'],
                                    tool_calling=runtime_options['tool_calling'],
                                    compatibility=runtime_options['compatibility'],
                                    allow_loopback_http=(True if local_opt_in else None),
                                    allow_empty_key=(True if local_opt_in else None),
                                    lightweight_options=runtime_options['lightweight_options'])
    try:
        provider = os.environ.get('XUENESS_PROVIDER', '').strip().lower()
        if provider not in ('', 'openai', 'anthropic'):
            raise ValueError('unsupported model provider; configure an OpenAI-compatible or Anthropic provider')
        if provider == 'anthropic':
            if reasoning_effort is not None:
                raise ValueError('Anthropic provider does not declare reasoning-effort support')
            if runtime_profile is None:
                return AnthropicMessages(model=model)
            runtime_options = resolve_runtime_options({'runtimeProfile': runtime_profile}, 'anthropic')
            anthropic = AnthropicMessages(
                model=model,
                max_tokens=(runtime_options['max_output_tokens']
                            if runtime_options['max_output_tokens'] is not None else 4096),
                allow_loopback_http=(True if runtime_options['runtime_profile'] == 'lightweight' else None),
            )
            anthropic.runtime_profile = runtime_options['runtime_profile']
            anthropic.context_window = runtime_options['context_window']
            anthropic.max_output_tokens = runtime_options['max_output_tokens']
            anthropic.tool_calling = runtime_options['tool_calling']
            anthropic.compatibility = runtime_options['compatibility']
            anthropic.lightweight_options = runtime_options['lightweight_options']
            return anthropic
        selected_model = model or os.environ.get('XUENESS_MODEL', '')
        _validate_reasoning_effort(selected_model, None, reasoning_effort)
        if runtime_profile is None:
            return OpenAICompatible(model=model, reasoning_effort=reasoning_effort)
        runtime_options = resolve_runtime_options({'runtimeProfile': runtime_profile}, 'openai')
        return OpenAICompatible(
            model=model, reasoning_effort=reasoning_effort,
            runtime_profile=runtime_options['runtime_profile'],
            context_window=runtime_options['context_window'],
            max_output_tokens=runtime_options['max_output_tokens'],
            tool_calling=runtime_options['tool_calling'],
            compatibility=runtime_options['compatibility'],
            lightweight_options=runtime_options['lightweight_options'],
            allow_loopback_http=(True if runtime_options['runtime_profile'] == 'lightweight' else None),
            allow_empty_key=(True if runtime_options['runtime_profile'] == 'lightweight' else None),
        )
    except ValueError as exc:
        raise ValueError(configuration_error(exc)) from None
