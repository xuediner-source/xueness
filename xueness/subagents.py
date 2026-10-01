"""Compatibility import for the subagents plugin; implementation moved."""
import importlib as _importlib
import sys as _sys
_sys.modules[__name__] = _importlib.import_module('xueness.bundled_plugins.subagents.subagents')
