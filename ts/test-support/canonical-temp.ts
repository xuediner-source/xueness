/** Fixtures share the canonical paths returned by production workspace/store APIs. */
import { mkdtempSync as createSync, realpathSync } from "node:fs";
import { mkdtemp as create } from "node:fs/promises";

export function mkdtempSync(prefix: string): string {
  return realpathSync.native(createSync(prefix));
}

export async function mkdtemp(prefix: string): Promise<string> {
  return realpathSync.native(await create(prefix));
}
