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

test("Codex 风格：中性白色画布、#f3f3f3 侧栏、#0d0d0d 文字，仅在 data-xn-palette=claude 下生效", () => {
  const light = block(':root[data-xn-palette="claude"]');
  const dark = block('.dark[data-xn-palette="claude"]');
  assert.ok(light, "codex light block");
  assert.ok(dark, "codex dark block");
  for (const [selector, source] of [['codex-light', light], ['codex-dark', dark]] as const) {
    for (const name of ["bg", "bg-window", "bg-sidebar", "bg-card", "bg-panel"]) {
      const hex = value(source, name);
      assert.match(hex, /^#[0-9a-f]{6}$/i, `${selector} --${name}`);
      const [r, g, b] = rgb(hex);
      assert.ok(r === g && g === b, `${selector} --${name} ${hex} should be neutral gray like Codex`);
    }
  }
  assert.equal(value(light, "bg"), "#ffffff");
  assert.equal(value(light, "bg-sidebar"), "#f3f3f3");
  assert.equal(value(light, "fg"), "#0d0d0d");
  assert.equal(value(light, "codex-user-bubble"), "#f3f3f3");
  assert.equal(value(dark, "bg"), "#181818");
  assert.equal(value(dark, "fg"), "#ffffff");
  assert.equal(value(light, "codex-toggle"), "#0285ff");
  assert.equal(value(dark, "codex-toggle"), "#339cff");
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
