'use strict';
/**
 * The desktop backend is the TypeScript desktop host
 * (`ts/apps/server/src/desktop-host.ts`). It keeps the stdio protocol and the
 * desktop token, serves the web app and API on its own loopback origin and
 * reports that origin as ready. Sources run unbuilt on a Node 24 runtime
 * (XUENESS_FRONT_DOOR_NODE, default `node` on PATH). Packaged builds carry JS,
 * production dependencies and the tested standalone Node runtime. Round 10
 * removed the Python backend and its rollback switch.
 */
const { join } = require('node:path');

/** The backend command; `Backend` appends `--data` and `--assets`. */
function frontDoorCommand({ env, packaged, root, resourcesPath, assets }) {
  if (packaged && !resourcesPath) throw new Error('packaged backend needs its resources directory');
  const runtime = packaged ? join(resourcesPath, 'backend-ts') : null;
  return {
    executable: env.XUENESS_FRONT_DOOR_NODE || (runtime ? join(runtime, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node') : 'node'),
    args: [runtime ? join(runtime, 'apps', 'server', 'src', 'desktop-host.js') : join(root, 'ts', 'apps', 'server', 'src', 'desktop-host.ts'), '--assets', assets,
      '--project-root', packaged ? resourcesPath : root],
  };
}

module.exports = { frontDoorCommand };
