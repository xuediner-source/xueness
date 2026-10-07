"""Trusted creator guidance; marketplace manifests remain inert data."""
CAPABILITIES = ({
    "id": "extensions.plugin_creator", "name": "插件创建器", "nameEn": "Plugin creator",
    "description": "创建、校验与完善 Xueness 插件资源；可执行功能需走源码构建。",
    "descriptionEn": "Create and validate Xueness plugin resources; executable features require a source build.",
    "tools": ["plugin_manifest_validate"],
    "instructions": "Develop a Xueness plugin for the user's concrete task. First inspect existing project conventions and AGENTS.md. A marketplace manifest is inert JSON, not an executable loader: never add entrypoints, code URLs or dynamic imports. A minimal data manifest has id, version (MAJOR.MINOR.PATCH), apiVersion:1, builtin (skills, hooks, mcp or subagents), capabilities (a subset of command, network, filesystem-write), enabled:false; choose the actual known adapter and minimum required powers. Use file tools to create the draft in the workspace, then plugin_manifest_validate with its parsed manifest. Validate dependencies and permissions, and clearly distinguish a data-only resource from a trusted bundled source plugin. For a source feature use bundled_plugins/<id>, its manifest, frontend registry and plugin architecture checks. Do not install, enable or publish automatically; report actual files and validation findings. The resource editor and marketplace provide the explicit installation path.",
},)
