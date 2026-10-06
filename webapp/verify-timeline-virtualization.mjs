#!/usr/bin/env node
// 长会话时间线虚拟化的真实渲染核验：在临时目录用 esbuild 打包真实组件，
// 随机 loopback 端口本地渲染，Playwright(Chrome) 校验窗口化、滚动位置保持、
// 贴尾自动滚动与历史轨道跳转。无网络、无外部请求、不读取用户状态。
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
const TURNS = 200;
const APPEND_TURNS = 3;

function buildRows(turns, startIndex = 0) {
  const rows = [];
  for (let index = startIndex; index < startIndex + turns; index += 1) {
    rows.push({ kind: "user", seq: index * 2 + 1, turnId: `turn-${index}`, text: `第 ${index + 1} 条用户消息，用于长会话虚拟化核验。` });
    rows.push({
      kind: "assistant",
      seq: index * 2 + 2,
      turnId: `turn-${index}`,
      text: `第 ${index + 1} 条助手回复。${"这是一段较长的回复内容，用来让时间线条目具备真实可测的高度。".repeat(4)}`,
    });
  }
  return rows;
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

function fixtureStyle() {
  return `<style>
    html, body { margin: 0; }
    #root { height: 600px; }
    .xn-session-timeline-viewport { height: 100%; }
    .xn-session-timeline-viewport__scroll { height: 100%; overflow-y: auto; overflow-anchor: none; }
    .xn-timeline-stream { display: flex; flex-direction: column; gap: 12px; padding: 20px 16px 28px; }
    .xn-timeline-window-spacer { flex: none; }
    .xn-timeline-item { min-width: 0; }
    .xn-conversation-history-rail { position: fixed; right: 8px; top: 8px; display: flex; flex-direction: column; }
    .xn-conversation-history-rail__track { max-height: 220px; overflow-x: hidden; overflow-y: auto; }
  </style>`;
}

function harnessSource(rowsJson, options) {
  return `
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { ConversationTimelineViewport } from ${JSON.stringify(resolve(webappRoot, "src/plugins/sessions/ConversationTimelineViewport.tsx"))};
    import { TimelineStream } from ${JSON.stringify(resolve(webappRoot, "src/plugins/sessions/XuenessTimeline.tsx"))};
    const initialRows = ${rowsJson};
    function Fixture() {
      const [rows, setRows] = React.useState(initialRows);
      const [version, setVersion] = React.useState(0);
      const append = () => {
        const base = rows.length / 2;
        const extra = [];
        for (let index = base; index < base + ${APPEND_TURNS}; index += 1) {
          extra.push({ kind: "user", seq: index * 2 + 1, turnId: "turn-" + index, text: "追加的第 " + (index + 1) + " 条用户消息。" });
          extra.push({ kind: "assistant", seq: index * 2 + 2, turnId: "turn-" + index, text: "追加的第 " + (index + 1) + " 条助手回复，内容足够长以形成真实高度。".repeat(4) });
        }
        setRows((current) => [...current, ...extra]);
        setVersion((value) => value + 1);
      };
      return React.createElement(ConversationTimelineViewport, { autoScroll: true, rowsVersion: version },
        React.createElement(TimelineStream, { rows, virtualize: true, virtualizeFromTail: ${options.virtualizeFromTail} }),
        React.createElement("button", { type: "button", "data-testid": "append-rows", onClick: append }, "append"),
      );
    }
    createRoot(document.getElementById("root")).render(React.createElement(Fixture));
  `;
}

async function prepare(caseName, options) {
  const tempRoot = await mkdtemp(join(tmpdir(), `xn-timeline-${caseName}-`));
  const rowsJson = JSON.stringify(buildRows(options.turns)).replaceAll("<", "\\u003c");
  const harnessPath = join(tempRoot, "harness.tsx");
  const bundlePath = join(tempRoot, "harness.js");
  const htmlPath = join(tempRoot, "index.html");
  await writeFile(harnessPath, harnessSource(rowsJson, options));
  await writeFile(htmlPath, `<!doctype html>
    <html lang="zh-CN"><head><meta charset="utf-8"><title>Timeline virtualization regression</title>${fixtureStyle()}</head>
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
  const server = createServer(async (request, response) => {
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
  return { server, tempRoot };
}

async function settle(page) {
  await page.evaluate(() => new Promise((resolveFrame) => {
    requestAnimationFrame(() => requestAnimationFrame(resolveFrame));
  }));
}

const scrollerState = (page) => page.evaluate(() => {
  const scroller = document.querySelector("[data-testid='session-timeline-scroller']");
  const items = [...scroller.querySelectorAll(".xn-timeline-item")];
  const rect = scroller.getBoundingClientRect();
  const visible = items.filter((item) => {
    const itemRect = item.getBoundingClientRect();
    return itemRect.top < rect.bottom && itemRect.top + itemRect.height > rect.top;
  });
  return {
    scrollTop: scroller.scrollTop,
    clientHeight: scroller.clientHeight,
    scrollHeight: scroller.scrollHeight,
    renderedItems: items.length,
    visibleItems: visible.length,
    topSpacers: document.querySelectorAll("[data-testid='timeline-window-top-spacer']").length,
    bottomSpacers: document.querySelectorAll("[data-testid='timeline-window-bottom-spacer']").length,
  };
});

async function withPage(caseName, options, run) {
  const { server, tempRoot } = await prepare(caseName, options);
  let browser;
  try {
    const port = await listen(server);
    browser = await chromium.launch({ channel: browserChannel, headless: true });
    const page = await browser.newPage({ viewport: { width: 900, height: 640 } });
    const pageErrors = [];
    const consoleErrors = [];
    const failedRequests = [];
    page.on("pageerror", (error) => pageErrors.push(`${error.message}\n${error.stack ?? ""}`));
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    page.on("requestfailed", (request) => failedRequests.push(`${request.url()}: ${request.failure()?.errorText ?? "failed"}`));
    await page.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin === `http://127.0.0.1:${port}`) return route.continue();
      return route.abort();
    });
    await page.goto(`http://127.0.0.1:${port}/`);
    try {
      await page.waitForSelector("[data-testid='timeline-stream']", { timeout: 5000 });
    } catch (error) {
      throw new Error(`${caseName}: timeline did not render; pageerrors=${JSON.stringify(pageErrors)} console=${JSON.stringify(consoleErrors)} failedRequests=${JSON.stringify(failedRequests)}; ${error.message}`);
    }
    await settle(page);
    await run(page);
    assert.deepEqual(pageErrors, [], "页面不应出现未捕获错误");
  } finally {
    if (browser) await browser.close();
    server.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

// 长会话：窗口化、贴尾、追加保持贴底、滚动位置保持、历史轨道跳转。
await withPage("long", { turns: TURNS, virtualizeFromTail: true }, async (page) => {
  const initial = await scrollerState(page);
  assert.ok(initial.renderedItems < TURNS * 2, `长会话应只渲染部分节点，实际渲染 ${initial.renderedItems}`);
  assert.equal(initial.topSpacers, 1, "尾部窗口应有顶部垫片");
  assert.equal(initial.bottomSpacers, 0, "尾部窗口不应有底部垫片");
  assert.ok(initial.visibleItems > 0, "视口内应可见条目");
  const distanceToBottom = initial.scrollHeight - initial.scrollTop - initial.clientHeight;
  assert.ok(distanceToBottom <= 40, `打开会话应自动贴底，距底部 ${distanceToBottom}px`);

  // 流式追加：保持贴底，新尾部渲染，窗口仍受控。
  await page.click("[data-testid='append-rows']");
  await page.waitForFunction(() => Boolean(document.querySelector("[data-testid='timeline-item-assistant-406']")));
  await settle(page);
  const appended = await scrollerState(page);
  const appendedDistance = appended.scrollHeight - appended.scrollTop - appended.clientHeight;
  assert.ok(appendedDistance <= 40, `追加后应保持贴底，距底部 ${appendedDistance}px`);
  assert.ok(appended.renderedItems < (TURNS + APPEND_TURNS) * 2, "追加后仍应保持窗口化");
  assert.ok(appended.visibleItems > 0, "追加后视口内应可见条目");

  // 向上滚动 600px：视口内容整体平移，不应出现额外跳动或空白。
  const beforeScroll = await page.evaluate(() => {
    const scroller = document.querySelector("[data-testid='session-timeline-scroller']");
    const rect = scroller.getBoundingClientRect();
    const center = rect.top + rect.height / 2;
    const item = [...scroller.querySelectorAll(".xn-timeline-item")]
      .find((node) => { const r = node.getBoundingClientRect(); return r.top <= center && r.bottom >= center; });
    return item ? { id: item.getAttribute("data-testid"), relativeTop: item.getBoundingClientRect().top - rect.top } : null;
  });
  assert.ok(beforeScroll, "滚动前视口中心应有条目");
  await page.evaluate(() => {
    const scroller = document.querySelector("[data-testid='session-timeline-scroller']");
    scroller.scrollTop -= 600;
  });
  await settle(page);
  const afterScroll = await page.evaluate((expectedId) => {
    const scroller = document.querySelector("[data-testid='session-timeline-scroller']");
    const rect = scroller.getBoundingClientRect();
    const item = scroller.querySelector(`[data-testid='${expectedId}']`);
    return item ? { relativeTop: item.getBoundingClientRect().top - rect.top } : null;
  }, beforeScroll.id);
  assert.ok(afterScroll, "滚动后原条目应仍在窗口内");
  const drift = Math.abs(afterScroll.relativeTop - (beforeScroll.relativeTop + 600));
  assert.ok(drift <= 60, `滚动 600px 后内容应平移 600px，实际偏差 ${drift}px`);
  const scrolledState = await scrollerState(page);
  assert.ok(scrolledState.visibleItems > 0, "上滚后视口内应可见条目");

  // 历史轨道跳转到第一条用户消息（当前不在窗口内）。
  await page.click("[data-history-seq='1']");
  await page.waitForFunction(() => {
    const scroller = document.querySelector("[data-testid='session-timeline-scroller']");
    const target = scroller.querySelector("[data-testid='timeline-item-user-1']");
    if (!target) return false;
    const rect = scroller.getBoundingClientRect();
    const top = target.getBoundingClientRect().top;
    return top >= rect.top - 4 && top <= rect.bottom;
  }, undefined, { timeout: 5000 });
  await settle(page);
  const jumpState = await scrollerState(page);
  assert.ok(jumpState.visibleItems > 0, "跳转后视口内应可见条目");
});

// 短会话：行为不变，完整渲染且无垫片。
await withPage("short", { turns: 20, virtualizeFromTail: true }, async (page) => {
  const state = await scrollerState(page);
  assert.equal(state.renderedItems, 40, "短会话应完整渲染全部节点");
  assert.equal(state.topSpacers, 0, "短会话不应有顶部垫片");
  assert.equal(state.bottomSpacers, 0, "短会话不应有底部垫片");
  await page.click("[data-testid='append-rows']");
  await page.waitForFunction(() => Boolean(document.querySelector("[data-testid='timeline-item-assistant-46']")));
  await settle(page);
  const appended = await scrollerState(page);
  assert.equal(appended.renderedItems, 46, "短会话追加后仍完整渲染");
  const distance = appended.scrollHeight - appended.scrollTop - appended.clientHeight;
  assert.ok(distance <= 40, `短会话追加后保持贴底，距底部 ${distance}px`);
});

console.log("PASS: 时间线虚拟化在真实构建中窗口化渲染、滚动位置保持、贴尾跟随与历史跳转均正常。");
