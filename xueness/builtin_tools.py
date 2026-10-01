"""Compatibility alias for the kernel tool router."""
import importlib as _importlib
import sys as _sys
_sys.modules[__name__] = _importlib.import_module("xueness.tool_registry")
