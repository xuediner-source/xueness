/**
 * SSH local port forwarding (F11.06). Each forward is one `ssh -N -L`
 * child: no shell, no remote command, only the saved connection's host key
 * and BatchMode authentication — credentials are never taken from or stored
 * in code. `ExitOnForwardFailure=yes` turns a refused remote bind into a
 * diagnosable exit instead of a silent half-open tunnel.
 *
 * Lifecycle is generation-fenced like the connection manager: reopening the
 * same forward id replaces the previous child, `close()` kills the process
 * group, and an early exit reports the same transport failure classes the
 * remote handshake already classifies (auth, host key, timeout, unavailable).
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { killTree, trackChild } from '@xueness/engine-tools';
import { boundText, classifyTransport } from './handshake.ts';
import { digest, loadConnections, posixOrThrow, sshEnv, type RemoteConnection } from './store.ts';

export const PORT_FORWARD_SCHEMA = 'xueness.port-forward.v1';
export const MAX_FORWARDS = 8;
export const ESTABLISH_GRACE_MS = 500;
const LOOPBACK_BINDS = new Set(['127.0.0.1', 'localhost', '::1']);
const HOST = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
const FORWARD_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SSH_DEVNULL = process.platform === 'win32' ? 'nul' : '/dev/null';
const STDERR_CAPTURE = 8192;

export interface ForwardSpec {
  bind: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
}

export interface ForwardView {
  forwardId: string;
  connectionId: string;
  generation: string;
  state: 'pending' | 'established' | 'closed' | 'failed';
  spec: ForwardSpec;
  failure: { code: string; message: string; retryable: boolean } | null;
  diagnostics: { exitCode: number | null; stderr: string };
}

type Spawner = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface ForwardHost {
  /** Saved-connection guard, mirroring the connection manager's row check. */
  row(connectionId: string, expectedDigest: string): RemoteConnection;
}

/** `ssh -N -L` argv for a validated spec; no remote command is ever attached. */
export function forwardArgv(row: RemoteConnection, spec: ForwardSpec): string[] {
  return [
    'ssh', '-F', SSH_DEVNULL, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=10',
    '-p', String(row.port), '-N',
    '-L', `${spec.bind}:${spec.localPort}:${spec.remoteHost}:${spec.remotePort}`,
    `${row.user}@${row.host}`,
  ];
}

/**
 * Spec rules: loopback bind only (a forwarded port must not become a shared
 * listener), the remote target must be a bare host (no user@, no scheme),
 * the remote port must be unprivileged, and both ports must be in range.
 */
export function validateForwardSpec(spec: unknown): ForwardSpec {
  if (typeof spec !== 'object' || spec === null) throw new TypeError('forward spec must be an object');
  const row = spec as Record<string, unknown>;
  const bind = typeof row.bind === 'string' && LOOPBACK_BINDS.has(row.bind) ? row.bind : null;
  if (bind === null) throw new RangeError('forward bind must be loopback (127.0.0.1, localhost or ::1)');
  const port = (value: unknown, label: string, floor: number): number => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < floor || value > 65535) {
      throw new RangeError(`forward ${label} must be an integer between ${floor} and 65535`);
    }
    return value;
  };
  const remoteHost = typeof row.remoteHost === 'string' && HOST.test(row.remoteHost) && !row.remoteHost.includes('@')
    ? row.remoteHost : null;
  if (remoteHost === null) throw new RangeError('forward remoteHost must be a bare host name');
  return { bind, localPort: port(row.localPort, 'localPort', 1), remoteHost, remotePort: port(row.remotePort, 'remotePort', 1024) };
}

interface LiveForward {
  view: ForwardView;
  child: ChildProcess | null;
  untrack: (() => void) | null;
  settled: boolean;
}

export interface PortForwardOptions {
  host: ForwardHost;
  /** Tests substitute a fake ssh child; production spawns the local client. */
  factory?: Spawner;
  /** Pair a synthetic child factory with its own lifecycle; real children use the platform process-tree terminator. */
  stopTree?: (child: ChildProcess, signal: NodeJS.Signals) => void;
  root?: string;
  graceMs?: number;
}

/**
 * Owns the forward children of one process. In-process only, like the
 * connection manager: nothing here is persisted or shared across processes.
 */
export class PortForwardManager {
  readonly forwards = new Map<string, LiveForward>();
  private readonly options: PortForwardOptions;
  private closed = false;

  constructor(options: PortForwardOptions) { this.options = options; }

  /**
   * Open (or replace, generation-fenced) a forward. The saved connection row
   * is re-checked under its digest first, so a changed configuration refuses
   * instead of forwarding through stale host settings.
   */
  open(forwardId: string, connectionId: string, expectedDigest: string, spec: unknown): ForwardView {
    if (this.closed) throw new Error('port forwarding is closed');
    if (typeof forwardId !== 'string' || !FORWARD_ID.test(forwardId)) throw new TypeError('invalid forward id');
    const validated = validateForwardSpec(spec);
    const row = this.options.host.row(connectionId, expectedDigest);
    posixOrThrow(row);
    this.close(forwardId);
    if (this.forwards.size >= MAX_FORWARDS) throw new RangeError('port forward capacity reached');
    const view: ForwardView = {
      forwardId, connectionId, generation: randomUUID().replace(/-/g, ''),
      state: 'pending', spec: validated, failure: null, diagnostics: { exitCode: null, stderr: '' },
    };
    const live: LiveForward = { view, child: null, untrack: null, settled: false };
    this.forwards.set(forwardId, live);
    const factory: Spawner = this.options.factory ?? ((file, args, spawnOptions) => spawn(file, [...args], spawnOptions));
    let child: ChildProcess;
    try {
      child = factory('ssh', forwardArgv(row, validated), {
        cwd: this.options.root ?? process.cwd(), env: sshEnv(),
        stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, shell: false, detached: process.platform !== 'win32',
      });
    } catch {
      view.state = 'failed';
      view.failure = { code: 'ssh_unavailable', message: 'ssh client unavailable', retryable: false };
      return view;
    }
    live.child = child;
    live.untrack = trackChild(child);
    child.once('exit', () => live.untrack?.());
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      // Only classification text is kept, bounded and sanitized on report.
      if (stderr.length < STDERR_CAPTURE) stderr += chunk.toString('utf8', 0, STDERR_CAPTURE - stderr.length);
    });
    child.once('error', () => this.fail(live, null, 'ssh client unavailable', 'ssh_unavailable', false, stderr));
    child.once('close', (code) => {
      if (live.settled) { this.finish(live, 'closed', code ?? null, stderr); return; }
      const kind = classifyTransport(stderr);
      this.fail(live, code ?? null, kind?.message ?? 'port forward exited before establishing', kind?.code ?? 'forward_failed', kind?.retryable ?? false, stderr);
    });
    const grace = setTimeout(() => {
      if (this.forwards.get(forwardId) === live && !live.settled && child.exitCode === null && child.signalCode === null) {
        live.settled = true;
        view.state = 'established';
      }
    }, this.options.graceMs ?? ESTABLISH_GRACE_MS);
    grace.unref?.();
    return { ...view };
  }

  list(): ForwardView[] { return [...this.forwards.values()].map((live) => ({ ...live.view })); }

  /** Close one forward by id; unknown ids close silently (idempotent). */
  close(forwardId: string): ForwardView | null {
    const live = this.forwards.get(forwardId);
    if (!live) return null;
    this.forwards.delete(forwardId);
    this.teardown(live, 'closed');
    return { ...live.view };
  }

  /** Close every forward; used when a connection or the manager dies. */
  closeAll(): void {
    for (const id of [...this.forwards.keys()]) this.close(id);
    this.closed = true;
  }

  private teardown(live: LiveForward, state: ForwardView['state']): void {
    live.settled = true;
    live.view.state = state;
    const child = live.child;
    if (child) {
      const stop = this.options.stopTree ?? killTree;
      try { stop(child, 'SIGTERM'); } catch { /* already gone */ }
      const grace = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) { try { stop(child, 'SIGKILL'); } catch { /* already gone */ } }
      }, 200);
      grace.unref?.();
    }
    try { child?.stderr?.destroy(); } catch { /* already closed */ }
  }

  private finish(live: LiveForward, state: ForwardView['state'], exitCode: number | null, stderr: string): void {
    live.view.state = state;
    live.view.diagnostics = { exitCode, stderr: boundText(stderr) };
  }

  private fail(live: LiveForward, exitCode: number | null, message: string, code: string, retryable: boolean, stderr: string): void {
    if (live.settled) {
      this.finish(live, 'closed', exitCode, stderr);
      return;
    }
    live.settled = true;
    live.view.state = 'failed';
    live.view.failure = { code, message, retryable };
    live.view.diagnostics = { exitCode, stderr: boundText(stderr) };
  }
}
