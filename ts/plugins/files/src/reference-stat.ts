/** A preview reference receives metadata only after every workspace hop is safe. */
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
export function statWorkspaceReference(root: string, relative: string): number | null {
  if (typeof root !== "string" || !isAbsolute(root) || typeof relative !== "string" || !relative) return null;
  const parts = relative.split("/"); if (parts.some((p) => ["", ".", ".."].includes(p) || p.includes("\\"))) return null;
  try { let current = realpathSync(root);
    for (const [index, part] of parts.entries()) { current = join(current, part); const info = lstatSync(current); if (info.isSymbolicLink()) return null; if (index === parts.length - 1) return info.isFile() && info.size >= 0 ? info.size : null; if (!info.isDirectory()) return null; }
  } catch { return null; }
  return null;
}
