import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// 回归：切换到 Claude 风格不得整体缩放界面；默认 Xueness 配色必须保持原版。
const polish = readFileSync(resolve(process.cwd(), "src/styles/claude-polish.css"), "utf8");
const tokens = readFileSync(resolve(process.cwd(), "src/styles/tokens.css"), "utf8");
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const block = (selector: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]+)\\}`).exec(strip(tokens))?.[1] ?? "";
};
const names = (body: string) => [...body.matchAll(/(--[\w-]+)\s*:/g)].map(match => match[1]);
const value = (body: string, name: string) => new RegExp(`${name}:\\s*([^;]+);`).exec(body)?.[1]?.trim() ?? "";

test("Claude 风格样式全部受 data-xn-palette=claude 门控，默认配色不受影响", () => {
  const selectors = [...strip(polish).matchAll(/([^{}]+)\{[^{}]*\}/g)].map(match => match[1].trim());
  assert.ok(selectors.length > 60);
  for (const group of selectors) {
    for (const selector of group.split(",")) assert.match(selector.trim(), /^html\[data-xn-palette="claude"\]/, selector);
  }
});

test("默认 :root / .dark 几何令牌与原版一致，且不含 Claude 专用令牌", () => {
  const root = block(":root");
  assert.equal(value(root, "--xn-ui-font-size"), "14px");
  assert.equal(value(root, "--workbench-content-width"), "672px");
  assert.equal(value(root, "--sidebar-width"), "270px");
  assert.equal(value(root, "--radius-md"), "9px");
  assert.equal(value(root, "--radius-lg"), "12px");
  assert.equal(value(root, "--text-md"), "14px");
  for (const name of [...names(root), ...names(block(".dark"))]) assert.doesNotMatch(name, /^--claude-/, name);
});

test("切换 Claude 风格不做全局缩放：不改根字号、界面字号、间距/字号/圆角令牌，不用 zoom 或 scale", () => {
  const claude = block(':root[data-xn-palette="claude"]') + block('.dark[data-xn-palette="claude"]');
  assert.ok(claude.length > 0);
  for (const name of names(claude)) {
    assert.doesNotMatch(name, /^--(xn-ui-font-size|text-|space-|radius-|font-sans|font-mono|workbench-|sidebar-width|z-)/, name);
  }
  const css = strip(polish);
  assert.doesNotMatch(css, /\bzoom\s*:/);
  assert.doesNotMatch(css, /scale\(/);
  assert.doesNotMatch(css, /html\[data-xn-palette="claude"\]\s*(?:body\s*)?\{/, "不得直接给 html/body 设样式");
  assert.doesNotMatch(css, /--xn-ui-font-size\s*:/);
  // 对话正文为 Claude 的 16px：基于用户界面字号 +2px，界面其余部分保持用户字号。
  assert.equal(value(block(':root[data-xn-palette="claude"]'), "--claude-reading-size"), "calc(var(--xn-ui-font-size, 14px) + 2px)");
  const fixedSizes = [...css.matchAll(/font-size:\s*(\d+)px/g)].map(match => Number(match[1]));
  for (const size of fixedSizes) assert.ok(size <= 40, `${size}px`);
});

test("Claude 风格不引入 Anthropic 专有字体", () => {
  assert.doesNotMatch(tokens + polish, /Anthropic (Sans|Serif|Mono)|Tiempos|Copernicus|Styrene/i);
});
