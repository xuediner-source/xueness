import { runSessionStorageCommand } from "../plugins/sessions/src/session-storage.ts";
import { fileURLToPath } from 'node:url';
import { effectivePlugins } from '../apps/server/src/plugin-state.ts';

try {
  process.stdout.write(`${await runSessionStorageCommand(process.argv.slice(2), state => effectivePlugins(fileURLToPath(new URL('../../', import.meta.url)), state)('sessions'))}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
