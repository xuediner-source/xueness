import { mkdtempSync } from "../../../test-support/canonical-temp.ts";
/** Memory-root fixtures shared by the Python and ZCode memory tests. */
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectHash } from "../src/index.ts";

export const ENTRIES = [
  "[id:0123abcd] [2026-10-01] [git main] [git feature/x] - durable fact one",
  "---\ntitle: x\n---\n<!-- hidden -->\n* bullet with\n\n\nmany lines",
  "[branch:dev] [id:XYZ] keep the bad id prefix",
  "[٢٠٢٦-١٠-٠١] arabic-indic date prefix",
  "   ",
  "\u3000全角空格开头\u3000",
  "\x1c\x85 python-only whitespace \ufeff",
  "emoji 😀".repeat(40),
];

export interface MemoryFixture { base: string; memoryRoot: string; workspace: string; outside: string }

export function memoryFixture(): MemoryFixture {
  const base = mkdtempSync(join(tmpdir(), "xueness-memory-"));
  const memoryRoot = join(base, "memory"); const workspace = join(base, "工作区 one"); const outside = join(base, "outside");
  for (const dir of [memoryRoot, workspace, outside]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(memoryRoot, "MEMORY.md"), "\ufeff" + ENTRIES.join("\n§\n").replace(/\n/g, "\r\n"));
  writeFileSync(join(memoryRoot, "USER.md"), ["prefers 中文 replies", "x".repeat(1600)].join("\n§\n"));
  const key = join(memoryRoot, "projects", projectHash(workspace));
  mkdirSync(key, { recursive: true });
  writeFileSync(join(key, "KEY.md"), Array.from({ length: 60 }, (_, i) => `key fact ${i} ` + "细".repeat(60)).join("\n§\n"));
  writeFileSync(join(outside, "secret.md"), "leaked secret");
  return { base, memoryRoot, workspace, outside };
}

/** Variants: escaping link, directory track, invalid UTF-8, linked root. */
export function variantRoots(fixture: MemoryFixture): string[] {
  const linked = join(fixture.base, "linked-root"); symlinkSync(fixture.memoryRoot, linked);
  const escape = join(fixture.base, "escape"); mkdirSync(escape);
  symlinkSync(join(fixture.outside, "secret.md"), join(escape, "MEMORY.md"));
  writeFileSync(join(escape, "USER.md"), Buffer.from([0x66, 0xff, 0x66]));
  mkdirSync(join(escape, "projects", projectHash(fixture.workspace), "KEY.md"), { recursive: true });
  const inside = join(fixture.base, "inside"); mkdirSync(inside);
  writeFileSync(join(inside, "real.md"), "linked inside\r\n§\r\nsecond\rline");
  symlinkSync(join(inside, "real.md"), join(inside, "USER.md"));
  return [fixture.memoryRoot, linked, escape, inside, join(fixture.base, "missing"), "  " + fixture.memoryRoot];
}
