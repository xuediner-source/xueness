"""Composer composition of statically bundled, plugin-owned capabilities.

Only trusted source entrypoints contribute guidance. Catalog/config/resource
data cannot import code, enable a plugin, authorize a tool or change run mode.
"""
from ... import plugin_runtime

CAPABILITIES = ({
    "id": "sessions.usage_guide", "name": "Xueness 使用指南", "nameEn": "Xueness guide",
    "description": "工作区、模型、插件、技能、MCP、命令与权限诊断。",
    "descriptionEn": "Help with workspaces, models, plugins, skills, MCP, commands and permissions.",
    "tools": [],
    "instructions": "Help the user configure and diagnose this Xueness installation. Inspect workspace documentation and actual enabled tools instead of inventing settings or claiming access. Settings contains model/search configuration and the complete installed feature-plugin catalog; disabled dependencies block features. The Add menu selects guidance/context without granting permissions. @ references workspace files, plugins and sessions; $ selects skills; / selects commands. Build asks before changes, edit allows file edits, plan is read-only, yolo skips ordinary approvals after confirmation while built-in file tools retain their workspace jail, network tools retain public HTTPS checks, and commands run with the current OS account permissions (commands are not OS-sandboxed). All new product features belong to an allowlisted bundled plugin and must appear in its manifest features. Use actual read/diagnostic results and report unknowns; never expose API keys or other sessions outside this workspace.",
},)


def _entries(state_dir, *, include_disabled=False):
    for plugin_id in ("extensions", "skills", "sessions", "office", "browser", "network"):
        if not include_disabled and not plugin_runtime.is_enabled(state_dir, plugin_id):
            continue
        callback = getattr(plugin_runtime.entrypoint(plugin_id), "composer_capabilities", None)
        for item in callback() if callable(callback) else ():
            # All values originate in trusted, allowlisted source modules.
            yield plugin_id, item


def catalog(state_dir):
    return [{"id": item["id"], "pluginId": owner, "label": item["name"],
             "labelEn": item["nameEn"], "description": item["description"],
             "descriptionEn": item["descriptionEn"], "available": plugin_runtime.is_enabled(state_dir, owner)}
            for owner, item in _entries(state_dir, include_disabled=True)]


def prepare(state_dir, selected):
    entries = {item["id"]: (owner, item) for owner, item in _entries(state_dir)}
    if any(identifier not in entries for identifier in selected):
        raise ValueError("capability disabled or unavailable")
    available = plugin_runtime.active_tool_names(state_dir)
    blocks, metadata = [], []
    for identifier in selected:
        owner, item = entries[identifier]
        if any(tool not in available for tool in item["tools"]):
            raise ValueError("capability tools unavailable")
        blocks.append("User-selected Xueness capability: " + item["nameEn"] + "\n" + item["instructions"])
        metadata.append({"id": identifier, "pluginId": owner, "label": item["name"],
                         "tools": list(item["tools"])})
    return "\n\n".join(blocks), metadata
