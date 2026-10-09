import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const css = readFileSync(resolve(process.cwd(), "src/styles/claude-polish.css"), "utf8");
const main = readFileSync(resolve(process.cwd(), "src/main.tsx"), "utf8");
const GATE = 'html[data-xn-palette="claude"]';

test("润饰样式层最后加载，才能覆盖其余工作台样式", () => {
  const imports = [...main.matchAll(/^import\s+"(\.\/[^"]+\.css)";/gm)].map(match => match[1]);
  assert.equal(imports.at(-1), "./styles/claude-polish.css");
});

test("润饰样式层仅在 Claude 风格配色方案下生效", () => {
  assert.ok(css.includes(GATE));
  assert.ok((css.match(/html\[data-xn-palette="claude"\]/g) ?? []).length >= 20);
  // Bare shell selectors must not escape the gate.
  assert.doesNotMatch(css, /(?:^|})\s*\.xn-shell-layout\b/);
});

test("润饰样式层只用设计令牌，不写死十六进制颜色", () => {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.deepEqual(withoutComments.match(/#[0-9a-f]{3,8}\b/gi) ?? [], []);
});

test("Claude 风格：对话、输入框、轻量模式共用 768px 阅读栏令牌，侧栏 288px", () => {
  for (const selector of [".xn-timeline-stream", ".xn-composer-region--docked", ".xn-lightweight-composer"]) {
    assert.ok(css.includes(selector), selector);
  }
  assert.ok((css.match(/var\(--claude-column\)/g) ?? []).length >= 4);
  assert.match(css, /\.xn-shell-sidebar \{ width: var\(--claude-sidebar-width\)/);
});

test("Claude 风格：输入框圆角 20、发送按钮 32px 圆角 8，动效不超过 200ms", () => {
  assert.match(css, /\.xn-composer \{[^}]*border-radius: 20px/);
  assert.match(css, /\.xn-composer__send \{[^}]*width: 32px;[^}]*height: 32px;[^}]*border-radius: 8px/);
  for (const match of css.matchAll(/(\d+(?:\.\d+)?)ms/g)) assert.ok(Number(match[1]) <= 200, match[0]);
});

test("焦点环统一使用强调色令牌，文本输入区不重复描边", () => {
  assert.match(css, /button:focus-visible[\s\S]*?outline: 2px solid var\(--focus-ring\)/);
  assert.match(css, /\.xn-composer__input:focus-visible \{ outline: none; \}/);
});
