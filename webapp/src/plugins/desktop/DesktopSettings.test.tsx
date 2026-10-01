import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { DesktopSettings } from "./DesktopSettings";
import { settingsNavigation } from "../../xuenessSettingsNavigation";

test("desktop settings only mount through their effective plugin route", () => {
  assert.equal(settingsNavigation(new Set()).some(s => s.id === "desktop"), false);
  assert.equal(settingsNavigation(new Set(["desktop"])).some(s => s.id === "desktop"), true);
  const html = renderToStaticMarkup(<DesktopSettings enabled={false} />);
  assert.match(html, /桌面集成已关闭/);
  assert.doesNotMatch(html, /正在读取桌面状态/);
});
