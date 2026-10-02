import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { DesktopTitlebar } from "./DesktopTitlebar";

test("DesktopTitlebar exposes native-safe navigation, workbench menu and effective plugin actions", () => {
  const html = renderToStaticMarkup(<DesktopTitlebar
    canGoBack={false}
    canGoForward
    onGoBack={() => {}}
    onGoForward={() => {}}
    hasSidebar
    onToggleSidebar={() => {}}
    terminalEnabled
    onOpenTerminal={() => {}}
    helpContent={<select aria-label="切换视图"><option>会话</option></select>}
  />);

  assert.match(html, /data-testid="xn-desktop-titlebar"/);
  assert.match(html, /Xueness/);
  const back = html.match(/<button[^>]*data-testid="xn-desktop-titlebar-back"[^>]*>/)?.[0] ?? "";
  assert.match(back, /disabled=""/);
  assert.match(html, /data-testid="xn-desktop-titlebar-forward"/);
  assert.match(html, /data-testid="xn-desktop-titlebar-help"/);
  assert.match(html, /aria-label="切换视图"/);
  assert.match(html, /data-testid="xn-desktop-titlebar-terminal"/);
  assert.match(html, /data-testid="xn-desktop-titlebar-sidebar"/);
});

test("DesktopTitlebar omits terminal and sidebar buttons when their owners are unavailable", () => {
  const html = renderToStaticMarkup(<DesktopTitlebar canGoBack={false} canGoForward={false}
    hasSidebar={false} terminalEnabled={false} />);
  assert.doesNotMatch(html, /data-testid="xn-desktop-titlebar-terminal"/);
  assert.doesNotMatch(html, /data-testid="xn-desktop-titlebar-sidebar"/);
});
