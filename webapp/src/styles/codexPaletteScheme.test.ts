import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// 回归：切换到 Claudex 外观（存储值 claude）不得整体缩放界面；默认 Xueness 配色必须保持原版。
const polish = readFileSync(resolve(process.cwd(), "src/styles/claudex-scheme.css"), "utf8");
const tokens = readFileSync(resolve(process.cwd(), "src/styles/tokens.css"), "utf8");
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const block = (selector: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]+)\\}`).exec(strip(tokens))?.[1] ?? "";
};
const names = (body: string) => [...body.matchAll(/(--[\w-]+)\s*:/g)].map(match => match[1]);
const value = (body: string, name: string) => new RegExp(`${name}:\\s*([^;]+);`).exec(body)?.[1]?.trim() ?? "";

test("Claudex 外观样式全部受 data-xn-palette=claudex 门控，默认配色不受影响", () => {
  const selectors = [...strip(polish).matchAll(/([^{}]+)\{[^{}]*\}/g)].map(match => match[1].trim());
  assert.ok(selectors.length > 60);
  for (const group of selectors) {
    for (const selector of group.split(",")) assert.match(selector.trim(), /^html\[data-xn-palette="claudex"\]/, selector);
  }
});

test("默认 :root / .dark 几何令牌与原版一致，且不含 Claudex 外观专用令牌", () => {
  const root = block(":root");
  assert.equal(value(root, "--xn-ui-font-size"), "14px");
  assert.equal(value(root, "--workbench-content-width"), "672px");
  assert.equal(value(root, "--sidebar-width"), "270px");
  assert.equal(value(root, "--radius-md"), "9px");
  assert.equal(value(root, "--radius-lg"), "12px");
  assert.equal(value(root, "--text-md"), "14px");
  for (const name of [...names(root), ...names(block(".dark"))]) assert.doesNotMatch(name, /^--(claude|codex)-/, name);
});

test("切换 Claudex 外观不做全局缩放：不改根字号、界面字号、间距/字号/圆角令牌，不用 zoom 或 scale", () => {
  const claude = block(':root[data-xn-palette="claudex"]') + block('.dark[data-xn-palette="claudex"]');
  assert.ok(claude.length > 0);
  for (const name of names(claude)) {
    assert.doesNotMatch(name, /^--(xn-ui-font-size|text-|space-|radius-|font-sans|font-mono|workbench-|sidebar-width|z-)/, name);
  }
  const css = strip(polish);
  assert.doesNotMatch(css, /\bzoom\s*:/);
  assert.doesNotMatch(css, /scale\(/);
  assert.doesNotMatch(css, /html\[data-xn-palette="claudex"\]\s*(?:body\s*)?\{/, "不得直接给 html/body 设样式");
  assert.doesNotMatch(css, /--xn-ui-font-size\s*:/);
  // Codex 正文与界面同为用户界面字号（默认 14px），不另设放大的阅读字号。
  assert.doesNotMatch(css, /--xn-ui-font-size,\s*14px\)\s*\+/);
  const fixedSizes = [...css.matchAll(/font-size:\s*(\d+)px/g)].map(match => Number(match[1]));
  for (const size of fixedSizes) assert.ok(size <= 40, `${size}px`);
});

test("Claudex 外观不引入专有字体或品牌字体", () => {
  assert.doesNotMatch(tokens + polish, /Anthropic (Sans|Serif|Mono)|Tiempos|Copernicus|Styrene|OpenAI Sans|Söhne|Soehne/i);
});
