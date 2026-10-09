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

test("动效保持克制（<= 200ms）并尊重减少动态效果偏好", () => {
  const durations = [...css.matchAll(/(\d+(?:\.\d+)?)ms/g)].map(match => Number(match[1]));
  for (const value of durations) assert.ok(value <= 200, `${value}ms`);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none/);
});

test("对话、输入框、轻量模式共享同一阅读宽度令牌", () => {
  for (const selector of [".xn-timeline-stream", ".xn-composer-region--docked", ".xn-lightweight-composer"]) {
    const index = css.indexOf(selector);
    assert.ok(index >= 0, selector);
  }
  assert.ok((css.match(/var\(--conversation-width\)/g) ?? []).length >= 4);
});

test("焦点环统一使用强调色令牌，文本输入区不重复描边", () => {
  assert.match(css, /button:focus-visible[\s\S]*?outline: 2px solid var\(--focus-ring\)/);
  assert.match(css, /\.xn-composer__input:focus-visible \{ outline: none; \}/);
});
