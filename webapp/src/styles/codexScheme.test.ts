import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const css = readFileSync(resolve(process.cwd(), "src/styles/codex-scheme.css"), "utf8");
const main = readFileSync(resolve(process.cwd(), "src/main.tsx"), "utf8");
const taskList = readFileSync(resolve(process.cwd(), "src/plugins/sessions/XuenessTaskList.tsx"), "utf8");
const GATE = 'html[data-xn-palette="claude"]';
const strip = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "");

test("Codex 风格样式层最后加载，才能覆盖其余工作台样式", () => {
  const imports = [...main.matchAll(/^import\s+"(\.\/[^"]+\.css)";/gm)].map(match => match[1]);
  assert.equal(imports.at(-1), "./styles/codex-scheme.css");
});

test("Codex 风格样式层仅在配色方案 = Codex 风格时生效", () => {
  assert.ok(css.includes(GATE));
  assert.ok((css.match(/html\[data-xn-palette="claude"\]/g) ?? []).length >= 20);
  assert.doesNotMatch(css, /(?:^|})\s*\.xn-shell-layout\b/);
});

test("Codex 风格样式层只用设计令牌，不写死十六进制颜色", () => {
  assert.deepEqual(strip(css).match(/#[0-9a-f]{3,8}\b/gi) ?? [], []);
});

test("Codex 风格：300px 侧栏、30px 行高、736px 阅读栏，对话与输入框共用阅读栏", () => {
  assert.match(css, /\.xn-shell-sidebar \{ width: var\(--codex-sidebar-width\)/);
  assert.match(css, /\.xn-sidebar-action \{[^}]*height: var\(--codex-row-height\)/);
  assert.match(css, /\.xn-shell-nav__link \{[^}]*height: var\(--codex-row-height\)/);
  for (const selector of [".xn-timeline-stream", ".xn-composer-region--docked", ".xn-lightweight-composer", ".xn-hero__composer"]) {
    assert.ok(css.includes(selector), selector);
  }
  assert.ok((strip(css).match(/var\(--codex-column\)/g) ?? []).length >= 6);
});

test("Codex 风格：「任务」分区标题来自 data-section-label，默认配色不显示", () => {
  assert.match(taskList, /className="xn-task-list__toolbar" data-section-label=\{tr\('任务'\)\}/);
  assert.match(css, /\.xn-task-list__toolbar::before \{[^}]*content: attr\(data-section-label\)/);
});

test("Codex 风格：输入框圆角 18、发送按钮 28px 圆形，用户气泡圆角 16（实测），动效不超过 200ms", () => {
  assert.match(css, /\.xn-composer \{[^}]*border-radius: 18px/);
  assert.match(css, /\.xn-composer__send \{[^}]*width: 28px;[^}]*height: 28px;[^}]*border-radius: 999px/);
  assert.match(css, /\.xn-zc-user-bubble \{[^}]*border-radius: 16px/);
  for (const match of css.matchAll(/(\d+(?:\.\d+)?)ms/g)) assert.ok(Number(match[1]) <= 200, match[0]);
});

test("Codex 风格：开关用蓝色轨道，焦点环统一使用强调色令牌", () => {
  assert.match(css, /\.xn-settings-switch:checked,[\s\S]*?background: var\(--codex-toggle\)/);
  assert.match(css, /button:focus-visible[\s\S]*?outline: 2px solid var\(--focus-ring\)/);
  assert.match(css, /\.xn-composer__input:focus-visible \{ outline: none; \}/);
});
