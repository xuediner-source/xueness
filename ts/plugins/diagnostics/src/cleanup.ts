/** Delete logs of settled workflows only. Does not own `/api/workflows`. */
import { mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDict, pyJsonLoads } from "@xueness/contracts";
import { isLink } from "@xueness/sessions";

const ID = /^[a-f0-9]{32}$/;
const ACTIVE = new Set(["queued", "running", "stopping", "pausing"]);

function refuse(message: string): never {
  const error = new Error(message);
  error.name = "ValueError";
  throw error;
}

/** Process-local stand-in for `WorkflowStore.lock`. No cross-process flock. */
const locks = new Map<string, Promise<void>>();

async function locked<T>(key: string, body: () => Promise<T> | T): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  locks.set(key, previous.then(() => gate));
  await previous;
  try { return await body(); } finally { release(); }
}

export async function removeSettledLogs(stateDir: string, olderThanDays: number, now = Date.now() / 1000): Promise<number> {
  const directory = join(resolve(stateDir), "workflows");
  if (isLink(directory)) refuse("workflow directory cannot be a symlink");
  mkdirSync(directory, { recursive: true });
  if (isLink(directory)) refuse("workflow directory cannot be a symlink");
  const cutoff = now - olderThanDays * 86400;
  let removed = 0;
  let names: string[] = [];
  try { names = readdirSync(directory); } catch { return 0; }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -5);
    if (!ID.test(id) || isLink(join(directory, name))) continue;
    await locked(id, () => {
      let row: unknown;
      try { row = pyJsonLoads(readFileSync(join(directory, name), "utf8")); } catch { return; }
      if (!isDict(row)) return;
      const status = row.status;
      const updated = row.updated_at;
      if (typeof status === "string" && ACTIVE.has(status)) return;
      if (typeof updated === "number" && updated >= cutoff) return;
      for (const logName of names) {
        if (!logName.startsWith(`${id}.`) || !logName.endsWith(".log") || logName.length < id.length + 5) continue;
        const logPath = join(directory, logName);
        if (isLink(logPath)) continue;
        try { unlinkSync(logPath); removed += 1; } catch { /* already gone */ }
      }
    });
  }
  return removed;
}
