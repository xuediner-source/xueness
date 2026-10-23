import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { bashByteSize, createToolEnv, execTool, isInside, type ExecData } from "../src/index.ts";
import { workspace } from "./helpers.ts";

const posix = process.platform === "win32" ? "POSIX shell tests" : false;
const ws = workspace();
after(() => ws.dispose());

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
}

describe("exec", { skip: posix }, () => {
  it("returns stdout and stderr separately with the exit code", async () => {
    const result = await ws.run(execTool, { command: "echo out; echo err >&2; exit 0" });
    assert.equal(result.ok, true);
    assert.equal(result.output, "out\nerr", "ZCode bash-model-content: stdout, then stderr");
    const failed = await ws.run(execTool, { command: "echo partial; exit 3" });
    assert.equal(failed.ok, false);
    assert.equal(failed.error?.code, "command_failed");
    assert.equal(failed.output, "Exit code 3\npartial");
    const noMatch = await ws.run(execTool, { command: "printf 'a\\n' | grep zzz" });
    assert.equal(noMatch.error?.code, "command_failed");
    assert.equal(noMatch.output, "", "grep exit 1 means no matches: no Exit code prefix");
    assert.equal(failed.data?.exitCode, 3);
  });

  it("reports a missing command as a result instead of failing the run", async () => {
    const shell = await ws.run(execTool, { command: "definitely-not-a-command-xyz --version" });
    assert.equal(shell.ok, false);
    assert.equal(shell.error?.code, "command_not_found");
    assert.match(shell.output, /not found/);
    const direct = await ws.run(execTool, { argv: ["definitely-not-a-command-xyz"] });
    assert.equal(direct.error?.code, "command_not_found");
    assert.equal(direct.output, "command not found: definitely-not-a-command-xyz");
    const argv = await ws.run(execTool, { argv: ["printf", "%s|", "a b", "$HOME"] });
    assert.equal(argv.output, "a b|$HOME|", "argv is not interpreted by a shell");
    assert.equal((await ws.run(execTool, { command: "true", argv: ["true"] })).error?.code, "invalid_argument");
  });

  it("kills the whole process tree on timeout", async () => {
    const pidFile = join(ws.base, "child.pid");
    const started = Date.now();
    const result = await ws.run(execTool, { command: `sleep 30 & echo $! > ${pidFile}; trap '' TERM; sleep 30`, timeout_ms: 400 });
    assert.equal(result.error?.code, "command_timeout");
    assert.equal(result.output, "<error>Command was aborted before completion</error>");
    assert.ok(Date.now() - started < 5000, "timeout must not wait for the commands");
    const pid = Number(await readFile(pidFile, "utf8"));
    assert.ok(await waitFor(() => !alive(pid)), `background child ${pid} survived`);
  });

  it("cancels with the abort signal", async () => {
    const controller = new AbortController();
    const cancelWs = workspace({ signal: controller.signal });
    try {
      setTimeout(() => controller.abort(), 150);
      const started = Date.now();
      const result = await cancelWs.run(execTool, { command: "sleep 30" });
      assert.equal(result.error?.code, "command_cancelled");
      assert.ok(Date.now() - started < 3000);
    } finally {
      cancelWs.dispose();
    }
  });

  it("keeps head and tail of long output and saves the full stream outside the workspace", async () => {
    const result = await ws.run(execTool, { command: "seq 1 200000" });
    assert.equal(result.ok, true);
    const stdout = (result.data as ExecData | undefined)?.stdout;
    assert.equal(stdout?.truncated, true);
    assert.ok(stdout?.fullOutputPath && !isInside(ws.root, stdout.fullOutputPath) && isInside(ws.artifacts, stdout.fullOutputPath));
    assert.ok(result.output.startsWith(`<persisted-output>\nOutput too large (${bashByteSize(stdout.bytes)}). Full output saved to: ${stdout.fullOutputPath}\n\nPreview (first 2KB):\n1\n2\n3\n`), result.output.slice(0, 300));
    assert.match(result.output, /\n\.\.\.\n<\/persisted-output>$/);
    const full = await readFile(stdout.fullOutputPath, "utf8");
    assert.equal(full.split("\n").length, 200_001);
    assert.ok(result.output.length < 2_500, `model output is ${result.output.length} characters`);
  });

  it("closes stdin, scrubs credentials and disables interactive prompts", async () => {
    process.env.XUENESS_TEST_API_KEY = "sk-should-not-leak";
    try {
      const result = await ws.run(execTool, { command: 'cat; echo "key=${XUENESS_TEST_API_KEY:-unset} prompt=$GIT_TERMINAL_PROMPT pager=$GIT_PAGER"', timeout_ms: 5000 });
      assert.equal(result.output, "key=unset prompt=0 pager=cat");
    } finally {
      delete process.env.XUENESS_TEST_API_KEY;
    }
  });

  it("returns when background jobs keep the output pipe open", async () => {
    const started = Date.now();
    const result = await ws.run(execTool, { command: "echo started; sleep 20 &" });
    assert.ok(Date.now() - started < 4000, "must not wait for the background job");
    assert.equal(result.output, "started");
  });

  it("decodes GBK console output and strips terminal escapes", async () => {
    const result = await ws.run(execTool, { command: "printf '\\326\\320\\316\\304\\n'; printf '\\033[31mred\\033[0m\\n'; printf 'progress 10%%\\rprogress 100%%\\n'" });
    assert.equal(result.output, "中文\nred\nprogress 100%");
  });

  it("runs in a workspace subdirectory and refuses directories outside it", async () => {
    await ws.put("sub/marker.txt", "x");
    const inside = await ws.run(execTool, { command: "ls", cwd: "sub" });
    assert.equal(inside.output, "marker.txt");
    assert.equal((await ws.run(execTool, { command: "ls", cwd: ".." })).error?.code, "path_outside_workspace");
  });
});

describe("tool environment", () => {
  it("refuses an artifacts directory inside the workspace", () => {
    assert.throws(() => createToolEnv({ cwd: ws.root, artifactsDir: join(ws.root, ".artifacts") }), { name: "ArtifactsInsideWorkspaceError" });
    assert.ok(existsSync(ws.root));
  });
});
