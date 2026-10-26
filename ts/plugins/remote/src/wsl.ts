/**
 * WSL and cross-platform path diagnostics for remote connections (F11.06).
 *
 * A saved connection points at a POSIX remote, but the local host may be
 * Windows, WSL or another POSIX system, and operators paste Windows paths
 * into `directory`. These pure helpers detect the local WSL mode, translate
 * drive/UNC paths to their WSL POSIX form and back, and explain the exact
 * platform difference in a diagnosable row — so connect failures name the
 * mismatch instead of surfacing as an opaque ssh error. No environment or
 * credential values are embedded: detection takes its inputs as arguments.
 */
import { WINDOWS_REMOTE_ERROR, type RemoteConnection } from './store.ts';

export type WslMode = 'none' | 'wsl1' | 'wsl2';

export interface WslProbe {
  platform?: string;
  env?: Record<string, string | undefined>;
  procVersion?: string;
}

/**
 * Classify the local host. Inside WSL the kernel string carries the marker
 * (`microsoft-standard` for WSL2, plain `Microsoft` for WSL1); a Windows
 * host that merely plans to reach WSL is not itself WSL.
 */
export function detectWsl(probe: WslProbe): WslMode {
  const version = (probe.procVersion ?? '').toLowerCase();
  if (version.includes('microsoft') || version.includes('wsldistro')) {
    if (version.includes('microsoft-standard') || version.includes('wsl2')) return 'wsl2';
    return 'wsl1';
  }
  const distro = probe.env?.WSL_DISTRO_NAME;
  if (distro) return 'wsl2';
  return 'none';
}

const DRIVE = /^([A-Za-z]):[\\/](.*)$/;
const UNC_WSL = /^\\\\wsl(?:\$|\.localhost)\\([^\\]+)\\(.*)$/;
const MNT_DRIVE = /^\/mnt\/([A-Za-z])\/(.*)$/;

function toSlashes(value: string): string { return value.replaceAll('\\', '/'); }

/** `C:\Users\x` → `/mnt/c/Users/x`; `\\wsl.localhost\Ubuntu\home\u` → `/home/u`. */
export function toWslPosixPath(path: string): string | null {
  if (typeof path !== 'string' || !path) return null;
  const unc = UNC_WSL.exec(path);
  if (unc) {
    const rest = toSlashes(unc[2] ?? '');
    return '/' + rest;
  }
  const drive = DRIVE.exec(path);
  if (!drive) return null;
  const [, letter, restRaw] = drive;
  const rest = toSlashes(restRaw ?? '');
  return `/mnt/${letter!.toLowerCase()}/${rest}`;
}

/** `/mnt/c/Users/x` → `C:\Users\x` (distinguished by the drive mount form). */
export function fromWslPosixPath(path: string): string | null {
  if (typeof path !== 'string' || !path) return null;
  const drive = MNT_DRIVE.exec(path);
  if (!drive) return null;
  const [, letter, rest] = drive;
  return `${letter!.toUpperCase()}:\\${rest!.replaceAll('/', '\\')}`;
}

export interface PathDiagnostic {
  code: string;
  message: string;
  suggestion: string | null;
  /** A translated replacement for the offending field, when one exists. */
  translated: string | null;
}

const WINDOWS_PATH_LOOKS = /^[A-Za-z]:[\\/]/;

/**
 * Diagnose one saved connection against the local platform: a Windows-style
 * directory on a POSIX remote, a remote declared `system=windows` (refused
 * upstream), or the local Windows/WSL client differences that matter for
 * ssh (`nul` vs `/dev/null`, CRLF in probe output, drive mounts).
 */
export function connectionDiagnostics(row: RemoteConnection, local: { platform: string; wsl: WslMode }): PathDiagnostic[] {
  const findings: PathDiagnostic[] = [];
  if (row.system === 'windows') {
    findings.push({ code: 'remote_windows_refused', message: WINDOWS_REMOTE_ERROR, suggestion: 'declare system=posix and connect to the host\'s WSL or POSIX side', translated: null });
    return findings;
  }
  const directory = row.directory ?? '.';
  if (WINDOWS_PATH_LOOKS.test(directory)) {
    const translated = toWslPosixPath(directory);
    findings.push({
      code: 'remote_directory_not_posix',
      message: `remote directory ${JSON.stringify(directory)} is a Windows path, but the POSIX remote expects /home/... form`,
      suggestion: translated ? `use ${JSON.stringify(translated)} for the remote's WSL mount, or a native POSIX path` : 'replace it with a POSIX path',
      translated,
    });
  }
  if (local.platform === 'win32') {
    findings.push({
      code: 'local_windows_client',
      message: 'local Windows OpenSSH client: ssh reads its own config and known_hosts, and devnull is nul',
      suggestion: 'verify the host key is trusted under the Windows user profile before enabling BatchMode',
      translated: null,
    });
  }
  if (local.wsl !== 'none') {
    findings.push({
      code: `local_${local.wsl}`,
      message: `running inside WSL (${local.wsl}): files under /mnt are DrvFs mounts and may carry different permissions than the remote expects`,
      suggestion: 'prefer a workspace inside the Linux filesystem (~/...) over /mnt/... for remote work',
      translated: null,
    });
  }
  return findings;
}

/** Human summary for one diagnostic row, for logs and approval prompts. */
export function describeDiagnostic(finding: PathDiagnostic): string {
  const head = `${finding.code}: ${finding.message}`;
  return finding.suggestion ? `${head} (${finding.suggestion})` : head;
}
