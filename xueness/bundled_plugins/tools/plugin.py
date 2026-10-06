"""Trusted entrypoint for the tool execution policy plugin.

The package contributes no model-facing tool of its own. It owns a policy over
the tools other plugins register, exercised through the ``before_tool_execution``
seam its manifest declares, plus the cooperative dry-run guard that the
side-effecting handlers ask before they touch anything.
"""
from __future__ import annotations


def before_tool_execution(payload):
    from .dry_run import before_tool_execution as participant
    return participant(payload)


def before_tool_effect(payload):
    from .call_budget import before_tool_effect as participant
    return participant(payload)


def after_tool_execution(payload):
    from .call_budget import status_for_context
    if not isinstance(payload, dict) or not isinstance(payload.get('result'), dict):
        return None
    status = status_for_context(
        state_dir=payload.get('state_dir'), session=payload.get('session'),
        store=payload.get('store'),
        execution_scope=payload.get('execution_scope'))
    if status is None:
        return None
    return {'decision': 'rewrite',
            'result': {**payload['result'], 'call_budget': status}}


def dispatch(method, parts, query, data, ctx):
    from .call_budget import dispatch_http
    return dispatch_http(method, parts, query, data, ctx)
