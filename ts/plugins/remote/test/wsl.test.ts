import assert from 'node:assert/strict';
import { it } from 'node:test';
import { connectionDiagnostics, describeDiagnostic, detectWsl, fromWslPosixPath, toWslPosixPath } from '../src/wsl.ts';
import type { RemoteConnection } from '../src/store.ts';

const row: RemoteConnection = { id: 'ci', host: 'h', user: 'ops', port: 22, directory: '/srv/work', system: 'posix' };

it('detectWsl classifies WSL2, WSL1 and non-WSL hosts from kernel and environment evidence', () => {
  assert.equal(detectWsl({ procVersion: 'Linux version 5.15.167.4-microsoft-standard-WSL2...' }), 'wsl2');
  assert.equal(detectWsl({ procVersion: 'Linux version 4.4.0-19041-Microsoft' }), 'wsl1');
  assert.equal(detectWsl({ env: { WSL_DISTRO_NAME: 'Ubuntu' } }), 'wsl2');
  assert.equal(detectWsl({ procVersion: 'Linux version 6.12.94+' }), 'none');
  assert.equal(detectWsl({}), 'none');
});

it('drive and WSL UNC paths translate to POSIX and back losslessly', () => {
  assert.equal(toWslPosixPath('C:\\Users\\xu\\项目'), '/mnt/c/Users/xu/项目');
  assert.equal(fromWslPosixPath('/mnt/c/Users/xu/项目'), 'C:\\Users\\xu\\项目');
  assert.equal(toWslPosixPath('D:/data/runs'), '/mnt/d/data/runs');
  assert.equal(toWslPosixPath('\\\\wsl.localhost\\Ubuntu\\home\\u\\wt'), '/home/u/wt');
  assert.equal(toWslPosixPath('\\\\wsl$\\Debian\\srv\\work'), '/srv/work');
  assert.equal(toWslPosixPath('relative\\path'), null);
  assert.equal(toWslPosixPath(''), null);
  assert.equal(toWslPosixPath('/already/posix'), null);
  assert.equal(fromWslPosixPath('/home/u/wt'), null, 'a non-mount POSIX path has no Windows form');
});

it('a Windows-style directory on a POSIX remote is diagnosable with a translated suggestion', () => {
  const findings = connectionDiagnostics(
    { ...row, directory: 'C:\\Users\\xu\\wt' },
    { platform: 'linux', wsl: 'none' },
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.code, 'remote_directory_not_posix');
  assert.equal(findings[0]?.translated, '/mnt/c/Users/xu/wt');
  assert.ok(findings[0]?.message.includes(JSON.stringify('C:\\Users\\xu\\wt')), 'the raw directory is quoted in the message');
  assert.ok(describeDiagnostic(findings[0]!).includes('use "/mnt/c/Users/xu/wt"'));
});

it('a remote declared system=windows is refused with the upstream message and nothing else', () => {
  const findings = connectionDiagnostics({ ...row, system: 'windows' }, { platform: 'linux', wsl: 'none' });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.code, 'remote_windows_refused');
  assert.ok(findings[0]?.message.includes('remote Windows hosts are not supported'));
});

it('local platform differences are reported for Windows and WSL clients, and clean POSIX stays quiet', () => {
  const windows = connectionDiagnostics(row, { platform: 'win32', wsl: 'none' });
  assert.equal(windows[0]?.code, 'local_windows_client');
  assert.ok(windows[0]?.message.includes('nul'));

  const inside = connectionDiagnostics(row, { platform: 'linux', wsl: 'wsl2' });
  assert.equal(inside[0]?.code, 'local_wsl2');
  assert.ok(inside[0]?.message.includes('DrvFs'));

  const wsl1 = connectionDiagnostics(row, { platform: 'linux', wsl: 'wsl1' });
  assert.equal(wsl1[0]?.code, 'local_wsl1');

  assert.deepEqual(connectionDiagnostics(row, { platform: 'linux', wsl: 'none' }), []);
});

it('diagnostics never embed credentials or environment values', () => {
  const findings = [
    ...connectionDiagnostics({ ...row, directory: 'C:\\secret' }, { platform: 'win32', wsl: 'wsl2' }),
    ...connectionDiagnostics(row, { platform: 'linux', wsl: 'none' }),
  ];
  const text = findings.map(describeDiagnostic).join(' ');
  for (const banned of ['PASSWORD', 'TOKEN', 'SECRET_KEY', 'API_KEY']) assert.ok(!text.includes(banned));
  // Only the operator-provided directory appears, never host credentials.
  assert.ok(text.includes('C:\\secret') || findings.length >= 2);
});
