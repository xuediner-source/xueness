import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { DesktopTitlebar, resolveDesktopTitlebarPlatform } from "./DesktopTitlebar";

test("titlebar resolves native host platforms for platform-specific caption insets", () => {
  assert.equal(resolveDesktopTitlebarPlatform("darwin"), "macos");
  assert.equal(resolveDesktopTitlebarPlatform("MacIntel"), "macos");
  assert.equal(resolveDesktopTitlebarPlatform("macOS"), "macos");
  assert.equal(resolveDesktopTitlebarPlatform("Win32"), "windows");
  assert.equal(resolveDesktopTitlebarPlatform("Linux x86_64"), "other");
  assert.equal(resolveDesktopTitlebarPlatform("win32"), "windows");
  // 名字里带 "win" 但不是 Windows 的平台不应套用 Windows 标题栏
  assert.equal(resolveDesktopTitlebarPlatform("cygwin-like"), "other");
});

test("DesktopTitlebar exposes native-safe navigation, workbench menu and effective plugin actions", () => {
  const html = renderToStaticMarkup(<DesktopTitlebar
    platform="Linux"
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
  assert.match(html, /data-platform="other"/);
  assert.match(html, /Xueness/);
  const back = html.match(/<button[^>]*data-testid="xn-desktop-titlebar-back"[^>]*>/)?.[0] ?? "";
  assert.match(back, /disabled=""/);
  assert.match(html, /data-testid="xn-desktop-titlebar-forward"/);
  assert.match(html, /data-testid="xn-desktop-titlebar-help"/);
  assert.match(html, /aria-label="切换视图"/);
  assert.match(html, /data-testid="xn-desktop-titlebar-terminal"/);
  assert.match(html, /data-testid="xn-desktop-titlebar-sidebar"/);
});

test("macOS and Windows retain the same keyboard-accessible workbench actions", () => {
  for (const [platform, label] of [["MacIntel", "macos"], ["Win32", "windows"]] as const) {
    const html = renderToStaticMarkup(<DesktopTitlebar platform={platform} canGoBack canGoForward
      onGoBack={() => {}} onGoForward={() => {}} hasSidebar onToggleSidebar={() => {}}
      terminalEnabled onOpenTerminal={() => {}} helpContent={<select aria-label="切换视图"><option>会话</option></select>} />);

    assert.match(html, new RegExp(`data-platform="${label}"`));
    assert.match(html, /role="group" aria-label="任务导航"/);
    for (const control of ["xn-desktop-titlebar-back", "xn-desktop-titlebar-forward", "xn-desktop-titlebar-help",
      "xn-desktop-titlebar-terminal", "xn-desktop-titlebar-sidebar"]) {
      const button = html.match(new RegExp(`<button[^>]*data-testid="${control}"[^>]*>`))?.[0]
        ?? html.match(new RegExp(`<summary[^>]*data-testid="${control}"[^>]*>`))?.[0]
        ?? "";
      assert.ok(button, `expected keyboard-focusable ${control}`);
      assert.doesNotMatch(button, /tabindex="-1"/);
    }
  }
});

test("DesktopTitlebar omits terminal and sidebar buttons when their owners are unavailable", () => {
  const html = renderToStaticMarkup(<DesktopTitlebar canGoBack={false} canGoForward={false}
    hasSidebar={false} terminalEnabled={false} />);
  assert.doesNotMatch(html, /data-testid="xn-desktop-titlebar-terminal"/);
  assert.doesNotMatch(html, /data-testid="xn-desktop-titlebar-sidebar"/);
});
