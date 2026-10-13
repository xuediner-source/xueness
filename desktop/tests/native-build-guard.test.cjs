const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');

const guard = join(__dirname, '../scripts/check-native-build.cjs');
const supportedHost = ['darwin', 'win32'].includes(process.platform);
const platform = process.platform;

test('desktop packaging guard accepts only the running native OS and architecture', { skip: !supportedHost }, () => {
  const native = spawnSync(process.execPath, [guard, platform], { encoding: 'utf8' });
  assert.equal(native.status, 0, native.stderr);

  const foreignPlatform = spawnSync(process.execPath, [guard, platform === 'darwin' ? 'win32' : 'darwin'], {
    encoding: 'utf8',
  });
  assert.equal(foreignPlatform.status, 1);
  assert.match(foreignPlatform.stderr, /cross-platform/);

  const foreignArch = spawnSync(process.execPath, [guard, platform], {
    encoding: 'utf8',
    env: { ...process.env, XUENESS_BUILD_ARCH: process.arch === 'arm64' ? 'x64' : 'arm64' },
  });
  assert.equal(foreignArch.status, 1);
  assert.match(foreignArch.stderr, /cross-architecture/);

  const unsupportedTarget = spawnSync(process.execPath, [guard, platform], {
    encoding: 'utf8',
    env: { ...process.env, XUENESS_BUILD_ARCH: 'ia32' },
  });
  assert.equal(unsupportedTarget.status, 1);
  assert.match(unsupportedTarget.stderr, /unsupported native desktop architecture target/);
});

test('packager arguments cannot bypass the native target guard', { skip: !supportedHost }, () => {
  const argumentsToReject = [
    [process.arch === 'arm64' ? '--x64' : '--arm64'],
    ['--x64', '--arm64'],
    ['--universal'],
    ['--ia32'],
    [platform === 'darwin' ? '--win' : '--mac'],
    ['--linux'],
    [`dmg:${process.arch === 'arm64' ? 'x64' : 'arm64'}`],
  ];
  for (const args of argumentsToReject) {
    const result = spawnSync(process.execPath, [guard, platform, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1, `${args}: ${result.stderr}`);
    assert.match(result.stderr, /Refusing (?:cross|unsupported)/);
  }
});
