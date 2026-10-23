/** The composer's capability and tool tables are the frozen Python registry's, entry for entry. */
import assert from "node:assert/strict";
import { it } from "node:test";
import { BUILTIN_TOOLS, COMPOSER_CAPABILITIES } from "../src/composer-data.ts";
import { pythonUnavailableReason, runPython } from "../../../test-support/python-oracle.ts";

it("matches Python's composer capabilities and builtin tool registry", { skip: pythonUnavailableReason() ?? false }, () => {
  const python = JSON.parse(runPython(`
import json
from xueness import plugin_runtime
from xueness.tool_registry import REGISTRY
caps = []
for pid in ('extensions', 'skills', 'sessions', 'office', 'browser', 'network'):
    callback = getattr(plugin_runtime.entrypoint(pid), 'composer_capabilities', None)
    for item in (callback() if callable(callback) else ()):
        caps.append({'pluginId': pid, **{key: list(value) if key == 'tools' else value for key, value in item.items()}})
tools = [[tool.name, plugin_runtime.tool_owner(tool.name) or '', tool.schema()['function']['description']] for tool in REGISTRY]
print(json.dumps({'caps': caps, 'tools': tools}))
`)) as { caps: unknown[]; tools: unknown[] };
  assert.deepEqual(COMPOSER_CAPABILITIES.map((item) => ({ ...item, tools: [...item.tools] })), python.caps);
  assert.deepEqual(BUILTIN_TOOLS.map((row) => [...row]), python.tools);
});
