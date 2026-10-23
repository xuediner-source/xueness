/** Differential tests: the TypeScript composer and command owners answer as Python's `composer_api` and `files_api`. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { listLevel } from "@xueness/plugin-files";
import { createProvidersApi } from "@xueness/plugin-providers";
import { createSettingsApi, declaredWorkspaceRoots } from "@xueness/plugin-settings";
import { listAll } from "@xueness/plugin-skills";
import { SessionStore } from "@xueness/sessions";
import { createComposerFeatures } from "../src/composer-features.ts";
import { effectivePlugins } from "../src/plugin-state.ts";
import { PROJECT_ROOT, pythonUnavailableReason, runPythonAsync } from "../../../test-support/python-oracle.ts";

type Row = Record<string, unknown>;
type Call = [string, string[], Record<string, string[]>, unknown];
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");
/** Built-in command rows name their own source file; only that location differs by design. */
const neutral = (value: unknown): unknown => Array.isArray(value) ? value.map(neutral) : value && typeof value === "object"
  ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, (value as Row).source === "builtin" && (key === "path" || key === "directory") ? "<builtin>" : neutral(item)])) : value;
const ORACLE = `
import json, sys
from pathlib import Path
from xueness import web
from xueness.bundled_plugins.sessions import composer_api
from xueness.bundled_plugins.commands import files_api
d = json.load(sys.stdin)
ctx = web.build_context(Path(d['state']), Path(d['runs']), Path(d['root']), allow_real=True, workspace_roots=[d['root']])
ctx['running'].update(d['running'])
out, last = [], ''
for method, parts, query, data in d['calls']:
    if method == 'CONSUME':
        try: reply = [200, composer_api.consume_prepared(ctx, last, Path(data['root']))]
        except ValueError as exc: reply = [400, {'error': str(exc)}]
    elif method == 'EXPAND':
        status, body = composer_api.dispatch('POST', ['api', 'composer', 'expand-command'], {}, data, ctx)
        reply = [200, body] if status == 200 else [400, {'error': body['error']}]
    else:
        status, body = (files_api if parts[1] == 'resources' else composer_api).dispatch(method, parts, query, data, ctx)
        if status == 200 and isinstance(body, dict) and 'token' in body: last, body = body['token'], {**body, 'token': ''}
        reply = [status, body]
    out.append(reply)
print(json.dumps(out))
`;

describe("composer and commands owners match Python", { skip: pythonUnavailableReason() ?? false }, () => {
  let base: string, root: string, state: string, runs: string, other: string, sid: string, skill: string;
  let features: ReturnType<typeof createComposerFeatures>;
  const running = new Set<string>();
  const git = (...args: string[]): string => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", ...args], { cwd: root, encoding: "utf8" });
  before(async () => {
    for (const key of ["XUENESS_WORKSPACE_ROOTS", "XUENESS_PROVIDER"]) delete process.env[key];
    Object.assign(process.env, { XUENESS_API_BASE: "https://models.example.test/v1", XUENESS_MODEL: "env-model", XUENESS_API_KEY: "env-key" });
    base = mkdtempSync(join(tmpdir(), "xue-composer-")); root = join(base, "ws"); state = join(base, "state"); runs = join(base, "runs"); other = join(base, "other");
    const put = (path: string, text: string): void => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); };
    put(join(root, "a.txt"), "alpha 中 text\n"); put(join(root, "src", "main.ts"), "export const x = 1;\n"); put(join(root, "node_modules", "x.js"), "ignored\n");
    put(join(root, "docs", "读我.md"), "# docs\n"); put(join(root, ".xueness", "commands", "review.md"), "---\ndescription: Review\n---\nReview $1 with focus $2.\n");
    put(join(state, "skills", "gamma", "SKILL.md"), "---\nname: gamma\ndescription: User gamma\n---\ngamma body\n");
    mkdirSync(runs, { recursive: true }); mkdirSync(other, { recursive: true });
    git("init", "-q", "-b", "main"); git("add", "-A"); git("commit", "-q", "-m", "init"); git("branch", "feature");
    const store = new SessionStore(state);
    mkdirSync(store.directory, { recursive: true });
    sid = "a".repeat(32);
    const session = (id: string, at: string, title: string): void => writeFileSync(store.pathFor(id), JSON.stringify({ id, task: title, title, root: at, status: "done",
      messages: [{ role: "user", content: "earlier question" }, { role: "assistant", content: "earlier answer 中" }] }));
    session(sid, root, "First session"); session("b".repeat(32), other, "Elsewhere"); session("c".repeat(32), root, "");
    put(join(state, "workflows", "d".repeat(32) + ".json"), JSON.stringify({ id: "d".repeat(32), status: "running", created_at: "x", updated_at: "x", root, concurrency: 1, plan: { name: "p" } }));
    const enabled = effectivePlugins(PROJECT_ROOT, state);
    const providers = createProvidersApi({ stateDir: state, enabled, allowReal: true });
    for (const profile of [{ id: "local", name: "Local", baseUrl: "https://local.example.test/v1", model: "fixture", apiKey: "k" },
      { id: "vision", name: "Vision", baseUrl: "https://vision.example.test/v1", model: "gpt-5", apiKey: "k", capabilities: ["image"], reasoningLevels: ["low", "high"] }]) {
      const saved = await providers.dispatch("POST", ["api", "providers"], {}, profile) as [number, unknown];
      assert.equal(saved[0], 200, JSON.stringify(saved));
    }
    const settings = createSettingsApi({ stateDir: state, projectDir: root, webRuns: runs, enabled, listLevel, declaredRoots: declaredWorkspaceRoots([root], "", base), maxEntries: 1000, desktop: false });
    const allowedRoots = (): string[] => settings.workspaces.allowedRoots();
    features = createComposerFeatures({ projectRoot: PROJECT_ROOT, projectDir: root, stateDir: state, webRuns: runs, store, providers: providers.store, running, enabled, allowedRoots,
      defaultRoot: () => settings.workspaces.defaultRoot(allowedRoots()), allowReal: true, env: process.env, bundledSkills: null });
    skill = String(listAll(state, null, true, null).skills.find((row) => row.name === "gamma")?.id);
  });
  after(() => { if (base) rmSync(base, { recursive: true, force: true }); });

  async function ours(calls: Call[]): Promise<unknown[]> {
    const out: unknown[] = []; let last = "";
    for (const [method, parts, query, data] of calls) {
      const body = data as Row;
      if (method === "CONSUME" || method === "EXPAND") {
        try { out.push([200, method === "CONSUME" ? await features.composer.consumePrepared(last, body.root as string) : await features.composer.expandCommands(body.text as string, body.root as string)]); }
        catch (error) { out.push([400, { error: (error as Error).message }]); }
        continue;
      }
      const reply = await (parts[1] === "resources" ? features.commands : features.composer).dispatch(method, parts, query, data) as [number, Row];
      if (reply[0] === 200 && typeof reply[1].token === "string") { last = reply[1].token; reply[1] = { ...reply[1], token: "" }; }
      out.push(reply);
    }
    return JSON.parse(JSON.stringify(out));
  }
  const python = async (calls: Call[], active: string[] = []): Promise<unknown[]> => JSON.parse(await runPythonAsync(ORACLE, JSON.stringify({ state, runs, root, running: active, calls })));
  const same = async (calls: Call[], active: string[] = []): Promise<unknown[]> => {
    running.clear(); for (const id of active) running.add(id);
    const actual = neutral(await ours(calls)) as unknown[], expected = neutral(await python(calls, active)) as unknown[];
    calls.forEach((call, index) => assert.equal(JSON.stringify(actual[index]), JSON.stringify(expected[index]), JSON.stringify(call).slice(0, 300)));
    return actual;
  };

  it("lists the catalogue and command files identically", async () => {
    const files = ["api", "resources", "commands", "files"], G = (query: Record<string, string[]>): Call => ["GET", ["api", "composer"], query, {}];
    const replies = await same([G({ root: [root] }), G({ session_id: [sid] }), G({}), G({ root: ["/etc"] }), G({ session_id: ["nothex"] }), G({ session_id: ["f".repeat(32)] }), G({ root: [runs] }),
      ["POST", ["api", "composer"], {}, {}], ["GET", files, { root: [root], language: ["en"] }, {}], ["GET", files, { root: ["/etc"] }, {}], ["GET", files, {}, {}], ["POST", files, {}, {}]]);
    const catalog = (replies[0] as [number, Row])[1];
    assert.deepEqual((catalog.sessions as Row[]).map((row) => row.id), [sid, "c".repeat(32)]);
    assert.equal(catalog.backgroundCount, 1); assert.deepEqual(catalog.git, { branch: "main", branches: ["feature", "main"] });
    assert((catalog.models as Row[]).some((row) => row.id === "") && (catalog.files as Row[]).every((row) => !String(row.path).includes("node_modules")));
  });

  it("prepares, refuses and consumes drafts identically", async () => {
    const P = (data: unknown): Call => ["POST", ["api", "composer", "prepare"], {}, data];
    const t = { text: "t", root, provider_id: "local" };
    const replies = await same([
      P({ text: "Plain task", root, provider_id: "local" }), ["CONSUME", [], {}, { root }], ["CONSUME", [], {}, { root }],
      P({ text: "  /review a.txt speed  ", root, provider_id: "local", input: { files: ["a.txt", "src/main.ts"], sessions: [sid], skills: [skill], plugins: ["git"], capabilities: [] } }),
      ["CONSUME", [], {}, { root: other }], ["CONSUME", [], {}, { root }],
      P({ text: "/init notes", root, provider_id: "local", language: "en", input: { goal: true } }), P({ text: "env task", root }),
      P({ text: "look", session_id: sid, provider_id: "vision", input: { attachments: [{ name: "p.png", mimeType: "image/png", data: PNG }, { name: "n.txt", mimeType: "text/plain", data: b64("note 中") }] } }),
      P({ ...t, input: { attachments: [{ name: "p.png", mimeType: "image/png", data: PNG }] } }), P({ ...t, input: { attachments: [{ name: "p.png", mimeType: "text/plain", data: PNG }] } }),
      P({ text: "x".repeat(5001), root }), P({ ...t, bogus: 1 }), P({ ...t, permission_mode: "nope" }), P({ ...t, input: { goal: "yes" } }), P("text"),
      P({ ...t, input: { files: ["node_modules/x.js"] } }), P({ ...t, input: { files: ["../outside.txt"] } }), P({ ...t, root: runs, input: { files: ["a.txt"] } }), P({ ...t, provider_id: "missing" }),
      P({ ...t, model: "other" }), P({ ...t, reasoning_effort: "turbo" }), P({ ...t, reasoning_effort: "high" }), P({ ...t, provider_id: "vision", reasoning_effort: "high" }), P({ ...t, text: "   " }),
      P({ ...t, input: { remote: "r1" } }), P({ ...t, root: "/etc" }), P({ text: "t", session_id: "f".repeat(32) }), P({ ...t, input: { sessions: [sid, sid] } }),
      P({ ...t, input: { sessions: ["b".repeat(32)] } }), P({ ...t, input: { plugins: ["nope"] } }), P({ ...t, input: { skills: ["missing"] } }), P({ ...t, input: { capabilities: ["unknown.cap"] } }),
      P({ ...t, input: { attachmentRefs: [{ id: "e".repeat(32) }] } }), ["GET", ["api", "composer", "prepare"], {}, {}]]);
    // Success paths too: plain, consumed, context-rich, built-in prompt with goal, environment model, media and a pinned effort.
    assert.deepEqual(replies.flatMap((reply, index) => (reply as [number])[0] === 200 ? [index] : []), [0, 1, 3, 5, 6, 7, 8, 23]);
    const prepared = (replies[3] as [number, Row])[1];
    assert.deepEqual((prepared.metadata as Row).commandInvocations, [{ command: "review", args: "a.txt speed" }]);
    assert.match(String(prepared.text), /^Review a\.txt with focus speed\./u);
  });

  it("expands slash commands for session admission identically", async () => {
    const E = (text: string, at = root): Call => ["EXPAND", [], {}, { text, root: at }];
    await same([E("  /review a.txt  "), E("plain 中 text"), E(""), E("x".repeat(5001)), E("/init", "/etc"), E("/nope x"), E("/help"), E("/init now")]);
  });

  it("switches branches with the same guards", async () => {
    const B = (data: unknown): Call => ["POST", ["api", "composer", "branch"], {}, data];
    const guards: Call[] = [B({ root, branch: "nope" }), B({ root, branch: "" }), B({ root }), B({ root, branch: "main", extra: 1 }), B({ root, branch: "main" }), B({ root: other, branch: "main" }), B({ root: "/etc", branch: "main" }), ["GET", ["api", "composer", "branch"], {}, {}]];
    await same(guards);
    await same([B({ root, branch: "main" })], [sid]);
    writeFileSync(join(root, "dirty.txt"), "untracked\n");
    await same([B({ root, branch: "feature" })]);
    rmSync(join(root, "dirty.txt"));
    running.clear();
    const actual = await ours([B({ root, branch: "feature" })]);
    git("switch", "-q", "main");
    assert.deepEqual(actual, await python([B({ root, branch: "feature" })]));
    assert.equal(git("branch", "--show-current").trim(), "feature");
  });

  it("gates the composer family on the sessions plugin", async () => {
    writeFileSync(join(state, "plugin-state.json"), JSON.stringify({ apiVersion: 1, enabled: { sessions: false } }));
    try {
      assert.deepEqual(await features.composer.dispatch("GET", ["api", "composer"], {}, {}), [403, { error: "plugin disabled or dependency unavailable: sessions", plugin: "sessions", code: "plugin_disabled" }]);
      await assert.rejects(features.composer.consumePrepared("0".repeat(32), root), /prepared input invalid or expired/u);
    } finally { rmSync(join(state, "plugin-state.json")); }
  });
});
