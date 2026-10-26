import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { it } from 'node:test';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { MAX_FORWARDS, PortForwardManager, forwardArgv, validateForwardSpec, type ForwardHost } from '../src/forwarding.ts';
import type { RemoteConnection } from '../src/store.ts';

type Factory = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const row: RemoteConnection = { id: 'ci', host: 'host.example', user: 'ops', port: 2222, directory: '.', system: 'posix' };
const windowsRow: RemoteConnection = { ...row, system: 'windows' };
const digest64 = 'd'.repeat(64);
const spec = { bind: '127.0.0.1', localPort: 8080, remoteHost: 'db.internal', remotePort: 5432 };

class FakeSsh extends EventEmitter {
  pid = 4242;
  exitCode: number | null = null;
  signalCode: string | null = null;
  argv: readonly string[] = [];
  stderr = Object.assign(new EventEmitter(), { destroy() {} });
  killed = false;
  kill(signal: NodeJS.Signals = 'SIGTERM') {
    this.killed = true;
    if (this.exitCode === null && this.signalCode === null) {
      this.signalCode = signal;
      this.emit('exit', null, signal);
      this.emit('close', null, signal);
    }
    return true;
  }
  exit(code: number | null, stderrText = ''): void {
    if (stderrText) this.stderr.emit('data', Buffer.from(stderrText));
    this.exitCode = code ?? 0;
    this.emit('exit', code);
    this.emit('close', code);
  }
}

function fakeFactory() {
  const spawnCalls: FakeSsh[] = [];
  const factory = ((_cmd: string, argv: readonly string[]): ChildProcess => {
    const child = new FakeSsh();
    child.argv = argv;
    spawnCalls.push(child);
    return child as unknown as ChildProcess;
  }) as unknown as Factory;
  // A synthetic PID must never reach the operating system's taskkill/kill.
  const stopTree = (child: ChildProcess, signal: NodeJS.Signals): void => { child.kill(signal); };
  return { spawnCalls, factory, stopTree };
}

const host = (connection = row): ForwardHost => ({ row: () => connection });

it('forwardArgv builds a no-shell -N -L command with BatchMode auth and no remote command', () => {
  const argv = forwardArgv(row, spec);
  assert.equal(argv[0], 'ssh');
  assert.ok(argv.includes('-N'), 'no remote command may execute');
  const forward = argv[argv.indexOf('-L') + 1];
  assert.equal(forward, '127.0.0.1:8080:db.internal:5432');
  assert.ok(argv.includes('BatchMode=yes'));
  assert.ok(argv.includes('StrictHostKeyChecking=yes'));
  assert.ok(argv.includes('ExitOnForwardFailure=yes'), 'a refused remote bind must exit, not hang half-open');
  assert.equal(argv[argv.indexOf('-p') + 1], '2222');
  assert.equal(argv.at(-1), 'ops@host.example');
  assert.equal(argv.filter((item) => item === 'ops@host.example').length, 1, 'no second command slot after user@host');
});

it('validateForwardSpec enforces loopback binds, unprivileged remote ports and bare hosts', () => {
  assert.deepEqual(validateForwardSpec(spec), spec);
  assert.throws(() => validateForwardSpec({ ...spec, bind: '0.0.0.0' }), /loopback/);
  assert.throws(() => validateForwardSpec({ ...spec, bind: '192.168.1.5' }), /loopback/);
  assert.throws(() => validateForwardSpec({ ...spec, remotePort: 22 }), /remotePort/);
  assert.throws(() => validateForwardSpec({ ...spec, remotePort: 70000 }), /remotePort/);
  assert.throws(() => validateForwardSpec({ ...spec, localPort: 0 }), /localPort/);
  assert.throws(() => validateForwardSpec({ ...spec, remoteHost: 'user@db.internal' }), /bare host/);
  assert.throws(() => validateForwardSpec({ ...spec, remoteHost: 'https://db.internal' }), /bare host/);
});

it('open refuses a Windows remote before any child is spawned', () => {
  const { spawnCalls, ...lifecycle } = fakeFactory();
  const manager = new PortForwardManager({ host: host(windowsRow), ...lifecycle, graceMs: 5 });
  assert.throws(() => manager.open('f1', 'ci', digest64, spec), /remote Windows hosts are not supported/);
  assert.equal(spawnCalls.length, 0);
});

it('a forward establishes after the grace window, closes on demand, and close is idempotent', async () => {
  const { spawnCalls, ...lifecycle } = fakeFactory();
  const manager = new PortForwardManager({ host: host(), ...lifecycle, graceMs: 10 });
  const view = manager.open('f1', 'ci', digest64, spec);
  assert.equal(view.state, 'pending');
  assert.ok(view.generation);
  await sleep(40);
  assert.equal(manager.list()[0]?.state, 'established');

  const closed = manager.close('f1');
  assert.equal(closed?.state, 'closed');
  assert.equal(spawnCalls[0]?.killed, true, 'close must kill the ssh process group');
  assert.equal(manager.close('f1'), null, 'closing again is a no-op');
  assert.deepEqual(manager.list(), []);
  manager.closeAll();
});

it('an early exit classifies ssh auth and timeout failures with bounded diagnostics', async () => {
  const auth = fakeFactory();
  const authManager = new PortForwardManager({ host: host(), factory: auth.factory, stopTree: auth.stopTree, graceMs: 500 });
  authManager.open('f1', 'ci', digest64, spec);
  auth.spawnCalls[0]!.exit(255, 'Permission denied (publickey).\r\n');
  const failed = authManager.list()[0]!;
  assert.equal(failed.state, 'failed');
  assert.equal(failed.failure?.code, 'ssh_auth');
  assert.equal(failed.failure?.retryable, false);
  assert.ok(!failed.diagnostics.stderr.includes('\r'), 'CRLF control characters are sanitized out of diagnostics');

  const timeout = fakeFactory();
  const timeoutManager = new PortForwardManager({ host: host(), factory: timeout.factory, stopTree: timeout.stopTree, graceMs: 500 });
  timeoutManager.open('f2', 'ci', digest64, spec);
  timeout.spawnCalls[0]!.exit(255, 'ssh: connect to host host.example port 2222: Connection timed out');
  const timedOut = timeoutManager.list()[0]!;
  assert.equal(timedOut.state, 'failed');
  assert.equal(timedOut.failure?.code, 'ssh_timeout');
  assert.equal(timedOut.failure?.retryable, true);

  const refused = fakeFactory();
  const refusedManager = new PortForwardManager({ host: host(), factory: refused.factory, stopTree: refused.stopTree, graceMs: 500 });
  refusedManager.open('f3', 'ci', digest64, spec);
  refused.spawnCalls[0]!.exit(1, 'channel 2: open failed: connect failed: Connection refused');
  assert.equal(refusedManager.list()[0]?.failure?.code, 'ssh_unavailable');
  authManager.closeAll();
  timeoutManager.closeAll();
  refusedManager.closeAll();
});

it('capacity is bounded and reopening a forward id replaces the previous child', async () => {
  const { spawnCalls, ...lifecycle } = fakeFactory();
  const manager = new PortForwardManager({ host: host(), ...lifecycle, graceMs: 5 });
  for (let index = 0; index < MAX_FORWARDS; index += 1) {
    manager.open(`f${index}`, 'ci', digest64, { ...spec, localPort: 20000 + index });
  }
  assert.throws(() => manager.open('fx', 'ci', digest64, spec), /capacity reached/);

  const replacement = manager.open('f0', 'ci', digest64, spec);
  assert.notEqual(replacement.generation, undefined);
  assert.equal(spawnCalls[0]?.killed, true, 'the replaced child is torn down');
  assert.equal(manager.list().length, MAX_FORWARDS, 'replacement reuses the slot');
  assert.equal(manager.list().filter((view) => view.forwardId === 'f0').length, 1);
  manager.closeAll();
});

it('a changed saved configuration refuses to open a forward', () => {
  const { spawnCalls, ...lifecycle } = fakeFactory();
  const strict: ForwardHost = {
    row: (_connectionId: string, expectedDigest: string) => {
      if (expectedDigest !== digest64) throw new Error('connection changed; inspect configuration again');
      return row;
    },
  };
  const manager = new PortForwardManager({ host: strict, ...lifecycle, graceMs: 5 });
  assert.throws(() => manager.open('f1', 'ci', 'stale', spec), /connection changed/);
  assert.equal(spawnCalls.length, 0);
  manager.closeAll();
});

it('replacement and close stop real owned processes through the platform process-tree terminator', async () => {
  const children: { child: ChildProcess; exited: Promise<void> }[] = [];
  const factory: Factory = (_command, _args, options) => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
    const exited = new Promise<void>((resolve, reject) => { child.once('close', () => resolve()); child.once('error', reject); });
    children.push({ child, exited });
    return child;
  };
  const manager = new PortForwardManager({ host: host(), factory, graceMs: 10 });
  const waitForExit = async (owned: typeof children[number]): Promise<void> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([owned.exited, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('owned forward child did not exit')), 5000); })]);
    } finally { clearTimeout(timer); }
    assert.ok(owned.child.pid);
    assert.throws(() => process.kill(owned.child.pid!, 0), 'the real child PID must be gone');
  };
  try {
    manager.open('real', 'ci', digest64, spec);
    assert.ok(children[0]!.child.pid);
    manager.open('real', 'ci', digest64, spec);
    await waitForExit(children[0]!);
    manager.close('real');
    await waitForExit(children[1]!);
    assert.deepEqual(manager.list(), []);
  } finally { manager.closeAll(); }
});
