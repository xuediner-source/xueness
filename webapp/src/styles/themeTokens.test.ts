import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const tokens = readFileSync(resolve(process.cwd(), "src/styles/tokens.css"), "utf8");
const block = (selector: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}\\s*\\{([^}]+)\\}`).exec(tokens)?.[1] ?? "";
};
const value = (source: string, name: string) => new RegExp(`--${name}:\\s*([^;]+);`).exec(source)?.[1]?.trim() ?? "";
const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));

test("默认配色：中性 Xueness 浅色/深色，不是暖色象牙白", () => {
  assert.equal(value(block(":root"), "bg"), "#fafafa");
  assert.equal(value(block(":root"), "bg-window"), "#ececee");
  assert.equal(value(block(".dark"), "bg"), "#161616");
  assert.equal(value(block(":root"), "accent"), "var(--info-fg)");
  assert.equal(value(block(":root"), "accent-brand"), "#0369a1");
});

test("Claude 风格：暖色象牙白/暖灰与 clay 强调色，仅在 data-xn-palette=claude 下生效", () => {
  const light = block(':root[data-xn-palette="claude"]');
  const dark = block('.dark[data-xn-palette="claude"]');
  assert.ok(light, "claude light block");
  assert.ok(dark, "claude dark block");
  for (const [selector, source] of [['claude-light', light], ['claude-dark', dark]] as const) {
    for (const name of ["bg", "bg-window", "bg-card", "bg-panel"]) {
      const hex = value(source, name);
      assert.match(hex, /^#[0-9a-f]{6}$/i, `${selector} --${name}`);
      const [r, , b] = rgb(hex);
      assert.ok(r >= b, `${selector} --${name} ${hex} should be warm (red >= blue)`);
    }
  }
  assert.equal(value(light, "accent-brand"), "#b05336");
  assert.equal(value(dark, "accent-brand"), "#dc8a69");
  assert.equal(value(light, "accent"), "var(--accent-brand)");
});

test("默认 :root 不新增仅供润饰层使用的布局令牌（与原版几何一致）", () => {
  const root = block(":root");
  for (const name of ["conversation-width", "leading-prose", "radius-xl", "font-serif", "shadow-composer", "ease-standard"]) {
    assert.equal(value(root, name), "", `--${name}`);
  }
  assert.equal(value(root, "workbench-content-width"), "672px");
  assert.equal(value(root, "radius-md"), "9px");
  assert.equal(value(root, "radius-lg"), "12px");
  assert.match(value(root, "focus-ring"), /accent-brand/);
});
