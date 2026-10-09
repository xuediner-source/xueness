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

test("润饰层不改阅读宽度、字号和输入框尺寸（只改颜色）", () => {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(withoutComments, /--conversation-width|font-size|line-height|max-width|border-radius|padding|margin|stroke-width|transform|font-family/);
});
