"""Workspace preferences stay inside operator-configured roots."""
import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from http.server import ThreadingHTTPServer

from xueness import plugin_runtime, web
from xueness.bundled_plugins.settings import preferences, settings_store, workspaces_api


class WorkspaceApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.state = self.base / "state"
        self.project = self.base / "project"
        self.project.mkdir()
        self.runs = self.base / "runs"
        self.extra = self.base / "allowed-projects"
        self.extra.mkdir()
        self.outside = self.base / "outside"
        self.outside.mkdir()
        self.ctx = web.build_context(self.state, self.runs, self.project,
                                     csrf="workspace-test", workspace_roots=(self.extra,))

    def test_native_picker_capability_is_hidden_from_remote_peers(self):
        local = {**self.ctx, "handler": SimpleNamespace(client_address=("127.0.0.1", 1234))}
        remote = {**self.ctx, "handler": SimpleNamespace(client_address=("192.0.2.8", 1234))}
        with patch.object(workspaces_api, "native_picker_capability",
                          return_value={"available": True, "platform": "macos"}), \
             patch.object(workspaces_api, "_choose_native_directory") as choose:
            self.assertEqual(
                workspaces_api.dispatch("GET", ["api", "workspaces", "native-picker"],
                                        {}, {}, local),
                (200, {"available": True, "platform": "macos"}),
            )
            self.assertEqual(
                workspaces_api.dispatch("GET", ["api", "workspaces", "native-picker"],
                                        {}, {}, remote),
                (200, {"available": False, "platform": "macos"}),
            )
            status, payload = workspaces_api.dispatch(
                "POST", ["api", "workspaces", "native-picker"], {}, {}, remote
            )
            self.assertEqual(status, 403, payload)
            choose.assert_not_called()

    def test_native_picker_cancel_and_registered_directory_reach_existing_services(self):
        selected = self.outside
        (selected / "source.txt").write_text("picker test")
        local = {**self.ctx, "handler": SimpleNamespace(client_address=("127.0.0.1", 1234))}

        with patch.object(workspaces_api, "native_picker_capability",
                          return_value={"available": True, "platform": "macos"}), \
             patch.object(workspaces_api, "_choose_native_directory",
                          side_effect=[None, str(selected)]) as choose:
            status, cancelled = workspaces_api.dispatch(
                "POST", ["api", "workspaces", "native-picker"], {}, {}, local
            )
            self.assertEqual((status, cancelled), (200, {"cancelled": True}))
            self.assertEqual(workspaces_api.selected_roots(local), ())

            status, rejected = workspaces_api.dispatch(
                "POST", ["api", "workspaces", "native-picker"], {},
                {"root": str(selected)}, local,
            )
            self.assertEqual(status, 400, rejected)
            self.assertEqual(choose.call_count, 1, "arbitrary request paths never open the chooser")

            status, rejected_initial = workspaces_api.dispatch(
                "POST", ["api", "workspaces", "native-picker"], {},
                {"initialRoot": str(selected)}, local,
            )
            self.assertEqual(status, 400, rejected_initial)
            self.assertEqual(choose.call_count, 1, "initialRoot cannot expand existing grants")

            status, chosen = workspaces_api.dispatch(
                "POST", ["api", "workspaces", "native-picker"], {}, {}, local
            )
            self.assertEqual((status, chosen), (200, {"root": str(selected.resolve())}))
            self.assertEqual(choose.call_count, 2)
            self.assertEqual(choose.call_args_list[0].args, (str(self.project.resolve()),))

        persisted = settings_store.load_settings(self.state)["workspace"]["selectedRoots"]
        self.assertEqual(persisted, [str(selected.resolve())])
        self.assertIn(selected.resolve(), workspaces_api.allowed_roots(local))

        from xueness.bundled_plugins.files import directory_api
        status, listing = directory_api.dispatch(
            "GET", ["api", "directory"],
            {"path": [str(selected)], "includeFiles": ["true"]}, {}, local,
        )
        self.assertEqual(status, 200, listing)
        self.assertIn(str((selected / "source.txt").resolve()),
                      [row["path"] for row in listing["entries"]])

        from xueness.bundled_plugins.sessions import composer_api
        self.assertIn(str(selected.resolve()),
                      [row["path"] for row in composer_api._root_catalog(local)])
        self.assertEqual(
            web._allowed_root(selected, self.runs, self.project,
                               workspaces_api.allowed_roots(local)),
            selected.resolve(),
        )

        from xueness.bundled_plugins.memory import catalog as memory_catalog
        self.assertIn(str(selected.resolve()), memory_catalog.workspace_roots(local))

        from xueness.bundled_plugins.terminal import terminals
        terminal_opened = {}

        class StoreStub:
            def load(self, session_id):
                return {"id": session_id, "root": str(selected)}

        class BrokerStub:
            items = {}

            def open(self, root, session_id, shell):
                terminal_opened.update(root=Path(root), session_id=session_id, shell=shell)
                return SimpleNamespace(id="mock-terminal")

        terminal_ctx = {**local, "store": StoreStub(), "terminals": BrokerStub()}
        status, response = terminals.dispatch(
            "POST", ["api", "terminals"], {},
            {"open": True, "session_id": "a" * 32}, terminal_ctx,
        )
        self.assertEqual((status, response["id"]), (200, "mock-terminal"))
        self.assertEqual(terminal_opened["root"], selected.resolve())

    def test_native_picker_rejects_broad_os_selections(self):
        local = {**self.ctx, "handler": SimpleNamespace(client_address=("127.0.0.1", 1234))}
        with patch.object(workspaces_api, "native_picker_capability",
                          return_value={"available": True, "platform": "macos"}), \
             patch.object(workspaces_api, "_choose_native_directory", return_value="/tmp"):
            status, payload = workspaces_api.dispatch(
                "POST", ["api", "workspaces", "native-picker"], {}, {}, local
            )
        self.assertEqual(status, 400, payload)
        self.assertEqual(workspaces_api.selected_roots(local), ())

    def test_windows_first_level_system_dirs_are_too_broad(self):
        from pathlib import PureWindowsPath
        for raw in ("C:\\Users", "C:\\ProgramData", "C:\\PerfLogs", "D:\\ProgramData"):
            path = PureWindowsPath(raw)
            self.assertTrue(workspaces_api.is_windows_first_level_system_dir(path), raw)
            with patch.object(workspaces_api.os, "name", "nt"):
                self.assertTrue(workspaces_api._is_too_broad_native_root(path), raw)
        nested = PureWindowsPath("C:\\Users\\Public")
        self.assertFalse(workspaces_api.is_windows_first_level_system_dir(nested))
        self.assertFalse(workspaces_api.is_windows_first_level_system_dir(
            PureWindowsPath(r"\\fileserver\projects\Users")))
        # normcase keeps the check case-insensitive where the OS supports it.
        with patch.object(workspaces_api.os.path, "normcase", lambda value: value.lower()):
            self.assertTrue(
                workspaces_api.is_windows_first_level_system_dir(PureWindowsPath("c:\\users")))

    def test_native_picker_passes_initial_path_as_data_not_script(self):
        malicious = "/tmp/quoted ' ; do not execute"
        completed = SimpleNamespace(returncode=0, stdout=str(self.outside) + "\n")
        with patch.object(workspaces_api, "native_picker_capability",
                          return_value={"available": True, "platform": "macos"}), \
             patch.object(workspaces_api.shutil, "which", return_value="/usr/bin/osascript"), \
             patch.object(workspaces_api.subprocess, "run", return_value=completed) as run:
            self.assertEqual(workspaces_api._choose_native_directory(malicious), str(self.outside))
        args = run.call_args.args[0]
        self.assertEqual(args[-1], malicious)
        self.assertNotIn(malicious, args[2])
        self.assertNotIn("shell", run.call_args.kwargs)
        self.assertEqual(run.call_args.kwargs["timeout"], workspaces_api._PICKER_TIMEOUT_SECONDS)

    def test_workspace_picker_default_confirmation_recent_and_security(self):
        (self.project / "visible.txt").write_text("text")
        (self.project / "child").mkdir()
        link = self.project / "escape"
        try:
            link.symlink_to(self.outside, target_is_directory=True)
        except OSError:
            link = None

        status, payload = workspaces_api.dispatch("GET", ["api", "workspaces"], {}, {}, self.ctx)
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["defaultRoot"], str(self.project.resolve()))
        self.assertIn(str(self.extra.resolve()), [row["path"] for row in payload["allowedRoots"]])
        self.assertNotIn(str(Path("/tmp").resolve()), [row["path"] for row in payload["allowedRoots"]])
        self.assertEqual(payload["picker"]["path"], str(self.project.resolve()))
        self.assertEqual({row["type"] for row in payload["picker"]["entries"]}, {"file", "directory"})
        if link is not None:
            self.assertNotIn(str(link), [row["path"] for row in payload["picker"]["entries"]])

        chosen = self.extra / "service"
        chosen.mkdir()
        status, confirmed = workspaces_api.dispatch("POST", ["api", "workspaces", "confirm"],
                                                   {}, {"root": str(chosen)}, self.ctx)
        self.assertEqual((status, confirmed["root"]), (200, str(chosen.resolve())))
        self.assertEqual(workspaces_api.get_default_root(self.ctx), self.project.resolve(),
                         "confirmation records recency, not the default selection")
        after_confirm = workspaces_api.dispatch("GET", ["api", "workspaces"], {}, {}, self.ctx)[1]
        self.assertEqual(after_confirm["allowedRoots"], payload["allowedRoots"],
                         "confirm records recency but never expands the allowlist")
        self.assertEqual(after_confirm["recentDirectories"][0]["path"], str(chosen.resolve()))

        status, saved = workspaces_api.dispatch("POST", ["api", "workspaces", "default"],
                                                {}, {"root": str(chosen)}, self.ctx)
        self.assertEqual(status, 200, saved)
        self.assertEqual(saved["defaultRoot"], str(chosen.resolve()))
        self.assertEqual(workspaces_api.get_default_root(self.ctx), chosen.resolve())

        for bad in (str(self.outside), str(self.outside / "missing"), str(self.outside / "file.txt")):
            if bad.endswith("file.txt"):
                Path(bad).write_text("not a directory")
            status, error = workspaces_api.dispatch("POST", ["api", "workspaces", "default"],
                                                    {}, {"root": bad}, self.ctx)
            self.assertEqual(status, 400, error)
            if bad == str(self.outside):
                self.assertIn("--workspace-root", error["error"])

    def test_isolated_session_directories_do_not_pollute_recent_workspaces(self):
        session_root = self.runs / ("a" * 32)
        session_root.mkdir()
        workspaces_api.remember_directory(self.ctx, session_root)
        status, catalog = workspaces_api.dispatch("GET", ["api", "workspaces"], {}, {}, self.ctx)
        self.assertEqual(status, 200, catalog)
        self.assertEqual(catalog["recentDirectories"], [])

    def test_concurrent_settings_and_workspace_writes_preserve_both_sections(self):
        first = self.extra / "first"
        second = self.extra / "second"
        first.mkdir()
        second.mkdir()
        barrier = threading.Barrier(3)
        errors = []

        def general_writer():
            barrier.wait()
            for index in range(30):
                status, payload = settings_store.dispatch(
                    "POST", ["api", "settings", "general"], {},
                    {"values": {"language": "en", "autoScroll": bool(index % 2)}},
                    self.ctx,
                )
                if status != 200:
                    raise AssertionError(payload)

        def default_writer():
            barrier.wait()
            for index in range(30):
                root = first if index % 2 == 0 else second
                status, payload = workspaces_api.dispatch(
                    "POST", ["api", "workspaces", "default"], {},
                    {"root": str(root)}, self.ctx,
                )
                if status != 200:
                    raise AssertionError(payload)

        def recent_writer():
            barrier.wait()
            for _ in range(30):
                workspaces_api.remember_directory(self.ctx, first)

        def guarded(target):
            try:
                target()
            except BaseException as exc:
                errors.append(exc)

        threads = [threading.Thread(target=guarded, args=(writer,))
                   for writer in (general_writer, default_writer, recent_writer)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)
        self.assertFalse(any(thread.is_alive() for thread in threads), "settings writer deadlocked")
        self.assertEqual(errors, [])

        persisted = settings_store.load_settings(self.state)
        self.assertEqual(persisted["general"], {"language": "en", "autoScroll": True})
        workspace = persisted["workspace"]
        self.assertEqual(workspace["defaultRoot"], str(second.resolve()))
        self.assertEqual({row["path"] for row in workspace["recentDirectories"]},
                         {str(first.resolve()), str(second.resolve())})

    def test_settings_or_sessions_plugin_disabled_never_reads_saved_default(self):
        selected = self.project / "selected"
        selected.mkdir()
        status, _ = workspaces_api.dispatch("POST", ["api", "workspaces", "default"],
                                            {}, {"root": str(selected)}, self.ctx)
        self.assertEqual(status, 200)
        self.assertEqual(workspaces_api.get_default_root(self.ctx), selected.resolve())

        plugin_runtime.set_enabled(self.state, "settings", False)
        status, _ = workspaces_api.dispatch("GET", ["api", "workspaces"], {}, {}, self.ctx)
        self.assertEqual(status, 403)
        self.assertEqual(workspaces_api.get_default_root(self.ctx), self.project.resolve())
        from xueness.bundled_plugins.sessions import composer_api
        status, catalog = composer_api.dispatch("GET", ["api", "composer"], {}, {}, self.ctx)
        self.assertEqual(status, 200, catalog)
        self.assertEqual(catalog["root"], str(self.project.resolve()),
                         "composer must not silently read a saved default with settings disabled")

        plugin_runtime.set_enabled(self.state, "settings", True)
        plugin_runtime.set_enabled(self.state, "sessions", False)
        status, _ = workspaces_api.dispatch("GET", ["api", "workspaces"], {}, {}, self.ctx)
        self.assertEqual(status, 403)
        self.assertEqual(workspaces_api.get_default_root(self.ctx), self.project.resolve())

    def test_new_web_session_uses_saved_default_and_updates_recent_directories(self):
        selected = self.extra / "project-a"
        selected.mkdir()
        server = web.create_server(0, self.ctx)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        url = f"http://127.0.0.1:{server.server_port}"

        def request(path, data=None):
            body = json.dumps(data).encode() if data is not None else None
            request = urllib.request.Request(url + path, data=body, method="POST" if body else "GET",
                                             headers={"X-CSRF-Token": "workspace-test",
                                                      **({"Content-Type": "application/json"} if body else {})})
            try:
                with urllib.request.urlopen(request, timeout=5) as response:
                    return response.status, json.loads(response.read())
            except urllib.error.HTTPError as exc:
                return exc.code, json.loads(exc.read())

        status, catalog = request("/api/composer")
        self.assertEqual(status, 200, catalog)
        self.assertEqual(catalog["root"], str(self.project.resolve()))
        status, saved_default = request("/api/workspaces/default", {"root": str(selected)})
        self.assertEqual(status, 200, saved_default)
        self.assertEqual(saved_default["root"], str(selected.resolve()))
        self.assertEqual(saved_default["defaultRoot"], str(selected.resolve()))
        status, catalog = request("/api/composer")
        self.assertEqual(status, 200, catalog)
        self.assertEqual(catalog["root"], str(selected.resolve()))
        status, created = request("/api/sessions", {"task": "workspace smoke"})
        self.assertEqual(status, 200, created)
        self.assertEqual(created["root"], str(selected.resolve()))
        status, workspace_state = request("/api/workspaces")
        self.assertEqual(status, 200, workspace_state)
        self.assertEqual(workspace_state["recentDirectories"][0]["path"], str(selected.resolve()))

    def test_startup_workspace_roots_are_repeatable_and_must_be_existing_directories(self):
        root_a = self.base / "root-a"
        root_b = self.base / "root-b"
        root_a.mkdir()
        root_b.mkdir()
        context = {}

        class ServerStub:
            def serve_forever(self):
                return None

        with patch.object(web, "create_server", side_effect=lambda port, ctx, host: (context.update(ctx) or ServerStub())), \
             patch.dict(os.environ, {"XUENESS_WORKSPACE_ROOTS": ""}), \
             redirect_stdout(StringIO()):
            self.assertEqual(web.main(["--state", str(self.state), "--web-runs", str(self.runs),
                                       "--workspace-root", str(root_a), "--workspace-root", str(root_b)]), 0)
        self.assertEqual(context["workspace_roots"], (root_a.resolve(), root_b.resolve()))

        missing = self.base / "missing"
        file_path = self.base / "not-a-directory"
        file_path.write_text("x")
        with patch.object(web, "create_server") as create_server, redirect_stderr(StringIO()):
            with self.assertRaises(SystemExit) as missing_exit:
                web.main(["--state", str(self.state), "--web-runs", str(self.runs),
                          "--workspace-root", str(missing)])
            self.assertEqual(missing_exit.exception.code, 2)
            with self.assertRaises(SystemExit) as file_exit:
                web.main(["--state", str(self.state), "--web-runs", str(self.runs),
                          "--workspace-root", str(file_path)])
            self.assertEqual(file_exit.exception.code, 2)
            create_server.assert_not_called()

    def test_preferences_validate_workbench_controls(self):
        self.assertEqual(preferences.validate("general", {
            "language": "zh", "autoScroll": True, "showTodos": False,
            "collapseTools": True,
        }), {"language": "zh", "autoScroll": True, "showTodos": False,
              "collapseTools": True})
        self.assertEqual(preferences.validate("browser", {"browserControlEnabled": True}),
                         {"browserControlEnabled": True})
        for values in ({"language": "fr"}, {"autoScroll": 1}, {"showTodos": "yes"},
                       {"collapseTools": None}):
            with self.subTest(values=values), self.assertRaises(ValueError):
                preferences.validate("general", values)
        with self.assertRaises(ValueError):
            preferences.validate("browser", {"browserControlEnabled": "true"})


    def test_preferences_validate_color_palette(self):
        self.assertEqual(preferences.validate("appearance", {"colorPalette": "xueness"}),
                         {"colorPalette": "xueness"})
        self.assertEqual(preferences.validate("appearance", {"colorPalette": "claude"}),
                         {"colorPalette": "claude"})
        with self.assertRaises(ValueError):
            preferences.validate("appearance", {"colorPalette": "warm"})


if __name__ == "__main__":
    unittest.main()

