"""Kernel contract for trusted bundled capability plugins.

Two shapes live here. :class:`Plugin` is the opt-in capability object the run
seam loads (skills, hooks, MCP, sub-agents). The bundled feature packages use a
module contract instead: ``dispatch``, ``tools``, ``register_cli``,
``execute_cli`` and, for lifecycles, an optional ``activate(scope, ctx)`` that
acquires services on the plugin's own scope. Manifests describe that lifecycle
with data only, validated by :func:`lifecycle_field_errors`.
"""
from __future__ import annotations

import re

#: Optional manifest fields the lifecycle runtime reads. They are compared as
#: strings only; a manifest never names importable code or commands to run.
LIFECYCLE_FIELDS = ('provides', 'inject', 'httpFamilies')

#: Services are dot-namespaced data keys, for example ``automation.scheduler``.
SERVICE_NAME = re.compile(r'[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*\Z')

#: HTTP ownership is declared per path family. ``*`` skips one path segment, so
#: ``sessions/*/git`` claims the git sub-resource of a session collection.
ROUTE_SEGMENT = re.compile(r'\*|[a-z][a-z0-9_]*\Z')


def lifecycle_field_errors(plugin_id, manifest) -> list[str]:
    """Return the reasons a bundled manifest's lifecycle declarations are unusable."""
    errors = []
    for field in LIFECYCLE_FIELDS:
        if field not in manifest:
            continue
        values = manifest[field]
        if not isinstance(values, list) or any(not isinstance(item, str) or not item for item in values):
            errors.append('%s: %s must be a string array' % (plugin_id, field))
            continue
        if len(values) != len(set(values)):
            errors.append('%s: duplicate %s' % (plugin_id, field))
        for value in values:
            if field == 'httpFamilies':
                errors.extend(_route_errors(plugin_id, field, value))
            elif not SERVICE_NAME.match(value):
                errors.append('%s: invalid %s name %s' % (plugin_id, field, value))
    return errors


def _route_errors(plugin_id, field, value) -> list[str]:
    segments = value.split('/')
    if any(not ROUTE_SEGMENT.match(segment) for segment in segments) or segments[0] == '*':
        return ['%s: invalid %s pattern %s' % (plugin_id, field, value)]
    return []


class Plugin:
    """One opt-in capability implementation.

    ``load`` returns keyword arguments for ``core.run``. ``teardown`` releases
    resources acquired while loading and must be safe to call more than once.
    """

    kind = ""

    def load(self, state_dir, root, session) -> dict:  # pragma: no cover - interface
        raise NotImplementedError

    def teardown(self) -> None:
        """Release acquired resources. Safe to call repeatedly."""
