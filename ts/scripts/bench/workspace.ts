/**
 * The synthetic workspace Xueness-bench measures the tools on: a source tree,
 * a large node_modules, a .gitignore'd build directory, and the fixtures of
 * the P0 problems (a CRLF file, a GBK file, a 1 MB log, a 200 KB source to edit).
 * Deterministic for a given size, so runs are comparable.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeText } from "@xueness/engine-tools";

/** Rare literal: in a few source files, a few dependencies and the ignored build. */
export const MARKER = "XUENESS_BENCH_MARKER";
/** Rare regex: functions whose index ends in 77. */
export const RARE_REGEX = String.raw`function item\d*77Handler\(`;

export interface WorkspaceSizes {
  /** Source files under src/. */
  files: number;
  /** Files under node_modules/. */
  deps: number;
}

export interface BenchWorkspace extends WorkspaceSizes {
  root: string;
  /** Marker hits a correct search finds (sources only), and the ones it must skip. */
  markers: { source: number; dependencies: number; ignored: number };
  /** Source files the rare regex matches. */
  rareMatches: number;
  bytes: number;
}

function sourceFile(index: number): string {
  const lines = [`// module ${index}`, `import { helper } from "../shared/helper";`, ""];
  lines.push(`export function item${index}Handler(input: string): string {`);
  for (let line = 0; line < 30; line += 1) lines.push(`  const value${line} = helper(input, ${index * 31 + line});`);
  lines.push(`  return value0 + value29;`, `}`, "");
  if (index % 50 === 7) lines.push(`// ${MARKER}: source ${index}`);
  return `${lines.join("\n")}\n`;
}

export function buildWorkspace(root: string, sizes: WorkspaceSizes): BenchWorkspace {
  let bytes = 0;
  const put = (path: string, content: string | Uint8Array): void => {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
    bytes += typeof content === "string" ? Buffer.byteLength(content) : content.length;
  };
  const markers = { source: 0, dependencies: 0, ignored: 0 };
  let rareMatches = 0;
  put(".gitignore", "dist/\n*.log\n");
  for (let index = 0; index < sizes.files; index += 1) {
    put(`src/mod${index % 40}/item${index}.ts`, sourceFile(index));
    if (index % 50 === 7) markers.source += 1;
    if (index % 100 === 77) rareMatches += 1;
  }
  for (let index = 0; index < sizes.deps; index += 1) {
    const marked = index % 100 === 3;
    put(`node_modules/pkg${index % 200}/lib/file${index}.js`, `module.exports = function dep${index}() { return ${index}; };\n${marked ? `// ${MARKER}\n` : ""}`);
    if (marked) markers.dependencies += 1;
  }
  for (let index = 0; index < 20; index += 1) {
    put(`dist/bundle${index}.js`, `var built${index} = "${MARKER}";\n`);
    markers.ignored += 1;
  }
  const crlf = "alpha\r\nbeta\r\ngamma\r\n";
  put("fixtures/crlf.txt", crlf);
  put("fixtures/crlf-python.txt", crlf);
  put("fixtures/gbk.txt", encodeText("第一行：你好\n第二行：世界\n", "gbk"));
  put("fixtures/big.txt", Array.from({ length: 16_000 }, (_, line) => `line ${line}: ${"x".repeat(56)}`).join("\n") + "\n");
  const editable = Array.from({ length: 5_000 }, (_, line) => `export const value${line} = ${line};`).join("\n");
  for (const name of ["edit.ts", "edit-python.ts"]) put(`fixtures/${name}`, `const alpha = 1;\n${editable}\n`);
  return { root, ...sizes, markers, rareMatches, bytes };
}
