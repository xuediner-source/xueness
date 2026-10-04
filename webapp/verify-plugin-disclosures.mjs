#!/usr/bin/env node
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const webappRoot = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(webappRoot, "../xueness/bundled_plugins");
const browserChannel = process.env.PLAYWRIGHT_CHANNEL?.trim() || "chrome";

async function loadCatalog() {
  const entries = await readdir(pluginRoot, { withFileTypes: true });
  const catalog = [];
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const manifestPath = join(pluginRoot, entry.name, "manifest.json");
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw new Error(`Could not read plugin manifest ${manifestPath}: ${error.message}`, { cause: error });
    }
    assert.equal(typeof manifest.id, "string", `${manifestPath} must have an id`);
    catalog.push({
      ...manifest,
      enabled: Boolean(manifest.defaultEnabled),
      effective: Boolean(manifest.defaultEnabled),
      blockedBy: [],
    });
  }
  assert.ok(catalog.length > 0, `No plugin manifests found in ${pluginRoot}`);
  assert.ok(catalog.some((plugin) => detailCount(plugin) > 0), "Plugin catalog has no expandable details");
  return catalog;
}

function detailCount(plugin) {
  return (Array.isArray(plugin.features) ? plugin.features.length : 0) +
    (Array.isArray(plugin.tools) ? plugin.tools.length : 0) +
    (Array.isArray(plugin.commands) ? plugin.commands.length : 0);
}

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

async function waitForDetails(page, expectedCount, open) {
  await page.waitForFunction(({ count, isOpen }) => {
    const details = [...document.querySelectorAll("details[data-testid^='xn-plugin-details-']")];
    return details.length === count && details.every((item) => item.open === isOpen);
  }, { count: expectedCount, isOpen: open });
}

async function waitForOneDetail(page, testId, open) {
  await page.waitForFunction(({ id, isOpen }) => document.querySelector(`[data-testid="${CSS.escape(id)}"]`)?.open === isOpen,
    { id: testId, isOpen: open });
}

const catalog = await loadCatalog();
const expandablePlugins = catalog.filter((plugin) => detailCount(plugin) > 0);
const target = expandablePlugins.find((plugin) => Array.isArray(plugin.features) && plugin.features.length > 0);
assert.ok(target, "Catalog needs at least one feature so search-forced-open behavior can be tested");
const targetFeature = target.features[0];
assert.equal(typeof targetFeature.id, "string", `${target.id} feature needs a searchable id`);

const tempRoot = await mkdtemp(join(tmpdir(), "xueness-plugin-disclosures-"));
let server;
let browser;
try {
  const harnessPath = join(tempRoot, "harness.tsx");
  const bundlePath = join(tempRoot, "harness.js");
  const htmlPath = join(tempRoot, "index.html");
  const managerPath = resolve(webappRoot, "src/XuenessPluginManager.tsx");
  const catalogSource = JSON.stringify(catalog).replaceAll("<", "\\u003c");
  await writeFile(harnessPath, `
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { XuenessPluginManager } from ${JSON.stringify(managerPath)};
    const plugins = ${catalogSource};
    createRoot(document.getElementById("root")).render(React.createElement(XuenessPluginManager, {
      plugins, loading: false, error: "", onRefresh: async () => {}, onToggle: async () => {},
    }));
  `);
  await writeFile(htmlPath, `<!doctype html>
    <html lang="zh-CN"><head><meta charset="utf-8"><title>Plugin disclosure regression</title></head>
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
    if (url.hostname === "127.0.0.1" && url.port === String(port) && !url.pathname.startsWith("/api/")) {
      return route.continue();
    }
    blockedRequests.push(url.href);
    return route.abort();
  });
  await page.goto(`http://127.0.0.1:${port}/`);

  const allDetails = page.locator("details[data-testid^='xn-plugin-details-']");
  const expectedDetails = expandablePlugins.length;
  const allToggle = page.locator(".xn-plugins__details-toggle");
  await page.waitForFunction((count) => document.querySelectorAll("details[data-testid^='xn-plugin-details-']").length === count,
    expectedDetails);
  assert.equal(await allDetails.evaluateAll((nodes) => nodes.filter((node) => node.open).length), 0, "Catalog starts collapsed");

  await allToggle.click();
  await waitForDetails(page, expectedDetails, true);
  await page.waitForTimeout(300); // Allow native, deferred <details> toggle events to run.
  await waitForDetails(page, expectedDetails, true);
  assert.equal((await allToggle.textContent()).trim(), "折叠全部");

  await allToggle.click();
  await waitForDetails(page, expectedDetails, false);
  await page.waitForTimeout(1000); // A stale expansion event must not reopen any card.
  await waitForDetails(page, expectedDetails, false);
  assert.equal((await allToggle.textContent()).trim(), "展开全部");

  const targetDetails = page.getByTestId(`xn-plugin-details-${target.id}`);
  const targetSummary = targetDetails.locator("summary");
  await targetSummary.click();
  await waitForOneDetail(page, `xn-plugin-details-${target.id}`, true);
  await page.waitForTimeout(150);
  assert.equal(await allDetails.evaluateAll((nodes) => nodes.filter((node) => node.open).length), 1,
    "A manual summary click opens only its own plugin details");
  await targetSummary.click();
  await waitForOneDetail(page, `xn-plugin-details-${target.id}`, false);

  const search = page.locator("input[type='search']");
  await search.fill(targetFeature.id);
  await waitForOneDetail(page, `xn-plugin-details-${target.id}`, true);
  await targetSummary.click();
  await page.waitForTimeout(150);
  assert.equal(await targetDetails.evaluate((node) => node.open), true, "Search-matched details stay forced open");
  await search.fill("");
  await waitForDetails(page, expectedDetails, false);

  await targetSummary.focus();
  await page.keyboard.press("Enter");
  await waitForOneDetail(page, `xn-plugin-details-${target.id}`, true);
  await page.keyboard.press("Space");
  await waitForOneDetail(page, `xn-plugin-details-${target.id}`, false);

  for (const key of ["Enter", " "]) {
    const prevented = await targetSummary.evaluate((element, activationKey) => {
      const event = new KeyboardEvent("keydown", {
        key: activationKey, keyCode: 229, isComposing: true, bubbles: true, cancelable: true,
      });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    }, key);
    assert.equal(prevented, true, `IME composition must suppress ${key === " " ? "Space" : key}`);
    assert.equal(await targetDetails.evaluate((node) => node.open), false, "IME keys do not change disclosure state");
  }

  assert.deepEqual(blockedRequests, [], "Harness must not request external services or API routes");
  assert.deepEqual(pageErrors, [], "Browser harness must finish without runtime errors");
  console.log(`Plugin disclosure browser regression passed using ${catalog.length} real manifests and ${browserChannel} Chrome.`);
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
