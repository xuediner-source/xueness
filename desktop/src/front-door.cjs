'use strict';
/**
 * The desktop backend is the TypeScript desktop host
 * (`ts/apps/server/src/desktop-host.ts`). It keeps the stdio protocol and the
 * desktop token, serves the web app and API on its own loopback origin and
 * reports that origin as ready. Packaged builds carry JS, production
 * dependencies and the tested standalone Node runtime. Round 10 removed the
 * Python backend and its rollback switch.
 *
 * Sources run unbuilt and need Node >= 24.11 (`ts/package.json` engines). The
 * runtime is, in order: XUENESS_FRONT_DOOR_NODE when set (honoured or reported,
 * never silently replaced); `node` on PATH when new enough; otherwise
 * Electron's own Node via ELECTRON_RUN_AS_NODE, so a source checkout starts
 * without a system-wide Node install.
 */
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const MINIMUM_NODE = '24.11';

function meetsMinimumNode(version) {
  const [major = 0, minor = 0] = String(version ?? '').replace(/^v/, '').split('.').map(Number);
  const [needMajor, needMinor] = MINIMUM_NODE.split('.').map(Number);
  return major > needMajor || (major === needMajor && minor >= needMinor);
}

/** The Node version an executable reports, or null when it cannot be run. */
function probeNodeVersion(executable, env) {
  try {
    const result = spawnSync(executable, ['-p', 'process.versions.node'], { env, encoding: 'utf8', timeout: 10000, windowsHide: true });
    return result.status === 0 ? result.stdout.trim() : null;
  } catch { return null; }
}

/** No usable runtime for the unbuilt sources; `reason` selects the user-facing message. */
class FrontDoorRuntimeError extends Error {
  constructor(reason, detail = {}) {
    super(`no usable Node ${MINIMUM_NODE}+ for the desktop backend (${reason})`);
    this.code = 'XUENESS_NODE_RUNTIME'; this.reason = reason; this.detail = { minimum: MINIMUM_NODE, ...detail };
  }
}

function sourceRuntime({ env, electronExecPath, electronNodeVersion, probe }) {
  const explicit = env.XUENESS_FRONT_DOOR_NODE;
  if (explicit) {
    const version = probe(explicit, env);
    if (meetsMinimumNode(version)) return { executable: explicit, env: {} };
    throw new FrontDoorRuntimeError(version ? 'explicit-too-old' : 'explicit-unusable', { executable: explicit, version });
  }
  const pathVersion = probe('node', env);
  if (meetsMinimumNode(pathVersion)) return { executable: 'node', env: {} };
  if (electronExecPath && meetsMinimumNode(electronNodeVersion)) return { executable: electronExecPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
  throw new FrontDoorRuntimeError(pathVersion ? 'path-too-old' : 'missing', { version: pathVersion });
}

/** The backend command; `Backend` appends `--data` and `--assets` and merges `env`. */
function frontDoorCommand({ env, packaged, root, resourcesPath, assets, electronExecPath, electronNodeVersion, probe = probeNodeVersion }) {
  if (packaged && !resourcesPath) throw new Error('packaged backend needs its resources directory');
  const runtime = packaged ? join(resourcesPath, 'backend-ts') : null;
  const node = runtime
    ? { executable: env.XUENESS_FRONT_DOOR_NODE || join(runtime, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'), env: {} }
    : sourceRuntime({ env, electronExecPath, electronNodeVersion, probe });
  return {
    executable: node.executable,
    env: node.env,
    args: [runtime ? join(runtime, 'apps', 'server', 'src', 'desktop-host.js') : join(root, 'ts', 'apps', 'server', 'src', 'desktop-host.ts'), '--assets', assets,
      '--project-root', packaged ? resourcesPath : root],
  };
}

module.exports = { frontDoorCommand, meetsMinimumNode, FrontDoorRuntimeError, MINIMUM_NODE };
