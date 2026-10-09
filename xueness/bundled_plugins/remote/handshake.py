"""Experimental SSH handshake and capability check. Default off.

Feature ``remote.handshake``. Settings key ``general.remoteHandshakeEnabled``
must be boolean true. While it is off, ``remote_exec`` runs the approved
argv exactly as before and the result stays ``ok`` / ``exit_code`` / ``output``.

While it is on, a POSIX host is probed before the operator command is sent.
The probe is a fixed shell script: ``uname -s``, ``uname -m``, and
``/proc/sys/kernel/ostype`` when that file exists. Banner lines before the
marker are skipped. The report is normalized, then negotiated:

* ``win32`` (including ``windows_nt``, ``mingw*``, ``msys*``, ``cygwin*``)
  is refused. The operator command is not sent. A connection saved as
  ``system=windows`` never reaches this probe; that refusal still happens
  before approval and before SSH.
* ``darwin`` reported on a Linux kernel is treated as ``linux``.
* anything else that parses is ``posix-shell`` and the command runs.

Failures carry a string ``error``, an ``error_code``, and
``failure.{code,message,retryable}``. Stdout and stderr in ``diagnostics``
are capped and stripped of control characters. There is no top-level
``retryable``: the agent loop pauses a run when that field is false, and a
failed probe must not be reported as that kind of pause.

A declared Windows host is still refused with the existing error before any
of this runs.

The shape follows ZCode v3.14.3 (Apache-2.0, idea only, not copied code):
``packages/server/src/remote/handshake.ts`` (skip preamble, keep a bounded
stdout/stderr and the exit code), ``detectEnv.ts`` and
``ssh-backend.ts`` ``detect`` (uname plus kernel ostype),
``remotePlatformSupport.ts`` (refuse a Windows remote before the command),
and ``packages/zcode-server-cli/src/contracts.ts`` plus
``ipc/controlError.ts`` (``code``, ``message``, ``retryable``).
``harness/remote`` is only a container that exposes sshd; this path does
not deploy a remote server and does not speak that server's hello.
"""
from __future__ import annotations

import re

FEATURE_ID = 'remote.handshake'
SETTINGS_SECTION = 'general'
SETTINGS_KEY = 'remoteHandshakeEnabled'
SCHEMA = 'xueness.remote-handshake.v1'
PROTOCOL = 1

PROBE_TIMEOUT_SECONDS = 15
MAX_PARSE_CHARS = 65536
MAX_PREAMBLE_LINES = 32
MAX_DIAGNOSTIC_CHARS = 2048
_DIAGNOSTIC_SCAN = 65536

BEGIN = 'xueness-hello-begin'
END = 'xueness-hello-end'
_FIELD = re.compile(r'[A-Za-z0-9._+/-]{0,64}\Z')
# CSI, OSC, and single-character ESC. Dropping only ESC would leave "[31m".
_ANSI = re.compile(
    r'\x1b\[[0-?]*[ -/]*[@-~]'
    r'|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?'
    r'|\x1b[@-Z\\-_]')

# Fixed remote script. No operator argv, directory, host, or user is inserted.
# ``|| true`` keeps a missing kernel file from failing the probe; there is no
# redirection, so a mislabeled Windows shell cannot be told to write a file.
# printf interprets ``\n`` in the format string. The shell sees those two
# characters because the format is single-quoted.
PROBE_COMMAND = (
    "printf '%s\\n' xueness-hello-begin\n"
    "uname -s\n"
    "uname -m\n"
    "xueness_kernel_ostype=$(cat /proc/sys/kernel/ostype || true)\n"
    "printf '%s\\n' \"$xueness_kernel_ostype\"\n"
    "printf '%s\\n' xueness-hello-end\n"
)

_TRANSPORT = (
    ('ssh_host_key', False, 'SSH host key verification failed', (
        'host key verification failed',
        'remote host identification has changed',
    )),
    ('ssh_auth', False, 'SSH authentication failed', (
        'permission denied',
        'authentication failed',
        'too many authentication failures',
    )),
    ('ssh_timeout', True, 'SSH connection timed out', (
        'connection timed out',
        'operation timed out',
    )),
    ('ssh_unavailable', True, 'SSH connection failed', (
        'connection refused',
        'connection closed',
        'could not resolve',
        'name or service not known',
        'no route to host',
        'network is unreachable',
        'connection reset',
    )),
)


def enabled(state_dir) -> bool:
    """True only for a boolean true in the bound state directory."""
    from ..settings.settings_store import load_settings
    try:
        section = load_settings(state_dir).get(SETTINGS_SECTION, {})
    except (OSError, ValueError, TypeError):
        return False
    return isinstance(section, dict) and section.get(SETTINGS_KEY) is True


def normalize_platform(raw: str) -> str:
    platform = raw.strip().lower()
    if platform in ('darwin', 'macos'):
        return 'darwin'
    if platform in ('linux', 'gnu/linux'):
        return 'linux'
    if (platform == 'windows_nt' or platform.startswith(('mingw', 'msys', 'cygwin'))):
        return 'win32'
    return platform


def normalize_arch(raw: str) -> str:
    arch = raw.strip().lower()
    if arch in ('x86_64', 'amd64'):
        return 'x64'
    if arch in ('aarch64', 'arm64e'):
        return 'arm64'
    return arch


def parse_hello(stdout):
    """Return the three probe fields, or None when the frame is not usable."""
    if not isinstance(stdout, str) or not stdout:
        return None
    text = stdout[:MAX_PARSE_CHARS]
    if '\0' in text:
        return None
    lines = text.split('\n')
    begin_at = None
    for index, line in enumerate(lines):
        if _marker(line) == BEGIN:
            begin_at = index
            break
        if index + 1 >= MAX_PREAMBLE_LINES:
            return None
    if begin_at is None:
        return None
    body = lines[begin_at + 1:begin_at + 5]
    if len(body) < 4 or _marker(body[3]) != END:
        return None
    platform, arch, kernel = (_field(body[0]), _field(body[1]), _field(body[2]))
    if not platform or not arch:
        return None
    if not _FIELD.fullmatch(platform) or not _FIELD.fullmatch(arch) or not _FIELD.fullmatch(kernel):
        return None
    return {'platform': platform, 'arch': arch, 'kernel': kernel}


def negotiate(raw):
    """Normalize one parsed hello into the capability report."""
    reported = normalize_platform(raw['platform'])
    kernel = normalize_platform(raw['kernel']) if raw.get('kernel') else ''
    platform = reported
    corrected = False
    if reported == 'darwin' and kernel == 'linux':
        platform = 'linux'
        corrected = True
    windows = platform == 'win32'
    return {
        'schema': SCHEMA,
        'protocol': PROTOCOL,
        'platform': platform,
        'reportedPlatform': reported,
        'arch': normalize_arch(raw['arch']),
        'reportedArch': raw['arch'],
        'kernel': kernel,
        'shell': 'unsupported' if windows else 'posix',
        'capabilities': [] if windows else ['posix-shell'],
        'accepted': not windows,
        'platformCorrected': corrected,
    }


def decide(returncode, stdout, stderr):
    """Accept a POSIX probe, or build the tool result that refuses the command."""
    hello = parse_hello(stdout)
    view = negotiate(hello) if hello else None
    if view is not None and view['platform'] == 'win32':
        return _rejected(
            'capability_unsupported', _windows_message(view), False,
            returncode, stdout, stderr, view)
    if view is not None and returncode == 0:
        return {'accepted': True, 'hello': view}
    kind = _classify_transport(stderr)
    if kind is not None:
        code, retryable, message = kind
        return _rejected(code, message, retryable, returncode, stdout, stderr, view)
    if view is None and returncode == 0:
        return _rejected(
            'handshake_invalid',
            'remote handshake did not report a usable capability',
            False, returncode, stdout, stderr, None)
    closed_retryable = returncode == 255
    return _rejected(
        'handshake_closed',
        'remote handshake closed before a capability report',
        closed_retryable, returncode, stdout, stderr, view)


def timeout_result(exc):
    """Probe timed out. The message does not include the ssh argv."""
    return _rejected(
        'ssh_timeout', 'SSH connection timed out', True, None,
        getattr(exc, 'stdout', None), getattr(exc, 'stderr', None), None)['result']


def command_timeout_result(exc, hello):
    """The operator command was sent and the local wait expired."""
    stdout = _text(getattr(exc, 'stdout', None))
    stderr = _text(getattr(exc, 'stderr', None))
    message = 'remote command timed out'
    return {
        'ok': False,
        'executed': True,
        'exit_code': None,
        'output': (stdout + stderr)[:16000],
        'error': message,
        'error_code': 'command_timeout',
        'feature': FEATURE_ID,
        'handshake': hello,
        'failure': {'code': 'command_timeout', 'message': message, 'retryable': True},
        'diagnostics': diagnostics(None, stdout, stderr),
    }


def client_unavailable_result():
    return _rejected(
        'ssh_unavailable', 'ssh client unavailable', False, None, '', '', None)['result']


def diagnostics(exit_code, stdout, stderr):
    code = exit_code if isinstance(exit_code, int) and not isinstance(exit_code, bool) else None
    return {
        'exitCode': code,
        'stdout': bound_text(stdout),
        'stderr': bound_text(stderr),
    }


def bound_text(value, limit=MAX_DIAGNOSTIC_CHARS) -> str:
    """Keep the tail of a diagnostic and drop terminal control characters."""
    if not isinstance(value, str) or not value:
        return ''
    if len(value) > _DIAGNOSTIC_SCAN:
        value = value[-_DIAGNOSTIC_SCAN:]
    value = _ANSI.sub('', value)
    kept = []
    for char in value:
        if char in '\n\t' or (char.isprintable() and char != '\r'):
            kept.append(char)
    cleaned = ''.join(kept)
    if len(cleaned) > limit:
        cleaned = cleaned[-limit:]
    return cleaned


def cli_local_failure(result) -> bool:
    """True when the CLI should print a local failure instead of command output."""
    if not isinstance(result, dict) or result.get('feature') != FEATURE_ID:
        return False
    if result.get('executed') is False:
        return True
    return result.get('error_code') == 'command_timeout'


def cli_payload(result):
    return {
        'error': result.get('error'),
        'error_code': result.get('error_code'),
        'failure': result.get('failure'),
        'handshake': result.get('handshake'),
        'diagnostics': result.get('diagnostics'),
        'executed': result.get('executed'),
        'feature': result.get('feature'),
    }


def _windows_message(view) -> str:
    reported = view.get('reportedPlatform') or view.get('platform') or 'win32'
    return (
        'remote Windows hosts are not supported (probed platform=%s): commands are '
        'quoted for a POSIX shell and cannot be run safely on cmd or PowerShell'
        % reported)


def _rejected(code, message, retryable, exit_code, stdout, stderr, view):
    code_value = exit_code if isinstance(exit_code, int) and not isinstance(exit_code, bool) else None
    return {
        'accepted': False,
        'result': {
            'ok': False,
            'executed': False,
            'exit_code': code_value,
            'error': message,
            'error_code': code,
            'feature': FEATURE_ID,
            'handshake': view,
            'failure': {
                'code': code,
                'message': message,
                'retryable': bool(retryable),
            },
            'diagnostics': diagnostics(code_value, stdout, stderr),
        },
    }


def _classify_transport(stderr):
    if not isinstance(stderr, str) or not stderr:
        return None
    sample = stderr[-_DIAGNOSTIC_SCAN:].lower()
    for code, retryable, message, needles in _TRANSPORT:
        if any(needle in sample for needle in needles):
            return code, retryable, message
    return None


def _marker(line) -> str:
    return line.rstrip('\r').strip()


def _field(line) -> str:
    return line.rstrip('\r').strip()


def _text(value) -> str:
    return value if isinstance(value, str) else ''
