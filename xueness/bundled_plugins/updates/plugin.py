"""Explicit, fast-forward-only updates from the checkout's configured origin."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import urlsplit


def register_cli(commands):
    update = commands.add_parser('update', help='check or explicitly apply a source update from configured origin')
    sub = update.add_subparsers(dest='update_action', required=True)
    sub.add_parser('check', help='compare the current branch with its configured origin')
    apply = sub.add_parser('apply', help='fast-forward a clean checkout after explicit authorization')
    apply.add_argument('--allow-update', action='store_true',
                       help='authorize fetching and fast-forwarding this source checkout')


def _repo_root():
    return Path(__file__).resolve().parents[3]


def _git(root, *argv, check=True):
    command = ['git', '-c', 'credential.helper=', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
               '-c', 'protocol.ssh.allow=always', '-c',
               'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c',
               'submodule.recurse=false', '-c',
               'remote.origin.uploadpack=git-upload-pack', '-c',
               'core.sshCommand=ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10',
               *argv]
    env = dict(os.environ)
    env['GIT_TERMINAL_PROMPT'] = '0'
    env['GIT_CONFIG_NOSYSTEM'] = '1'
    env['GIT_CONFIG_GLOBAL'] = os.devnull
    env['GIT_SSH_COMMAND'] = 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10'
    env.pop('GIT_ASKPASS', None)
    env.pop('SSH_ASKPASS', None)
    for key in ('GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'GIT_DIR', 'GIT_WORK_TREE',
                'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'):
        env.pop(key, None)
    # A local filter driver may run an arbitrary command during checkout. Blank
    # every locally configured smudge/process driver for these read/update ops.
    filters = subprocess.run(['git', 'config', '--local', '--name-only', '--get-regexp',
                              r'^filter\..*\.(smudge|process)$'], cwd=root, env=env,
                             text=True, capture_output=True, timeout=10, check=False)
    if filters.returncode not in (0, 1):
        raise ValueError('could not inspect local Git filters')
    for key in filters.stdout.splitlines():
        if re.fullmatch(r'filter\.[A-Za-z0-9._-]+\.(?:smudge|process)', key):
            command.extend(['-c', key + '='])
    result = subprocess.run(command, cwd=root, env=env, text=True, capture_output=True,
                            timeout=45, check=False)
    if len(result.stdout) > 1_000_000 or len(result.stderr) > 100_000:
        raise ValueError('git response exceeded safety limits')
    if check and result.returncode:
        raise ValueError('git command failed: ' + (result.stderr.strip()[:300] or 'unknown error'))
    return result


def _configured_origin(root):
    top = Path(_git(root, 'rev-parse', '--show-toplevel').stdout.strip()).resolve()
    if top != Path(root).resolve():
        raise ValueError('update must run from the Xueness source checkout root')
    remote = _git(root, 'remote', 'get-url', 'origin').stdout.strip()
    if not remote or not _safe_origin(remote):
        raise ValueError('origin must be a configured HTTPS or SSH Git remote')
    branch = _git(root, 'branch', '--show-current').stdout.strip()
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/-]{0,200}', branch):
        raise ValueError('current branch is not configured for updates')
    upstream = _git(root, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}', check=False)
    if upstream.returncode or upstream.stdout.strip() != 'origin/' + branch:
        raise ValueError('current branch must track its origin branch')
    return branch


def _safe_origin(remote):
    if len(remote) > 2048 or any(ch.isspace() for ch in remote):
        return False
    if remote.startswith('https://') or remote.startswith('ssh://'):
        try:
            parsed = urlsplit(remote)
            return (parsed.scheme in ('https', 'ssh') and bool(parsed.hostname)
                    and (parsed.username is None if parsed.scheme == 'https' else parsed.username in (None, 'git'))
                    and parsed.password is None
                    and not parsed.query and not parsed.fragment)
        except ValueError:
            return False
    # Git's SCP-like SSH form. Reject options, ext:: helpers and local paths.
    return bool(re.fullmatch(r'(?:git@)?[A-Za-z0-9][A-Za-z0-9.-]{0,252}:[A-Za-z0-9._/-]{1,1000}', remote))


def _clean(root):
    status = _git(root, 'status', '--porcelain=v1', '--untracked-files=all').stdout
    return not status.strip()


def check(root):
    """Read-only comparison to the exact configured origin tracking branch."""
    root = Path(root).resolve()
    branch = _configured_origin(root)
    head = _git(root, 'rev-parse', 'HEAD').stdout.strip()
    remote = _git(root, 'ls-remote', '--heads', 'origin', 'refs/heads/' + branch).stdout.strip()
    remote_head = remote.split()[0] if remote else None
    if remote_head and not re.fullmatch(r'[0-9a-fA-F]{40,64}', remote_head):
        raise ValueError('origin returned an invalid revision')
    clean = _clean(root)
    relation = 'same' if remote_head == head else 'unknown'
    if remote_head and remote_head != head:
        exists = _git(root, 'cat-file', '-e', remote_head + '^{commit}', check=False)
        if exists.returncode == 0:
            local_before_remote = _git(root, 'merge-base', '--is-ancestor', 'HEAD', remote_head, check=False)
            remote_before_local = _git(root, 'merge-base', '--is-ancestor', remote_head, 'HEAD', check=False)
            relation = ('fast-forward' if local_before_remote.returncode == 0 else
                        'local-ahead' if remote_before_local.returncode == 0 else 'diverged')
    # ls-remote is read-only and does not fetch objects, so check reports only
    # whether origin differs. Fast-forward direction is proven during apply.
    return {'branch': branch, 'current': head, 'origin': remote_head,
            'originDiffers': bool(remote_head and remote_head != head),
            'relation': relation, 'clean': clean,
            'canAttemptApply': bool(remote_head and remote_head != head and clean
                                    and relation not in ('local-ahead', 'diverged')),
            'message': ('working tree has local changes' if not clean else
                        'origin differs; apply will verify fast-forward direction' if remote_head and remote_head != head and relation == 'unknown' else
                        'origin is ahead' if relation == 'fast-forward' else
                        'local branch is ahead of origin' if relation == 'local-ahead' else
                        'branches have diverged' if relation == 'diverged' else
                        'already current' if remote_head else 'origin branch not found')}


def apply(root):
    """Fetch only origin and move HEAD by a clean fast-forward; run no code."""
    root = Path(root).resolve()
    branch = _configured_origin(root)
    if not _clean(root):
        raise ValueError('source checkout has local changes; update refused')
    index = _git(root, 'ls-files', '--stage').stdout
    if any(line.startswith('160000 ') for line in index.splitlines()):
        raise ValueError('source checkout with submodules is not supported')
    _git(root, 'fetch', '--no-tags', '--recurse-submodules=no', 'origin', branch)
    remote_ref = 'refs/remotes/origin/' + branch
    ancestor = _git(root, 'merge-base', '--is-ancestor', 'HEAD', remote_ref, check=False)
    if ancestor.returncode == 1:
        raise ValueError('origin is not a fast-forward; update refused')
    if ancestor.returncode:
        raise ValueError('could not verify the origin fast-forward')
    old = _git(root, 'rev-parse', 'HEAD').stdout.strip()
    _git(root, 'merge', '--ff-only', remote_ref)
    new = _git(root, 'rev-parse', 'HEAD').stdout.strip()
    return {'updated': old != new, 'previous': old, 'current': new,
            'message': 'source updated; restart Xueness to load the new version' if old != new else 'already current'}


def execute_cli(args):
    try:
        if args.update_action == 'check':
            result = check(_repo_root())
        else:
            if not args.allow_update:
                raise ValueError('apply requires --allow-update')
            result = apply(_repo_root())
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
        print(json.dumps({'error': str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1
