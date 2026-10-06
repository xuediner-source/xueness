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
