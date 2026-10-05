#!/usr/bin/env node
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const webappRoot = dirname(fileURLToPath(import.meta.url));
const browserChannel = process.env.PLAYWRIGHT_CHANNEL?.trim() || "chrome";

async function listen(server) {
  await new Promise((resolveListen, rejectListen) => {
    const onError = (error) => rejectListen(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolveListen();
    });
  });
  return server.address().port;
}

const tempRoot = await mkdtemp(join(tmpdir(), "xueness-composer-interactions-"));
let server;
let browser;
try {
  const harnessPath = join(tempRoot, "harness.tsx");
  const bundlePath = join(tempRoot, "harness.js");
  const htmlPath = join(tempRoot, "index.html");
  const lightweightPath = resolve(webappRoot, "src/plugins/providers/LightweightWorkbench.tsx");
  const elicitationPath = resolve(webappRoot, "src/plugins/mcp/ElicitationForm.tsx");
  await writeFile(harnessPath, `
    import React, { useRef, useState } from "react";
    import { createRoot } from "react-dom/client";
    import { LightweightComposer, LightweightComposerControls } from ${JSON.stringify(lightweightPath)};
    import { ElicitationForm, type ElicitationPending, type ElicitationSubmission } from ${JSON.stringify(elicitationPath)};

    type TestState = {
      mode: "accept" | "false" | "reject" | "deferred";
      sends: string[];
      resolveDeferred?: (accepted: boolean) => void;
      submissions: ElicitationSubmission[];
      invalid: string;
    };
    const testState: TestState = { mode: "accept", sends: [], submissions: [], invalid: "" };
    (window as Window & { __composerTest?: TestState }).__composerTest = testState;

    const models = [
      { id: "local-a", name: "Local A", model: "model-a", configured: true, protocol: "openai", capabilities: [], reasoningLevels: [], runtimeProfile: "lightweight" },
      { id: "local-b", name: "Local B", model: "model-b", configured: true, protocol: "openai", capabilities: [], reasoningLevels: [], runtimeProfile: "lightweight" },
    ];
    const choices = { provider: "real", provider_id: "local-a", model: "model-a", mode: "build", permission_mode: "build", runtime_profile: "lightweight" };
    const pending: ElicitationPending = {
      id: "emoji", serverId: "test", serverName: "Test server", message: "Answer with one character", expiresAt: 1_900_000_000,
      requestedSchema: { type: "object", required: ["answer"], properties: { answer: { type: "string", maxLength: 1 } } },
    };

    function App() {
      const inputRef = useRef<HTMLTextAreaElement | null>(null);
      const [values, setValues] = useState<Record<string, string | boolean>>({});
      const controls = <LightweightComposerControls enabled choices={choices} onChange={() => {}} models={models} loading={false} error="" onReload={() => {}} onManageModels={() => {}} inputRef={inputRef} />;
      return <main>
        <LightweightComposer
          inputRef={inputRef}
          controls={controls}
          onSend={async (text) => {
            testState.sends.push(text);
            document.getElementById("send-count")!.textContent = String(testState.sends.length);
            if (testState.mode === "deferred") return await new Promise<boolean>((resolve) => { testState.resolveDeferred = resolve; });
            if (testState.mode === "reject") throw new Error("send rejected");
            return testState.mode !== "false";
          }}
        />
        <output id="send-count">0</output>
        <output id="elicitation-submit-count">0</output>
        <ElicitationForm
          pending={pending}
          values={values}
          onChange={(name, value) => setValues(current => ({ ...current, [name]: value }))}
          onResolve={(body) => {
            testState.submissions.push(body);
            document.getElementById("elicitation-submit-count")!.textContent = String(testState.submissions.length);
          }}
          onInvalid={(_field, code) => { testState.invalid = code; }}
        />
      </main>;
    }
    createRoot(document.getElementById("root")!).render(<App />);
  `);
  await writeFile(htmlPath, `<!doctype html>
    <html lang="zh-CN"><head><meta charset="utf-8"><title>Composer interaction regression</title></head>
    <body><div id="root"></div><script src="/harness.js"></script></body></html>`);

  await build({
    entryPoints: [harnessPath],
    outfile: bundlePath,
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2020",
    jsx: "automatic",
    nodePaths: [join(webappRoot, "node_modules")],
    loader: { ".css": "empty" },
    logLevel: "warning",
  });

  server = createServer(async (request, response) => {
    try {
      if (request.method !== "GET") {
        response.writeHead(405).end();
        return;
      }
      if (request.url === "/" || request.url === "/index.html") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(await readFile(htmlPath));
      } else if (request.url === "/harness.js") {
        response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
        response.end(await readFile(bundlePath));
      } else {
        response.writeHead(404).end();
      }
    } catch (error) {
      response.writeHead(500).end(String(error));
    }
  });
  const port = await listen(server);

  browser = await chromium.launch({ channel: browserChannel, headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors = [];
  const blockedRequests = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "127.0.0.1" && url.port === String(port) && url.pathname === "/harness.js") return route.continue();
    if (url.hostname === "127.0.0.1" && url.port === String(port) && url.pathname === "/") return route.continue();
    blockedRequests.push(url.href);
    return route.abort();
  });
  await page.goto(`http://127.0.0.1:${port}/`);
  const composer = page.getByTestId("lightweight-composer-input");
  const sendCount = page.locator("#send-count");
  await page.waitForFunction(() => Boolean(document.querySelector("[data-testid='lightweight-composer-input']")));

  await page.evaluate(() => { window.__composerTest.mode = "false"; });
  await composer.fill("  keep this draft  ");
  await composer.press("Enter");
  await page.waitForFunction(() => window.__composerTest.sends.length === 1);
  assert.equal(await composer.inputValue(), "  keep this draft  ", "an explicit false result preserves exact text");

  await page.evaluate(() => { window.__composerTest.mode = "reject"; });
  await composer.press("Enter");
  await page.waitForFunction(() => window.__composerTest.sends.length === 2);
  assert.equal(await composer.inputValue(), "  keep this draft  ", "a rejected promise preserves exact text");

  await page.evaluate(() => { window.__composerTest.mode = "accept"; });
  await composer.fill("accepted draft");
  await composer.press("Enter");
  await page.waitForFunction(() => window.__composerTest.sends.length === 3 && document.querySelector("[data-testid='lightweight-composer-input']")?.value === "");
  assert.equal(await composer.inputValue(), "", "an accepted send clears the submitted draft");

  await page.evaluate(() => { window.__composerTest.mode = "deferred"; });
  await composer.fill("submitted while pending");
  await composer.press("Enter");
  await page.waitForFunction(() => window.__composerTest.sends.length === 4 && typeof window.__composerTest.resolveDeferred === "function");
  await composer.fill("typed during send");
  await composer.press("Enter");
  assert.equal(await sendCount.textContent(), "4", "a second submit is ignored while the first request is pending");
  await page.evaluate(() => window.__composerTest.resolveDeferred(true));
  await page.waitForFunction(() => document.querySelector("[data-testid='lightweight-composer-input']")?.value === "typed during send" && !document.querySelector("[data-testid='composer-send']")?.disabled);
  assert.equal(await composer.inputValue(), "typed during send", "accepting an older revision does not erase newer typing");
  await page.evaluate(() => { window.__composerTest.mode = "accept"; });
  await composer.press("Enter");
  await page.waitForFunction(() => window.__composerTest.sends.length === 5 && document.querySelector("[data-testid='lightweight-composer-input']")?.value === "");

  await page.getByRole("button", { name: "选择模型" }).click();
  await page.locator('[data-model-row="local-b:model-b"]').click();
  await page.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "lightweight-composer-input");
  assert.equal(await composer.evaluate((node) => node === document.activeElement), true, "model selection returns focus to the actual lightweight textarea");

  const answer = page.locator("#xn-mcp-elicitation-answer");
  assert.equal(await answer.getAttribute("maxlength"), "2", "one-code-point limit allows a supplementary character's two UTF-16 units");
  await answer.fill("😀");
  await page.getByRole("button", { name: "提交" }).click();
  await page.waitForFunction(() => window.__composerTest.submissions.length === 1);
  assert.deepEqual(await page.evaluate(() => window.__composerTest.submissions[0].content), { answer: "😀" }, "one emoji passes the same code-point bound as Python");
  await answer.fill("ab");
  await page.getByRole("button", { name: "提交" }).click();
  assert.equal(await page.evaluate(() => window.__composerTest.invalid), "length", "code-point validation still rejects two basic characters at maxLength 1");
  assert.equal(await page.locator("#elicitation-submit-count").textContent(), "1", "invalid content is not submitted");

  assert.deepEqual(blockedRequests, [], "Harness must not request external services or API routes");
  assert.deepEqual(pageErrors, [], "Harness must finish without runtime errors");
  console.log(`Composer interaction browser regression passed using ${browserChannel} Chrome.`);
} finally {
  let cleanupError;
  try {
    await browser?.close();
  } catch (error) {
    cleanupError = error;
  }
  try {
    if (server?.listening) {
      await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
    }
  } catch (error) {
    cleanupError ??= error;
  }
  try {
    await rm(tempRoot, { recursive: true, force: true });
  } catch (error) {
    cleanupError ??= error;
  }
  if (cleanupError) throw cleanupError;
}
