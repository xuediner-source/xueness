#!/usr/bin/env node
// 会话侧栏/历史轨道窗口化与键盘导航的真实渲染核验：在临时目录用 esbuild 打包
// 真实组件，随机 loopback 端口本地渲染，Playwright(Chrome) 校验长列表只挂载
// 可视区附近的行、垫片保持滚动总高、键盘导航（aria-activedescendant/Enter）
// 与命令面板搜索防抖。无网络、无外部请求、不读取用户状态。
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
const SESSIONS = 400;
const STOPS = 300;

function fixtureStyle() {
  return `<style>
    html, body { margin: 0; }
    #root { height: 600px; }
    .xn-shell-sidebar__body { height: 480px; overflow-y: auto; }
    .xn-shell-nav__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 1px; }
    .xn-shell-nav__item { display: flex; align-items: center; }
    .xn-shell-nav__link { flex: 1; display: flex; align-items: center; gap: 8px; padding: 6px 8px; min-height: 32px;
      border: 0; background: transparent; font: 13px/1.4 sans-serif; text-align: left; }
    .xn-shell-nav__label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .xn-task-list { font: 13px sans-serif; }
    .xn-conversation-history-rail { position: fixed; right: 8px; top: 8px; width: 34px; }
    .xn-conversation-history-rail__track { max-height: 220px; overflow-y: auto; scrollbar-width: none; }
    .xn-conversation-history-rail__stops { display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 5px 0; }
    .xn-conversation-history-rail__stop { width: 34px; height: 12px; flex: 0 0 12px; border: 0; padding: 0; background: transparent; }
    .xn-command-results { height: 300px; overflow-y: auto; }
  </style>`;
}

function sidebarHarnessSource() {
  return `
    import React, { useState } from "react";
    import { createRoot } from "react-dom/client";
    import { XuenessTaskList } from ${JSON.stringify(resolve(webappRoot, "src/plugins/sessions/XuenessTaskList.tsx"))};
    const sessions = Array.from({ length: ${SESSIONS} }, (_, index) => ({
      id: "task-" + (index + 1),
      task: "task-" + (index + 1),
      title: "会话 " + (index + 1),
      status: "completed",
      updatedAt: new Date(Date.UTC(2026, 0, 1, 0, ${SESSIONS} - index)).toISOString(),
      root: "/work/demo",
    }));
    function Fixture() {
      const [activeId, setActiveId] = useState("task-1");
      const [selected, setSelected] = useState([]);
      const select = (id) => { setActiveId(id); setSelected((current) => [...current, id]); };
      return React.createElement("div", { className: "xn-shell-sidebar__body", "data-testid": "sidebar-body" },
        React.createElement(XuenessTaskList, {
          sessions, activeId, busy: false,
          onPreferences: () => {}, onSelect: select,
          onRename: () => {}, onArchive: () => {}, onPin: () => {}, onOpenArchived: () => {},
        }),
        React.createElement("button", { type: "button", "data-testid": "external-select-last", style: { display: "none" }, onClick: () => setActiveId("task-${SESSIONS}") }, "external select"),
        React.createElement("div", { "data-testid": "selected-log", style: { display: "none" } }, selected.join(",")),
      );
    }
    createRoot(document.getElementById("root")).render(React.createElement(Fixture));
  `;
}

function railHarnessSource() {
  return `
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { TimelineStream } from ${JSON.stringify(resolve(webappRoot, "src/plugins/sessions/XuenessTimeline.tsx"))};
    const rows = [];
    for (let index = 0; index < ${STOPS}; index += 1) {
      rows.push({ kind: "user", seq: index + 1, turnId: "turn-" + index, text: "第 " + (index + 1) + " 条用户消息" });
    }
    createRoot(document.getElementById("root")).render(
      React.createElement(TimelineStream, { rows, virtualize: false }),
    );
  `;
}

function paletteHarnessSource() {
  return `
    import React, { useRef } from "react";
    import { createRoot } from "react-dom/client";
    import { CommandPalette } from ${JSON.stringify(resolve(webappRoot, "src/plugins/sessions/CommandPalette.tsx"))};
    const sessions = Array.from({ length: ${SESSIONS} }, (_, index) => ({
      id: "task-" + (index + 1),
      task: "task-" + (index + 1),
      title: "普通会话 " + (index + 1),
      status: "completed",
      updatedAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
    }));
    function Fixture() {
      const dialogRef = useRef(null);
      const inputRef = useRef(null);
      return React.createElement(CommandPalette, {
        dialogRef, inputRef, sessions, busy: false, sessionsEnabled: true, settingsEnabled: true,
        onClose: () => {}, onRunCommand: () => {}, onSelectSession: () => {},
      });
    }
    createRoot(document.getElementById("root")).render(React.createElement(Fixture));
  `;
}

function narrowSelectHarnessSource() {
  return `
    import React, { useState } from "react";
    import { createRoot } from "react-dom/client";
    import { Shell } from ${JSON.stringify(resolve(webappRoot, "src/XuenessShell.tsx"))};
    import { Select } from ${JSON.stringify(resolve(webappRoot, "src/ui/Select.tsx"))};
    function Fixture() {
      const [value, setValue] = useState("one");
      return React.createElement(Shell, {
        sidebar: React.createElement(React.Fragment, null,
          React.createElement("button", { type: "button", "data-testid": "before-select" }, "之前"),
          React.createElement(Select, {
            "aria-label": "Fixture select", "data-testid": "fixture-select", value,
            onChange: (event) => setValue(event.target.value),
          },
            React.createElement("option", { value: "one" }, "One"),
            React.createElement("option", { value: "two" }, "Two"),
          ),
          React.createElement("button", { type: "button", "data-testid": "after-select" }, "之后"),
        ),
        children: React.createElement("div", null, "Main"),
      });
    }
    createRoot(document.getElementById("root")).render(React.createElement(Fixture));
  `;
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

async function prepare(caseName, harnessSource) {
  const tempRoot = await mkdtemp(join(tmpdir(), `xn-sidebar-${caseName}-`));
  const harnessPath = join(tempRoot, "harness.tsx");
  const bundlePath = join(tempRoot, "harness.js");
  const htmlPath = join(tempRoot, "index.html");
  await writeFile(harnessPath, harnessSource);
  await writeFile(htmlPath, `<!doctype html>
    <html lang="zh-CN"><head><meta charset="utf-8"><title>Sidebar virtualization regression</title>${fixtureStyle()}</head>
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

async function withPage(caseName, harnessSource, run) {
  const { server, tempRoot } = await prepare(caseName, harnessSource);
  let browser;
  try {
    const port = await listen(server);
    browser = await chromium.launch({ channel: browserChannel, headless: true });
    const page = await browser.newPage({ viewport: { width: 900, height: 640 } });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin === `http://127.0.0.1:${port}`) return route.continue();
      return route.abort();
    });
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForSelector("#root > *");
    await page.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
    await run(page);
    assert.deepEqual(pageErrors, [], "页面不应出现未捕获错误");
  } finally {
    if (browser) await browser.close();
    server.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

const rowCount = (page) => page.evaluate(() => document.querySelectorAll('[data-testid^="xn-sidebar-item-"]').length);

// Narrow drawer: only an explicitly owned Select portal may receive focus
// outside the aside, and its keyboard/selection flow returns focus correctly.
await withPage("narrow-select", narrowSelectHarnessSource(), async (page) => {
  await page.setViewportSize({ width: 390, height: 780 });
  const toggle = page.getByTestId("xn-shell-sidebar-toggle");
  await toggle.click();
  await page.waitForFunction(() => document.querySelector('[data-testid="xn-shell"]')?.getAttribute("data-sidebar-open") === "true");
  const trigger = page.getByTestId("fixture-select");
  await trigger.click();
  const listbox = page.getByRole("listbox");
  await listbox.waitFor();
  await page.waitForFunction(() => {
    const content = document.querySelector(".xn-select-menu[data-xn-select-portal-owner]");
    const owner = content?.getAttribute("data-xn-select-portal-owner");
    return Boolean(owner && document.querySelector(`[data-xn-select-portal-trigger="${owner}"]`));
  });

  // A matching-looking but unowned body node must not bypass the drawer focus scope.
  const rejectedSpoof = await page.evaluate(() => {
    const spoof = document.createElement("button");
    spoof.className = "xn-select-menu";
    spoof.dataset.xnSelectPortalOwner = "unowned";
    spoof.textContent = "unowned portal";
    document.body.append(spoof);
    spoof.focus();
    const rejected = !spoof.matches(":focus");
    spoof.remove();
    return rejected;
  });
  assert.equal(rejectedSpoof, true, "同名 marker 但侧栏内没有 trigger owner 时必须拦截焦点");

  // Radix owns Tab while its popup is active. The drawer trap must not bounce
  // the focus back to its first control or close the popup.
  await page.keyboard.press("Tab");
  assert.equal(await listbox.isVisible(), true, "Tab 事件由打开的 Select 处理，菜单保持打开");
  const focusStayedInSelect = await page.evaluate(() => {
    const content = document.querySelector(".xn-select-menu[data-xn-select-portal-owner]");
    return Boolean(content?.contains(document.activeElement));
  });
  assert.equal(focusStayedInSelect, true, "Select popup 的焦点不应被抽回 drawer 首项");

  await page.keyboard.press("Escape");
  await listbox.waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid="xn-shell"]')?.getAttribute("data-sidebar-open")), "true",
    "关闭 Select 不应顺带关闭窄屏 drawer");
  await page.waitForFunction(() => document.activeElement === document.querySelector('[data-testid="fixture-select"]'));
  assert.equal(await trigger.evaluate((node) => node === document.activeElement), true, "关闭 Select 后焦点返回它自己的 trigger");

  await trigger.click();
  await page.getByRole("option", { name: "Two" }).click();
  await listbox.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.activeElement === document.querySelector('[data-testid="fixture-select"]'));
  assert.equal(await trigger.textContent(), "Two", "选择项应更新受控 value");
  assert.equal(await trigger.evaluate((node) => node === document.activeElement), true, "选择后焦点仍返回 trigger");
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid="xn-shell"]')?.getAttribute("data-sidebar-open")), "true");
});

// 会话侧栏：长列表窗口化、滚动后窗口平移、键盘导航与 Enter 激活。
const pickList = "[...document.querySelectorAll('.xn-shell-nav__list')].at(-1)";

await withPage("sidebar", sidebarHarnessSource(), async (page) => {
  await page.waitForSelector('.xn-shell-nav__list li');
  const initial = await rowCount(page);
  assert.ok(initial < SESSIONS, `长列表应只挂载部分行，实际 ${initial}`);
  assert.ok(initial > 10, "窗口内应有可见行");

  // 滚到中部：窗口平移到可视区附近，列表滚动总高保持（垫片精确）。
  const before = await page.evaluate(() => {
    const body = document.querySelector('[data-testid="sidebar-body"]');
    return { height: body.scrollHeight, top: body.scrollTop };
  });
  await page.evaluate(() => {
    const body = document.querySelector('[data-testid="sidebar-body"]');
    body.scrollTop = body.scrollHeight / 2;
  });
  await page.waitForFunction(() => {
    const body = document.querySelector('[data-testid="sidebar-body"]');
    return Boolean([...body.querySelectorAll('[data-testid^="xn-sidebar-item-"]')]
      .find((node) => node.getBoundingClientRect().top >= body.getBoundingClientRect().top));
  }, undefined, { timeout: 5000 });
  const mid = await rowCount(page);
  assert.ok(mid < SESSIONS, `滚动后仍应窗口化，实际 ${mid}`);
  const midVisible = await page.evaluate(() => {
    const body = document.querySelector('[data-testid="sidebar-body"]');
    const bodyRect = body.getBoundingClientRect();
    return [...body.querySelectorAll('[data-testid^="xn-sidebar-item-"]')]
      .filter((node) => { const r = node.getBoundingClientRect(); return r.top < bodyRect.bottom && r.bottom > bodyRect.top; }).length;
  });
  assert.ok(midVisible > 0, `滚动到中部后视口内应有可见行，实际 ${midVisible}`);
  const after = await page.evaluate(() => {
    const body = document.querySelector('[data-testid="sidebar-body"]');
    return { height: body.scrollHeight, top: body.scrollTop };
  });
  assert.ok(Math.abs(after.height - before.height) <= 2, `滚动总高应保持不变，${before.height} -> ${after.height}`);

  // 键盘导航：焦点进列表，End 跳到最后一行并挂载它，Enter 选中。
  await page.evaluate((pick) => document.querySelectorAll('.xn-shell-nav__list')[document.querySelectorAll('.xn-shell-nav__list').length - 1].focus(), pickList);
  await page.keyboard.press("End");
  await page.waitForFunction((pick) => {
    const list = eval(pick);
    const id = list.getAttribute("aria-activedescendant");
    return Boolean(id && document.getElementById(id));
  }, pickList, { timeout: 5000 });
  const endState = await page.evaluate((pick) => {
    const list = eval(pick);
    const id = list.getAttribute("aria-activedescendant");
    return { id, mounted: Boolean(document.getElementById(id)), focused: document.activeElement === list };
  }, pickList);
  assert.equal(endState.focused, true, "焦点应留在列表容器上");
  assert.equal(endState.mounted, true, "光标行应已挂载");
  assert.equal(endState.id.endsWith("task-" + SESSIONS), true, "End 应把光标移到最后一行");
  await page.keyboard.press("Enter");
  const selectedEnd = await page.evaluate(() => document.querySelector('[data-testid="selected-log"]').textContent);
  assert.equal(selectedEnd.split(",").at(-1), "task-" + SESSIONS, "Enter 应激活光标行");

  // ArrowDown 从最后一行夹取边界不环绕；Home 回到第一行。
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Home");
  const homeId = await page.evaluate((pick) => eval(pick).getAttribute("aria-activedescendant"), pickList);
  assert.equal(homeId?.endsWith("task-1"), true, `Home 应回到第一行；当前 id=${homeId}`);
  await page.keyboard.press("Enter");
  const selectedHome = await page.evaluate(() => document.querySelector('[data-testid="selected-log"]').textContent);
  assert.equal(selectedHome.split(",").at(-1), "task-1", "Enter 应选中第一行");

  // 点击行后焦点回到列表容器，随后的方向键继续生效。
  await page.click('[data-testid="xn-sidebar-item-task-40"]');
  const clickFocus = await page.evaluate((pick) => {
    const active = document.activeElement;
    return active === eval(pick) ? "xn-shell-nav__list" : (active?.className ?? "");
  }, pickList);
  assert.match(clickFocus, /xn-shell-nav__list/, "点击行后焦点应回到列表容器");
  await page.keyboard.press("ArrowDown");
  const afterArrow = await page.evaluate((pick) => eval(pick).getAttribute("aria-activedescendant"), pickList);
  assert.equal(afterArrow.endsWith("task-41"), true, "点击后方向键应以被点击行为基准移动");

  // 外部选中远端会话：光标选项须先挂载并滚入侧栏视口。
  await page.evaluate(() => document.querySelector('[data-testid="external-select-last"]').click());
  await page.waitForFunction(({ pick, lastIndex }) => {
    const list = eval(pick);
    const id = list.getAttribute("aria-activedescendant");
    const option = id ? document.getElementById(id) : null;
    if (!option) return false;
    const body = document.querySelector('[data-testid="sidebar-body"]');
    const rect = option.getBoundingClientRect();
    const viewport = body.getBoundingClientRect();
    return option.dataset.optionIndex === String(lastIndex)
      && rect.bottom > viewport.top && rect.top < viewport.bottom;
  }, { pick: pickList, lastIndex: SESSIONS - 1 }, { timeout: 5000 });

  // 鼠标滚动期间列表仍持有焦点：active descendant 跟随可见行，不指向已卸载的旧选项。
  await page.evaluate(() => {
    const body = document.querySelector('[data-testid="sidebar-body"]');
    body.scrollTop = 0;
  });
  await page.waitForFunction((pick) => {
    const list = eval(pick);
    if (document.activeElement !== list) return false;
    const id = list.getAttribute("aria-activedescendant");
    const option = id ? document.getElementById(id) : null;
    if (!option) return false;
    const body = document.querySelector('[data-testid="sidebar-body"]');
    const rect = option.getBoundingClientRect();
    const viewport = body.getBoundingClientRect();
    return Number(option.dataset.optionIndex) < 80 && rect.bottom > viewport.top && rect.top < viewport.bottom;
  }, pickList, { timeout: 5000 });
  const beforeVisibleArrow = await page.evaluate((pick) => {
    const option = document.getElementById(eval(pick).getAttribute("aria-activedescendant"));
    return Number(option.dataset.optionIndex);
  }, pickList);
  await page.keyboard.press("ArrowDown");
  const afterVisibleArrow = await page.evaluate((pick) => {
    const option = document.getElementById(eval(pick).getAttribute("aria-activedescendant"));
    return Number(option.dataset.optionIndex);
  }, pickList);
  assert.equal(afterVisibleArrow, Math.min(SESSIONS - 1, beforeVisibleArrow + 1), "滚动后方向键应从当前可见行继续");

  // Row-action focus is a child-focus event, not a request to reveal the old
  // active session. Keep the mid-list viewport stable for rename and delete.
  await page.evaluate(() => {
    const body = document.querySelector('[data-testid="sidebar-body"]');
    body.scrollTop = body.scrollHeight / 2;
  });
  await page.waitForFunction((pick) => {
    const list = eval(pick);
    const option = list.querySelector('[role="option"][data-cursor="true"]');
    const body = document.querySelector('[data-testid="sidebar-body"]');
    if (!option || document.activeElement !== list) return false;
    const rect = option.getBoundingClientRect(), viewport = body.getBoundingClientRect();
    return rect.bottom > viewport.top && rect.top < viewport.bottom;
  }, pickList, { timeout: 5000 });
  const actionId = await page.evaluate((pick) => {
    const option = eval(pick).querySelector('[role="option"][data-cursor="true"]');
    return option.dataset.testid.replace("xn-sidebar-item-", "");
  }, pickList);
  const actionTop = await page.evaluate(() => document.querySelector('[data-testid="sidebar-body"]').scrollTop);
  await page.getByTestId(`xn-sidebar-rename-${actionId}`).click();
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-testid")), `xn-sidebar-rename-${actionId}`,
    "重命名控件应保有自身焦点");
  assert.ok(Math.abs(await page.evaluate(() => document.querySelector('[data-testid="sidebar-body"]').scrollTop) - actionTop) <= 1,
    "聚焦重命名控件不应把侧栏跳回旧 active 行");
  await page.getByTestId(`xn-sidebar-delete-${actionId}`).click();
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-testid")), `xn-sidebar-delete-${actionId}`,
    "删除控件应保有自身焦点");
  assert.ok(Math.abs(await page.evaluate(() => document.querySelector('[data-testid="sidebar-body"]').scrollTop) - actionTop) <= 1,
    "聚焦删除控件不应把侧栏跳回旧 active 行");
});

// 历史轨道：长会话只挂载部分停靠点，方向键移动焦点前自动补挂载。
await withPage("rail", railHarnessSource(), async (page) => {
  await page.waitForSelector('[data-testid="conversation-history-rail"]');
  const initial = await page.evaluate(() => document.querySelectorAll("[data-history-seq]").length);
  assert.ok(initial < STOPS, `长会话应只挂载部分停靠点，实际 ${initial}`);

  await page.click("[data-history-seq='1']");
  await page.keyboard.press("ArrowDown");
  const focusSeq = await page.evaluate(() => document.activeElement?.getAttribute("data-history-seq"));
  assert.equal(focusSeq, "2", "ArrowDown 应把焦点移到下一个停靠点");
  await page.keyboard.press("End");
  const endSeq = await page.evaluate(() => document.activeElement?.getAttribute("data-history-seq"));
  assert.equal(endSeq, String(STOPS), "End 应聚焦最后一个停靠点（含自动挂载）");

  // 用户滚动轨道离开远端焦点后，焦点交给视口内停靠点，方向键仍可继续。
  await page.evaluate(() => {
    const track = document.querySelector(".xn-conversation-history-rail__track");
    track.scrollTop = 0;
  });
  await page.waitForFunction(() => {
    const track = document.querySelector(".xn-conversation-history-rail__track");
    const active = document.activeElement;
    if (!(active instanceof HTMLButtonElement) || !track.contains(active) || !active.hasAttribute("data-history-seq")) return false;
    const rect = active.getBoundingClientRect();
    const viewport = track.getBoundingClientRect();
    return Number(active.dataset.historySeq) < 60 && rect.bottom > viewport.top && rect.top < viewport.bottom;
  }, undefined, { timeout: 5000 });
  const beforeScrollArrow = Number(await page.evaluate(() => document.activeElement?.getAttribute("data-history-seq")));
  await page.keyboard.press("ArrowDown");
  const afterScrollArrow = Number(await page.evaluate(() => document.activeElement?.getAttribute("data-history-seq")));
  assert.equal(afterScrollArrow, Math.min(STOPS, beforeScrollArrow + 1), "轨道滚动后方向键应从恢复的焦点继续");
});

// 命令面板：输入先应用中间防抖轮次，补全输入后在防抖窗口内保持旧结果，再收敛到最终过滤态。
await withPage("palette", paletteHarnessSource(), async (page) => {
  await page.waitForSelector(".xn-command-results");
  const optionCount = (page2) => page2.evaluate(() => document.querySelectorAll(".xn-command-option").length);
  assert.ok(await optionCount(page) > SESSIONS, "空输入应显示全部会话与命令");
  await page.click("input[role='combobox']");
  await page.keyboard.type("普通会话 4", { delay: 10 });
  await page.waitForFunction(() => {
    const count = document.querySelectorAll(".xn-command-option").length;
    return count > 0 && count < 400;
  }, undefined, { timeout: 5000 });
  const midCount = await optionCount(page);
  await page.keyboard.type("00");
  const firstSample = await optionCount(page);
  assert.equal(firstSample, midCount, "防抖窗口内应保持上一轮输入的过滤态");
  await page.waitForFunction(() => document.querySelectorAll(".xn-command-option").length < 20, undefined, { timeout: 5000 });
  const finalCount = await optionCount(page);
  assert.ok(finalCount < midCount, `补全后应收敛到完整输入的过滤结果，${midCount} -> ${finalCount}`);
});

console.log("PASS: 会话侧栏/历史轨道窗口化、键盘导航与命令面板防抖在真实构建中均正常。");
