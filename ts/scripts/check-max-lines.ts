// Enforce ZCode's oxlint max-lines standard (.oxlintrc.json):
// - Production source files: max 400 effective lines (skipBlankLines: true, skipComments: true)
// - Test/spec files (*.test.ts, *.spec.ts, test/, tests/, __tests__/, test-support/) and i18n locales: max-lines off
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

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

export function countEffectiveLines(source: string): number {
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

function* typescriptFiles(dir: string, includeTsx = false): Generator<string> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIPPED.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* typescriptFiles(path, includeTsx);
    else if (entry.isFile() && (entry.name.endsWith(".ts") || (includeTsx && entry.name.endsWith(".tsx")))) yield path;
  }
}

export type LineBaseline = Record<string, number>;

/** Check backend under its existing rule and frontend against its gradual baseline. */
export function checkLines(root: string, maxLines: number, baseline: LineBaseline) {
  const tooLong: string[] = [];
  let count = 0;
  let largest = { file: "", lines: 0 };
  const groups = [
    ...SCANNED.map((top) => ({ dir: join(root, top), web: false })),
    { dir: join(root, "..", "webapp", "src"), web: true },
  ];
  for (const group of groups) {
    for (const file of typescriptFiles(group.dir, group.web)) {
      const rel = relative(root, file).replaceAll("\\", "/");
      if (isExemptFile(rel) || (group.web && /(?:^|\/)i18n\.[^.]+\.ts$/.test(rel))) continue;
      count += 1;
      const lines = countEffectiveLines(readFileSync(file, "utf8"));
      if (lines > largest.lines) largest = { file: rel, lines };
      // A legacy entry is a ceiling, not a permanent exemption. A newly created
      // or renamed file must satisfy the normal limit.
      const limit = group.web ? (baseline[rel] ?? 400) : maxLines;
      if (lines > limit) tooLong.push(`${rel}: ${lines} effective lines (max ${limit})`);
    }
  }
  return { tooLong, count, largest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const baseline = JSON.parse(readFileSync(join(ROOT, "scripts", "frontend-lines-baseline.json"), "utf8")) as LineBaseline;
  const { tooLong, count, largest } = checkLines(ROOT, MAX_LINES, baseline);
  if (tooLong.length) {
    process.stderr.write(`Files over their effective-line limit (skipBlankLines + skipComments):\n${tooLong.map((line) => `  ${line}`).join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write(`check:lines ok: ${count} prod files, largest ${largest.file} (${largest.lines} effective lines; backend max ${MAX_LINES}; frontend max 400 or baseline; tests/comments/blanks exempt)\n`);
}
