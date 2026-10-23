/** Local-only interactive CLI acceptance; no real model endpoints or user state. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { stripVTControlCharacters } from "node:util";

const root = resolve(import.meta.dirname, "..");
const require = createRequire(join(root, "ts/package.json"));
const pty = require("@lydell/node-pty");
const built = process.argv.includes("--built");
const main = join(root, built ? "ts/dist/apps/server/src/cli/main.js" : "ts/apps/server/src/cli/main.ts");
const resultPath = join(root, "..", built ? "tui-built-acceptance.json" : "tui-source-acceptance.json");
const scratch = mkdtempSync(join(tmpdir(), "xueness-tui-round14-"));
const state = join(scratch, "state"), workspace = join(scratch, "workspace");
const exitStatusPath = join(scratch, "exit-status.json");
const wrapper = join(scratch, "entry-wrapper.mjs");
mkdirSync(state); mkdirSync(workspace);
writeFileSync(join(workspace, "note.txt"), "Temporary completion fixture.\n");
writeFileSync(join(state, "settings.json"), JSON.stringify({ workspace: { selectedRoots: [workspace], defaultRoot: workspace }, general: { sessionsAutoTitleEnabled: false } }));
writeFileSync(wrapper, `import { main } from ${JSON.stringify(pathToFileURL(main).href)};\nimport { writeFileSync } from "node:fs";\nconst code = await main(process.argv.slice(2));\nwriteFileSync(process.env.XUENESS_TUI_EXIT_STATUS, JSON.stringify({ code }));\nprocess.stdout.write("", () => process.stderr.write("", () => process.exit(code)));\n`);
let calls = 0;
const server = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks));
  assert.equal(req.url, "/v1/chat/completions");
  assert.equal(body.model, "local-tui-fixture");
  calls++;
  const delta = calls === 1 ? { tool_calls: [{ index: 0, id: "tui-write", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "result.txt", content: "TUI approved 中\n" }) } }] }
    : { content: calls === 2 ? "TUI_STREAM_OK\nEvidence: E1" : "NEXT_TURN_OK\nEvidence: E1" };
  res.setHeader("Content-Type", "text/event-stream");
  res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const env = { ...process.env, XUENESS_API_BASE: `http://127.0.0.1:${server.address().port}/v1`,
  XUENESS_API_KEY: "local-test-only", XUENESS_MODEL: "local-tui-fixture", XUENESS_PROVIDER: "openai",
  XUENESS_ALLOW_LOOPBACK_HTTP: "1", XUENESS_ALLOW_REAL: "1", TERM: "xterm-256color", NO_COLOR: "1" };
const cli = pty.spawn(process.execPath, [wrapper, "--state", state, "--language", "en", "chat", "--root", workspace, "--tui"], {
  name: "xterm-256color", cols: 90, rows: 28, cwd: root, env: { ...env, XUENESS_TUI_EXIT_STATUS: exitStatusPath },
});
let raw = "", pending = null, exitCode, exitEvent;
const exited = new Promise((done) => cli.onExit((event) => { exitEvent = event; exitCode = event.exitCode; done(); }));
cli.onData((data) => { raw += data; pending?.(); });
function waitText(text, after = 0) {
  return new Promise((done, reject) => {
    const timer = setTimeout(() => { pending = null; reject(new Error(`Missing ${text}: ${stripVTControlCharacters(raw).slice(-4500)}`)); }, 15_000);
    pending = () => { if (stripVTControlCharacters(raw.slice(after)).includes(text)) { clearTimeout(timer); pending = null; done(); } };
    pending();
  });
}
function removeScratch(path) {
  const base = resolve(tmpdir()), target = resolve(path), rel = relative(base, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Refusing to remove path outside the temp directory: ${target}`);
  rmSync(target, { recursive: true, force: true });
}
try {
  await waitText("workspace");
  const callsBeforeMenus = calls;
  cli.write("/model");
  await waitText("Models");
  await waitText("Environment/local-tui-fixture");
  cli.write("\t");
  await waitText("/model env");
  cli.write("\x15");
  cli.write("@not");
  await waitText("Files");
  await waitText("note.txt");
  cli.write("\t");
  await waitText("@note.txt");
  cli.write("\x15");
  assert.equal(calls, callsBeforeMenus, "menu and file completion must not call the provider");
  const approvalOffset = raw.length;
  cli.write("Create the result file\r");
  await waitText("Permission approval", approvalOffset);
  assert.equal(calls, 1);
  const approvalText = stripVTControlCharacters(raw.slice(approvalOffset));
  assert.match(approvalText, /Subject:/);
  assert.match(approvalText, /result\.txt/);
  assert.match(approvalText, /Allow once/);
  assert.match(approvalText, /Always allow in this project/);
  cli.resize(54, 18);
  await new Promise((done) => setTimeout(done, 100));
  cli.resize(90, 28);
  await new Promise((done) => setTimeout(done, 100));
  cli.write("y");
  await waitText("TUI_STREAM_OK");
  assert.equal(readFileSync(join(workspace, "result.txt"), "utf8"), "TUI approved 中\n");
  assert.equal(calls, 2, "approval must not submit an extra Enter");
  await waitText("enter a follow-up");
  cli.resize(90, 28);
  const nextOffset = raw.length;
  cli.write("Explain the update\r");
  await waitText("NEXT_TURN_OK", nextOffset);
  await waitText("enter a follow-up", nextOffset);
  cli.write("/exit\r");
  let exitTimeout;
  try { await Promise.race([exited, new Promise((_, reject) => { exitTimeout = setTimeout(() => reject(new Error("CLI did not exit")), 10_000); })]); }
  finally { clearTimeout(exitTimeout); }
  assert.ok(exitCode === undefined || exitCode === 0, `unexpected PTY exit: ${JSON.stringify(exitEvent)}\n${stripVTControlCharacters(raw).slice(-2500)}`);
  const cliExitStatus = JSON.parse(readFileSync(exitStatusPath, "utf8"));
  assert.equal(cliExitStatus.code, 0, `CLI main returned ${cliExitStatus.code}\n${stripVTControlCharacters(raw).slice(-2500)}`);
  assert.ok(raw.includes("\x1b[?1049h"));
  assert.ok(raw.includes("\x1b[?1049l"));
  const sessions = readdirSync(state).filter((name) => /^[0-9a-f]{32}\.json$/.test(name));
  assert.equal(sessions.length, 1);
  const saved = JSON.parse(readFileSync(join(state, sessions[0]), "utf8"));
  assert.ok(saved.messages.some((message) => message.role === "user" && message.content === "Explain the update"));
  assert.ok(!saved.messages.some((message) => message.role === "user" && message.content === "y"));
  const screenText = stripVTControlCharacters(raw);
  const finalSummary = [...screenText.matchAll(/== completed \(\d+ steps\) · enter a follow-up, \/retry to continue, \/exit to leave/g)].at(-1)?.[0] ?? null;
  const restoreIndex = raw.lastIndexOf("\x1b[?1049l"), lastFrameStart = raw.lastIndexOf("\x1b[H", restoreIndex);
  const lastFrameText = lastFrameStart >= 0 && restoreIndex > lastFrameStart ? stripVTControlCharacters(raw.slice(lastFrameStart, restoreIndex)) : "";
  const lastFrameWriteCardStatus = lastFrameText.match(/\+ write result\.txt \[(failed|completed)\]/)?.[1] ?? null;
  const writeResult = saved.results?.["tui-write"];
  assert.equal(writeResult?.ok, true, "saved write result was not successful");
  assert.equal(lastFrameWriteCardStatus, "completed", `final write card status was ${lastFrameWriteCardStatus ?? "missing"}`);
  assert.ok(finalSummary, "final completed-turn summary was not captured");

  const piped = spawnSync(process.execPath, [main, "--state", join(scratch, "line-state"), "--language", "en", "chat", "--root", workspace, "--tui"], { cwd: root, env, input: "/exit\n", encoding: "utf8" });
  assert.equal(piped.status, 0, piped.stderr);
  assert.ok(!piped.stderr.includes("\x1b[?1049h"));
  assert.match(piped.stderr, /using line chat/);
  const result = { round: 14, built, platform: process.platform, modelCalls: calls, completion: { modelMenuTab: true, atFileTab: true, providerCalls: callsBeforeMenus }, approval: { resultOk: writeResult.ok === true, fileWritten: true, finalCardStatus: lastFrameWriteCardStatus }, resize: "90x28 -> 54x18 -> 90x28", savedFollowup: true, finalSummary, ptyExitCode: exitCode ?? null, cliExitCode: cliExitStatus.code, screenRestored: true, pipedFallback: true };
  const resultJson = JSON.stringify(result);
  writeFileSync(resultPath, resultJson);
  console.log(resultJson);
} finally {
  cli.kill();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  removeScratch(scratch);
}
