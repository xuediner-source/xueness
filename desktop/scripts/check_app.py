"""Start the packaged application with isolated data and validate its real UI."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import queue
import threading

ROOT = Path(__file__).resolve().parents[2]
RELEASE = ROOT/'desktop/release'
from sys import path as module_path
module_path.insert(0, str(ROOT))
from xueness import __version__ as expected_version
from xueness.plugin_runtime import PLUGIN_IDS
expected_plugins = len(PLUGIN_IDS)
expected_features = sum(len(json.loads((ROOT/'xueness/bundled_plugins'/ident/'manifest.json').read_text(encoding='utf-8'))['features']) for ident in PLUGIN_IDS)
parser = argparse.ArgumentParser()
parser.add_argument('--executable', type=Path, help='check this packaged application executable')
args = parser.parse_args()
if args.executable:
    executable = args.executable.expanduser().resolve()
    if not executable.is_file():
        raise SystemExit(f'Packaged application executable does not exist: {executable}')
elif os.name == 'nt':
    executable = RELEASE/'win-unpacked/Xueness.exe'
else:
    candidates = list(RELEASE.glob('mac*/Xueness.app/Contents/MacOS/Xueness'))
    if len(candidates) != 1:
        raise SystemExit('Expected one native packaged Mac application.')
    executable = candidates[0]

with tempfile.TemporaryDirectory(prefix='xueness-app-check-') as temporary:
    report = Path(temporary)/'report.json'
    isolated_data = (Path(temporary)/'data').resolve()
    # Keep the packaged UI check offline while retaining the full installed-plugin catalog.
    plugin_state = isolated_data/'state'/'plugin-state.json'
    plugin_state.parent.mkdir(parents=True, exist_ok=True)
    plugin_state.write_text(json.dumps({'apiVersion': 1, 'enabled': {'updates': False}}), encoding='utf-8')
    env = {**os.environ, 'XUENESS_DESKTOP_DATA': str(isolated_data),
           'XUENESS_DESKTOP_SMOKE_FILE': str(report), 'XUENESS_ALLOW_REAL': '0'}
    result = subprocess.run([str(executable)], env=env, capture_output=True, timeout=90)
    if result.returncode or not report.exists():
        detail = json.loads(report.read_text(encoding='utf-8')).get('reason', '') if report.exists() else ''
        raise SystemExit('Packaged desktop did not complete its UI startup check. '+detail)
    state = json.loads(report.read_text(encoding='utf-8'))
    assert state.get('plugins') == expected_plugins and state.get('features') == expected_features, state
    assert state.get('installedCards') == expected_plugins and state.get('aboutReady') is True, state
    assert state.get('aboutVersion') == expected_version, state
    assert state.get('aboutDataDirectory') == str(isolated_data), state
    assert state.get('oldDesktopNavAbsent') is True, state
    assert state.get('onboardingSeen') is True and state.get('onboardingCompleted') is True, state
    assert state.get('permissionSnapshotValid') is True and state.get('permissionPostRequests') == 0, state
    assert state.get('clipWriteGranted') is True and state.get('clipReadDenied') is True, state
    assert state.get('title') == 'Xueness' and state.get('nodeAccess') is False and state.get('workbenchReady') is True and state.get('body', 0) > 100, state
    print(f'PASS: packaged Electron workbench renders, {expected_plugins} plugins/{expected_features} features, isolated renderer and clean exit')
    resources = executable.parent/'resources' if os.name == 'nt' else executable.parents[1]/'Resources'
    worker = resources/'backend/_internal/xueness/bundled_plugins/browser/bridge.mjs'
    driver = resources/'browser-runtime/node_modules/playwright/index.mjs'
    assert worker.is_file() and driver.is_file(), 'browser runtime missing from installer'
    browser = subprocess.Popen([str(executable), str(worker), str(Path(temporary)/'browser-profile')],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, encoding='utf-8', env={**env, 'ELECTRON_RUN_AS_NODE': '1',
                               'XUENESS_DESKTOP_PLAYWRIGHT': str(driver)})
    lines = queue.Queue()
    threading.Thread(target=lambda: lines.put(browser.stdout.readline()), daemon=True).start()
    try:
        assert json.loads(lines.get(timeout=35)).get('ready') is True
        browser.stdin.close()
        assert browser.wait(timeout=15) == 0
        print('PASS: packaged browser plugin uses the bundled Node/Playwright driver and an installed Chrome/Edge')
    finally:
        if browser.poll() is None:
            browser.kill(); browser.wait(timeout=5)
        browser.stdout.close(); browser.stderr.close()
