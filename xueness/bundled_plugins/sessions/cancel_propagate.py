"""Bind a stop probe around one model call. Experimental, default off.

Feature ``sessions.cancel_propagate``. Settings key
``general.sessionsCancelPropagateEnabled`` must be boolean true, and the
sessions plugin must be enabled. Otherwise ``begin`` does nothing: no
context value, no probe thread, and provider methods keep their existing
signatures so test doubles are unchanged.

The socket work lives in ``providers/cancel_watch.py``. That module is the
existing provider transport helper, not a new model capability. Core only
calls ``begin`` / ``end`` around ``request_model``, including the overflow
retry of that same call.

Reference (idea, not copied code): ZCode v3.14.3
``packages/rpc/src/channelServer.ts``.
"""
from __future__ import annotations

FEATURE_ID = 'sessions.cancel_propagate'
SETTINGS_SECTION = 'general'
SETTINGS_KEY = 'sessionsCancelPropagateEnabled'


def callback_for(state_dir, should_stop):
    """The stop probe, or ``None`` when the experiment is off."""
    if not callable(should_stop):
        return None
    try:
        from ..settings.settings_store import load_settings
        from ...plugin_runtime import is_enabled
        if not is_enabled(state_dir, 'sessions'):
            return None
        section = load_settings(state_dir).get(SETTINGS_SECTION, {})
    except (OSError, ValueError, TypeError):
        return None
    if not isinstance(section, dict) or section.get(SETTINGS_KEY) is not True:
        return None
    return should_stop


def begin(state_dir, should_stop):
    """Start the probe for this context, or return ``None`` when disabled."""
    callback = callback_for(state_dir, should_stop)
    if callback is None:
        return None
    from ..providers.cancel_watch import bind_provider_cancel
    return bind_provider_cancel(callback)


def end(token):
    """Join the probe started by :func:`begin`. ``None`` is a no-op."""
    if token is None:
        return
    from ..providers.cancel_watch import unbind_provider_cancel
    unbind_provider_cancel(token)
