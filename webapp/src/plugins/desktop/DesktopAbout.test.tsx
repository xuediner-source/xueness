import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { DesktopAbout, DesktopAboutDetails } from "./DesktopAbout";
import { settingsNavigation } from "../../xuenessSettingsNavigation";
import { getLocale, setLocale } from "../../i18n";

test("desktop status moves to About and remains gated by its effective plugin", () => {
  for (const effective of [new Set<string>(), new Set(["desktop"])]) {
    const navigation = settingsNavigation(effective);
    assert.equal(navigation.some(section => section.id === "desktop"), false);
    assert.equal(navigation.some(section => section.id === "about"), effective.has("desktop"));
  }
  assert.equal(renderToStaticMarkup(<DesktopAbout enabled={false} />), "");
});

test("About keeps actual version and data location without the technical desktop list", () => {
  const previous = getLocale();
  try {
    setLocale("en");
    const dataDirectory = "C:\\Users\\Example\\Xueness";
    const html = renderToStaticMarkup(<DesktopAboutDetails version="0.1.4" dataDirectory={dataDirectory} />);
    assert.match(html, /Version 0\.1\.4/);
    assert.match(html, /Data directory/);
    assert.ok(html.includes(dataDirectory));
    assert.doesNotMatch(html, /darwin|win32|Python|Native folder picker|Bundled runtime|[\u3400-\u9fff]/);
  } finally { setLocale(previous); }
});
