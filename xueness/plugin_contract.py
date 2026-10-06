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
LIFECYCLE_FIELDS = ('provides', 'inject', 'httpFamilies', 'pluginsActions', 'dataFiles')

#: Services and sub-actions are lowercase words; ``pluginsActions`` names the
#: sub-actions of the shared ``plugins`` command group that this plugin runs.
SERVICE_NAME = re.compile(r'[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*\Z')

#: HTTP ownership is declared per path family. ``*`` skips one path segment, so
#: ``sessions/*/git`` claims the git sub-resource of a session collection.
ROUTE_SEGMENT = re.compile(r'\*|[a-z][a-z0-9_]*\Z')

#: Data files are read-only package data addressed by relative path.
DATA_PATH = re.compile(r'[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*\Z')

#: Tool event pipeline seams a manifest may declare. before_tool_effect is a
#: strict post-Gate reservation point; after_tool_authorization is observer-only;
#: the other declarations grant structured intervention.
TOOL_EVENT_NAMES = ('before_tool_execution', 'after_tool_execution',
                    'after_tool_authorization', 'before_tool_effect')

#: Inclusive bounds for the optional declared dispatch priority.
TOOL_EVENT_PRIORITY_BOUNDS = (-1000, 1000)


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
            elif field == 'dataFiles':
                errors.extend(_data_errors(plugin_id, field, value))
            elif not SERVICE_NAME.match(value):
                errors.append('%s: invalid %s name %s' % (plugin_id, field, value))
    return errors


def _route_errors(plugin_id, field, value) -> list[str]:
    segments = value.split('/')
    if any(not ROUTE_SEGMENT.match(segment) for segment in segments) or segments[0] == '*':
        return ['%s: invalid %s pattern %s' % (plugin_id, field, value)]
    return []


def _data_errors(plugin_id, field, value) -> list[str]:
    if value.startswith('/') or '..' in value.split('/') or not DATA_PATH.match(value):
        return ['%s: invalid %s path %s' % (plugin_id, field, value)]
    return []


def tool_events_field_errors(plugin_id, manifest) -> list[str]:
    """Return the reasons a manifest's ``toolEvents`` declaration is unusable.

    The field is pure data: an object naming the events where the plugin may
    intervene (unique members of :data:`TOOL_EVENT_NAMES`) plus an optional
    integer dispatch priority. Nothing here names code, so the same shapes can
    be checked statically by the build gate.
    """
    declaration = manifest.get('toolEvents')
    if declaration is None:
        return []
    if not isinstance(declaration, dict) or set(declaration) - {'events', 'priority'}:
        return ['%s: toolEvents must be an object with events and an optional priority'
                % plugin_id]
    errors = []
    events = declaration.get('events')
    if (not isinstance(events, list) or not events
            or any(not isinstance(item, str) or item not in TOOL_EVENT_NAMES for item in events)
            or len(events) != len(set(events))):
        errors.append('%s: toolEvents events must list unique names from %s'
                      % (plugin_id, ', '.join(TOOL_EVENT_NAMES)))
    priority = declaration.get('priority')
    if priority is not None and (type(priority) is not int
                                 or not TOOL_EVENT_PRIORITY_BOUNDS[0] <= priority
                                 <= TOOL_EVENT_PRIORITY_BOUNDS[1]):
        errors.append('%s: toolEvents priority must be an int within [%d, %d]'
                      % (plugin_id, *TOOL_EVENT_PRIORITY_BOUNDS))
    return errors


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
