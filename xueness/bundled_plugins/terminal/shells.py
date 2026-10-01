"""Fixed executable shell profiles; arbitrary command text is never accepted."""
import os
from pathlib import Path

SHELL_PATHS = tuple(f'{directory}/{name}'
                    for directory in ('/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin')
                    for name in ('sh', 'bash', 'zsh', 'fish'))


def available_shells():
    return [{'id': path, 'label': f'{Path(path).name} ({path})'}
            for path in SHELL_PATHS if Path(path).is_file() and os.access(path, os.X_OK)]


def resolve_shell(profile=None):
    profile = profile or '/bin/sh'
    if profile not in SHELL_PATHS or not Path(profile).is_file() or not os.access(profile, os.X_OK):
        raise ValueError('terminal shell profile is unavailable')
    return profile
