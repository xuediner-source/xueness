/** Differential tests: command discovery, expansion and the resource store against the Python oracle. */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { isDict, pyJsonDumps, pyJsonLoads } from "@xueness/contracts";
import { resourceDispatch } from "@xueness/sessions";
import { PROJECT_ROOT, pythonUnavailableReason, runPython } from "../../../test-support/python-oracle.ts";
import { expandCommand, listAll, loadCommands } from "../src/index.ts";
import { commandFixture, manifestCommands } from "./fixture.ts";

const skip = pythonUnavailableReason();
const TEXTS = ["/review a b", '/review "a b" c', "/res1 x y", "/init notes here", "/init", "/help", "/nope", "/ns:deep z", "/review", "/content q", "not a command",
  "/review\u00a0x\u3000y", "/plain extra args", "/float", "/compat-only one", "/user-cmd u1 u2", "/review $1 $ARGUMENTS", "/git x", "/Upper", "/review\n", "/" + "a".repeat(65)];
const LIST_PY = `
import json, sys
from pathlib import Path
from xueness.bundled_plugins.commands import commands
a = json.loads(sys.stdin.read())
out = {lang or "default": commands.list_all(a["state"], Path(a["root"]), language=lang or None) for lang in ["", "en", "zh-CN", "fr"]}
out["noroot"] = commands.list_all(a["state"], None)
loaded = commands.load(a["state"], Path(a["root"]), language="en")
out["load"] = loaded
out["expand"] = [list(commands.expand(loaded, t)) for t in a["texts"]]
print(json.dumps(out, ensure_ascii=False))
`;
const builtinNeutral = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(builtinNeutral);
  if (!isDict(value)) return value;
  const out = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, builtinNeutral(item)]));
  return value.source === "builtin" ? { ...out, path: "<builtin>", directory: "<builtin>" } : out;
};

describe("commands match Python", { skip: skip ?? false }, () => {
  const fixture = commandFixture();
  after(() => rmSync(fixture.base, { recursive: true, force: true }));
  it("lists, loads and expands every family the same way", () => {
    const root = realpathSync(fixture.root), env = { ...process.env, XUENESS_LANGUAGE: "" };
    const python = pyJsonLoads(runPython(LIST_PY, JSON.stringify({ state: fixture.state, root, texts: TEXTS })), { lossless: true }) as Record<string, unknown>;
    const scope = { stateDir: fixture.state, root, manifestCommands: manifestCommands(PROJECT_ROOT), env };
    const ours: Record<string, unknown> = {};
    for (const lang of ["", "en", "zh-CN", "fr"]) ours[lang || "default"] = listAll({ ...scope, language: lang });
    ours.noroot = listAll({ ...scope, root: null });
    const loaded = loadCommands({ ...scope, language: "en" });
    ours.load = loaded;
    ours.expand = TEXTS.map((text) => expandCommand(loaded, text, env));
    for (const key of Object.keys(python)) assert.equal(pyJsonDumps(builtinNeutral(ours[key])), pyJsonDumps(builtinNeutral(python[key])), key);
  });
});

const CRUD: [string, string[], unknown][] = [
  ["GET", [], {}], ["POST", [], { id: "a", prompt: "x", createOnly: true, n: 1 }], ["POST", [], { id: "a", createOnly: true }], ["POST", [], { id: "a", prompt: "y", createdAt: "spoof" }],
  ["POST", [], { id: "bad/id" }], ["POST", [], { id: "b", createOnly: "yes" }], ["POST", [], { id: "..x" }], ["PATCH", ["a"], { prompt: "z", id: "a", updatedAt: "spoof" }], ["PATCH", ["a"], { id: "b" }],
  ["PATCH", ["missing"], { prompt: "m" }], ["PATCH", ["bad%20id"], {}], ["PUT", [], { items: [{ id: "c", prompt: "c", createdAt: "x" }, { id: "a", prompt: "a2" }] }], ["PUT", [], { items: [{ id: "x" }, { id: "x" }] }],
  ["PUT", [], { items: [{ prompt: "no id" }] }], ["PUT", [], { items: [{ id: 5 }] }], ["PUT", [], { items: "no" }], ["PUT", [], { items: [7] }], ["DELETE", ["c"], {}], ["DELETE", ["c"], {}], ["DELETE", [".."], {}], ["GET", [], {}],
];
const CRUD_PY = `
import json, sys
from pathlib import Path
from xueness import resources
a = json.loads(sys.stdin.read())
out = []
for method, extra, body in a["ops"]:
    out.append(list(resources.dispatch(method, ["api", "resources", "commands", *extra], {}, json.loads(body), {"state_dir": Path(a["state"])})))
print(json.dumps(out, ensure_ascii=False))
`;
const timeless = (text: string): string => text.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{6})?\+00:00/g, "<time>").replaceAll(/"(createdAt|updatedAt)": "<time>"/g, '"$1": "<time>"');

describe("resource store matches Python", { skip: skip ?? false }, () => {
  const base = mkdtempSync(join(tmpdir(), "xueness-resources-"));
  after(() => rmSync(base, { recursive: true, force: true }));
  it("answers every CRUD step identically and keeps Python's numbers", () => {
    const python = runPython(CRUD_PY, JSON.stringify({ state: join(base, "py"), ops: CRUD.map(([method, extra, body]) => [method, extra, JSON.stringify(body).replace('"n":1', '"n":1.0')]) }));
    const ours = CRUD.map(([method, extra, body]) => resourceDispatch(join(base, "ts"), method, ["api", "resources", "commands", ...extra], pyJsonLoads(JSON.stringify(body).replace('"n":1', '"n":1.0'), { lossless: true })));
    assert.equal(timeless(pyJsonDumps(ours)), timeless(python.trim()));
    assert.match(pyJsonDumps(ours), /"n": 1\.0/);
  });
  it("refuses a linked resource root", { skip: process.platform === "win32" }, () => {
    const state = join(base, "linked"); mkdirSync(join(base, "elsewhere"), { recursive: true }); mkdirSync(state, { recursive: true });
    symlinkSync(join(base, "elsewhere"), join(state, "resources"));
    assert.deepEqual(resourceDispatch(state, "GET", ["api", "resources", "commands"], {}), [400, { error: "resource root must not be a link or reparse point" }]);
    assert.deepEqual(resourceDispatch(state, "POST", ["api", "resources", "commands"], { id: "a" }), [400, { error: "invalid resource id" }]);
    assert.deepEqual(resourceDispatch(state, "GET", ["api", "resources", "nope"], {}), [404, { error: "unknown resource kind: nope" }]);
  });
});
