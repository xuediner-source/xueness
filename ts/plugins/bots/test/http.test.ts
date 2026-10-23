/** `/api/bots` parity with `bundled_plugins/bots/plugin.py` `dispatch`: the same steps, Bot API replies and resulting sessions on twin state directories. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { SessionStore } from "@xueness/sessions";
import { pythonUnavailableReason, runPythonAsync } from "../../../test-support/python-oracle.ts";
import { createBotsHttp, type BotTransport } from "../src/index.ts";

type Row = Record<string, any>;
type Step = [method: string, parts: string[], data?: unknown];
const TOKEN = "123456:abcdefghijKLMNOP_-";
const message = (id: unknown, chat: unknown, text: unknown): Row => ({ update_id: id, message: { chat: { id: chat }, text } });
/** Bot API replies in call order: two polls, a rejected poll, then one confirmed send. */
const REPLIES = [
  { ok: true, result: [message(5, 42, "hello"), message(6, 7, "blocked chat"), message(7, -100, ""), { update_id: "x" }, { update_id: 8, message: "not a message" }, message(9, -100, "second chat")] },
  { ok: true, result: [message(5, 42, "replayed below the offset"), message(10, 42, "hello again")] },
  { ok: false, description: "rejected" },
  { ok: true, result: { message_id: 1 } },
];
const steps = (root: string): Step[] => [
  ["GET", ["api", "bots"]],
  ["POST", ["api", "bots"], { id: "tg", kind: "telegram", tokenEnv: "BOT_TOKEN", root, allowedChats: [42, "-100"] }],
  ["POST", ["api", "bots"], { id: "tg", kind: "slack", tokenEnv: "BOT_TOKEN", root, allowedChats: [42] }],
  ["POST", ["api", "bots"], { id: "other", kind: "telegram", tokenEnv: "BOT_TOKEN", root, allowedChats: [] }],
  ["POST", ["api", "bots"], { id: "other", kind: "telegram", tokenEnv: "1BAD", root, allowedChats: [1] }],
  ["POST", ["api", "bots", "tg", "poll"], {}],
  ["POST", ["api", "bots", "tg", "poll"], {}],
  ["POST", ["api", "bots", "tg", "poll"], {}],
  ["POST", ["api", "bots", "tg", "reply"], { chatId: 7, text: "not allowed", confirmed: true }],
  ["POST", ["api", "bots", "tg", "reply"], { chatId: 42, text: "unconfirmed" }],
  ["POST", ["api", "bots", "tg", "reply"], { chatId: 42, text: "reviewed reply", confirmed: true }],
  ["POST", ["api", "bots", "missing", "poll"], {}],
  ["POST", ["api", "bots", "tg", "unknown"], {}],
  ["PUT", ["api", "bots"], {}],
  ["GET", ["api", "bots"]],
];
/** Session ids are random on both sides; everything else must match. */
const scrub = (value: unknown): unknown => JSON.parse(JSON.stringify(value).replace(/"sessionId":"[0-9a-f]{32}"/g, '"sessionId":"<sid>"'));

it("polls, files and replies through the Bot API exactly as Python's dispatch does", { skip: pythonUnavailableReason() ?? false }, async () => {
  const base = mkdtempSync(join(tmpdir(), "bots-http-")), py = join(base, "py"), ts = join(base, "ts"), root = join(base, "workspace");
  for (const dir of [py, ts, root]) mkdirSync(dir);
  const expected = JSON.parse(await runPythonAsync(`
import io,json,os,sys
from pathlib import Path
from xueness import core
from xueness.bundled_plugins.bots import plugin
d=json.load(sys.stdin); os.environ['BOT_TOKEN']=d['token']; replies=d['replies']; calls=[]
class Reply(io.BytesIO):
    def __enter__(self): return self
    def __exit__(self,*exc): return False
class Opener:
    def open(self,req,timeout=None):
        calls.append([req.full_url.rsplit('/',1)[1],json.loads(req.data)]); return Reply(json.dumps(replies.pop(0)).encode())
plugin.urllib.request.build_opener=lambda *handlers: Opener()
store=core.Store(Path(d['state'])); ctx={'state_dir':d['state'],'store':store}
out=[list(plugin.dispatch(method,parts,{},data,ctx) or [None,None]) for method,parts,data in d['steps']]
sessions=sorted([[s['task'],s['root'],s.get('bot_source'),s['status']] for s in (store.load(x['id']) for x in store.list())],key=lambda row:row[2])
print(json.dumps({'out':out,'calls':calls,'sessions':sessions,'file':json.loads(Path(d['state'],'bots.json').read_text())}))
`, JSON.stringify({ state: py, token: TOKEN, replies: REPLIES, steps: steps(root).map(([method, parts, data]) => [method, parts, data ?? {}]) }))) as Row;
  const replies = structuredClone(REPLIES), calls: unknown[] = [];
  const transport: BotTransport = async (url, body) => {
    calls.push([url.slice(url.lastIndexOf("/") + 1), JSON.parse(Buffer.from(body).toString("utf8"))]);
    return { status: 200, body: Buffer.from(JSON.stringify(replies.shift())) };
  };
  const store = new SessionStore(ts);
  const http = createBotsHttp({ stateDir: ts, enabled: () => true, store, env: { BOT_TOKEN: TOKEN }, transport });
  try {
    for (const [index, [method, parts, data]] of steps(root).entries()) {
      assert.deepEqual(scrub(await http.dispatch(method, parts, {}, data ?? {})), scrub(expected.out[index]), `${method} /${parts.join("/")}`);
    }
    assert.deepEqual(calls, expected.calls);
    const sessions = await Promise.all((await store.list()).map(async (row) => { const s = await store.load(String(row.id)) as Row; return [s.task, s.root, s.bot_source, s.status]; }));
    assert.deepEqual(sessions.sort((a, b) => String(a[2]).localeCompare(String(b[2]))), expected.sessions);
    assert.deepEqual(scrub(JSON.parse(readFileSync(join(ts, "bots.json"), "utf8"))), scrub(expected.file));
    assert.equal(JSON.stringify(expected).includes(TOKEN), false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

it("is refused while the plugin is off", async () => {
  const base = mkdtempSync(join(tmpdir(), "bots-off-"));
  const http = createBotsHttp({ stateDir: base, enabled: () => false, store: new SessionStore(base) });
  try {
    assert.deepEqual(await http.dispatch("GET", ["api", "bots"], {}, {}), [403, { error: "plugin disabled or dependency unavailable: bots", plugin: "bots", code: "plugin_disabled" }]);
    assert.equal(await http.dispatch("GET", ["api", "remote"], {}, {}), null);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
