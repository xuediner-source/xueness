#!/usr/bin/env node
/**
 * Detached owner for one local workflow run (Python `xueness.workflow_worker`):
 *
 *   node apps/server/src/workflow-worker.ts <state-dir> <workflow-id>
 *
 * The launcher starts it in the project root. Controls persist in the record,
 * so the run keeps going when the UI or the server that started it goes away;
 * a desktop host instead passes its pid and the worker cancels once that host
 * is gone (POSIX parent check, as Python's `owner_gone`).
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drive, nodeExecutor, recordControl, WorkflowStore } from "@xueness/plugin-workflows";
import { effectivePlugins } from "./plugin-state.ts";
import { createActorHost } from "./workflow-actors.ts";

/** `desktop_lifecycle.owner_gone`. */
export function desktopOwnerGone(env: NodeJS.ProcessEnv = process.env): boolean {
  const owner = env.XUENESS_DESKTOP_OWNER_PID;
  return process.platform !== "win32" && !!owner && String(process.ppid) !== owner;
}

export async function runWorkflowWorker(state: string, wid: string, projectRoot = process.cwd()): Promise<void> {
  const store = new WorkflowStore(state);
  const enabled = effectivePlugins(projectRoot, state);
  const probe = (id: string): boolean => { try { return enabled(id); } catch { return false; } };
  try {
    await drive(store, wid, nodeExecutor(createActorHost({ stateDir: state, enabled: probe })), recordControl(store, wid, () => desktopOwnerGone()), { enabled: () => probe("workflows") });
  } catch (error) {
    store.update(wid, (record) => { record.status = "interrupted"; });
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [state, wid] = process.argv.slice(2);
  if (!state || !wid) {
    process.stderr.write("usage: workflow-worker <state-dir> <workflow-id>\n");
    process.exit(2);
  }
  runWorkflowWorker(state, wid).then(() => process.exit(0), () => process.exit(1));
}
