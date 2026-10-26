import assert from "node:assert/strict";
import fs, { statSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { mkdtempSync } from "../../../test-support/canonical-temp.ts";
import { BackgroundTasks } from "../src/background.ts";

it("waits for capped log files to close even after the child output is closed", { timeout: 10000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "xueness-log-drain-"));
  const tasks = new BackgroundTasks({ maxLogBytes: 10000, killGraceMs: 20 });
  const original = fs.createWriteStream;
  const files: fs.WriteStream[] = [];
  const finishers: (() => void)[] = [];
  let released = false;
  const finishLogs = () => { if (!released) { released = true; for (const finish of finishers) finish(); } };
  let signalEnd: () => void = () => {};
  const ending = new Promise<void>(resolve => { signalEnd = resolve; });
  // Hold real file completion until the caller has entered its drain wait.
  fs.createWriteStream = (...args: Parameters<typeof original>) => {
    const file = original(...args), end = file.end.bind(file);
    file.end = ((...endArgs: unknown[]) => {
      finishers.push(() => { Reflect.apply(end, file, endArgs); });
      signalEnd();
      return file;
    }) as typeof file.end;
    files.push(file);
    return file;
  };
  syncBuiltinESMExports();
  try {
    const info = await tasks.start({ file: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(12000))"],
      cwd: root, logDir: root, command: "log-drain-fixture", env: { ...process.env }, timeoutMs: 5000 });
    await ending;
    assert.equal(tasks.get(info.id)?.outputOpen, false);
    let settled = false;
    const reading = tasks.read(info.id, { waitMs: 5000 }).then(result => { settled = true; return result; });
    await Promise.resolve();
    assert.equal(settled, false, "read must enter the log drain wait after outputOpen becomes false");
    finishLogs();
    const result = await reading;
    assert.equal(result.info.state, "exited");
    assert.equal(files.length, 2);
    await tasks.dispose();
    assert(files.every(file => file.closed));
    assert.equal(statSync(info.stdout.path).size, 10000);
  } finally {
    fs.createWriteStream = original;
    syncBuiltinESMExports();
    finishLogs();
    await tasks.dispose();
    assert(root.startsWith(join(fs.realpathSync.native(tmpdir()), "xueness-log-drain-")));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
