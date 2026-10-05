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
const tempRoot = await mkdtemp(join(tmpdir(), "xueness-review-r6-r7-"));
let server;
let browser;

async function listen(serverToStart) {
  await new Promise((resolveListen, reject) => {
    const onError = (error) => reject(error);
    serverToStart.once("error", onError);
    serverToStart.listen(0, "127.0.0.1", () => {
      serverToStart.off("error", onError);
      resolveListen();
    });
  });
  return serverToStart.address().port;
}

try {
  const harnessPath = join(tempRoot, "harness.tsx");
  const bundlePath = join(tempRoot, "harness.js");
  const htmlPath = join(tempRoot, "index.html");
  const cloneDialogPath = resolve(webappRoot, "src/plugins/git/XuenessCloneDialog.tsx");
  const sidePanePath = resolve(webappRoot, "src/plugins/subagents/SubagentSidePane.tsx");
  await writeFile(harnessPath, `
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { XuenessCloneDialog } from ${JSON.stringify(cloneDialogPath)};
    import { SubagentSidePane } from ${JSON.stringify(sidePanePath)};

    const cloneRoot = createRoot(document.getElementById("clone-root"));
    let cloneProps = { open: true, defaultParent: "/default-parent" };
    const renderClone = () => cloneRoot.render(React.createElement(XuenessCloneDialog, {
      ...cloneProps, onCancel: () => {}, onCloned: () => {},
    }));
    renderClone();

    const paneRoot = createRoot(document.getElementById("pane-root"));
    let paneProps = { sessionId: "session-a", isOpen: true, subagentsEnabled: true, pollIntervalMs: 60000 };
    const requests = [];
    const cancellations = [];
    const fetchTasksFn = (sessionId, signal) => new Promise((resolve, reject) => {
      requests.push({ sessionId, signal, resolve, reject });
    });
    const onCancel = (taskId) => new Promise((resolve, reject) => {
      cancellations.push({ taskId, resolve, reject });
    });
    const renderPane = () => paneRoot.render(React.createElement(SubagentSidePane, {
      ...paneProps, fetchTasksFn, onCancel,
    }));
    renderPane();

    window.__reviewR6R7 = {
      clone: {
        setProps(patch) { cloneProps = { ...cloneProps, ...patch }; renderClone(); },
      },
      pane: {
        setProps(patch) { paneProps = { ...paneProps, ...patch }; renderPane(); },
        requestCount() { return requests.length; },
        requestInfo(index) {
          const request = requests[index];
          return request ? { sessionId: request.sessionId, hasSignal: Boolean(request.signal), aborted: request.signal?.aborted === true } : null;
        },
        resolve(index, tasks) { requests[index]?.resolve({ tasks }); },
        reject(index, message) { requests[index]?.reject(new Error(message)); },
        cancellationCount() { return cancellations.length; },
        rejectCancellation(index, message) { cancellations[index]?.reject(new Error(message)); },
        unmount() { paneRoot.unmount(); },
      },
    };
  `);
  await writeFile(htmlPath, `<!doctype html>
    <html lang="zh-CN"><head><meta charset="utf-8"><title>Review lifecycle regression</title></head>
    <body><div id="clone-root"></div><div id="pane-root"></div><script src="/harness.js"></script></body></html>`);

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
    if (request.url === "/" || request.url === "/index.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(await readFile(htmlPath));
    } else if (request.url === "/harness.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      response.end(await readFile(bundlePath));
    } else {
      response.writeHead(404).end();
    }
  });
  const port = await listen(server);

  browser = await chromium.launch({ channel: browserChannel, headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors = [];
  const pickerCalls = [];
  let pickerRoots = ["/tmp/Projects", "/tmp/OtherProjects"];
  let holdNextPicker = false;
  let releaseHeldPicker = null;
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "127.0.0.1" || url.port !== String(port)) {
      await route.abort();
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/harness.js") {
      await route.continue();
      return;
    }
    if (url.pathname === "/api/workspaces/native-picker" && route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ available: true, platform: "test" }) });
      return;
    }
    if (url.pathname === "/api/csrf" && route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ csrfToken: "isolated-test-token" }) });
      return;
    }
    if (url.pathname === "/api/workspaces/native-picker" && route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      pickerCalls.push(body);
      if (holdNextPicker) {
        holdNextPicker = false;
        const root = pickerRoots.shift() ?? "/tmp/Projects";
        await new Promise((resolveRelease) => {
          releaseHeldPicker = async () => {
            await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ root, cancelled: false }) });
            resolveRelease();
          };
        });
      } else {
        const root = pickerRoots.shift() ?? "/tmp/Projects";
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ root, cancelled: false }) });
      }
      return;
    }
    await route.abort();
  });
  await page.goto(`http://127.0.0.1:${port}/`);

  // R6: choosing a parent before typing the remote derives a child directory.
  await page.getByTestId("clone-pick-directory").waitFor({ state: "visible" });
  await page.waitForFunction(() => !document.querySelector('[data-testid="clone-pick-directory"]')?.disabled);
  const firstPickerResponse = page.waitForResponse((response) => response.url().includes("/api/workspaces/native-picker") && response.request().method() === "POST");
  await page.getByTestId("clone-pick-directory").click();
  await firstPickerResponse;
  await page.waitForFunction(() => window.__reviewR6R7 && document.querySelector('[data-testid="clone-dest"]')?.value === "");
  assert.deepEqual(pickerCalls[0], { initialRoot: "/default-parent" });
  await page.getByTestId("clone-url").fill("https://github.com/acme/widgets.git");
  await page.waitForFunction(() => document.querySelector('[data-testid="clone-dest"]')?.value === "/tmp/Projects/widgets");

  // An explicit final destination stays pinned when the URL changes.
  await page.getByTestId("clone-dest").fill("/manual/final-destination");
  await page.getByTestId("clone-url").fill("https://github.com/acme/changed.git");
  assert.equal(await page.getByTestId("clone-dest").inputValue(), "/manual/final-destination");

  // Choosing a different parent resets the suggestion and derives the latest repo name.
  await page.getByTestId("clone-pick-directory").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="clone-dest"]')?.value === "/tmp/OtherProjects/changed");

  // A picker response from an older open cycle must not replace the new parent or destination.
  holdNextPicker = true;
  await page.getByTestId("clone-pick-directory").click();
  await page.waitForFunction(() => typeof window.__reviewR6R7 !== "undefined");
  for (let attempt = 0; attempt < 100 && !releaseHeldPicker; attempt += 1) await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  assert.ok(releaseHeldPicker, "The test picker request should be held");
  await page.evaluate(() => window.__reviewR6R7.clone.setProps({ open: false }));
  await page.getByTestId("clone-dialog").waitFor({ state: "detached" });
  await page.evaluate(() => window.__reviewR6R7.clone.setProps({ open: true, defaultParent: "/fresh-parent" }));
  await page.getByTestId("clone-url").fill("https://github.com/acme/latest.git");
  await page.waitForFunction(() => document.querySelector('[data-testid="clone-dest"]')?.value === "/fresh-parent/latest");
  await releaseHeldPicker();
  releaseHeldPicker = null;
  await page.waitForTimeout(50);
  assert.equal(await page.getByTestId("clone-dest").inputValue(), "/fresh-parent/latest");

  // R7: old session success/error and spinner completion cannot update the new session.
  await page.waitForFunction(() => window.__reviewR6R7.pane.requestCount() === 1);
  await page.evaluate(() => window.__reviewR6R7.pane.setProps({ sessionId: "session-b" }));
  await page.waitForFunction(() => window.__reviewR6R7.pane.requestCount() === 2);
  assert.deepEqual(await page.evaluate(() => window.__reviewR6R7.pane.requestInfo(0)), {
    sessionId: "session-a", hasSignal: true, aborted: true,
  });
  await page.evaluate(() => window.__reviewR6R7.pane.resolve(0, [{ id: "old-task", status: "running", steps: 1 }]));
  await page.waitForTimeout(30);
  assert.equal(await page.getByTestId("subagent-sidepane-loading").count(), 1, "stale success must not clear the new session spinner");
  assert.equal(await page.getByTestId("subagent-task-old-task").count(), 0);
  await page.evaluate(() => window.__reviewR6R7.pane.resolve(1, [{ id: "b-task", status: "running", steps: 2 }]));
  await page.getByTestId("subagent-task-b-task").waitFor({ state: "visible" });

  await page.evaluate(() => window.__reviewR6R7.pane.setProps({ sessionId: "session-c" }));
  await page.waitForFunction(() => window.__reviewR6R7.pane.requestCount() === 3);
  await page.evaluate(() => window.__reviewR6R7.pane.setProps({ sessionId: "session-d" }));
  await page.waitForFunction(() => window.__reviewR6R7.pane.requestCount() === 4);
  await page.evaluate(() => window.__reviewR6R7.pane.resolve(3, [{ id: "d-task", status: "completed", steps: 3 }]));
  await page.getByTestId("subagent-task-d-task").waitFor({ state: "visible" });
  await page.evaluate(() => window.__reviewR6R7.pane.reject(2, "stale session error"));
  await page.waitForTimeout(30);
  assert.equal(await page.getByTestId("subagent-sidepane-error").count(), 0);
  assert.equal(await page.getByTestId("subagent-task-d-task").count(), 1);

  // Poll requests receive the same lifecycle signal and are aborted on a session switch.
  await page.evaluate(() => window.__reviewR6R7.pane.setProps({ pollIntervalMs: 20 }));
  await page.waitForFunction(() => window.__reviewR6R7.pane.requestCount() === 5);
  await page.evaluate(() => window.__reviewR6R7.pane.resolve(4, [{ id: "d-task", status: "completed", steps: 3 }]));
  await page.waitForFunction(() => window.__reviewR6R7.pane.requestCount() >= 6, null, { timeout: 2000 });
  const pollIndex = await page.evaluate(() => window.__reviewR6R7.pane.requestCount() - 1);
  assert.equal((await page.evaluate((index) => window.__reviewR6R7.pane.requestInfo(index), pollIndex)).hasSignal, true);
  await page.evaluate(() => window.__reviewR6R7.pane.setProps({ sessionId: "session-e", pollIntervalMs: 60000 }));
  await page.waitForFunction(() => window.__reviewR6R7.pane.requestCount() >= 7);
  assert.equal((await page.evaluate((index) => window.__reviewR6R7.pane.requestInfo(index), pollIndex)).aborted, true);
  await page.evaluate((index) => window.__reviewR6R7.pane.resolve(index, [{ id: "stale-poll-task", status: "running", steps: 4 }]), pollIndex);
  await page.waitForTimeout(30);
  assert.equal(await page.getByTestId("subagent-task-stale-poll-task").count(), 0);

  // Disabling the plugin aborts its pending work and discards later errors.
  const disabledPendingIndex = await page.evaluate(() => window.__reviewR6R7.pane.requestCount() - 1);
  await page.evaluate(() => window.__reviewR6R7.pane.setProps({ subagentsEnabled: false }));
  await page.getByTestId("subagent-sidepane-disabled").waitFor({ state: "visible" });
  assert.equal((await page.evaluate((index) => window.__reviewR6R7.pane.requestInfo(index), disabledPendingIndex)).aborted, true);
  await page.evaluate((index) => window.__reviewR6R7.pane.reject(index, "disabled stale error"), disabledPendingIndex);
  await page.waitForTimeout(30);
  assert.equal(await page.getByTestId("subagent-sidepane-error").count(), 0);

  // A previous session's async cancel error must not surface in the next session.
  await page.evaluate(() => window.__reviewR6R7.pane.setProps({ sessionId: "cancel-session", subagentsEnabled: true }));
  await page.waitForFunction(() => window.__reviewR6R7.pane.requestInfo(window.__reviewR6R7.pane.requestCount() - 1)?.sessionId === "cancel-session");
  const cancelLoadIndex = await page.evaluate(() => window.__reviewR6R7.pane.requestCount() - 1);
  await page.evaluate((index) => window.__reviewR6R7.pane.resolve(index, [{ id: "cancel-task", status: "running", steps: 1 }]), cancelLoadIndex);
  await page.getByTestId("subagent-cancel-cancel-task").waitFor({ state: "visible" });
  await page.getByTestId("subagent-cancel-cancel-task").click();
  await page.waitForFunction(() => window.__reviewR6R7.pane.cancellationCount() === 1);
  await page.evaluate(() => window.__reviewR6R7.pane.setProps({ sessionId: "next-session" }));
  await page.waitForFunction(() => window.__reviewR6R7.pane.requestInfo(window.__reviewR6R7.pane.requestCount() - 1)?.sessionId === "next-session");
  const nextLoadIndex = await page.evaluate(() => window.__reviewR6R7.pane.requestCount() - 1);
  await page.evaluate(() => window.__reviewR6R7.pane.rejectCancellation(0, "old cancel error"));
  await page.evaluate((index) => window.__reviewR6R7.pane.resolve(index, [{ id: "next-task", status: "completed", steps: 5 }]), nextLoadIndex);
  await page.getByTestId("subagent-task-next-task").waitFor({ state: "visible" });
  await page.waitForTimeout(30);
  assert.equal(await page.getByTestId("subagent-sidepane-error").count(), 0);
  assert.equal(await page.getByTestId("subagent-task-cancel-task").count(), 0);

  // Unmount aborts the final outstanding request as well.
  await page.evaluate(() => window.__reviewR6R7.pane.setProps({ sessionId: "unmount-session" }));
  await page.waitForFunction(() => window.__reviewR6R7.pane.requestInfo(window.__reviewR6R7.pane.requestCount() - 1)?.sessionId === "unmount-session");
  const unmountIndex = await page.evaluate(() => window.__reviewR6R7.pane.requestCount() - 1);
  await page.evaluate(() => window.__reviewR6R7.pane.unmount());
  assert.equal((await page.evaluate((index) => window.__reviewR6R7.pane.requestInfo(index), unmountIndex)).aborted, true);

  assert.deepEqual(pageErrors, [], "browser lifecycle regression should not throw");
  console.log("Workspace parent selection and subagent lifecycle browser checks passed.");
} finally {
  await browser?.close();
  await new Promise((resolveClose) => server?.close(resolveClose));
  await rm(tempRoot, { recursive: true, force: true });
}
