/** Store parity with `bundled_plugins/remote/plugin.py` (`_validate`, `_load`, `_digest`, `_ssh_*`). */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { JsonFloat, validateManifest } from "@xueness/contracts";
import { pythonUnavailableReason, runPython } from "../../../test-support/python-oracle.ts";
import {
  digest, keepSavedSystem, loadConnections, posixOrThrow, saveConnections, sshArgv, sshEnv, validateConnection, WINDOWS_REMOTE_ERROR,
  type RemoteConnection,
} from "../src/store.ts";

const base = { id: "node", host: "host.example", user: "operator" };
const full: RemoteConnection = { ...base, port: 22, directory: ".", system: "posix" };

function catches(run: () => unknown): { message: string; name: string } | undefined {
  try { run(); return undefined; } catch (error) { const err = error as Error; return { message: err.message, name: err.name }; }
}

function state(): string {
  return mkdtempSync(join(tmpdir(), "remote-store-"));
}

function file(dir: string, bytes: Buffer | string): void {
  writeFileSync(join(dir, "remote-connections.json"), bytes);
}

interface PyResult { ok: boolean; value?: unknown; raw?: unknown; error?: string; type?: string }

function oracle(input: unknown): Record<string, unknown> {
  const code = `
import json, os, re, sys
from xueness.bundled_plugins.remote import plugin as remote

def run(fn):
    try:
        return {"ok": True, "value": fn()}
    except Exception as exc:
        return {"ok": False, "error": str(exc), "type": type(exc).__name__}

def norm(row):
    item = dict(row)
    item.setdefault("port", 22)
    item.setdefault("directory", ".")
    item.setdefault("system", "posix")
    return item

req = json.loads(sys.stdin.read())
out = {"windowsError": remote._WINDOWS_REMOTE_ERROR, "devnull": os.devnull}
out["validate"] = []
for row in req.get("validate", []):
    item = run(lambda row=row: remote._validate(row))
    if item["ok"]:
        item["raw"] = item["value"]
        item["value"] = norm(dict(item["value"]))
    out["validate"].append(item)
out["digests"] = [remote._digest(row) for row in req.get("digests", [])]
out["argv"] = [remote._ssh_argv(item["row"], item["command"]) for item in req.get("argv", [])]
out["posix"] = [run(lambda row=row: remote._require_posix_remote(dict(row))) for row in req.get("posix", [])]
pattern = re.compile("KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL", re.I)
env = req.get("env", {})
out["env"] = {key: value for key, value in env.items() if not pattern.search(key)}
saved = dict(os.environ)
try:
    os.environ.clear()
    os.environ.update(env)
    out["envLive"] = remote._ssh_env()
finally:
    os.environ.clear()
    os.environ.update(saved)
out["keep"] = []
for item in req.get("keep", []):
    previous = item.get("previous")
    kept = remote._keep_saved_system(dict(item["row"]), None if previous is None else dict(previous))
    out["keep"].append({"raw": kept, "norm": norm(dict(kept))})
out["loads"] = []
for directory in req.get("loads", []):
    item = run(lambda directory=directory: remote._load(directory))
    if item["ok"]:
        item["raw"] = item["value"]
        item["value"] = [norm(dict(row)) for row in item["value"]]
    out["loads"].append(item)
print(json.dumps(out, ensure_ascii=False))
`;
  return JSON.parse(runPython(code, JSON.stringify(input))) as Record<string, unknown>;
}

describe("remote connection store", () => {
  it("declares the apiVersion 2 manifest", () => {
    const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8")) as Record<string, unknown>;
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { name: string };
    const checked = validateManifest(manifest);
    assert.deepEqual(checked.issues, []);
    assert.equal(packageJson.name, "@xueness/plugin-remote");
    assert.equal(manifest.version, "0.2.0");
    assert.equal(manifest.defaultEnabled, false);
    assert.deepEqual(manifest.dependencies, []);
    assert.deepEqual(manifest.capabilities, { fs: { read: ["state"], write: ["state"] }, exec: ["*"] });
    assert.deepEqual(manifest.tools, [{ name: "remote_exec", gate: "exec", mutating: true, concurrencySafe: false }]);
    assert.deepEqual(manifest.httpFamilies, ["remote"]);
    assert.deepEqual(manifest.commands, ["remote", "app-server"]);
    assert.equal((manifest.features as unknown[]).length, 19);
  });

  it("fills defaults and rejects the same field mistakes Python names", () => {
    const row = validateConnection(base);
    assert.deepEqual(row, full);
    assert.deepEqual(validateConnection({ ...full, system: "windows" }).system, "windows");
    assert.equal(validateConnection({ ...full, directory: "" }).directory, "");
    assert.equal(validateConnection({ ...full, directory: ".." }).directory, "..");
    assert.equal(validateConnection({ ...full, host: "a".repeat(253), user: `_${"a".repeat(63)}`, id: "a".repeat(64) }).host.length, 253);
    const bad: [unknown, string][] = [
      [null, "invalid remote fields"],
      [[], "invalid remote fields"],
      [{ ...full, shell: "sh" }, "invalid remote fields"],
      [{}, "invalid remote id"],
      [{ ...full, id: "a".repeat(65) }, "invalid remote id"],
      [{ ...full, id: "a.b" }, "invalid remote id"],
      [{ ...full, host: "a".repeat(254) }, "invalid remote host"],
      [{ ...full, host: "-bad" }, "invalid remote host"],
      [{ ...full, host: "a\n" }, "invalid remote host"],
      [{ ...full, user: "9op" }, "invalid remote user"],
      [{ ...full, user: "a".repeat(65) }, "invalid remote user"],
      [{ ...full, port: 0 }, "invalid remote port"],
      [{ ...full, port: 65536 }, "invalid remote port"],
      [{ ...full, port: 1.5 }, "invalid remote port"],
      [{ ...full, port: true }, "invalid remote port"],
      [{ ...full, port: "22" }, "invalid remote port"],
      [{ ...full, port: null }, "invalid remote port"],
      [{ ...full, port: new JsonFloat(22) }, "invalid remote port"],
      [{ ...full, directory: `${"a".repeat(1001)}` }, "invalid remote directory"],
      [{ ...full, directory: "a\0b" }, "invalid remote directory"],
      [{ ...full, directory: 1 }, "invalid remote directory"],
      [{ ...full, system: "cmd" }, "invalid remote system"],
      [{ ...full, system: null }, "invalid remote system"],
    ];
    for (const [input, message] of bad) assert.deepEqual(catches(() => validateConnection(input)), { message, name: "ValueError" }, JSON.stringify(input)?.slice(0, 80));
    assert.equal(validateConnection({ ...full, directory: "😀".repeat(1000) }).directory.length, 2000);
    assert.deepEqual(catches(() => validateConnection({ ...full, directory: "😀".repeat(1001) })), { message: "invalid remote directory", name: "ValueError" });
  });

  it("keeps a stored system only when the incoming object omitted it", () => {
    const previous = validateConnection({ ...full, system: "windows" });
    const omitted = validateConnection(base);
    const kept = keepSavedSystem(omitted, previous, false);
    assert.equal(kept.system, "windows");
    assert.equal(omitted.system, "posix");
    assert.equal(previous.system, "windows");
    assert.equal(keepSavedSystem(validateConnection({ ...full, system: "posix" }), previous, true).system, "posix");
    assert.equal(keepSavedSystem(omitted, undefined, false), omitted);
  });

  it("hashes the six stored fields with Python's compact sorted JSON", () => {
    const text = JSON.stringify({ directory: ".", host: "host.example", id: "node", port: 22, system: "posix", user: "operator" });
    assert.equal(digest(full), createHash("sha256").update(text, "utf8").digest("hex"));
    const fancy = validateConnection({ ...full, directory: "café/项目\u2028" });
    const ascii = JSON.stringify({ ...persisted(fancy) });
    assert.notEqual(digest(fancy), createHash("sha256").update(ascii, "utf8").digest("hex"));
  });

  it("refuses Windows before building ssh argv and filters secret env keys", () => {
    assert.equal(WINDOWS_REMOTE_ERROR.includes("PowerShell"), true);
    assert.deepEqual(catches(() => posixOrThrow(validateConnection({ ...full, system: "windows" }))), { message: WINDOWS_REMOTE_ERROR, name: "ValueError" });
    assert.equal(posixOrThrow(full), undefined);
    assert.deepEqual(catches(() => posixOrThrow({ ...full, system: "cmd" as "posix" })), { message: "invalid remote system", name: "ValueError" });
    const argv = sshArgv({ ...full, port: 2222 }, "echo a&b");
    assert.deepEqual(argv.slice(0, 3), ["ssh", "-F", process.platform === "win32" ? "nul" : "/dev/null"]);
    assert.equal(argv.includes("StrictHostKeyChecking=no"), false);
    assert.equal(argv.at(-2), "operator@host.example");
    assert.equal(argv.at(-1), "echo a&b");
    assert.equal(argv.at(-3), "2222");
    const filtered = sshEnv({ PATH: "/bin", EMPTY: "", API_KEY: "s", token: "t", keyboard: "k", mouse: "m", OK: "1", GONE: undefined });
    assert.deepEqual(filtered, { PATH: "/bin", EMPTY: "", mouse: "m", OK: "1" });
    filtered.PATH = "changed";
    assert.equal(sshEnv({ PATH: "/bin" }).PATH, "/bin");
  });

  it("loads and atomically saves the state file", () => {
    const dir = state();
    try {
      assert.deepEqual(loadConnections(dir), []);
      assert.equal(existsSync(join(dir, "remote-connections.json")), false);
      const windows = validateConnection({ ...full, id: "win", system: "windows", directory: "srv/my project" });
      saveConnections(dir, [full, windows]);
      assert.deepEqual(loadConnections(dir), [full, windows]);
      assert.equal(readdirSync(dir).some((name) => name.startsWith(".resource-")), false);
      file(dir, Buffer.concat([Buffer.from("[]"), Buffer.alloc(100_000 - 2, 0x20)]));
      assert.deepEqual(loadConnections(dir), []);
      file(dir, Buffer.concat([Buffer.from("[]"), Buffer.alloc(100_001 - 2, 0x20)]));
      assert.deepEqual(catches(() => loadConnections(dir)), { message: "remote configuration too large", name: "ValueError" });
      file(dir, "{}");
      assert.deepEqual(catches(() => loadConnections(dir)), { message: "invalid remote configuration", name: "ValueError" });
      file(dir, JSON.stringify([full, full]));
      assert.deepEqual(catches(() => loadConnections(dir)), { message: "duplicate remote connection id", name: "ValueError" });
      file(dir, JSON.stringify(Array.from({ length: 101 }, (_, index) => ({ ...full, id: `n${index}` }))));
      assert.deepEqual(catches(() => loadConnections(dir)), { message: "invalid remote configuration", name: "ValueError" });
      file(dir, JSON.stringify([{ ...full, port: 22.0 }]).replace("22", "22.0"));
      assert.deepEqual(catches(() => loadConnections(dir)), { message: "invalid remote port", name: "ValueError" });
      file(dir, JSON.stringify([{ id: "node", host: "host.example", user: "operator", port: 22, directory: "." }]));
      assert.deepEqual(loadConnections(dir), [full]);
      mkdirSync(join(dir, "nested"));
      rmSync(join(dir, "remote-connections.json"));
      mkdirSync(join(dir, "remote-connections.json"));
      assert.deepEqual(catches(() => loadConnections(dir)), { message: "remote state must be a regular file", name: "ValueError" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not replace a symlinked state file", (t) => {
    const dir = state();
    const target = join(dir, "real.json");
    const link = join(dir, "remote-connections.json");
    try {
      writeFileSync(target, "SECRET");
      try { symlinkSync(target, link); } catch (error) { t.skip(`symlink unavailable: ${(error as Error).message}`); return; }
      assert.deepEqual(catches(() => loadConnections(dir)), { message: "remote state symlink denied", name: "ValueError" });
      assert.deepEqual(catches(() => saveConnections(dir, [full])), { message: "remote state symlink denied", name: "ValueError" });
      assert.equal(readFileSync(target, "utf8"), "SECRET");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function persisted(row: RemoteConnection): Record<string, unknown> {
  return { directory: row.directory, host: row.host, id: row.id, port: row.port, system: row.system, user: row.user };
}

describe("remote store python oracle", { skip: pythonUnavailableReason() ?? false }, () => {
  it("matches validation, digest, argv, env and load errors", () => {
    const fancy = "café/项目\u2028😀 \"\\\\";
    const omitted = { id: "node", host: "host.example", user: "operator", port: 22, directory: "." };
    const validate: unknown[] = [
      base,
      full,
      { ...full, system: "windows", directory: "/srv/my project" },
      { ...full, directory: fancy },
      { ...full, directory: "😀".repeat(1000) },
      { ...full, directory: "" },
      { ...full, host: "a".repeat(253), id: "a".repeat(64), user: `_${"b".repeat(63)}` },
      { ...full, shell: "powershell" },
      { ...full, system: "cmd" },
      { ...full, port: 22.5 },
      { ...full, port: true },
      { ...full, port: 0 },
      { ...full, port: 65535 },
      { ...full, host: "a\n" },
      { ...full, directory: "a\0b" },
      { ...full, directory: "😀".repeat(1001) },
      [],
      null,
      { ...full, id: "" },
    ];
    const env = { PATH: "/bin", EMPTY: "", API_KEY: "s", XTOKEN: "t", SECRET_X: "s", db_password: "p", CREDENTIAL: "c", keyboard: "k", mouse: "m", PLAIN: "ok" };
    const missing = state();
    const good = state();
    const bare = state();
    const huge = state();
    const shape = state();
    const duplicate = state();
    const many = state();
    const broken = state();
    const floatPort = state();
    const linked = state();
    const dirs = [missing, good, bare, huge, shape, duplicate, many, broken, floatPort, linked];
    let symlink = true;
    try {
      file(good, JSON.stringify([full, { ...full, id: "win", system: "windows" }]));
      file(bare, JSON.stringify([omitted]));
      file(huge, Buffer.alloc(100_001, 0x20));
      file(shape, "{");
      file(duplicate, JSON.stringify([full, { ...full }]));
      file(many, JSON.stringify(Array.from({ length: 101 }, (_, index) => ({ ...full, id: `n${index}` }))));
      file(broken, "[,]");
      file(floatPort, "[{\"id\":\"node\",\"host\":\"host.example\",\"user\":\"operator\",\"port\":22.0,\"directory\":\".\"}]");
      try {
        writeFileSync(join(linked, "real.json"), "[]");
        symlinkSync(join(linked, "real.json"), join(linked, "remote-connections.json"), "file");
      } catch { symlink = false; }
      const py = oracle({
        validate,
        digests: [full, omitted, validateConnection({ ...full, directory: fancy }), { ...omitted, system: "posix" }],
        argv: [{ row: { ...full, port: 2222 }, command: "echo a&b" }],
        posix: [{ ...full, system: "windows" }, full, { ...full, system: "cmd" }],
        env,
        keep: [
          { row: omitted, previous: { ...omitted, system: "windows" } },
          { row: { ...omitted, system: "posix" }, previous: { ...omitted, system: "windows" } },
          { row: omitted, previous: null },
        ],
        loads: symlink ? dirs : dirs.slice(0, -1),
      });
      assert.equal(py.windowsError, WINDOWS_REMOTE_ERROR);
      assert.equal(py.devnull, process.platform === "win32" ? "nul" : "/dev/null");
      (py.validate as PyResult[]).forEach((item, index) => {
        const input = validate[index];
        if (item.ok) assert.deepEqual(validateConnection(input), item.value, JSON.stringify(input).slice(0, 80));
        else assert.deepEqual(catches(() => validateConnection(input)), { message: item.error, name: "ValueError" }, JSON.stringify(input)?.slice(0, 120));
      });
      const digests = py.digests as string[];
      assert.equal(digest(full), digests[0]);
      assert.equal(digest(validateConnection(omitted)), digests[1]);
      assert.equal(digest(validateConnection({ ...full, directory: fancy })), digests[2]);
      assert.equal(digest(validateConnection({ ...omitted, system: "posix" })), digests[3]);
      assert.deepEqual(sshArgv({ ...full, port: 2222 }, "echo a&b"), (py.argv as string[][])[0]);
      const posix = py.posix as PyResult[];
      assert.equal(posix[0]?.error, WINDOWS_REMOTE_ERROR);
      assert.equal(posix[1]?.ok, true);
      assert.equal(posix[2]?.error, "invalid remote system");
      assert.deepEqual(sshEnv(env), py.env);
      // Windows `os.environ` folds key names to upper case, so the live-oracle read cannot
      // preserve the synthetic lower-case keys. Compare case-insensitively there only.
      const foldKeys = (record: Record<string, string>): Record<string, string> =>
        process.platform === "win32" ? Object.fromEntries(Object.entries(record).map(([key, value]) => [key.toUpperCase(), value])) : record;
      assert.deepEqual(foldKeys(sshEnv(env)), foldKeys(py.envLive as Record<string, string>));
      const keep = py.keep as { norm: RemoteConnection }[];
      assert.equal(keepSavedSystem(validateConnection(omitted), validateConnection({ ...full, system: "windows" }), false).system, keep[0]?.norm.system);
      assert.equal(keepSavedSystem(validateConnection({ ...omitted, system: "posix" }), validateConnection({ ...full, system: "windows" }), true).system, "posix");
      assert.equal(keep[1]?.norm.system, "posix");
      assert.equal(keepSavedSystem(validateConnection(omitted), undefined, false).system, keep[2]?.norm.system);
      const loads = py.loads as PyResult[];
      assert.deepEqual(loadConnections(missing), loads[0]?.value);
      assert.deepEqual(loadConnections(good), loads[1]?.value);
      assert.deepEqual(loadConnections(bare), loads[2]?.value);
      assert.equal((loads[2]?.raw as { system?: string }[])[0]?.system, undefined);
      for (const [index, dir] of [huge, shape, duplicate, many, broken, floatPort].entries()) {
        assert.deepEqual(catches(() => loadConnections(dir)), { message: loads[index + 3]?.error, name: loads[index + 3]?.type === "JSONDecodeError" ? "JSONDecodeError" : "ValueError" }, String(loads[index + 3]?.error));
      }
      if (symlink) assert.deepEqual(catches(() => loadConnections(linked)), { message: loads[9]?.error, name: "ValueError" });
    } finally {
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    }
  });
});
