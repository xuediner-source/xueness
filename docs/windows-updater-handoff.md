# Windows desktop update handoff

Copy the following prompt to the agent running on your Windows computer.

---

You are taking over the **Windows desktop updater only** in this repository:
https://github.com/xuediner-source/xueness

Clone or fetch the latest `main`, read `AGENTS.md` and `CONTRIBUTING.md`, and inspect the existing implementation before changing anything. Xueness 0.1.2 is being released with the owner's explicit approval to defer the full Windows update rehearsal. Do not interpret a green release build as proof that an installed Windows update completed: the release workflow may have been dispatched with `skip_windows_update_smoke=true`. That input defaults to false.

Goal: prove and, where necessary, fix the real Windows x64 **NSIS installed edition** update path: discover a newer version, download and validate the installer, install it, restart into the new version, and preserve sessions, workspaces, provider configuration and plugin switches. Distinguish failures in the test harness from failures in the product. The portable ZIP does not support in-place updating. macOS currently uses verified DMG download and manual replacement; do not change the Mac flow or unrelated UI.

Current evidence and known limitations:

- Three native platforms have repeatedly passed backend freezing and packaged Electron workbench startup. Frontend tests/typecheck/build and plugin architecture checks pass. No paid model is needed to test updating.
- Run `37210300729` used Electron's native `autoUpdater` by mistake in the Windows test fixture; it returned no update metadata. The fixture now imports the real updater from `electron-updater`, matching production `desktop/src/main.cjs`.
- Run `37211421430` reached `phase=installing`, update version `0.1.3`, download progress 100%, but did not produce the restarted verification report. This proves that the isolated fixture could discover and download the newer installer; it does **not** prove that installation/restart succeeded.
- NSIS relaunches through `StdUtils.ExecShellAsUser`. That launch can lose fixture environment variables. The fixture now uses `update-smoke-config.json` outside the installation directory, derived from the executable's parent directory, for isolated paths and the expected version. It fails closed instead of falling back to normal user data.
- Run `37212985528` then timed out while executing the installed baseline's `--seed`, before the update download. A suspected cause is Windows 8.3 paths such as `C:\Users\RUNNER~1` versus Python's resolved long path. The latest source compares native real paths, handles absent leaves through existing parents, and logs startup errors before exiting. Those last changes have targeted regressions but have **not yet been validated through a successful native installed-update rehearsal**. Do not assume the suspected cause or the latest fix is conclusive.
- A separate Windows-only floating-point test failure (`120.00000000000003 <= 120`) was corrected by comparing absolute deadlines. Do not loosen the child's actual 120-second deadline.

Start with these files:

- `desktop/src/main.cjs`
- `desktop/src/update-coordinator.cjs`
- `desktop/electron-builder.cjs`
- `desktop/scripts/check_windows_update.py`
- `desktop/scripts/windows_update_fixture.cjs`
- `desktop/tests/windows-update-fixture.test.cjs`
- `desktop/tests/test_windows_update_smoke.py`
- `.github/workflows/desktop-build.yml`
- `xueness/bundled_plugins/updates/` and `webapp/src/plugins/updates/` if the issue reaches the product UI or policy bridge

Reproduce in a disposable installation and state directory. Never install a synthetic fixture over the user's real Xueness installation or point its state at the user's data. The fixture currently shares the product app ID; examine registry/install-directory interactions and isolate the test identity if necessary. Capture both the seed process and updater process logs, actual executable versions, installer exit codes, paths, report contents, and the restart's process/arguments. If `--seed` fails, resolve that first; do not merely increase timeouts or skip it. Ensure cleanup only affects fixture-owned files/processes.

On Windows, install the build dependencies with Python 3.12 and Node matching the workflow:

```powershell
python -m pip install -r desktop/requirements-build.txt
npm ci --prefix webapp --no-audit --no-fund
npm ci --prefix desktop --no-audit --no-fund
node desktop/node_modules/electron/install.js
python -m unittest discover -s desktop/tests -p test_windows_update_smoke.py -q
npm --prefix desktop test
python desktop/scripts/check_windows_update.py
```

The real rehearsal must produce `stage=verified`, the expected newer version, and `preserved=true`, with the seeded configuration and session intact. A download reaching 100%, a mocked test, or a workflow with the update step skipped is insufficient. Use the same standard Electron/electron-updater/NSIS path as production; retain checksum validation, update plugin policy, cancellation and the active-task installation guard. Do not hide failures with `continue-on-error`, disable certificate/hash checks, or make the skip input the default.

Also inspect the public v0.1.2 Release. `latest.yml` must reference the exact x64 NSIS installer, with matching size and SHA-512; the corresponding blockmap and aggregate SHA-256 file should be present. Test an installed 0.1.1 client discovering 0.1.2 against the public feed in an isolated environment if available. Keep public-feed checking separate from the synthetic 0.1.2 → 0.1.3 loopback rehearsal.

Every product change must remain owned by the existing updates plugin or documented shared desktop infrastructure; do not add updater business logic to the workbench container. Preserve all user changes and configuration. Any subagents must use **GPT-6 Luna with MAX reasoning**. Do not call a paid model, commit, push or publish without the owner's explicit authorization.

Run the required architecture gates and relevant regressions. If production backend/frontend behavior changes, run the corresponding full suites required by `AGENTS.md`, and validate the packaged application. After the local Windows rehearsal succeeds, run the native release workflow **without** `skip_windows_update_smoke`, check its actual logs, and report precisely what was verified and what remains unverified. Give the owner a concise diagnosis, changed files, real evidence, and any remaining limitations.
