import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { pyJsonDumps, pyJsonLoads } from "@xueness/contracts";
import { dispatchSettings, validate } from "../src/index.ts";
import { pythonUnavailableReason, runPython } from "../../../test-support/python-oracle.ts";

const ORACLE = `
import json,sys
from pathlib import Path
from xueness.bundled_plugins.settings import preferences, settings_store
p=json.loads(sys.stdin.read()); state=Path(p['state'])
def attempt(call):
    try: return ['ok', call()]
    except Exception as exc: return [type(exc).__name__, str(exc)]
def text():
    path=state/'settings.json'
    return path.read_text(encoding='utf-8') if path.exists() else None
validated=[attempt(lambda c=c: preferences.validate(c[0], c[1]) is c[1]) for c in p['cases']]
replies=[]
for method, path, data in p['requests']:
    replies.append([attempt(lambda: settings_store.dispatch(method, [x for x in path.split('/') if x], {}, data, {'state_dir': state})), text()])
loads=[]
for raw in p['files']:
    (state/'settings.json').write_bytes(bytes.fromhex(raw))
    loads.append(attempt(lambda: settings_store.dispatch('GET', ['api','settings'], {}, {}, {'state_dir': state})))
print(json.dumps({'validated': validated, 'replies': replies, 'loads': loads}, ensure_ascii=False))
`;

const binding = (command: string, combo: unknown) => ["shortcuts", { bindings: { [command]: combo } }];
const CASES = `[
  ["appearance", {"appZoom": 1.0}], ["appearance", {"appZoom": 1}], ["appearance", {"appZoom": 0.74}], ["appearance", {"appZoom": true}],
  ["appearance", {"appZoom": 1.5}], ["appearance", {"appZoom": 100000000000000000000000}], ["appearance", {"appZoom": "1"}],
  ["appearance", {"fontSize": 12.0}], ["appearance", {"fontSize": 12}], ["appearance", {"fontSize": 25}], ["appearance", {"fontSize": true}],
  ["appearance", {"terminalFontSize": 10}], ["appearance", {"terminalFontSize": 9}], ["appearance", {"terminalFontSize": 24.0}],
  ["appearance", {"tabSize": 2.0}], ["appearance", {"tabSize": 3}], ["appearance", {"tabSize": true}], ["appearance", {"tabSize": "2"}], ["appearance", {"tabSize": 8}],
  ["appearance", {"wordWrap": 1}], ["appearance", {"wordWrap": false}], ["appearance", {"theme": "dark", "colorPalette": "claude"}],
  ["appearance", {"colorPalette": "x"}], ["appearance", {"theme": "neon"}], ["appearance", {"theme": ["dark"]}],
  ["general", {"language": "fr"}], ["general", {"language": "en"}], ["general", {"terminalFontFamily": "Menlo"}], ["general", {"terminalFontFamily": "Arial"}],
  ["general", {"autoScroll": 1}], ["general", {"toolsDryRunEnabled": "true"}], ["general", {"sessionsAutoTitleEnabled": false}],
  ["general", {"toolsCallBudgetLimit": 0}], ["general", {"toolsCallBudgetLimit": 10000}], ["general", {"toolsCallBudgetLimit": 5.0}], ["general", {"toolsCallBudgetLimit": true}],
  ["general", {"taskAutoArchiveOlderThanDays": 7}], ["general", {"taskAutoArchiveOlderThanDays": 7.0}], ["general", {"taskAutoArchiveOlderThanDays": 5}],
  ["general", {"defaultShell": "bash"}], ["general", {"defaultShell": "nonexistent-shell"}], ["general", {"defaultShell": 1}],
  ["browser", {"browserControlEnabled": 0}], ["browser", {"browserControlEnabled": true}], ["agent", {"subagentCancelOneEnabled": null}], ["agent", {"other": 1}],
  ["shortcuts", {"sendShortcut": "mod-enter"}], ["shortcuts", {"sendShortcut": "ctrl-enter"}], ["shortcuts", {"bindings": []}], ["shortcuts", {"bindings": {"nope": "mod+k"}}],
  ${[["new-session", "mod+c"], ["new-session", "Ctrl+Shift+Z"], ["new-session", "Mod+B"], ["find-in-task", "Mod+B"], ["new-session", "enter"], ["insert-newline", "Enter"],
    ["new-session", ""], ["new-session", "|mod+j"], ["new-session", "mod+1|mod+2|mod+3|mod+4|mod+5"], ["new-session", 5], ["new-session", "shift+mod+J"],
    ["new-session", "ctrl+ctrl+j"], ["new-session", "mod+f13"], ["new-session", "mod+f12"], ["new-session", "j"], ["new-session", "cmd+alt+j"], ["new-session", "Meta+N"],
    ["toggle-sidebar", "Ctrl+N"], ["command-palette", "Mod+K | Mod+K"], ["command-palette", "x".repeat(257)], ["session-back", "Alt+Shift+O"], ["new-session", "Mod+Ctrl+F"]]
    .map(([command, combo]) => JSON.stringify(binding(command as string, combo))).join(", ")},
  ["shortcuts", {"shortcutScopes": []}], ["shortcuts", {"shortcutScopes": {"new-session": "global"}}], ["shortcuts", {"shortcutScopes": {"new-session": "pane"}}],
  ["shortcuts", {"shortcutScopes": {"nope": "global"}}], ["other", {"anything": 1}]
]`;

const REQUESTS = `[
  ["GET", "/api/settings", {}],
  ["POST", "/api/settings/appearance", {"values": {"theme": "dark", "appZoom": 1.0, "tabSize": 2.0, "big": 12345678901234567890123, "nested": {"x": [1.0, -0.0, 1e400, 1e-7, 0.1]}}}],
  ["GET", "/api/settings/appearance", {}],
  ["POST", "/api/settings/general", {"values": {"language": "en", "名": "中文 \\u2028 \\ud83d\\ude00"}}],
  ["POST", "/api/settings/general", {"values": {"language": "fr"}}], ["POST", "/api/settings/nope", {"values": {}}],
  ["POST", "/api/settings/general", {"values": []}], ["POST", "/api/settings/general", []], ["POST", "/api/settings/general", {}],
  ["PUT", "/api/settings/general", {}], ["PUT", "/api/settings/nope", {}], ["POST", "/api/settings", {}], ["GET", "/api/settings/general/x", {}], ["GET", "/api/settingsx", {}],
  ["POST", "/api/settings/agent", {"values": {"subagentCancelOneEnabled": true}}], ["get", "/api/settings/agent", {}], ["GET", "/api/settings", {}]
]`;

const FILES = ["ff", "efbbbf7b7d", "5b5d", '{"a": 1, "a": 2}', '{"a": NaN, "b": -Infinity}', "not json", "", '{"a": 1}\r\n', '{"a": "\xc3\x28"}', '{"general": 3}']
  .map((text) => /^[0-9a-f]*$/.test(text) && text.length % 2 === 0 && text !== "" ? text : Buffer.from(text, "latin1").toString("hex"));

const attempt = (call: () => unknown): unknown[] => {
  try { return ["ok", call()]; } catch (error) { return [(error as Error).name, (error as Error).message]; }
};
/** Compare as the Python side's JSON: lossless values print as Python prints them. */
const asPython = (value: unknown): unknown => pyJsonLoads(pyJsonDumps(value));

it("validates, stores and loads settings exactly as Python settings_store", { skip: pythonUnavailableReason() ?? false }, () => {
  const base = mkdtempSync(join(tmpdir(), "xueness-settings-store-")), state = join(base, "ts"), pyState = join(base, "py");
  try {
    const expected = pyJsonLoads(runPython(ORACLE, `{"cases": ${CASES}, "requests": ${REQUESTS}, "files": ${JSON.stringify(FILES)}, "state": ${JSON.stringify(pyState)}}`)) as Record<string, unknown[]>;
    const cases = pyJsonLoads(CASES, { lossless: true }) as [string, Record<string, unknown>][];
    assert.deepEqual(cases.map(([section, values]) => attempt(() => validate(section, values) === values)), expected.validated);
    const requests = pyJsonLoads(REQUESTS, { lossless: true }) as [string, string, Record<string, unknown>][];
    const file = (): string | null => existsSync(join(state, "settings.json")) ? readFileSync(join(state, "settings.json"), "utf8") : null;
    const replies = requests.map(([method, path, data]) => [asPython(attempt(() => dispatchSettings(method, path.split("/").filter(Boolean), data, state))), file()]);
    assert.deepEqual(replies, expected.replies);
    const loads = FILES.map((hex) => {
      writeFileSync(join(state, "settings.json"), Buffer.from(hex, "hex"));
      return asPython(attempt(() => dispatchSettings("GET", ["api", "settings"], {}, state)));
    });
    assert.deepEqual(loads, expected.loads);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
