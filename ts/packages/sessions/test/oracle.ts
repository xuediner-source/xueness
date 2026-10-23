/** Calls `test-support/python/sessions_oracle.py` with lossless JSON both ways. */
import { join } from "node:path";
import { pyJsonDumps, pyJsonLoads } from "@xueness/contracts";
import { PROJECT_ROOT, runPython, runPythonAsync } from "../../../test-support/python-oracle.ts";

const SCRIPT = join(PROJECT_ROOT, "ts", "test-support", "python", "sessions_oracle.py");
const BOOT = `import runpy, sys; sys.argv = [${JSON.stringify(SCRIPT)}]; runpy.run_path(sys.argv[0], run_name='__main__')`;

export function oracle(request: Record<string, unknown>): unknown {
  return pyJsonLoads(runPython(BOOT, pyJsonDumps(request, { ensureAscii: true })), { lossless: true });
}

export async function oracleAsync(request: Record<string, unknown>): Promise<unknown> {
  return pyJsonLoads(await runPythonAsync(BOOT, pyJsonDumps(request, { ensureAscii: true })), { lossless: true });
}

export const ORACLE_BOOT = BOOT;
