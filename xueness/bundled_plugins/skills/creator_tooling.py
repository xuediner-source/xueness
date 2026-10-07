"""Skill creator validation reuses the actual discovery contract."""
from ...tool_contract import BuiltinTool
from .file_skills import MAX_SKILL_FILE_BYTES, parse_frontmatter, validate_frontmatter


def _validate(root, gate, args, session, call_id):
    gate.check("read", "")
    content = args.get("content")
    if not isinstance(content, str) or len(content.encode("utf-8")) > MAX_SKILL_FILE_BYTES:
        raise ValueError("skill content exceeds the text limit")
    values, keys, error = parse_frontmatter(content)
    if error:
        return {"ok": False, "errors": [{"code": error}], "executed": False}
    metadata, invalid = validate_frontmatter(values, keys)
    if invalid:
        return {"ok": False, "errors": [invalid], "executed": False}
    lines = content.lstrip("\ufeff").replace("\r\n", "\n").split("\n")
    end = next(index for index, line in enumerate(lines[1:], 1) if line.strip() == "---")
    body = "\n".join(lines[end + 1:]).strip()
    if not body:
        return {"ok": False, "errors": [{"code": "skill_empty_body"}], "executed": False}
    return {"ok": True, "metadata": metadata, "errors": [], "executed": False}


REGISTRY = (BuiltinTool("skill_validate",
    "Validate a complete SKILL.md against Xueness skill discovery rules; never executes its content",
    {"content": {"type": "string"}}, ("content",), "read", False, _validate,
    concurrency_safe=True),)
