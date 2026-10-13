import { build } from 'esbuild';
import { readdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
const root = import.meta.dirname;
const filters = process.argv.slice(2);
const sources = (await readdir(join(root, 'src'), { recursive: true })).filter(f => /\.test\.tsx?$/.test(f)
  && (!filters.length || filters.some(filter => f.replaceAll('\\', '/').includes(filter))));
if (!sources.length) throw new Error('No test files matched the requested filters');
const output = await mkdtemp(join(root, '.native-tests-'));
try {
  await build({ entryPoints: sources.map(f => join(root, 'src', f)), outdir: output, bundle: true,
    platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic', loader: { '.css': 'empty' }, logLevel: 'warning' });
  const files = (await readdir(output, { recursive: true })).filter(f => f.endsWith('.js')).map(f => resolve(output, f));
  const code = await new Promise((done, reject) => {
    const child = spawn(process.execPath, ['--test', ...files], { stdio: 'inherit' });
    child.on('error', reject); child.on('exit', done);
  });
  process.exitCode = code ?? 1;
} finally { await rm(output, { recursive: true, force: true }); }
