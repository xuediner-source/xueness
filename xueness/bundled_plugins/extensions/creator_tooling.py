"""Bounded, non-executing validation available to the plugin creation workflow."""
import json
from ...tool_contract import BuiltinTool
from .validate_update import validate_manifest_document


def _validate(root, gate, args, session, call_id):
    gate.check("read", "")
    manifest = args.get("manifest")
    if not isinstance(manifest, dict) or len(json.dumps(manifest, ensure_ascii=False)) > 65536:
        raise ValueError("manifest must be a bounded JSON object")
    errors, warnings, normalized = validate_manifest_document(manifest)
    return {"ok": not errors, "errors": errors, "warnings": warnings,
            "manifest": normalized, "executed": False, "installed": False}


REGISTRY = (BuiltinTool("plugin_manifest_validate",
    "Validate a Xueness data-only plugin manifest without executing, installing or enabling it",
    {"manifest": {"type": "object"}}, ("manifest",), "read", False, _validate,
    concurrency_safe=True),)
