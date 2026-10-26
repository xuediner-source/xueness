// Enforce ZCode's oxlint max-lines standard (.oxlintrc.json):
// - Production source files: max 400 effective lines (skipBlankLines: true, skipComments: true)
// - Test/spec files (*.test.ts, *.spec.ts, test/, tests/, __tests__/, test-support/) and i18n locales: max-lines off
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const MAX_LINES = Number(process.env.XUENESS_MAX_LINES ?? 400);
const ROOT = join(import.meta.dirname, "..");
const SCANNED = ["packages", "plugins", "apps", "scripts"];
const SKIPPED = new Set(["node_modules", "dist", ".tmp", "test", "tests", "__tests__", "test-support"]);

function isExemptFile(relPath: string): boolean {
  const normalized = relPath.replaceAll("\\", "/");
  if (
    normalized.endsWith(".test.ts") ||
    normalized.endsWith(".test.tsx") ||
    normalized.endsWith(".spec.ts") ||
    normalized.endsWith(".spec.tsx")
  ) {
    return true;
  }
  if (normalized.includes("/i18n/locales/")) {
    return true;
  }
  const segments = normalized.split("/");
  return segments.some((seg) => SKIPPED.has(seg));
}

function countEffectiveLines(source: string): number {
  if (source.length === 0) return 0;
  const rawLines = source.replaceAll("\r\n", "\n").split("\n");
  if (rawLines.at(-1) === "") rawLines.pop();

  let count = 0;
  let inBlockComment = false;

  for (const rawLine of rawLines) {
    let line = rawLine.trim();
    if (line.length === 0) continue;

    let hasCode = false;
    while (line.length > 0) {
      if (inBlockComment) {
        const endIdx = line.indexOf("*/");
        if (endIdx === -1) {
          line = "";
        } else {
          inBlockComment = false;
          line = line.slice(endIdx + 2).trim();
        }
      } else {
        if (line.startsWith("//")) {
          line = "";
        } else if (line.startsWith("/*")) {
          inBlockComment = true;
          line = line.slice(2).trim();
        } else {
          const nextBlock = line.indexOf("/*");
          const nextLine = line.indexOf("//");
          hasCode = true;
          if (nextBlock !== -1 && (nextLine === -1 || nextBlock < nextLine)) {
            inBlockComment = true;
            line = line.slice(nextBlock + 2).trim();
          } else {
            line = "";
          }
        }
      }
    }

    if (hasCode) count += 1;
  }

  return count;
}

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
    const rel = relative(ROOT, file);
    if (isExemptFile(rel)) continue;
    count += 1;
    const text = readFileSync(file, "utf8");
    const lines = countEffectiveLines(text);
    if (lines > largest.lines) largest = { file: rel, lines };
    if (lines > MAX_LINES) tooLong.push(`${rel}: ${lines} effective lines (max ${MAX_LINES})`);
  }
}

if (tooLong.length) {
  process.stderr.write(`Files over the ${MAX_LINES}-line limit (skipBlankLines + skipComments):\n${tooLong.map((line) => `  ${line}`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`check:lines ok: ${count} prod files, largest ${largest.file} (${largest.lines} effective lines, max ${MAX_LINES}; tests/comments/blanks exempt per ZCode .oxlintrc.json)\n`);
