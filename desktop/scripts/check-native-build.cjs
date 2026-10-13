'use strict';

const { spawnSync } = require('node:child_process');

const expectedPlatform = process.argv[2] === 'current' ? process.platform : process.argv[2];
const builderArgs = process.argv.slice(3);
if (!['darwin', 'win32'].includes(expectedPlatform)) {
  console.error('Usage: node scripts/check-native-build.cjs <darwin|win32>');
  process.exit(2);
}
if (process.platform !== expectedPlatform) {
  console.error(`Refusing cross-platform desktop package: expected ${expectedPlatform}, running on ${process.platform}.`);
  process.exit(1);
}

const SUPPORTED_ARCHES = new Set(['x64', 'arm64']);
const expectedArch = process.env.XUENESS_BUILD_ARCH;
const actualArch = process.arch === 'x64' ? 'x64' : process.arch;
if (!SUPPORTED_ARCHES.has(actualArch)) {
  console.error(`Refusing unsupported native desktop architecture: Node is ${actualArch}; expected x64 or arm64.`);
  process.exit(1);
}
if (expectedArch && !SUPPORTED_ARCHES.has(expectedArch)) {
  console.error(`Refusing unsupported native desktop architecture target: expected ${expectedArch}; use x64 or arm64.`);
  process.exit(1);
}
if (expectedArch && expectedArch !== actualArch) {
  console.error(`Refusing cross-architecture desktop package: expected ${expectedArch}, Node is ${actualArch}.`);
  process.exit(1);
}
// npm appends flags to this wrapper, so the guard checks the same target that
// electron-builder will receive rather than trusting only the CI environment.
const architectures = new Set();
for (const argument of builderArgs) {
  const match = argument.match(/^--(x64|arm64|ia32|armv7l|universal)(?:=|$)/)
    || argument.match(/:(x64|arm64|ia32|armv7l|universal)$/);
  if (match) architectures.add(match[1]);
  if ((expectedPlatform === 'win32' && /^(?:--mac|-m|--linux|-l)(?:=|$)/.test(argument))
      || (expectedPlatform === 'darwin' && /^(?:--win|-w|--linux|-l)(?:=|$)/.test(argument))) {
    console.error(`Refusing cross-platform desktop package argument: ${argument}.`);
    process.exit(1);
  }
}
if ([...architectures].some(arch => !SUPPORTED_ARCHES.has(arch))) {
  console.error('Refusing unsupported native desktop architecture argument; use x64 or arm64.');
  process.exit(1);
}
if (architectures.size > 1 || [...architectures].some(arch => arch !== actualArch)) {
  console.error(`Refusing cross-architecture desktop package argument: Node is ${actualArch}.`);
  process.exit(1);
}
console.log(`Native package target verified: ${expectedPlatform}/${actualArch}`);
if (builderArgs.length) {
  const result = spawnSync(process.execPath, [require.resolve('electron-builder/cli.js'), ...builderArgs], {
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(`Could not start native packager: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status === null ? 1 : result.status);
}
