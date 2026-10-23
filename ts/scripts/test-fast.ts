/** Cross-platform fast tests, including Windows cmd/npm. */
import { spawn } from "node:child_process";
const child = spawn(process.execPath, ["--test", "--test-reporter=spec", ...["packages/*", "plugins/*", "apps/*", "scripts"].map((path) => `${path}/test/**/*.test.ts`)], {
  stdio: "inherit", windowsHide: true, env: { ...process.env, XUENESS_SKIP_PYTHON_TESTS: "1" },
});
child.once("error", (error) => { process.stderr.write(error.message + "\n"); process.exitCode = 1; });
child.once("exit", (code) => { process.exitCode = code ?? 1; });
