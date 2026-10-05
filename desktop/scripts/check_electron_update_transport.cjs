'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const desktopRoot = path.resolve(__dirname, '..');
const electron = createRequire(path.join(desktopRoot, 'package.json'))('electron');
const fixture = path.join(desktopRoot, 'tests', 'electron-net-asset-fixture.cjs');

async function main() {
  if (typeof electron !== 'string') throw new Error('Electron runtime is not installed.');
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'xueness-electron-update-transport-'));
  const resultPath = path.join(scratch, 'result.json');
  let child;
  let stdout = '';
  let stderr = '';
  try {
    const environment = { ...process.env, XUENESS_ELECTRON_FIXTURE_RESULT: resultPath };
    delete environment.ELECTRON_RUN_AS_NODE;
    child = spawn(electron, ['--user-data-dir=' + path.join(scratch, 'profile'), fixture], {
      cwd: desktopRoot,
      env: environment,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout = (stdout + chunk).slice(-8000); });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });

    const exit = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('Electron loopback transport fixture timed out after 45 seconds.'));
      }, 45_000);
      child.once('error', error => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });

    let fileResult = null;
    try { fileResult = JSON.parse(await fs.readFile(resultPath, 'utf8')); } catch {}
    if (exit.code !== 0) {
      throw new Error('Electron fixture exited with ' + (exit.signal || exit.code)
        + ': ' + (fileResult?.error || stderr || stdout || 'no diagnostic output'));
    }
    if (!fileResult?.result) {
      throw new Error('Electron fixture did not write results: ' + (stderr || stdout || 'no diagnostic output'));
    }
    const result = fileResult.result;
    assert.equal(result.trustedHits, 2, 'trusted redirect and slow stream should reach the trusted loopback server');
    assert.equal(result.deniedHits, 0, 'untrusted redirect target must receive zero requests');
    assert.equal(result.streamedBytes, 256 * 1024, 'trusted redirect body must stream completely');
    assert.equal(result.streamedBeforeComplete, true, 'body must be readable before the server finishes sending it');
    assert.equal(result.abortErrorObserved, true, 'cancelling must abort the active body stream');
    assert.equal(result.slowClosed, true, 'cancellation must close the upstream response');
    process.stdout.write('Electron updater transport loopback regression passed: ' + JSON.stringify(result) + '\n');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
