import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const tokens = readFileSync(resolve(process.cwd(), "src/styles/tokens.css"), "utf8");
const token = (name: string) => new RegExp(`--${name}:\\s*([^;]+);`).exec(tokens)?.[1] ?? "";

test("UI and code font tokens cover both macOS and Windows, including CJK fallbacks", () => {
  const sans = token("font-sans");
  const mono = token("font-mono");
  for (const font of ['"Segoe UI"', '"Microsoft YaHei UI"', '"PingFang SC"']) assert.ok(sans.includes(font), `sans ${font}`);
  for (const font of ["Menlo", "Consolas", '"Cascadia Mono"', '"Microsoft YaHei UI"', '"PingFang SC"']) assert.ok(mono.includes(font), `mono ${font}`);
  assert.ok(mono.trim().endsWith("monospace"));
});
