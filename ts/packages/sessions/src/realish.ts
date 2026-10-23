/**
 * `Path.resolve()` (non-strict): the real path of the deepest existing
 * ancestor, joined with the components that do not exist yet.
 */
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export function realish(path: string): string {
  const missing: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      const real = realpathSync.native(current);
      return missing.length ? join(real, ...missing.reverse()) : real;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      missing.push(basename(current));
      current = parent;
    }
  }
}
