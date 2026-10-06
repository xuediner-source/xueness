#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const webappRoot = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(webappRoot, "..");
const distRoot = join(webappRoot, "dist");
const outputRoot = "/tmp/xueness-onboarding-review-20261006";
const browserChannel = process.env.PLAYWRIGHT_CHANNEL?.trim() || "chrome";
const matrix = [
  { scheme: "light", width: 1280, height: 900 },
  { scheme: "dark", width: 1280, height: 900 },
  { scheme: "light", width: 420, height: 860 },
  { scheme: "dark", width: 420, height: 860 },
];

async function reservePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const port = server.address().port;
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  return port;
}

async function waitForHealth(url, processHandle, logs) {
  const until = Date.now() + 30_000;
  let lastError;
  while (Date.now() < until) {
    if (processHandle.exitCode !== null) {
      throw new Error(`Xueness test server exited (${processHandle.exitCode}):\n${logs.join("")}`);
    }
    try {
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_500) });
      if (response.ok) return;
      lastError = new Error(`health endpoint returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 150));
  }
  throw new Error(`Timed out waiting for Xueness test server: ${lastError?.message ?? "unknown error"}\n${logs.join("")}`);
}

function safeName(value) {
  return value.replace(/[^a-z0-9-]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
}

function sizeName(view) {
  return `${view.width}x${view.height}`;
}

async function screenshot(page, view, scenario) {
  const path = join(outputRoot, `${safeName(scenario)}-${view.scheme}-${sizeName(view)}.png`);
  await page.screenshot({ path, fullPage: true, animations: "disabled" });
  return path;
}

async function assertNoHorizontalOverflow(page, view, scenario) {
  const dimensions = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
  }));
  assert.ok(dimensions.documentWidth <= dimensions.viewportWidth + 1,
    `${scenario} (${view.scheme} ${sizeName(view)}) overflows horizontally: ${JSON.stringify(dimensions)}`);
  assert.ok(dimensions.bodyWidth <= dimensions.viewportWidth + 1,
    `${scenario} (${view.scheme} ${sizeName(view)}) body overflows horizontally: ${JSON.stringify(dimensions)}`);
  return dimensions;
}

async function assertAutomationGutter(page, view, scenario) {
  const geometry = await page.evaluate(() => {
    const panel = document.querySelector("[data-testid='automations-panel']");
    if (!panel) return null;
    const box = panel.getBoundingClientRect();
    const content = panel.firstElementChild?.getBoundingClientRect();
    const style = getComputedStyle(panel);
    return {
      leftPadding: Number.parseFloat(style.paddingLeft),
      contentInset: content ? content.left - box.left : null,
      maxWidth: style.maxWidth,
      width: box.width,
    };
  });
  assert.ok(geometry, `${scenario} should render the automation panel`);
  const minimum = view.width <= 680 ? 16 : 24;
  assert.ok(geometry.leftPadding >= minimum,
    `${scenario} (${sizeName(view)}) automation padding must be at least ${minimum}px: ${JSON.stringify(geometry)}`);
  assert.ok(geometry.contentInset >= minimum,
    `${scenario} (${sizeName(view)}) automation copy needs at least ${minimum}px left clearance: ${JSON.stringify(geometry)}`);
  if (view.width === 1280) {
    assert.equal(geometry.maxWidth, "1080px", `Wide automation view should use the centered 1080px measure: ${JSON.stringify(geometry)}`);
  }
  return geometry;
}

async function navigateTo(page, view, id, panelTestId) {
  const panel = page.getByTestId(panelTestId);
  if (await panel.count() && await panel.isVisible().catch(() => false)) return panel;
  const action = page.getByTestId(`xn-sidebar-action-${id}`);
  if (!await action.isVisible().catch(() => false)) {
    const toggle = page.getByTestId("xn-shell-sidebar-toggle");
    assert.ok(await toggle.isVisible().catch(() => false), `Sidebar navigation is unavailable for ${id} at ${sizeName(view)}`);
    await toggle.click();
    await action.waitFor({ state: "visible", timeout: 5_000 });
  }
  await action.click();
  await panel.waitFor({ state: "visible", timeout: 15_000 });
  return panel;
}

async function collectGeometry(page, view, scenario, summary) {
  const overflow = await assertNoHorizontalOverflow(page, view, scenario);
  const details = await page.evaluate(() => {
    const panel = document.querySelector("[data-testid='automations-panel'], [data-testid='offpeak-panel'], [data-testid='marketplace-panel']");
    if (!panel) return null;
    const rect = panel.getBoundingClientRect();
    const style = getComputedStyle(panel);
    return {
      testId: panel.getAttribute("data-testid"),
      x: Math.round(rect.x * 10) / 10,
      y: Math.round(rect.y * 10) / 10,
      width: Math.round(rect.width * 10) / 10,
      height: Math.round(rect.height * 10) / 10,
      paddingLeft: style.paddingLeft,
      paddingRight: style.paddingRight,
      rootTheme: document.documentElement.dataset.xnTheme || null,
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
    };
  });
  summary.views.push({ scenario, scheme: view.scheme, viewport: sizeName(view), ...overflow, panel: details });
}

async function capture(page, view, scenario, summary) {
  const path = await screenshot(page, view, scenario);
  if (await page.getByTestId("automations-panel").count()) {
    const gutter = await assertAutomationGutter(page, view, scenario);
    summary.automationGutters ??= [];
    summary.automationGutters.push({ scenario, scheme: view.scheme, viewport: sizeName(view), ...gutter });
  }
  if (scenario === "marketplace-cards") {
    const beforeContent = await page.locator(".xn-marketplace__header").evaluate(element => getComputedStyle(element, "::before").content);
    assert.equal(beforeContent, "none", `Marketplace header must not render the removed decorative stripe: ${beforeContent}`);
    summary.marketplaceHeaderBefore ??= [];
    summary.marketplaceHeaderBefore.push({ scheme: view.scheme, viewport: sizeName(view), content: beforeContent });
  }
  await collectGeometry(page, view, scenario, summary);
  summary.screenshots.push(path);
  return path;
}

async function apiCreateAutomation(baseUrl, state, record) {
  const tokenResponse = await fetch(`${baseUrl}/api/csrf`);
  assert.equal(tokenResponse.status, 200, "CSRF endpoint should be available on the loopback server");
  const { csrfToken } = await tokenResponse.json();
  const response = await fetch(`${baseUrl}/api/automations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
      Origin: baseUrl,
    },
    body: JSON.stringify(record),
  });
  const payload = await response.json();
  assert.equal(response.status, 201, `Fixture automation was rejected: ${JSON.stringify(payload)}`);
  state.fixtureAutomationIds.push(payload.automation.id);
  return payload.automation;
}

async function apiApproveAutomation(baseUrl, record) {
  const tokenResponse = await fetch(`${baseUrl}/api/csrf`);
  const { csrfToken } = await tokenResponse.json();
  const response = await fetch(`${baseUrl}/api/automations/${encodeURIComponent(record.id)}/approve`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
      Origin: baseUrl,
    },
    body: JSON.stringify({ confirmed: true, allowReal: false }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, `Fixture plan approval was rejected: ${JSON.stringify(payload)}`);
  return payload.automation;
}

const distStat = await stat(join(distRoot, "index.html")).catch(() => null);
assert.ok(distStat?.isFile(), `Build the production webapp first; missing ${join(distRoot, "index.html")}`);
const distHtml = await readFile(join(distRoot, "index.html"), "utf8");
const assetRefs = [...distHtml.matchAll(/(?:src|href)="([^\"]*\/assets\/[^\"]+)"/g)].map(match => match[1]);
assert.ok(assetRefs.some(asset => asset.endsWith(".js")), "Production dist must reference a JavaScript bundle");
assert.ok(assetRefs.some(asset => asset.endsWith(".css")), "Production dist must reference a CSS bundle");

await mkdir(outputRoot, { recursive: true });
const tempRoot = await mkdtemp(join(tmpdir(), "xueness-automation-browser-"));
const stateDir = join(tempRoot, "state");
const webRunsDir = join(tempRoot, "web-runs");
const fixtureWorkspace = join(tempRoot, "fixture-workspace");
await mkdir(stateDir, { recursive: true, mode: 0o700 });
await mkdir(webRunsDir, { recursive: true, mode: 0o700 });
await mkdir(fixtureWorkspace, { recursive: true, mode: 0o700 });
await writeFile(join(fixtureWorkspace, "README.txt"), "Local visual verification fixture. No task is executed.\n");
// Keep updates explicitly unavailable in this isolated state. Every other plugin
// retains its bundled default, including automation and extensions.
await writeFile(join(stateDir, "plugin-state.json"), JSON.stringify({
  apiVersion: 1,
  enabled: { updates: false, desktop: false, browser: false },
}));

const port = await reservePort();
const baseUrl = `http://127.0.0.1:${port}`;
const serverLogs = [];
const serverProcess = spawn(process.env.PYTHON || "python3", [
  "-m", "xueness.web", "--host", "127.0.0.1", "--port", String(port),
  "--state", stateDir, "--web-runs", webRunsDir, "--workspace-root", fixtureWorkspace,
], {
  cwd: projectRoot,
  env: {
    ...process.env,
    XUENESS_ALLOW_REAL: "0",
    XUENESS_MARKETPLACE_URL: "",
    XUENESS_WORKSPACE_ROOTS: "",
    PYTHONUNBUFFERED: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
serverProcess.stdout.on("data", chunk => serverLogs.push(String(chunk)));
serverProcess.stderr.on("data", chunk => serverLogs.push(String(chunk)));

let browser;
const state = { fixtureAutomationIds: [], externalRequests: [], pages: [], requestLog: [] };
const summary = {
  server: baseUrl,
  stateDirectory: stateDir,
  distDirectory: distRoot,
  distBuiltAt: distStat.mtime.toISOString(),
  productionAssets: assetRefs,
  browserChannel,
  screenshots: [],
  views: [],
  fixtureAutomationIds: state.fixtureAutomationIds,
  browserExternalRequests: state.externalRequests,
  mutationsFromUi: state.requestLog,
};

try {
  await waitForHealth(baseUrl, serverProcess, serverLogs);
  browser = await chromium.launch({ channel: browserChannel, headless: true });

  const pages = [];
  for (const view of matrix) {
    const context = await browser.newContext({
      viewport: { width: view.width, height: view.height },
      colorScheme: view.scheme,
      serviceWorkers: "block",
      reducedMotion: "reduce",
    });
    await context.addInitScript(({ scheme }) => {
      localStorage.setItem("xueness.theme", scheme);
    }, { scheme: view.scheme });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));
    page.on("console", message => {
      if (message.type() === "error") errors.push(`console: ${message.text()}`);
    });
    page.on("request", request => {
      if (request.method() !== "GET" && request.method() !== "HEAD") {
        state.requestLog.push({ viewport: sizeName(view), scheme: view.scheme, method: request.method(), path: new URL(request.url()).pathname });
      }
    });
    await page.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.origin === baseUrl) {
        await route.continue();
      } else {
        state.externalRequests.push(url.href);
        await route.abort();
      }
    });
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.getByTestId("xn-shell-sidebar").waitFor({ state: "attached", timeout: 20_000 });
    await page.waitForFunction(() => document.documentElement.dataset.xnTheme === "light" || document.documentElement.dataset.xnTheme === "dark");
    assert.equal(await page.locator("html").getAttribute("data-xn-theme"), view.scheme,
      `The ${view.scheme} browser appearance should be applied by the production app`);
    pages.push({ view, context, page, errors });
  }
  state.pages = pages;

  // Verify the real empty state, the keyboard-safe creation form, and off-peak
  // settings in every appearance/viewport pair before adding fixture records.
  for (const item of pages) {
    const { page, view } = item;
    const automation = await navigateTo(page, view, "automations", "automations-panel");
    await page.waitForFunction(() => {
      const text = document.querySelector("[data-testid='automation-overview']")?.textContent || "";
      return text.includes("0") && !document.querySelector("[role='status']")?.textContent?.includes("加载");
    }, null, { timeout: 15_000 }).catch(() => {});
    await page.getByText("没有配置自动化").waitFor({ state: "visible", timeout: 15_000 });
    await capture(page, view, "automation-empty", summary);

    await automation.getByRole("button", { name: "新建定时计划" }).first().click();
    const form = automation.locator("form.xn-automation__form").first();
    await form.waitFor({ state: "visible" });
    const nameInput = form.getByLabel("名称", { exact: true });
    await nameInput.focus();
    assert.equal(await nameInput.evaluate(element => document.activeElement === element), true, "The new schedule name field should accept focus");
    const before = await nameInput.inputValue();
    const imeDidNotSubmit = await nameInput.evaluate(element => {
      const event = new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, isComposing: true, bubbles: true, cancelable: true });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    });
    assert.equal(imeDidNotSubmit, false, "The form does not swallow composed input events");
    assert.equal(await nameInput.inputValue(), before, "IME confirmation must not insert or submit fixture data");
    assert.equal(await form.isVisible(), true, "IME confirmation must leave the form open");
    await capture(page, view, "automation-create-form", summary);
    await form.getByRole("button", { name: "取消" }).first().click();
    await form.waitFor({ state: "detached" });

    const offPeak = page.getByTestId("offpeak-panel");
    await offPeak.waitFor({ state: "visible" });
    await page.getByText("队列是空的").waitFor({ state: "visible", timeout: 15_000 });
    await capture(page, view, "offpeak-empty", summary);
    await offPeak.getByRole("button", { name: "设置闲时窗口" }).click();
    await offPeak.getByRole("heading", { name: "闲时窗口" }).waitFor({ state: "visible" });
    assert.equal(await offPeak.locator("form").count(), 1, "Off-peak settings form should be visible");
    await capture(page, view, "offpeak-settings", summary);
    await offPeak.getByRole("button", { name: "取消" }).click();
    assert.equal(await offPeak.locator("form").count(), 0, "Cancel should leave off-peak settings unchanged");
  }

  const fixtureAutomation = record => ({
    name: record.name,
    schedule: "0 9 * * 1-5",
    timezone: "UTC",
    enabled: record.enabled,
    workflow: {
      root: fixtureWorkspace,
      name: `${record.name} fixture workflow`,
      nodes: [{ id: "step-1", kind: "agent", prompt: "Fixture only; never run this automation.", cwd: ".", timeout: 300 }],
      concurrency: 1,
    },
  });
  const approvedFixture = await apiCreateAutomation(baseUrl, state, fixtureAutomation({ name: "Weekday planning", enabled: false }));
  await apiApproveAutomation(baseUrl, approvedFixture);
  await apiCreateAutomation(baseUrl, state, fixtureAutomation({ name: "Morning review", enabled: true, approved: false }));

  for (const item of pages) {
    const { page, view } = item;
    const automation = await navigateTo(page, view, "automations", "automations-panel");
    await automation.getByRole("button", { name: "刷新" }).first().click();
    await page.getByRole("heading", { name: "Weekday planning" }).waitFor({ state: "visible", timeout: 15_000 });
    await page.getByRole("heading", { name: "Morning review" }).waitFor({ state: "visible", timeout: 15_000 });
    assert.equal(await automation.locator(".xn-automation__card").count(), 2, "Two trusted fixture records should render as schedule cards");
    await capture(page, view, "automation-seeded-cards", summary);

    const firstCard = automation.locator(".xn-automation__list > .xn-automation__card").first();
    assert.match(await firstCard.innerText(), /已暂停/);
    assert.match(await firstCard.innerText(), /计划已批准/);
    assert.match(await firstCard.innerText(), /下次运行/);
    await firstCard.getByRole("button", { name: "查看详情和历史" }).click();
    const detail = page.getByTestId("automation-detail");
    await detail.waitFor({ state: "visible" });
    await capture(page, view, "automation-detail", summary);

    await detail.getByRole("button", { name: "返回计划列表" }).click();
    await firstCard.getByRole("button", { name: "立即运行" }).click();
    const dialog = page.getByRole("alertdialog");
    await dialog.waitFor({ state: "visible" });
    const cancel = dialog.getByRole("button", { name: "取消" });
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "取消");
    const imeEscapeResult = await cancel.evaluate(element => {
      const event = new KeyboardEvent("keydown", { key: "Escape", keyCode: 229, isComposing: true, bubbles: true, cancelable: true });
      element.dispatchEvent(event);
      return { defaultPrevented: event.defaultPrevented, dialogOpen: Boolean(document.querySelector("[role='alertdialog']")) };
    });
    assert.equal(imeEscapeResult.dialogOpen, true, "Composing Escape must leave the run confirmation open");
    await capture(page, view, "automation-run-confirm", summary);
    await cancel.click();
    await dialog.waitFor({ state: "detached" });
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "立即运行", null, { timeout: 2_000 });
    assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "立即运行",
      "Dismissing the confirmation should restore focus to its opener");
    const runMutations = state.requestLog.filter(request => request.path.endsWith("/run"));
    assert.equal(runMutations.length, 0, "Cancelling run confirmation must not start a workflow");

    const marketplace = await navigateTo(page, view, "marketplace", "marketplace-panel");
    await page.getByTestId("marketplace-card").first().waitFor({ state: "visible", timeout: 15_000 });
    assert.ok(await page.getByTestId("marketplace-card").count() >= 1, "Bundled trusted marketplace catalog should provide cards");
    if (view.width === 1280) {
      const padding = await marketplace.evaluate(element => Number.parseFloat(getComputedStyle(element).paddingLeft));
      assert.ok(padding >= 24, `Wide marketplace left padding should be at least 24px (received ${padding}px)`);
    }
    await capture(page, view, "marketplace-cards", summary);

    await page.getByTestId("marketplace-card-detail").first().click();
    const marketDetail = page.getByTestId("marketplace-detail");
    await marketDetail.waitFor({ state: "visible" });
    await capture(page, view, "marketplace-detail", summary);
    const installButton = page.getByTestId("marketplace-detail-install");
    await installButton.click();
    const installDialog = page.getByTestId("marketplace-confirm-dialog");
    await installDialog.waitFor({ state: "visible" });
    const installCancel = installDialog.getByRole("button", { name: "取消" });
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "取消");
    const marketImeEscapeResult = await installCancel.evaluate(element => {
      const event = new KeyboardEvent("keydown", { key: "Escape", keyCode: 229, isComposing: true, bubbles: true, cancelable: true });
      element.dispatchEvent(event);
      return Boolean(document.querySelector("[data-testid='marketplace-confirm-dialog']"));
    });
    assert.equal(marketImeEscapeResult, true, "Composing Escape must leave the marketplace confirmation open");
    await capture(page, view, "marketplace-install-confirm", summary);
    await installCancel.click();
    await installDialog.waitFor({ state: "detached" });
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "marketplace-detail-install");
    assert.equal(await page.getByTestId("marketplace-detail").count(), 1, "Cancelling install should keep the detail view open");
    const installMutations = state.requestLog.filter(request => request.path.includes("/api/plugins/marketplace/") && /\/(install|update)$/.test(request.path));
    assert.equal(installMutations.length, 0, "Cancelling install confirmation must not install a manifest");

    await assertNoHorizontalOverflow(page, view, "marketplace-install-cancelled");
  }

  assert.deepEqual(state.externalRequests, [], "Browser must not reach services outside the local loopback server");
  assert.deepEqual(pages.flatMap(item => item.errors), [], "Production pages must have no console errors or uncaught exceptions");
  summary.fixtureAutomationIds = [...state.fixtureAutomationIds];
  summary.browserExternalRequests = [...state.externalRequests];
  summary.mutationsFromUi = [...state.requestLog];
  summary.pageErrors = pages.flatMap(item => item.errors);
  summary.result = "passed";
  const summaryPath = join(outputRoot, "automation-marketplace-geometry.json");
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`Production automation and marketplace browser verification passed using ${browserChannel} Chrome.`);
  console.log(`Captured ${summary.screenshots.length} screenshots and geometry at ${summaryPath}`);
} catch (error) {
  summary.fixtureAutomationIds = [...state.fixtureAutomationIds];
  summary.browserExternalRequests = [...state.externalRequests];
  summary.mutationsFromUi = [...state.requestLog];
  summary.pageErrors = state.pages.flatMap(item => item.errors);
  summary.result = "failed";
  summary.failure = String(error?.stack || error);
  await writeFile(join(outputRoot, "automation-marketplace-geometry.json"), `${JSON.stringify(summary, null, 2)}\n`).catch(() => {});
  throw error;
} finally {
  let cleanupError;
  try { await browser?.close(); } catch (error) { cleanupError = error; }
  if (serverProcess.exitCode === null) {
    serverProcess.kill("SIGTERM");
    await new Promise(resolveExit => {
      if (serverProcess.exitCode !== null) return resolveExit();
      const timeout = setTimeout(() => { serverProcess.kill("SIGKILL"); resolveExit(); }, 5_000);
      serverProcess.once("exit", () => { clearTimeout(timeout); resolveExit(); });
    });
  }
  try { await rm(tempRoot, { recursive: true, force: true }); } catch (error) { cleanupError ??= error; }
  if (cleanupError) throw cleanupError;
}
