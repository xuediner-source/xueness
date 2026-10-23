/** Read-only published checkpoints. Sidebar/search polls never invoke recovery. */
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { pyDecodeUtf8, pyJsonLoads, pyUtcIsoformat } from "@xueness/contracts";
import { isLink, readRegularBeneath } from "@xueness/sessions";
export function timestamp(seconds: number): string { try { const whole = Math.floor(seconds); return pyUtcIsoformat(BigInt(whole) * 1000000n + BigInt(Math.round((seconds - whole) * 1000000))); } catch { return ""; } }
export function readPublished(root: string, relative: string, maximum: number): { value: unknown; size: number; mtimeNs: bigint; mtime: number } | null {
  if (maximum <= 0 || isLink(root)) return null;
  try {
    const path = join(root, relative), before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(maximum)) return null;
    const result = readRegularBeneath(root, relative, maximum + 1); if (!result || result.raw.length > maximum || result.size !== result.raw.length) return null;
    const after = lstatSync(path, { bigint: true }); if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeNs !== after.mtimeNs || before.size !== after.size || before.size !== BigInt(result.raw.length)) return null;
    let value: unknown; try { value = pyJsonLoads(pyDecodeUtf8(result.raw), { lossless: true }); } catch { value = null; }
    return { value, size: result.raw.length, mtimeNs: before.mtimeNs, mtime: Number(before.mtimeNs) / 1e9 };
  } catch { return null; }
}
