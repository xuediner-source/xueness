import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// 配色方案只能改颜色：Claude 风格下任何尺寸、字号、行高、间距、圆角、边框宽度、
// 阴影几何、变换、动效都必须与默认 Xueness 配色完全一致。
const polish = readFileSync(resolve(process.cwd(), "src/styles/claude-polish.css"), "utf8");
const tokens = readFileSync(resolve(process.cwd(), "src/styles/tokens.css"), "utf8");
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

const COLOR_PROPERTIES = new Set([
  "color", "background-color", "border-color", "border-top-color", "border-right-color",
  "border-bottom-color", "border-left-color", "border-block-color", "border-inline-color",
  "outline-color", "text-decoration-color", "caret-color", "accent-color", "fill", "stroke",
  "column-rule-color", "text-emphasis-color",
]);

type Rule = { selector: string; body: string };
const rules = (css: string): Rule[] => {
  const out: Rule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (const match of strip(css).matchAll(re)) out.push({ selector: match[1].trim(), body: match[2] });
  return out;
};
const declarations = (body: string) =>
  body.split(";").map(part => part.trim()).filter(Boolean).map(part => {
    const index = part.indexOf(":");
    return { name: part.slice(0, index).trim().toLowerCase(), value: part.slice(index + 1).trim() };
  });

test("Claude 风格润饰层只含颜色属性（白名单）", () => {
  const css = strip(polish);
  assert.doesNotMatch(css, /@keyframes|@media|@supports|@font-face/, "不得有动画、媒体查询或字体");
  const offenders: string[] = [];
  for (const rule of rules(polish)) {
    assert.match(rule.selector, /html\[data-xn-palette="claude"\]/, `未受门控的选择器: ${rule.selector}`);
    for (const { name, value } of declarations(rule.body)) {
      if (!COLOR_PROPERTIES.has(name)) offenders.push(`${rule.selector.split("\n")[0]} → ${name}: ${value}`);
    }
  }
  assert.deepEqual(offenders, []);
});

const tokenBlock = (selector: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]+)\\}`).exec(strip(tokens))?.[1] ?? "";
  return Object.fromEntries(declarations(body).map(({ name, value }) => [name, value]));
};
const geometry = (shadow: string) =>
  shadow.replace(/rgba?\([^)]*\)|#[0-9a-f]{3,8}\b|color-mix\((?:[^()]|\([^)]*\))*\)|var\([^)]*\)/gi, "C").replace(/\s+/g, " ").trim();
const COLOR_VALUE = /^(#[0-9a-f]{3,8}|rgba?\(.+\)|hsla?\(.+\)|oklch\(.+\)|color-mix\(.+\)|var\(--[\w-]+\)|transparent|currentcolor|white|black)$/i;

test("Claude 风格令牌块只覆盖颜色令牌，阴影几何与默认一致", () => {
  const pairs: Array<[string, string]> = [
    [':root[data-xn-palette="claude"]', ":root"],
    ['.dark[data-xn-palette="claude"]', ".dark"],
  ];
  for (const [claudeSelector, defaultSelector] of pairs) {
    const claude = tokenBlock(claudeSelector);
    const base = { ...tokenBlock(":root"), ...tokenBlock(defaultSelector) };
    assert.ok(Object.keys(claude).length > 20, claudeSelector);
    for (const [name, value] of Object.entries(claude)) {
      assert.ok(name in base, `${claudeSelector} ${name} 必须是已有的默认令牌`);
      assert.doesNotMatch(name, /radius|space|text-(xs|sm|md|lg|xl|heading)|font|width|height|size|dur|ease|leading|z-|gap|pad/, `${claudeSelector} 不得覆盖几何/字体/动效令牌 ${name}`);
      if (name.startsWith("--shadow")) {
        assert.equal(geometry(value), geometry(base[name]), `${claudeSelector} ${name} 阴影几何须与默认一致`);
      } else {
        assert.match(value, COLOR_VALUE, `${claudeSelector} ${name}: ${value} 不是颜色值`);
      }
    }
  }
});

test("Claude 风格深色块补齐浅色块覆盖的阴影令牌，避免浅色阴影漏进深色", () => {
  const light = tokenBlock(':root[data-xn-palette="claude"]');
  const dark = tokenBlock('.dark[data-xn-palette="claude"]');
  for (const name of Object.keys(light).filter(key => key.startsWith("--shadow"))) {
    assert.equal(dark[name], tokenBlock(".dark")[name], name);
  }
});
