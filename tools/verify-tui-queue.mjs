/** Local-only ConPTY integration for durable follow-up and current-turn inputs. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";

const root = resolve(import.meta.dirname, "..");
const require = createRequire(join(root, "ts/package.json"));
const pty = require("@lydell/node-pty");
const built = process.argv.includes("--built");
const main = join(root, built ? "ts/dist/apps/server/src/cli/main.js" : "ts/apps/server/src/cli/main.ts");
const resultPath = join(root, "..", built ? "tui-built-queue.json" : "tui-source-queue.json");
const scratch = mkdtempSync(join(tmpdir(), "xueness-tui-round14-queue-"));
const state = join(scratch, "state"), workspace = join(scratch, "workspace");
const exitStatusPath = join(scratch, "exit-status.json");
const wrapper = join(scratch, "entry-wrapper.mjs");
mkdirSync(state); mkdirSync(workspace);
writeFileSync(join(workspace, "note.txt"), "Queue smoke fixture content.\n");
writeFileSync(join(state, "settings.json"), JSON.stringify({ workspace: { selectedRoots: [workspace], defaultRoot: workspace }, general: { sessionsAutoTitleEnabled: false } }));
writeFileSync(wrapper, `import { main } from ${JSON.stringify(pathToFileURL(main).href)};\nimport { writeFileSync } from "node:fs";\nconst code = await main(process.argv.slice(2));\nwriteFileSync(process.env.XUENESS_TUI_EXIT_STATUS, JSON.stringify({ code }));\nprocess.stdout.write("", () => process.stderr.write("", () => process.exit(code)));\n`);

function removeScratch(path) {
  const base = resolve(tmpdir()), target = resolve(path), rel = relative(base, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Refusing to remove path outside the temp directory: ${target}`);
  rmSync(target, { recursive: true, force: true });
}
function gate() {
  let release;
  const promise = new Promise((done) => { release = done; });
  return { promise, release: () => release() };
}
function waitPromise(promise, label, timeoutMs = 25_000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs); })])
    .finally(() => clearTimeout(timer));
}
function sendResponse(res, delta) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: "stop" }] })}\n\n`);
  res.end("data: [DONE]\n\n");
}
function hasUserText(body, value) {
  return Array.isArray(body?.messages) && body.messages.some((message) => message?.role === "user" && typeof message.content === "string" && message.content.includes(value));
}

const firstGate = gate(), secondGate = gate(), thirdGate = gate();
let resolveFirst, resolveSecond, resolveThird;
const firstSeen = new Promise((done) => { resolveFirst = done; });
const secondSeen = new Promise((done) => { resolveSecond = done; });
const thirdSeen = new Promise((done) => { resolveThird = done; });
const requests = [];
let calls = 0;
const server = createServer((req, res) => {
  void (async () => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    assert.equal(req.url, "/v1/chat/completions");
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(body.model, "local-tui-queue-fixture");
    calls += 1; requests.push(body);
    if (calls === 1) {
      resolveFirst(body);
      await firstGate.promise;
      if (res.destroyed) return;
      sendResponse(res, { tool_calls: [{ index: 0, id: "queue-read-note", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "note.txt" }) } }] });
    } else if (calls === 2) {
      resolveSecond(body);
      await secondGate.promise;
      if (res.destroyed) return;
      sendResponse(res, { content: "GUIDANCE_CONSUMED_OK\nEvidence: G1" });
    } else if (calls === 3) {
      resolveThird(body);
      await thirdGate.promise;
      if (res.destroyed) return;
      sendResponse(res, { content: "QUEUE_CONSUMED_OK\nEvidence: Q1" });
    } else {
      sendResponse(res, { content: "UNEXPECTED_EXTRA_REQUEST" });
    }
  })().catch((error) => {
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(String(error?.message ?? error));
  });
});

await new Promise((done) => server.listen(0, "127.0.0.1", done));
const env = { ...process.env, XUENESS_API_BASE: `http://127.0.0.1:${server.address().port}/v1`,
  XUENESS_API_KEY: "local-test-only", XUENESS_MODEL: "local-tui-queue-fixture", XUENESS_PROVIDER: "openai",
  XUENESS_ALLOW_LOOPBACK_HTTP: "1", XUENESS_ALLOW_REAL: "1", TERM: "xterm-256color", NO_COLOR: "1" };
const cli = pty.spawn(process.execPath, [wrapper, "--state", state, "--language", "en", "chat", "--root", workspace, "--tui"], {
  name: "xterm-256color", cols: 90, rows: 28, cwd: root, env: { ...env, XUENESS_TUI_EXIT_STATUS: exitStatusPath },
});
let raw = "", pending = null, exitCode;
const exited = new Promise((done) => cli.onExit((event) => { exitCode = event.exitCode; done(); }));
cli.onData((data) => { raw += data; pending?.(); });
function waitText(text, after = 0) {
  return new Promise((done, reject) => {
    const timer = setTimeout(() => { pending = null; reject(new Error(`Missing ${text}: ${stripVTControlCharacters(raw).slice(-5000)}`)); }, 20_000);
    pending = () => { if (stripVTControlCharacters(raw.slice(after)).includes(text)) { clearTimeout(timer); pending = null; done(); } };
    pending();
  });
}

try {
  await waitText("workspace");
  cli.write("Start the local queue smoke\r");
  const firstBody = await waitPromise(firstSeen, "the held first provider request");
  assert.ok(hasUserText(firstBody, "Start the local queue smoke"));
  assert.equal(calls, 1, "the fixture must hold the first request before sending a response");

  const sessionFiles = readdirSync(state).filter((name) => /^[0-9a-f]{32}\.json$/u.test(name));
  assert.equal(sessionFiles.length, 1, "expected one session in the isolated state directory");
  const sessionPath = join(state, sessionFiles[0]);
  const sessionId = sessionFiles[0].slice(0, -5);
  const session = JSON.parse(readFileSync(sessionPath, "utf8"));
  assert.equal(typeof session.active_turn_id, "string");

  const queuedText = "Queue follow-up after this turn";
  cli.write(`${queuedText}\r`);
  await waitText("Follow-up queued.");
  const guidedText = "Guide the current turn to mention the note";
  cli.write(guidedText);
  cli.write("\x13");
  await waitText("Guidance sent to current turn.");

  const queuePath = join(state, "session-message-queues", `${sessionId}.json`);
  const guidePath = join(state, "session-turn-inputs", `${sessionId}.json`);
  const queueRecord = JSON.parse(readFileSync(queuePath, "utf8"));
  const guideRecord = JSON.parse(readFileSync(guidePath, "utf8"));
  const queuedItem = queueRecord.items.find((item) => item.text === queuedText);
  const guidedItem = guideRecord.items.find((item) => item.text === guidedText);
  assert.ok(queuedItem, "queued follow-up was not persisted");
  assert.ok(guidedItem, "current-turn guidance was not persisted");
  assert.equal(queuedItem.status, "queued");
  assert.equal(guidedItem.status, "queued");
  for (const item of [queuedItem, guidedItem]) {
    assert.equal(item.submission?.receipt?.id, item.id, "sidecar is missing the accepted receipt");
    assert.equal(item.submission?.receipt?.status, "queued", "accepted receipt has the wrong status");
  }
  assert.equal(guidedItem.target_turn_id, session.active_turn_id, "guidance was not addressed to the active turn");
  assert.equal(calls, 1, "fixture's first request must remain held until both receipts are verified");

  firstGate.release();
  const secondBody = await waitPromise(secondSeen, "the model request after the read tool");
  assert.ok(hasUserText(secondBody, guidedText), "model did not receive current-turn guidance");
  assert.ok(!hasUserText(secondBody, queuedText), "next-turn queue was consumed before the active turn ended");
  secondGate.release();

  const thirdBody = await waitPromise(thirdSeen, "the queued follow-up model request");
  assert.ok(hasUserText(thirdBody, queuedText), "model did not receive the queued follow-up");
  assert.ok(hasUserText(thirdBody, guidedText), "current-turn guidance was not retained in the session transcript");
  thirdGate.release();
  await waitText("QUEUE_CONSUMED_OK");
  await waitText("enter a follow-up");

  const saved = JSON.parse(readFileSync(sessionPath, "utf8"));
  assert.ok(saved.messages.some((message) => message.role === "user" && message.content === guidedText && message._input_kind === "guide"));
  assert.ok(saved.messages.some((message) => message.role === "user" && message.content === queuedText));
  const queueAfter = JSON.parse(readFileSync(queuePath, "utf8"));
  const guideAfter = JSON.parse(readFileSync(guidePath, "utf8"));
  assert.equal(queueAfter.items.find((item) => item.id === queuedItem.id)?.status, "completed");
  assert.equal(guideAfter.items.find((item) => item.id === guidedItem.id)?.status, "completed");
  assert.equal(calls, 3);

  cli.write("/exit\r");
  let exitTimeout;
  try { await Promise.race([exited, new Promise((_, reject) => { exitTimeout = setTimeout(() => reject(new Error("CLI did not exit")), 10_000); })]); }
  finally { clearTimeout(exitTimeout); }
  assert.ok(exitCode === undefined || exitCode === 0, `unexpected PTY exit ${exitCode}`);
  const cliExitStatus = JSON.parse(readFileSync(exitStatusPath, "utf8"));
  assert.equal(cliExitStatus.code, 0, `CLI main returned ${cliExitStatus.code}`);
  assert.ok(raw.includes("\x1b[?1049h"));
  assert.ok(raw.includes("\x1b[?1049l"));
  const result = { round: 14, built, platform: process.platform, modelCalls: calls, heldFirstRequest: true,
    acceptedSidecars: { queue: queuedItem.status, steer: guidedItem.status }, modelReceived: { steer: true, queuedFollowup: true },
    consumedSessionMessages: { steer: true, queuedFollowup: true }, finalSidecars: { queue: "completed", steer: "completed" },
    ptyExitCode: exitCode ?? null, cliExitCode: cliExitStatus.code, screenRestored: true };
  const resultJson = JSON.stringify(result);
  writeFileSync(resultPath, resultJson);
  console.log(resultJson);
} finally {
  firstGate.release(); secondGate.release(); thirdGate.release();
  cli.kill();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  removeScratch(scratch);
}
