import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { messages } from "./i18n";
import "./plugins/sessions/messageTimeLabel";

// NetworkSettings 使用组件内的 tr(zh, en) 双语写法，不走全局词表。
const LOCAL_BILINGUAL = new Set(["plugins/network/NetworkSettings.tsx"]);

function unescapeLiteral(raw: string): string {
  return raw.replace(/\\(["'\\])/g, "$1").replace(/\\n/g, "\n");
}

test("every Chinese literal passed to t()/tr()/tf() has an English translation", () => {
  const root = resolve(process.cwd(), "src");
  const files = (readdirSync(root, { recursive: true }) as string[])
    .map((file) => file.replace(/\\/g, "/"))
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\./.test(file) && file !== "i18n.ts" && !LOCAL_BILINGUAL.has(file));
  const missing: string[] = [];
  for (const file of files) {
    const source = readFileSync(join(root, file), "utf8");
    if (/messages\[/.test(source) && !file.endsWith("messageTimeLabel.ts")) continue; // 自行注册词条的模块
    for (const match of source.matchAll(/\b(?:tr|tf|t)\(\s*(["'])((?:(?!\1)[^\\]|\\.)*)\1/g)) {
      const key = unescapeLiteral(match[2]).trim();
      if (/[\u4e00-\u9fff]/.test(key) && !Object.hasOwn(messages, key)) missing.push(`${file}: ${key}`);
    }
  }
  assert.deepEqual(missing, []);
});
