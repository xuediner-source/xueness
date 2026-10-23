/**
 * `remote`, `bots` and `app-server` (Python remote and bots `execute_cli`):
 * saved SSH connections, the allowlisted Telegram inbox, and the stdio
 * JSON-RPC server (`app-server.ts`). Remote execution needs `--allow-exec`
 * or an exact interactive approval of the literal argv.
 */
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { pyJsonDumps, pyTruthy } from "@xueness/contracts";
import { loadState, poll, reply, saveChannel } from "@xueness/plugin-bots";
import { cliLocalFailure, cliPayload, digest, keepSavedSystem, loadConnections, persisted, prepareRemote, runRemoteExec, saveConnections, validateConnection } from "@xueness/plugin-remote";
import { REMAINDER, type Parser } from "./argparse.ts";
import { appServer } from "./app-server.ts";
import { type Cli, dumps, err, errorText, out, pyPath } from "./host.ts";
import { visiblePrompt } from "./input.ts";

type Sub = ReturnType<Parser["subparsers"]>;
type Row = Record<string, any>;

export function register(sub: Sub): void {
  const remote = sub.add("remote", "manage explicitly approved named SSH connections").subparsers("remote_action", true);
  remote.add("list", "list saved SSH connection metadata");
  const save = remote.add("save", "save a named SSH connection");
  save.add("id").add("--host", { required: true }).add("--user", { required: true }).add("--port", { type: "int", default: 22 }).add("--directory", { default: "." });
  save.add("--system", { choices: ["posix", "windows"], default: null, help: "remote shell family; windows is stored but execution is refused" });
  remote.add("remove", "remove a saved SSH connection").add("id");
  const run = remote.add("exec", "run literal remote argv (requires exact interactive approval or --allow-exec)");
  run.add("id").add("--root", { default: process.cwd() }).add("--allow-exec", { action: "store_true", help: "approve this remote execution for the invocation" });
  run.add("argv", { nargs: REMAINDER, help: "remote argv after --" });
  const server = sub.add("app-server", "serve JSON-RPC 2.0 over stdio for an IDE or external frontend (never opens a network port)");
  server.add("--web-runs", { default: null, metavar: "PATH", help: "server-owned workspace parent (default the repository .web-runs)" });
  server.add("--workspace-root", { action: "append", default: [], metavar: "PATH", help: "allow an existing host workspace directory (repeatable)" });
  server.add("--allow-real-provider", { dest: "allow_real", action: "store_true", default: null, help: "allow online provider runs (default follows XUENESS_ALLOW_REAL)" });
  server.add("--no-real-provider", { dest: "allow_real", action: "store_false", default: null, help: "refuse online provider runs for this server" });
  const bots = sub.add("bots", "manage an allowlisted Telegram inbox and reviewed replies").subparsers("bot_action", true);
  bots.add("list");
  bots.add("save").add("id").add("--token-env", { required: true }).add("--root", { required: true }).add("--chat-id", { action: "append", required: true });
  bots.add("poll").add("id");
  bots.add("reply").add("id").add("--chat-id", { required: true }).add("--text", { required: true }).add("--confirm-send", { action: "store_true" });
}

const isDirectory = (path: string): boolean => { try { return statSync(path).isDirectory(); } catch { return false; } };

/** Python `Gate(root, allow_exec, interactive=True).check('exec', subject)` for one literal call. */
async function approveExec(allowExec: boolean, call: Row): Promise<void> {
  if (allowExec) return;
  const subject = pyJsonDumps(call, { sortKeys: true, separators: [",", ":"], ensureAscii: false });
  let answer = "";
  try { answer = await visiblePrompt(`Approve exec ${Array.from(subject).slice(0, 160).join("")}? [y/N] `); } catch { answer = ""; }
  if (answer.trim().toLowerCase() !== "y") throw new Error("exec requires explicit approval");
}

async function remoteCommand(cli: Cli): Promise<number> {
  const a = cli.args;
  let result: Row;
  try {
    const rows = loadConnections(cli.state);
    if (a.remote_action === "list") result = { connections: rows.map((row) => ({ ...persisted(row), digest: digest(row) })) };
    else if (a.remote_action === "save") {
      const fields: Row = { id: a.id, host: a.host, user: a.user, port: a.port, directory: a.directory };
      if (a.system != null) fields.system = a.system;
      let row = validateConnection(fields);
      row = keepSavedSystem(row, rows.find((item) => item.id === row.id), a.system != null);
      const kept = rows.filter((item) => item.id !== row.id);
      if (kept.length >= 100) throw new Error("remote connections capped at 100");
      saveConnections(cli.state, [...kept, row]);
      result = { connection: persisted(row), digest: digest(row) };
    } else if (a.remote_action === "remove") {
      if (!rows.some((row) => row.id === a.id)) throw new Error("connection not found");
      saveConnections(cli.state, rows.filter((row) => row.id !== a.id));
      result = { deleted: a.id };
    } else {
      const row = rows.find((item) => item.id === a.id);
      if (!row) throw new Error("connection not found");
      const raw: string[] = a.argv ?? [], argv = raw[0] === "--" ? raw.slice(1) : raw;
      if (!argv.length) throw new Error("remote argv required after --");
      const root = resolve(String(a.root));
      if (!isDirectory(root)) throw new Error("approval workspace must already exist");
      const call = { connection: row.id, connection_digest: digest(row), argv };
      prepareRemote(cli.state, call);
      await approveExec(Boolean(a.allow_exec), call);
      result = await runRemoteExec(cli.state, root, call);
    }
  } catch (error) {
    err(dumps({ error: errorText(error) }));
    return 1;
  }
  if (cliLocalFailure(result)) { err(dumps(cliPayload(result))); return 1; }
  out(dumps(result, 2));
  return Object.hasOwn(result, "ok") && !pyTruthy(result.ok) ? 2 : 0;
}

async function botsCommand(cli: Cli): Promise<number> {
  const a = cli.args;
  try {
    if (!cli.enabled("bots")) throw new Error("plugin disabled or dependency unavailable: bots");
    const context = { stateDir: cli.state, store: await cli.store() };
    let result: unknown;
    if (a.bot_action === "list") result = loadState(cli.state);
    else if (a.bot_action === "save") result = { channel: await saveChannel(cli.state, { id: a.id, kind: "telegram", tokenEnv: a.token_env, root: pyPath(a.root), allowedChats: a.chat_id }) };
    else if (a.bot_action === "poll") result = await poll(context, String(a.id));
    else if (a.bot_action === "reply") result = await reply(context, String(a.id), { chatId: a.chat_id, text: a.text, confirmed: Boolean(a.confirm_send) });
    else throw new Error("unknown channel command");
    out(dumps(result, 2));
    return 0;
  } catch {
    err("ERROR: invalid channel configuration or request failed");
    return 1;
  }
}

export async function execute(cli: Cli): Promise<number | null> {
  const cmd = cli.args.cmd;
  if (cmd === "app-server") return appServer(cli);
  if (cmd === "remote") return remoteCommand(cli);
  if (cmd === "bots") return botsCommand(cli);
  return null;
}
