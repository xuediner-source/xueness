"""Start the packaged application with isolated data and validate its real UI."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import queue
import threading

ROOT = Path(__file__).resolve().parents[2]
RELEASE = ROOT/'desktop/release'
if os.name == 'nt':
    executable = RELEASE/'win-unpacked/Xueness.exe'
else:
    candidates = list(RELEASE.glob('mac*/Xueness.app/Contents/MacOS/Xueness'))
    if len(candidates) != 1:
        raise SystemExit('Expected one native packaged Mac application.')
    executable = candidates[0]

with tempfile.TemporaryDirectory(prefix='xueness-app-check-') as temporary:
    report = Path(temporary)/'report.json'
    env = {**os.environ, 'XUENESS_DESKTOP_DATA': str(Path(temporary)/'data'),
           'XUENESS_DESKTOP_SMOKE_FILE': str(report), 'XUENESS_ALLOW_REAL': '0'}
    result = subprocess.run([str(executable)], env=env, capture_output=True, timeout=90)
    if result.returncode or not report.exists():
        detail = json.loads(report.read_text()).get('reason', '') if report.exists() else ''
        raise SystemExit('Packaged desktop did not complete its UI startup check. '+detail)
    state = json.loads(report.read_text())
    assert state.get('plugins') == 27 and state.get('features') == 88, state
    assert state.get('installedCards') == 27 and state.get('desktopSettingsReady') is True, state
    assert state.get('clipWriteGranted') is True and state.get('clipReadDenied') is True, state
    assert state.get('title') == 'Xueness' and state.get('nodeAccess') is False and state.get('workbenchReady') is True and state.get('body', 0) > 100, state
    print('PASS: packaged Electron workbench renders, 27 plugins/88 features, isolated renderer and clean exit')
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
