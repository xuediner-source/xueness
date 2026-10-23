/**
 * Keep every TypeScript file small enough to review in one sitting.
 * Fails when a source, test or script file exceeds MAX_LINES lines.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const MAX_LINES = Number(process.env.XUENESS_MAX_LINES ?? 400);
const ROOT = join(import.meta.dirname, "..");
const SCANNED = ["packages", "plugins", "apps", "scripts", "test-support"];
const SKIPPED = new Set(["node_modules", "dist", ".tmp"]);

function* typescriptFiles(dir: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIPPED.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* typescriptFiles(path);
    else if (entry.isFile() && entry.name.endsWith(".ts")) yield path;
  }
}

const tooLong: string[] = [];
let count = 0;
let largest = { file: "", lines: 0 };
for (const top of SCANNED) {
  for (const file of typescriptFiles(join(ROOT, top))) {
    count += 1;
    const text = readFileSync(file, "utf8");
    const lines = text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    if (lines > largest.lines) largest = { file: relative(ROOT, file), lines };
    if (lines > MAX_LINES) tooLong.push(`${relative(ROOT, file)}: ${lines} lines (max ${MAX_LINES})`);
  }
}

if (tooLong.length) {
  process.stderr.write(`Files over the ${MAX_LINES}-line limit:\n${tooLong.map((line) => `  ${line}`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`check:lines ok: ${count} files, largest ${largest.file} (${largest.lines} lines, max ${MAX_LINES})\n`);
