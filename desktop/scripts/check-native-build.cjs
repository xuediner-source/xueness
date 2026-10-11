'use strict';

const expectedPlatform = process.argv[2];
if (!['darwin', 'win32'].includes(expectedPlatform)) {
  console.error('Usage: node scripts/check-native-build.cjs <darwin|win32>');
  process.exit(2);
}
if (process.platform !== expectedPlatform) {
  console.error(`Refusing cross-platform desktop package: expected ${expectedPlatform}, running on ${process.platform}.`);
  process.exit(1);
}

const expectedArch = process.env.XUENESS_BUILD_ARCH;
const actualArch = process.arch === 'x64' ? 'x64' : process.arch;
if (expectedArch && expectedArch !== actualArch) {
  console.error(`Refusing cross-architecture desktop package: expected ${expectedArch}, Node is ${actualArch}.`);
  process.exit(1);
}
console.log(`Native package target verified: ${expectedPlatform}/${actualArch}`);
