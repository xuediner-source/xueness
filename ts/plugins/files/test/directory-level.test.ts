import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { DirectoryError, listLevel } from "../src/index.ts";
import { pythonUnavailableReason, runPython } from "../../../test-support/python-oracle.ts";

const ORACLE = `
import json,sys
from xueness.bundled_plugins.files.directory_api import DirectoryError, list_level
out=[]
for roots, path, hidden, limit, files in json.load(sys.stdin):
    try: out.append(list_level(tuple(roots), path, hidden, limit, include_files=files))
    except DirectoryError as exc: out.append(['DirectoryError', exc.code, exc.path, exc.message])
print(json.dumps(out, ensure_ascii=False))
`;

it("lists one bounded level exactly as Python list_level", { skip: pythonUnavailableReason() ?? (process.platform === "win32" ? "POSIX fixture" : false) }, () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "xueness-level-"))), root = join(base, "root"), outside = join(base, "outside");
  for (const name of ["B", "a", "é", "Z", "_x", "中", ".hid", "\ud83d\ude00", "\uff5e", "locked", "many", "outside-target"]) mkdirSync(join(name === "outside-target" ? base : root, name), { recursive: true });
  mkdirSync(outside);
  for (let index = 0; index < 5; index += 1) { mkdirSync(join(root, "many", `d${index}`)); writeFileSync(join(root, "many", `f${index}.txt`), ""); }
  writeFileSync(join(root, "file.txt"), "x"); writeFileSync(join(root, ".hidden.txt"), "x");
  symlinkSync("a", join(root, "link-dir")); symlinkSync("file.txt", join(root, "link-file")); symlinkSync(outside, join(root, "link-out"));
  symlinkSync("missing", join(root, "dangling")); symlinkSync("loop", join(root, "loop"));
  chmodSync(join(root, "locked"), 0o000);
  const asRoot = process.getuid?.() === 0;
  const scenarios: [string[], string | null, boolean, number, boolean][] = [
    [[root], root, false, 1000, false], [[root], root, true, 1000, true], [[root], join(root, "many"), false, 2, true], [[root], join(root, "many"), false, 0, false],
    [[root], join(root, "many"), true, 5, true], [[root], `${root}/a/`, false, 1000, true], [[root], `  ${root}//many/./  `, false, 1000, true], [[root], "relative", false, 1000, true],
    [[root], outside, false, 1000, true], [[root], join(root, "link-out"), false, 1000, true], [[root], join(root, "link-dir"), false, 1000, true],
    ...asRoot ? [] : [[[root], join(root, "locked"), false, 1000, true] as [string[], string, boolean, number, boolean]],
    [[root], join(root, "file.txt"), false, 1000, true], [[root], join(root, "missing"), false, 1000, true], [[root], null, false, 1000, false], [[root], "   ", false, 1000, false],
    [[], base, false, 1000, false], [[root, join(root, "a"), root], join(root, "a"), false, 1000, true], [[root], `${root}/\u0000x`, false, 1000, true],
    [[join(base, "gone"), root], join(root, "many"), false, 2.5, true], [[join(root, "many")], join(root, "many", "d1"), false, 1000, true],
  ];
  try {
    const expected = JSON.parse(runPython(ORACLE, JSON.stringify(scenarios)));
    const actual = scenarios.map(([roots, path, hidden, limit, files]) => {
      try { return listLevel(roots, path, hidden, limit, files); } catch (error) {
        if (error instanceof DirectoryError) return ["DirectoryError", error.code, error.path, error.message];
        throw error;
      }
    });
    assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected);
  } finally {
    chmodSync(join(root, "locked"), 0o755);
    rmSync(base, { recursive: true, force: true });
  }
});
