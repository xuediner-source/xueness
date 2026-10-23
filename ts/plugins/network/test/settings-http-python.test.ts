/** Settings and diagnostics HTTP against `settings_api.dispatch` and the bytes `update_settings` writes. No live search calls. */
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { describe, it } from "node:test";
import { pyJsonDumps } from "@xueness/contracts";
import { pythonUnavailableReason, runPython } from "../../../test-support/python-oracle.ts";
import { createNetworkHttp, NetworkError, type Net } from "../src/index.ts";

const SETTINGS = ["api", "network", "settings"];
const DIAGNOSTICS = ["api", "network", "diagnostics"];
const endpoint = "https://search.example/v1/search";
const messy = JSON.stringify({ extra: "drop", apiKey: "leak", searchEndpoints: { bing: "https://nope.example/s", tavily: "https://old.example/search", brave: 1 }, searchEndpoint: "https://legacy.example/search", dohEndpoint: "https://dns.example/dns-query", searchMode: "service", imageSearchEndpoint: "" });

interface Step { method: string; parts: string[]; data?: unknown; query?: Record<string, unknown> }
interface Case { name: string; env?: Record<string, string>; files?: Record<string, string>; steps: Step[] }
interface Outcome { status?: number | null; json?: string; error?: string; message?: string; code?: string | null }
interface PythonCase { steps: Outcome[]; files: Record<string, string> }

const step = (method: string, parts: string[], data: unknown = {}, query?: Record<string, unknown>): Step => ({ method, parts, data, ...(query ? { query } : {}) });
const settings = (method: string, data: unknown = {}, query?: Record<string, unknown>): Step => step(method, SETTINGS, data, query);
const diagnostics = (data: unknown, method = "POST"): Step => step(method, DIAGNOSTICS, data);

const CASES: Case[] = [
  { name: "methods", steps: [settings("GET", null, { ignored: "1" }), settings("get"), settings("PUT", {}), settings("post", { nope: 1 }), diagnostics({ operation: "dns" }, "GET"), diagnostics({}), diagnostics({ operation: "dns", extra: 1 }), diagnostics({ operation: "nope" }), diagnostics({ operation: null }), step("GET", ["api", "network", "other"]), step("POST", ["api", "network"])] },
  { name: "empty-post", steps: [settings("POST", {})] },
  { name: "validation", steps: [null, [], "x", { nope: true }, { clearSearchKey: 1 }, { clearSearchModelKey: "yes" }, { searchKey: 1 }, { searchModelKey: "a\nb" }, { searchKey: "k".repeat(4097) }, { searchMode: "both" }, { searchProvider: "bing" }, { searchEndpoint: "  " }, { searchEndpoint: "http://search.example/s" }, { searchEndpoint: "https://user:pw@search.example/s" }, { searchEndpoint: "https://search.example:444/s" }, { searchEndpoint: "https://127.0.0.1/s" }, { searchEndpoint: "https://localhost/s" }, { searchEndpoint: "https://" + "a".repeat(2040) + ".example/s" }, { imageSearchEndpoint: 1 }, { imageSearchEndpoint: "https://192.168.1.7/images" }, { searchModelEndpoint: "https://10.0.0.2/v1" }, { searchModel: "bad\nname" }, { searchModel: "m".repeat(201) }, { dohEndpoint: 1 }, { dohEndpoint: "https://dns.example/dns-query?x=1" }, { dohEndpoint: "https://dns.example" }, { dohEndpoint: "https://[::1]/dns-query" }].map((data) => settings("POST", data)) },
  { name: "save-clear-rewrite", steps: [settings("POST", { searchEndpoint: endpoint, imageSearchEndpoint: "https://images.example/v1", dohEndpoint: "https://dns.example/dns-query", searchMode: "model", searchModelEndpoint: "https://models.example/v1/chat/completions", searchModel: " 搜索模型 ", searchKey: "密钥\"\\", searchModelKey: "模型密钥" }), settings("POST", { searchKey: "", searchModelKey: "" }), settings("POST", { clearSearchKey: false, clearSearchModelKey: false }), settings("POST", { clearSearchKey: true, clearSearchModelKey: true }), settings("POST", { searchEndpoint: "https://search.example/v2/search", searchMode: "service" })] },
  { name: "provider-switch", steps: [settings("POST", { searchProvider: "brave", searchEndpoint: "https://brave.example/search", searchKey: "brave-key" }), settings("POST", { searchProvider: "tavily", searchEndpoint: "https://tavily.example/search", searchKey: "tavily-key" })] },
  { name: "env-tavily", env: { XUENESS_SEARCH_PROVIDER: "tavily", XUENESS_TAVILY_SEARCH_KEY: "env-key", XUENESS_SEARCH_ENDPOINT: "https://env.example/search" }, steps: [settings("GET"), settings("POST", { searchKey: "saved-key" })] },
  { name: "searxng-ignores-key", steps: [settings("POST", { searchProvider: "searxng", searchEndpoint: "https://sx.example/search", searchKey: "ignored", clearSearchKey: true })] },
  { name: "rewrite-preserves-order", files: { "network/settings.json": messy }, steps: [settings("POST", { searchEndpoint: "https://new.example/search" })] },
  { name: "invalid-file", files: { "network/settings.json": "{not json" }, steps: [settings("GET"), settings("POST", { searchMode: "service" }), diagnostics({ operation: "dns" })] },
  { name: "bad-provider", files: { "network/settings.json": "{\"searchProvider\":\"bing\"}" }, steps: [settings("GET"), settings("POST", {}), diagnostics({ operation: "search" })] },
  { name: "diagnostics-offline", steps: [diagnostics({ operation: "search" }), settings("POST", { searchMode: "model" }), diagnostics({ operation: "dns" }), settings("POST", { searchModelEndpoint: "https://models.example/v1/chat/completions", searchModel: "web" }), diagnostics({ operation: "search" })] },
  { name: "network-is-file", files: { network: "x" }, steps: [settings("GET"), settings("POST", {})] },
];

function snapshot(root: string): Record<string, string> {
  const directory = join(root, "network");
  if (!existsSync(directory)) return {};
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) return info.isSymbolicLink() ? {} : { network: readFileSync(directory).toString("utf8") };
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const entry = lstatSync(path);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(path); else out[relative(root, path).replaceAll("\\", "/")] = readFileSync(path).toString("utf8");
    }
  };
  walk(directory);
  return out;
}

function plant(root: string, files: Record<string, string> | undefined): void {
  mkdirSync(root, { recursive: true });
  for (const [name, text] of Object.entries(files ?? {})) { const path = join(root, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
}

async function runTs(state: string, item: Case): Promise<{ steps: Outcome[]; files: Record<string, string> }> {
  const api = createNetworkHttp({ stateDir: state, enabled: () => true, env: item.env ?? {} });
  const steps: Outcome[] = [];
  for (const entry of item.steps) {
    try {
      const result = await api.dispatch(entry.method, entry.parts, entry.query ?? {}, entry.data);
      steps.push(result === null ? { status: null } : { status: result[0], json: pyJsonDumps(result[1]) });
    } catch (error) {
      steps.push({ error: error instanceof NetworkError ? "NetworkError" : error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error), code: error instanceof NetworkError ? error.code : null });
    }
  }
  return { steps, files: snapshot(state) };
}

const ORACLE = String.raw`
import base64, json, os, sys
from pathlib import Path
from unittest import mock
from xueness.bundled_plugins.network import settings_api

def snapshot(root):
    net = Path(root) / "network"
    if not net.exists() or net.is_symlink(): return {}
    if net.is_file(): return {"network": net.read_text(encoding="utf-8")}
    out = {}
    for path in net.rglob("*"):
        if path.is_file() and not path.is_symlink(): out[path.relative_to(root).as_posix()] = path.read_text(encoding="utf-8")
    return out

def one(case):
    root = Path(case["state"]); root.mkdir(parents=True, exist_ok=True)
    for name, payload in (case.get("files") or {}).items():
        dest = root / name; dest.parent.mkdir(parents=True, exist_ok=True); dest.write_bytes(base64.b64decode(payload))
    env = {k: v for k, v in os.environ.items() if not k.startswith("XUENESS_")}
    env.update(case.get("env") or {})
    steps = []
    with mock.patch.dict(os.environ, env, clear=True):
        for entry in case["steps"]:
            try:
                result = settings_api.dispatch(entry["method"], entry["parts"], entry.get("query") or {}, entry.get("data"), {"state_dir": str(root)})
                steps.append({"status": None} if result is None else {"status": result[0], "json": json.dumps(result[1], ensure_ascii=False)})
            except Exception as exc:
                steps.append({"error": type(exc).__name__, "message": str(exc), "code": getattr(exc, "error_code", None)})
    return {"steps": steps, "files": snapshot(root)}

sys.stdout.write(json.dumps([one(case) for case in json.loads(sys.stdin.read())], ensure_ascii=False))
`;

describe("network settings HTTP", () => {
  it("owns only the two routes, refuses a disabled plugin, and resolves dns on a stub", async () => {
    const state = mkdtempSync(join(tmpdir(), "xueness-net-http-"));
    const requests: string[] = [];
    const net: Net = { async lookup(host) { assert.equal(host, "api.search.brave.com"); return ["8.8.8.8", "8.8.8.8"]; }, async request() { requests.push("http"); throw new Error("unexpected connection"); } };
    try {
      const api = createNetworkHttp({ stateDir: state, enabled: true, env: {}, net });
      assert.equal(api.owns("GET", SETTINGS), true);
      assert.equal(api.owns("POST", DIAGNOSTICS), true);
      assert.equal(api.owns("GET", ["api", "network"]), false);
      assert.equal(api.owns("GET", ["api", "network", "settings", "extra"]), false);
      assert.equal(await api.dispatch("GET", ["api", "other"], {}, {}), null);
      assert.deepEqual(await api.dispatch("POST", DIAGNOSTICS, {}, { operation: "dns" }), [200, { ok: true, operation: "dns", host: "api.search.brave.com", addressCount: 1, dnsSource: "system", message: "目标 DNS 解析正常；未连接搜索服务或模型接口。" }]);
      assert.deepEqual(requests, []);
      const disabled = createNetworkHttp({ stateDir: state, enabled: () => false, env: {} });
      assert.equal(disabled.owns("POST", SETTINGS), true);
      assert.deepEqual(await disabled.dispatch("PUT", SETTINGS, {}, {}), [403, { error: "plugin disabled or dependency unavailable: network", plugin: "network" }]);
      assert.equal(await disabled.dispatch("GET", ["api", "network", "nope"], {}, {}), null);
    } finally { rmSync(state, { recursive: true, force: true }); }
  });

  const skip = pythonUnavailableReason() ?? false;
  it("matches Python validation, responses and persisted files", { skip }, async () => {
    const root = mkdtempSync(join(tmpdir(), "xueness-net-http-"));
    try {
      const prepared = CASES.map((item, index) => ({ ...item, py: join(root, "py" + index), ts: join(root, "ts" + index) }));
      const encoded = prepared.map((item) => ({ state: item.py, env: item.env ?? {}, files: Object.fromEntries(Object.entries(item.files ?? {}).map(([name, text]) => [name, Buffer.from(text, "utf8").toString("base64")])), steps: item.steps }));
      const python = JSON.parse(runPython(ORACLE, JSON.stringify(encoded))) as PythonCase[];
      for (let index = 0; index < prepared.length; index += 1) {
        const item = prepared[index]!, expect = python[index]!;
        plant(item.ts, item.files);
        const actual = await runTs(item.ts, item);
        assert.deepEqual(actual.steps, expect.steps, item.name);
        assert.deepEqual(actual.files, expect.files, item.name + " files");
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
