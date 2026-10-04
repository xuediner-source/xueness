"""Detect the same packaged browser runtime that the worker actually uses."""
import json
import os
from pathlib import Path
import re
import subprocess


def worker_environment():
    env = {key: value for key, value in os.environ.items()
           if not re.search(r'KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL', key, re.I)}
    if os.environ.get('XUENESS_DESKTOP_NODE'):
        env['ELECTRON_RUN_AS_NODE'] = '1'
    return env


def worker_command(argument):
    return [os.environ.get('XUENESS_DESKTOP_NODE') or 'node',
            str(Path(__file__).with_name('bridge.mjs')), str(argument)]


def browser_runtime():
    from ...process_runtime import spawn_external
    try:
        result = spawn_external(subprocess.run, worker_command('--probe'), env=worker_environment(),
                                capture_output=True, text=True, encoding='utf-8', timeout=10,
                                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        value = json.loads(result.stdout) if len(result.stdout) < 4096 else {}
        if not isinstance(value, dict):
            value = {}
        if result.returncode == 0 and value.get('available') is True and value.get('browser') in ('Chrome', 'Edge', 'Chromium'):
            return {'available': True, 'browser': value['browser'], 'reason': None}
        if value.get('reason') in ('browser_missing', 'driver_missing'):
            return {'available': False, 'browser': None, 'reason': value['reason']}
    except (OSError, ValueError, subprocess.TimeoutExpired):
        pass
    return {'available': False, 'browser': None, 'reason': 'runtime_missing'}
