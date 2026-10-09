import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const tokens = readFileSync(resolve(process.cwd(), "src/styles/tokens.css"), "utf8");
const block = (selector: string) => new RegExp(`${selector.replace(".", "\\.")}\\s*\\{([^}]+)\\}`).exec(tokens)?.[1] ?? "";
const value = (source: string, name: string) => new RegExp(`--${name}:\\s*([^;]+);`).exec(source)?.[1]?.trim() ?? "";
const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));

test("暖色主题：浅色象牙白、深色暖灰，背景不偏蓝", () => {
  for (const selector of [":root", ".dark"]) {
    const source = block(selector);
    for (const name of ["bg", "bg-window", "bg-card", "bg-panel"]) {
      const hex = value(source, name);
      assert.match(hex, /^#[0-9a-f]{6}$/i, `${selector} --${name}`);
      const [r, , b] = rgb(hex);
      assert.ok(r >= b, `${selector} --${name} ${hex} should be warm (red >= blue)`);
    }
  }
});

test("单一强调色：--accent 指向 clay 强调色，两套主题都有自己的值与前景色", () => {
  const root = block(":root");
  assert.equal(value(root, "accent"), "var(--accent-brand)");
  for (const selector of [":root", ".dark"]) {
    assert.match(value(block(selector), "accent-brand"), /^#[0-9a-f]{6}$/i);
    assert.match(value(block(selector), "accent-brand-fg"), /^#[0-9a-f]{6}$/i);
  }
  assert.match(value(root, "focus-ring"), /accent-brand/);
});

test("阅读宽度、正文行高、圆角与动效令牌存在", () => {
  const root = block(":root");
  assert.equal(value(root, "conversation-width"), "768px");
  assert.ok(Number(value(root, "leading-prose")) >= 1.6);
  assert.equal(value(root, "radius-xl"), "20px");
  const slow = Number.parseInt(value(root, "dur-slow"), 10);
  assert.ok(slow <= 200, "motion stays subtle");
  assert.ok(value(root, "ease-standard").startsWith("cubic-bezier"));
});

test("衬线问候字体在 Windows 回退到雅黑而不是宋体", () => {
  const serif = value(block(":root"), "font-serif");
  assert.ok(serif.includes('"Songti SC"'));
  assert.ok(serif.includes('"Microsoft YaHei UI"'));
  assert.ok(!/SimSun|宋体/.test(serif));
  assert.ok(serif.trim().endsWith("serif"));
});
