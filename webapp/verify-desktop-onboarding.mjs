#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const webappRoot = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(webappRoot, "..");
const distRoot = join(webappRoot, "dist");
const outputRoot = "/tmp/xueness-onboarding-review-20261006";
const browserChannel = process.env.PLAYWRIGHT_CHANNEL?.trim() || "chrome";
const desktopToken = "a".repeat(64);
const matrix = [
  { scheme: "light", width: 1280, height: 900 },
  { scheme: "dark", width: 1280, height: 900 },
  { scheme: "light", width: 420, height: 860 },
  { scheme: "dark", width: 420, height: 860 },
];
const pluginIds = [
  "sessions", "files", "shell", "planning", "providers", "memory", "settings", "usage", "git", "workflows",
  "terminal", "office", "commands", "skills", "hooks", "mcp", "subagents", "network", "automation", "extensions",
  "diagnostics", "browser", "remote", "bots", "onboarding", "updates", "desktop", "tools",
];
const enabledPlugins = new Set(["sessions", "providers", "settings", "onboarding", "desktop"]);
const permissionPath = "/api/desktop/permissions";
const permissionRequestPath = "/api/desktop/permissions/request";
const onboardingPath = "/api/onboarding/desktop";
const cjkPattern = /[\u3400-\u9fff\uf900-\ufaff]/;

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

async function waitForHealth(url, processHandle, logs, token) {
  const until = Date.now() + 30_000;
  let lastError;
  while (Date.now() < until) {
    if (processHandle.exitCode !== null) {
      throw new Error(`Xueness test server exited (${processHandle.exitCode}):\n${logs.join("")}`);
    }
    try {
      const response = await fetch(`${url}/api/health`, {
        headers: { "X-Xueness-Desktop-Token": token },
        signal: AbortSignal.timeout(1_500),
      });
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

function requestRows(state, path, method) {
  return state.requestLog.filter(row => row.path === path && (!method || row.method === method));
}

function permissionReadsForView(state, view) {
  return requestRows(state, permissionPath, "GET").filter(row => row.viewport === sizeName(view) && row.scheme === view.scheme).length;
}

async function replacePermissionStatusFixture(path, value) {
  const temporaryPath = `${path}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(value)}\n`);
  await rename(temporaryPath, path);
}

function assertEnglish(value, description) {
  assert.equal(cjkPattern.test(value), false, `${description} contains CJK text: ${value}`);
}

async function assertVisibleGeometry(page, view, step, summary) {
  const geometry = await page.evaluate(() => {
    const dialog = document.querySelector(".xn-desktop-permission");
    const backdrop = document.querySelector(".xn-desktop-permission__backdrop");
    if (!dialog || !backdrop) return null;
    const rect = dialog.getBoundingClientRect();
    const actions = Array.from(dialog.querySelectorAll(".xn-desktop-permission__footer button, .xn-desktop-permission__request, .xn-desktop-permission__status-line button"));
    const buttons = actions.map(button => {
      const box = button.getBoundingClientRect();
      const style = getComputedStyle(button);
      return {
        text: button.textContent?.trim() ?? "",
        visible: style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0,
        x: Math.round(box.x * 10) / 10,
        y: Math.round(box.y * 10) / 10,
        right: Math.round(box.right * 10) / 10,
        bottom: Math.round(box.bottom * 10) / 10,
        disabled: button.disabled,
      };
    });
    const content = dialog.querySelector(".xn-desktop-permission__content");
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      dialogWidth: dialog.clientWidth,
      dialogScrollWidth: dialog.scrollWidth,
      contentWidth: content?.clientWidth ?? null,
      contentScrollWidth: content?.scrollWidth ?? null,
      leftGutter: Math.round(rect.left * 10) / 10,
      rightGutter: Math.round((window.innerWidth - rect.right) * 10) / 10,
      rootTheme: document.documentElement.dataset.xnTheme || null,
      lang: document.documentElement.lang,
      buttons,
      text: backdrop.innerText,
    };
  });
  assert.ok(geometry, `Onboarding dialog should be visible for step ${step}`);
  assert.equal(geometry.rootTheme, view.scheme, `Production ${view.scheme} appearance should be applied`);
  assert.equal(geometry.lang, "en", "English locale should be active in the production page");
  assert.ok(geometry.documentWidth <= geometry.viewportWidth + 1,
    `Step ${step} ${sizeName(view)} document overflows: ${JSON.stringify(geometry)}`);
  assert.ok(geometry.bodyWidth <= geometry.viewportWidth + 1,
    `Step ${step} ${sizeName(view)} body overflows: ${JSON.stringify(geometry)}`);
  assert.ok(geometry.dialogScrollWidth <= geometry.dialogWidth + 1,
    `Step ${step} ${sizeName(view)} dialog overflows horizontally: ${JSON.stringify(geometry)}`);
  assert.ok(geometry.contentScrollWidth <= geometry.contentWidth + 1,
    `Step ${step} ${sizeName(view)} content overflows horizontally: ${JSON.stringify(geometry)}`);
  const gutter = view.width <= 680 ? 10 : 24;
  assert.ok(geometry.leftGutter >= gutter - 1 && geometry.rightGutter >= gutter - 1,
    `Step ${step} ${sizeName(view)} needs at least ${gutter}px outer gutter: ${JSON.stringify(geometry)}`);
  assert.ok(geometry.buttons.length >= 2, `Step ${step} should expose visible footer actions`);
  for (const button of geometry.buttons) {
    assert.ok(button.visible, `Step ${step} has a hidden action button: ${JSON.stringify(button)}`);
    assert.ok(button.x >= -1 && button.right <= geometry.viewportWidth + 1
      && button.y >= -1 && button.bottom <= geometry.viewportHeight + 1,
    `Step ${step} action button is outside the viewport: ${JSON.stringify(button)}`);
  }
  assertEnglish(geometry.text, `English onboarding step ${step} at ${sizeName(view)}`);
  summary.views.push({ step, scheme: view.scheme, viewport: sizeName(view), ...geometry, text: undefined });
  return geometry;
}

async function captureStep(page, view, step, summary) {
  await page.getByTestId("desktop-permission-onboarding").waitFor({ state: "visible" });
  const geometry = await assertVisibleGeometry(page, view, step, summary);
  const screenshotPath = join(outputRoot, `onboarding-step-${step}-${view.scheme}-${sizeName(view)}.png`);
  await page.screenshot({ path: screenshotPath, animations: "disabled" });
  summary.screenshots.push(screenshotPath);
  return geometry;
}

async function getOnboardingState(page) {
  return page.evaluate(async path => {
    const response = await fetch(path, { headers: { Accept: "application/json" }, cache: "no-store" });
    return { status: response.status, body: await response.json() };
  }, onboardingPath);
}

async function setPluginEnabled(page, id, enabled) {
  return page.evaluate(async ({ id, enabled }) => {
    const csrfResponse = await fetch("/api/csrf", { cache: "no-store" });
    const { csrfToken } = await csrfResponse.json();
    const response = await fetch(`/api/plugins/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ enabled }),
    });
    let body;
    try { body = await response.json(); } catch { body = null; }
    return { status: response.status, body };
  }, { id, enabled });
}

const serverSource = String.raw`
from pathlib import Path
import json
import sys
import threading

from xueness import web
from xueness.bundled_plugins.desktop.permissions import bind_permissions
from xueness.bundled_plugins.onboarding import desktop_setup

state_dir, web_runs, workspace, dist_dir, bridge_log, bridge_status_path = map(Path, sys.argv[1:])
token = 'a' * 64
snapshot = {
    'platform': 'darwin',
    'permissions': [
        {'id': 'accessibility', 'status': 'not-determined', 'canRequest': True},
        {'id': 'screen', 'status': 'denied', 'canRequest': True},
        # Deliberately hostile fixture: the host claims this, but no code may probe it.
        {'id': 'fullDisk', 'status': 'granted', 'canRequest': True},
        {'id': 'microphone', 'status': 'not-determined', 'canRequest': True},
    ],
}
log_lock = threading.Lock()

class FixtureBridge:
    def request(self, message, timeout=30):
        if not isinstance(message, dict) or message.get('type') != 'permissions':
            raise ValueError('unexpected private bridge message')
        action = message.get('action')
        if action == 'status' and set(message) == {'type', 'action'}:
            pass
        elif action == 'request' and set(message) == {'type', 'action', 'permission'} and message['permission'] in ('accessibility', 'screen', 'fullDisk', 'microphone'):
            pass
        else:
            raise ValueError('private permission protocol contract mismatch')
        with log_lock, bridge_log.open('a', encoding='utf-8') as stream:
            stream.write(json.dumps(message, separators=(',', ':')) + '\n')
        current_snapshot = json.loads(bridge_status_path.read_text(encoding='utf-8'))
        return {'id': '0123456789abcdef0123456789abcdef', 'state': current_snapshot}

ctx = web.build_context(state_dir, web_runs, workspace, allow_real=False)
ctx['desktop_token'] = token
ctx['webapp_dir'] = dist_dir.resolve()
bind_permissions(ctx, FixtureBridge())

# Exercise a failed real persistence response once, then leave the production
# handler and atomic write path intact for the retry.
atomic_write = desktop_setup._atomic_write_json
failure = {'remaining': 1}
def fail_first_onboarding_write(path, value):
    if Path(path).name == 'desktop-onboarding.json' and failure['remaining']:
        failure['remaining'] -= 1
        raise OSError('verification fixture write failure')
    return atomic_write(path, value)
desktop_setup._atomic_write_json = fail_first_onboarding_write

server = web.create_server(0, ctx, host='127.0.0.1')
def serve():
    server.serve_forever(poll_interval=0.1)
thread = threading.Thread(target=serve, daemon=True)
thread.start()
print(json.dumps({'ready': True, 'port': server.server_address[1]}), flush=True)
try:
    for line in sys.stdin:
        if line.strip() == 'shutdown':
            break
finally:
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)
`;

const distStat = await stat(join(distRoot, "index.html")).catch(() => null);
assert.ok(distStat?.isFile(), `Build the production webapp first; missing ${join(distRoot, "index.html")}`);
const distHtml = await readFile(join(distRoot, "index.html"), "utf8");
const assetRefs = [...distHtml.matchAll(/(?:src|href)="([^\"]*\/assets\/[^\"]+)"/g)].map(match => match[1]);
assert.ok(assetRefs.some(asset => asset.endsWith(".js")), "Production dist must reference a JavaScript bundle");
assert.ok(assetRefs.some(asset => asset.endsWith(".css")), "Production dist must reference a CSS bundle");

await mkdir(outputRoot, { recursive: true });
const tempRoot = await mkdtemp(join(tmpdir(), "xueness-desktop-onboarding-browser-"));
const stateDir = join(tempRoot, "state");
const webRunsDir = join(tempRoot, "web-runs");
const fixtureWorkspace = join(tempRoot, "fixture-workspace");
await mkdir(stateDir, { recursive: true, mode: 0o700 });
await mkdir(webRunsDir, { recursive: true, mode: 0o700 });
await mkdir(fixtureWorkspace, { recursive: true, mode: 0o700 });
await writeFile(join(fixtureWorkspace, "README.txt"), "Isolated visual verification fixture. No task is executed.\n");
const switches = Object.fromEntries(pluginIds.map(id => [id, enabledPlugins.has(id)]));
switches.updates = false;
await writeFile(join(stateDir, "plugin-state.json"), JSON.stringify({ apiVersion: 1, enabled: switches }));
const serverScript = join(tempRoot, "desktop-onboarding-server.py");
const bridgeLog = join(tempRoot, "permission-bridge.jsonl");
const bridgeStatusPath = join(tempRoot, "permission-status.json");
const bridgeStatusFixture = {
  platform: "darwin",
  permissions: [
    { id: "accessibility", status: "not-determined", canRequest: true },
    { id: "screen", status: "denied", canRequest: true, requiresRestart: true },
    { id: "fullDisk", status: "granted", canRequest: true },
    { id: "microphone", status: "not-determined", canRequest: true },
  ],
};
await writeFile(bridgeStatusPath, JSON.stringify(bridgeStatusFixture));
await writeFile(serverScript, serverSource);
const serverLogs = [];
const serverProcess = spawn(process.env.PYTHON || "python3", [serverScript, stateDir, webRunsDir, fixtureWorkspace, distRoot, bridgeLog, bridgeStatusPath], {
  cwd: projectRoot,
  env: {
    ...process.env,
    XUENESS_ALLOW_REAL: "0",
    XUENESS_MARKETPLACE_URL: "",
    XUENESS_WORKSPACE_ROOTS: "",
    PYTHONPATH: [projectRoot, process.env.PYTHONPATH].filter(Boolean).join(process.platform === "win32" ? ";" : ":"),
    PYTHONUNBUFFERED: "1",
  },
  stdio: ["pipe", "pipe", "pipe"],
});
serverProcess.stdout.on("data", chunk => serverLogs.push(String(chunk)));
serverProcess.stderr.on("data", chunk => serverLogs.push(String(chunk)));

let browser;
const state = { externalRequests: [], requestLog: [], responseLog: [], expectedConsoleErrors: [], pages: [] };
const summary = {
  distDirectory: distRoot,
  distBuiltAt: distStat.mtime.toISOString(),
  productionAssets: assetRefs,
  serverIsolation: "temporary state and workspace; updates disabled; allow_real false",
  browserChannel,
  desktopToken: "a repeated 64-character fixture token was sent in the desktop auth header",
  fixturePlatform: "darwin",
  fixturePermissionStatuses: {
    accessibility: "not-determined",
    screen: "denied",
    fullDisk: "granted (deliberately dishonest fixture; UI must normalize to unknown)",
    microphone: "not-determined",
  },
  fixtureStatusesAreMocked: true,
  noNativeOSPermissionAPIsWereCalled: true,
  screenshots: [],
  views: [],
  mutationsFromUi: state.requestLog,
  browserExternalRequests: state.externalRequests,
};

let baseUrl;
try {
  const startup = new Promise((resolveReady, rejectReady) => {
    let pending = "";
    const onData = chunk => {
      pending += String(chunk);
      const newline = pending.indexOf("\n");
      if (newline < 0) return;
      const line = pending.slice(0, newline);
      try {
        const ready = JSON.parse(line);
        serverProcess.stdout.off("data", onData);
        resolveReady(ready);
      } catch (error) {
        rejectReady(new Error(`Invalid server startup response: ${line}\n${String(error)}`));
      }
    };
    serverProcess.stdout.on("data", onData);
    serverProcess.once("exit", code => rejectReady(new Error(`Server exited before startup (${code}):\n${serverLogs.join("")}`)));
    setTimeout(() => rejectReady(new Error(`Server startup timed out:\n${serverLogs.join("")}`)), 30_000).unref();
  });
  const ready = await startup;
  assert.equal(ready.ready, true, "Isolated production server should report ready");
  baseUrl = `http://127.0.0.1:${ready.port}`;
  await waitForHealth(baseUrl, serverProcess, serverLogs, desktopToken);
  browser = await chromium.launch({ channel: browserChannel, headless: true });

  const pages = [];
  for (const view of matrix) {
    const context = await browser.newContext({
      viewport: { width: view.width, height: view.height },
      colorScheme: view.scheme,
      extraHTTPHeaders: { "X-Xueness-Desktop-Token": desktopToken },
      serviceWorkers: "block",
      reducedMotion: "reduce",
    });
    await context.addInitScript(({ scheme }) => {
      localStorage.setItem("xueness.theme", scheme);
      localStorage.setItem("xueness.language", "en");
      window.__desktopPermissionFocusEvents = 0;
      window.addEventListener("focus", () => { window.__desktopPermissionFocusEvents += 1; });
    }, { scheme: view.scheme });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));
    page.on("console", message => {
      if (message.type() === "error") {
        const text = message.text();
        if (text === "Failed to load resource: the server responded with a status of 400 (Bad Request)") {
          state.expectedConsoleErrors.push({ viewport: sizeName(view), scheme: view.scheme, message: text });
        } else {
          errors.push(`console: ${text}`);
        }
      }
    });
    page.on("request", request => {
      const url = new URL(request.url());
      if (url.origin === baseUrl && url.pathname.startsWith("/api/")) {
        state.requestLog.push({ viewport: sizeName(view), scheme: view.scheme, method: request.method(), path: url.pathname, body: request.postData() });
      }
    });
    page.on("response", response => {
      const url = new URL(response.url());
      if (url.origin === baseUrl && url.pathname.startsWith("/api/")) {
        state.responseLog.push({ viewport: sizeName(view), scheme: view.scheme, status: response.status(), path: url.pathname });
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
    await page.goto(`${baseUrl}/?xuenessDesktop=1`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("xn-shell-sidebar").waitFor({ state: "attached", timeout: 20_000 });
    await page.getByTestId("desktop-permission-onboarding").waitFor({ state: "visible", timeout: 20_000 });
    await page.waitForFunction(() => Boolean(document.documentElement.dataset.xnTheme));
    const bootState = await page.evaluate(() => ({
      lang: document.documentElement.lang,
      theme: document.documentElement.dataset.xnTheme,
      localePreference: localStorage.getItem("xueness.language"),
      themePreference: localStorage.getItem("xueness.theme"),
    }));
    assert.equal(bootState.lang, "en", `English locale should be applied during document boot: ${JSON.stringify(bootState)}`);
    assert.equal(bootState.theme, view.scheme, `Requested ${view.scheme} theme should be applied during document boot: ${JSON.stringify(bootState)}`);
    pages.push({ view, context, page, errors });
  }
  state.pages = pages;
  const primary = pages.find(item => item.view.width === 1280 && item.view.scheme === "light");
  assert.ok(primary, "The wide light appearance should be present for interaction checks");

  // All four pages are opened against the same incomplete isolated state before
  // any completion write, so each real production layout is checked at steps 1–3.
  for (const item of pages) {
    const { page, view } = item;
    const dialog = page.getByTestId("desktop-permission-onboarding");
    await dialog.locator(".xn-desktop-permission__hero h2").waitFor({ state: "visible" });
    assert.equal(await dialog.locator(".xn-desktop-permission__hero h2").innerText(), "Accessibility and Screen Recording");
    assert.equal(await dialog.locator('[data-permission="accessibility"]').count(), 1);
    assert.equal(await dialog.locator('[data-permission="screen"]').count(), 1);
    const screen = dialog.locator('[data-permission="screen"]');
    await screen.locator('[data-permission-status="denied"]').waitFor({ state: "visible" });
    const restartHint = screen.locator("small");
    await restartHint.waitFor({ state: "visible" });
    assert.match(await restartHint.innerText(), /fully quit and reopen Xueness/i,
      "A native requiresRestart signal should offer a truthful manual restart hint");
    await captureStep(page, view, 1, summary);
  }
  assert.equal(requestRows(state, permissionRequestPath, "POST").length, 0,
    "The first-open guide must not send permission POST requests before an explicit permission click");
  assert.equal(requestRows(state, onboardingPath, "POST").length, 0,
    "Opening the guide must not mark onboarding complete");

  const focusEventsBeforeRefresh = await primary.page.evaluate(() => window.__desktopPermissionFocusEvents);
  const readsBeforeRefresh = permissionReadsForView(state, primary.view);
  const grantedPermissionFixture = {
    ...bridgeStatusFixture,
    permissions: bridgeStatusFixture.permissions.map(permission => permission.id === "screen"
      ? { id: "screen", status: "granted", canRequest: false }
      : permission),
  };
  await replacePermissionStatusFixture(bridgeStatusPath, grantedPermissionFixture);
  await primary.page.waitForFunction(() => document.querySelector('[data-permission="screen"] [data-permission-status="granted"]') !== null,
    null, { timeout: 5_000 });
  assert.equal(await primary.page.evaluate(() => window.__desktopPermissionFocusEvents), focusEventsBeforeRefresh,
    "The periodic status refresh should detect a changed native permission without a window focus event");
  assert.ok(permissionReadsForView(state, primary.view) > readsBeforeRefresh,
    "The changed screen permission must arrive through a later read-only status request");
  assert.equal(await primary.page.locator('[data-permission="screen"] small').count(), 0,
    "The restart hint should disappear once the native snapshot reports screen recording granted");

  for (const item of pages) {
    await item.page.getByTestId("desktop-permission-onboarding-continue").click();
    const dialog = item.page.getByTestId("desktop-permission-onboarding");
    await dialog.locator('[data-permission="fullDisk"]').waitFor({ state: "visible" });
    const fullDisk = dialog.locator('[data-permission="fullDisk"]');
    await fullDisk.locator('[data-permission-status="unknown"]').waitFor({ state: "visible" });
    assert.equal(await fullDisk.locator('[data-permission-status="granted"]').count(), 0,
      "A fixture host claim of Full Disk Access granted must never be displayed as granted");
    assert.match(await fullDisk.locator(".xn-desktop-permission__request").innerText(), /Open System Settings/,
      "macOS Full Disk Access must have a fixed System Settings action");
    await captureStep(item.page, item.view, 2, summary);
  }
  assert.equal(requestRows(state, permissionRequestPath, "POST").length, 0,
    "Advancing to Full Disk Access must not request permission implicitly");

  const fullDiskButton = primary.page.locator('[data-permission="fullDisk"] .xn-desktop-permission__request');
  await fullDiskButton.click();
  await primary.page.waitForFunction(() => document.querySelectorAll("[data-permission='fullDisk'] .xn-desktop-permission__request").length === 1
    && !document.querySelector("[data-permission='fullDisk'] .xn-desktop-permission__request").disabled);
  await primary.page.waitForFunction(() => window.performance.getEntriesByType("resource").some(entry => entry.name.includes("/api/desktop/permissions/request")));
  await primary.page.waitForTimeout(100);
  const fullDiskPosts = requestRows(state, permissionRequestPath, "POST");
  assert.equal(fullDiskPosts.length, 1, "One explicit Full Disk Access action should make one permission request");
  assert.deepEqual(JSON.parse(fullDiskPosts[0].body), { permission: "fullDisk" }, "Full Disk Access request body must contain only the permission id");
  await primary.page.getByTestId("desktop-permission-onboarding").locator('[data-permission="fullDisk"] [data-permission-status="unknown"]').waitFor({ state: "visible" });

  for (const item of pages) {
    await item.page.getByTestId("desktop-permission-onboarding-continue").click();
    const dialog = item.page.getByTestId("desktop-permission-onboarding");
    await dialog.locator('[data-permission="microphone"]').waitFor({ state: "visible" });
    const microphone = dialog.locator('[data-permission="microphone"]');
    await microphone.locator('[data-permission-status="not-determined"]').waitFor({ state: "visible" });
    assert.equal(await microphone.locator(".xn-desktop-permission__request").innerText(), "Allow microphone");
    await captureStep(item.page, item.view, 3, summary);
  }
  assert.equal(requestRows(state, permissionRequestPath, "POST").length, 1,
    "Changing to the microphone step must not request permission without a click");
  for (const item of pages.filter(item => item !== primary)) {
    await item.page.getByRole("button", { name: "Later", exact: true }).click();
    await item.page.getByTestId("desktop-permission-onboarding").waitFor({ state: "detached" });
  }
  const dismissedPageReadCounts = new Map(pages.filter(item => item !== primary)
    .map(item => [item.page, permissionReadsForView(state, item.view)]));
  await primary.page.waitForTimeout(2_200);
  for (const item of pages.filter(item => item !== primary)) {
    assert.equal(permissionReadsForView(state, item.view), dismissedPageReadCounts.get(item.page),
      `Dismissed ${sizeName(item.view)} ${item.view.scheme} dialog must stop status polling`);
  }

  await primary.page.locator('[data-permission="microphone"] .xn-desktop-permission__request').click();
  await primary.page.waitForFunction(() => window.performance.getEntriesByType("resource").filter(entry => entry.name.includes("/api/desktop/permissions/request")).length >= 2);
  await primary.page.waitForTimeout(100);
  const permissionPosts = requestRows(state, permissionRequestPath, "POST");
  assert.equal(permissionPosts.length, 2, "Only the two explicit permission actions should POST permission requests");
  assert.deepEqual(permissionPosts.map(row => JSON.parse(row.body)), [
    { permission: "fullDisk" }, { permission: "microphone" },
  ], "Native permission HTTP requests must use the exact one-field contract");

  // The production persistence endpoint is made to fail once by the isolated
  // server fixture; the wizard must keep the modal open and permit a real retry.
  await primary.page.getByTestId("desktop-permission-onboarding-finish").click();
  const completionAlert = primary.page.getByTestId("desktop-permission-onboarding").getByRole("alert");
  await completionAlert.waitFor({ state: "visible", timeout: 10_000 });
  assertEnglish(await completionAlert.innerText(), "English completion failure message");
  await primary.page.getByTestId("desktop-permission-onboarding").waitFor({ state: "visible" });
  assert.equal(requestRows(state, onboardingPath, "POST").length, 1, "Failed finish should be an actual onboarding API write");
  await assertVisibleGeometry(primary.page, primary.view, 3, summary);
  await primary.page.getByTestId("desktop-permission-onboarding-finish").click();
  await primary.page.getByTestId("desktop-permission-onboarding").waitFor({ state: "detached", timeout: 10_000 });
  const finishState = await getOnboardingState(primary.page);
  assert.equal(finishState.status, 200);
  assert.deepEqual(finishState.body, { completed: true, version: 1 }, "Finish must persist through the actual onboarding API");
  assert.equal(requestRows(state, onboardingPath, "POST").length, 2, "Finish retry should persist once after the fixture failure");
  assert.equal(state.responseLog.filter(row => row.path === onboardingPath && row.status === 400).length, 1,
    "The isolated persistence fixture should produce exactly one failed completion response");
  assert.equal(state.expectedConsoleErrors.length, 1,
    "Only the browser console error caused by that single intentional 400 response may be classified as expected");
  assert.deepEqual(
    { viewport: state.expectedConsoleErrors[0].viewport, scheme: state.expectedConsoleErrors[0].scheme },
    { viewport: primary.view.width + "x" + primary.view.height, scheme: primary.view.scheme },
    "The classified console error must come from the page that triggered the failed completion write",
  );

  // Reopen from Settings > About and verify the actual focus trap, IME-safe
  // Escape behavior, ordinary Escape dismissal, and return focus to the opener.
  const openSettings = primary.page.getByRole("button", { name: "Open settings", exact: true });
  await openSettings.click();
  const extensionSections = primary.page.locator(".xn-settings-view__extensions");
  await extensionSections.waitFor({ state: "visible", timeout: 10_000 });
  if (await extensionSections.getAttribute("open") === null) await extensionSections.locator("summary").click();
  await primary.page.getByTestId("xn-settings-nav-about").waitFor({ state: "visible", timeout: 10_000 });
  await primary.page.getByTestId("xn-settings-nav-about").click();
  const reopen = primary.page.getByTestId("desktop-permissions-reopen");
  await reopen.waitFor({ state: "visible", timeout: 10_000 });
  const statusReadsBeforeReopen = requestRows(state, permissionPath, "GET").length;
  await reopen.click();
  const reopenedDialog = primary.page.getByTestId("desktop-permission-onboarding");
  await reopenedDialog.waitFor({ state: "visible" });
  await primary.page.waitForFunction(() => document.activeElement?.classList.contains("xn-desktop-permission__later"));
  await primary.page.waitForFunction(() => window.performance.getEntriesByType("resource").filter(entry => entry.name.includes("/api/desktop/permissions")).length > 0);
  await primary.page.waitForTimeout(150);
  assert.ok(requestRows(state, permissionPath, "GET").length > statusReadsBeforeReopen,
    "Reopening the permissions guide from About should refresh its native status snapshot");
  const lastDialogAction = reopenedDialog.getByTestId("desktop-permission-onboarding-continue");
  await lastDialogAction.focus();
  await primary.page.keyboard.press("Tab");
  assert.equal(await primary.page.evaluate(() => document.activeElement?.classList.contains("xn-desktop-permission__later")), true,
    "Tab from the last action should wrap to the first dialog action");
  await primary.page.keyboard.press("Shift+Tab");
  assert.equal(await primary.page.evaluate(() => document.activeElement?.getAttribute("data-testid") === "desktop-permission-onboarding-continue"), true,
    "Shift+Tab from the first action should wrap to the last dialog action");
  const imeEscape = await reopenedDialog.evaluate(element => {
    const event = new KeyboardEvent("keydown", { key: "Escape", keyCode: 229, isComposing: true, bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return { defaultPrevented: event.defaultPrevented, stillOpen: Boolean(document.querySelector("[data-testid='desktop-permission-onboarding']")) };
  });
  assert.deepEqual(imeEscape, { defaultPrevented: false, stillOpen: true }, "IME Escape must not dismiss the permission guide");
  await primary.page.keyboard.press("Escape");
  await reopenedDialog.waitFor({ state: "detached" });
  await primary.page.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "desktop-permissions-reopen");
  assert.equal(await primary.page.evaluate(() => document.activeElement?.getAttribute("data-testid")), "desktop-permissions-reopen",
    "Escape dismissal should restore focus to the About reopen control");
  const readsAfterDismissal = permissionReadsForView(state, primary.view);
  await primary.page.waitForTimeout(2_200);
  assert.equal(permissionReadsForView(state, primary.view), readsAfterDismissal,
    "Closing the guide from About must stop status polling");

  // A completed first-launch record survives reload and suppresses reopening.
  const permissionReadsBeforeCompletedReload = requestRows(state, permissionPath, "GET").length;
  await primary.page.reload({ waitUntil: "domcontentloaded" });
  await primary.page.getByTestId("xn-shell-sidebar").waitFor({ state: "attached", timeout: 20_000 });
  await primary.page.waitForTimeout(300);
  assert.equal(await primary.page.getByTestId("desktop-permission-onboarding").count(), 0,
    "A completed wizard must not reopen after reload");
  assert.equal(requestRows(state, onboardingPath, "GET").length >= 2, true,
    "Reload should consult the actual persisted onboarding API state");
  assert.equal(requestRows(state, permissionPath, "GET").length, permissionReadsBeforeCompletedReload,
    "A completed reload should not poll native permission status");
  const reloadedState = await getOnboardingState(primary.page);
  assert.deepEqual(reloadedState.body, { completed: true, version: 1 });

  // Reset only the disposable test state file so Skip all can be verified as a
  // separate first-launch completion path against the same production API.
  await unlink(join(stateDir, "desktop-onboarding.json"));
  await primary.page.reload({ waitUntil: "domcontentloaded" });
  await primary.page.getByTestId("desktop-permission-onboarding").waitFor({ state: "visible", timeout: 20_000 });
  const skipPostsBefore = requestRows(state, onboardingPath, "POST").length;
  await primary.page.getByTestId("desktop-permission-onboarding-skip-all").click();
  await primary.page.getByTestId("desktop-permission-onboarding").waitFor({ state: "detached", timeout: 10_000 });
  assert.equal(requestRows(state, onboardingPath, "POST").length, skipPostsBefore + 1,
    "Skip all should save completion using the onboarding API");
  const skipState = await getOnboardingState(primary.page);
  assert.equal(skipState.status, 200);
  assert.deepEqual(skipState.body, { completed: true, version: 1 }, "Skip all must persist through the actual onboarding API");
  const permissionReadsBeforeSkipReload = requestRows(state, permissionPath, "GET").length;
  await primary.page.reload({ waitUntil: "domcontentloaded" });
  await primary.page.getByTestId("xn-shell-sidebar").waitFor({ state: "attached", timeout: 20_000 });
  await primary.page.waitForTimeout(300);
  assert.equal(await primary.page.getByTestId("desktop-permission-onboarding").count(), 0,
    "Skip all completion must prevent reopening on reload");
  assert.equal(requestRows(state, permissionPath, "GET").length, permissionReadsBeforeSkipReload,
    "A skipped/completed reload should not poll native permission status");

  // Disable both owner plugins through their authenticated production endpoints;
  // after reload neither first-launch nor native permission routes may be read.
  for (const id of ["onboarding", "desktop"]) {
    const result = await setPluginEnabled(primary.page, id, false);
    assert.equal(result.status, 200, `Disabling ${id} in isolated plugin state should succeed: ${JSON.stringify(result.body)}`);
  }
  const featureRequestCountBeforeDisabledReload = state.requestLog.filter(row =>
    row.path === onboardingPath || row.path === permissionPath || row.path === permissionRequestPath).length;
  await primary.page.reload({ waitUntil: "domcontentloaded" });
  await primary.page.getByTestId("xn-shell-sidebar").waitFor({ state: "attached", timeout: 20_000 });
  await primary.page.waitForTimeout(2_200);
  assert.equal(await primary.page.getByTestId("desktop-permission-onboarding").count(), 0,
    "Disabled desktop/onboarding plugins must not mount the first-launch guide");
  const featureRequestsAfterDisabledReload = state.requestLog.filter(row =>
    row.path === onboardingPath || row.path === permissionPath || row.path === permissionRequestPath).length;
  assert.equal(featureRequestsAfterDisabledReload, featureRequestCountBeforeDisabledReload,
    "Disabled desktop/onboarding plugins must not start first-launch or permission requests/polls");
  const finalPluginState = JSON.parse(await readFile(join(stateDir, "plugin-state.json"), "utf8"));
  assert.equal(finalPluginState.enabled.onboarding, false);
  assert.equal(finalPluginState.enabled.desktop, false);
  assert.equal(finalPluginState.enabled.updates, false);

  const bridgeCalls = (await readFile(bridgeLog, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const nativeActions = bridgeCalls.filter(message => message.action === "request");
  assert.deepEqual(nativeActions, [
    { type: "permissions", action: "request", permission: "fullDisk" },
    { type: "permissions", action: "request", permission: "microphone" },
  ], "Only explicitly clicked, exact native bridge actions should be recorded by the mocked host");
  assert.deepEqual(state.externalRequests, [], "The browser must not reach services outside the loopback server");
  assert.deepEqual(pages.flatMap(item => item.errors), [], "Production pages should have no console errors or uncaught exceptions");
  summary.mutationsFromUi = [...state.requestLog];
  summary.browserExternalRequests = [...state.externalRequests];
  summary.mockPrivateBridgeCalls = bridgeCalls;
  summary.expectedFixtureConsoleErrors = [...state.expectedConsoleErrors];
  summary.expectedFixtureConsoleErrorMatchedResponse = {
    request: requestRows(state, onboardingPath, "POST")[0],
    response: state.responseLog.find(row => row.path === onboardingPath && row.status === 400),
  };
  summary.apiResponses = [...state.responseLog];
  summary.permissionHttpPosts = permissionPosts;
  summary.onboardingHttpPosts = requestRows(state, onboardingPath, "POST");
  summary.pageErrors = pages.flatMap(item => item.errors);
  summary.pluginDisableResults = { onboarding: "disabled", desktop: "disabled" };
  summary.result = "passed";
  const summaryPath = join(outputRoot, "onboarding-browser-verification.json");
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`Production desktop onboarding browser verification passed using headless ${browserChannel} Chrome.`);
  console.log(`Captured ${summary.screenshots.length} screenshots and fixture/API evidence at ${summaryPath}`);
} catch (error) {
  summary.mutationsFromUi = [...state.requestLog];
  summary.browserExternalRequests = [...state.externalRequests];
  summary.pageErrors = state.pages.flatMap(item => item.errors);
  summary.result = "failed";
  summary.failure = String(error?.stack || error);
  await writeFile(join(outputRoot, "onboarding-browser-verification.json"), `${JSON.stringify(summary, null, 2)}\n`).catch(() => {});
  throw error;
} finally {
  let cleanupError;
  try { await browser?.close(); } catch (error) { cleanupError = error; }
  if (serverProcess.exitCode === null) {
    serverProcess.stdin.write("shutdown\n");
    await new Promise(resolveExit => {
      if (serverProcess.exitCode !== null) return resolveExit();
      const timeout = setTimeout(() => { serverProcess.kill("SIGKILL"); resolveExit(); }, 5_000);
      serverProcess.once("exit", () => { clearTimeout(timeout); resolveExit(); });
    });
  }
  try { await rm(tempRoot, { recursive: true, force: true }); } catch (error) { cleanupError ??= error; }
  if (cleanupError) throw cleanupError;
}
