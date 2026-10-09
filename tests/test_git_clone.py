"""git.clone: URL and destination validation, confirmation, plugin switch, CLI.

A real ``git clone`` runs against a local bare repository through the
test-only ``URL_TRANSPORT`` hook, which rewrites an *already validated* https
remote. ``file://`` and local paths stay refused by ``validated_url``.
"""
import argparse
import io
import os
import shutil
import subprocess
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

from xueness import plugin_runtime
from xueness.bundled_plugins.git import clone, operator_cli
from xueness.bundled_plugins.settings import workspaces_api
from tests.fs_link_helpers import make_directory_boundary_link, remove_directory_junction

GIT = shutil.which("git")
GIT_IDENT = ["-c", "user.name=t", "-c", "user.email=t@example.invalid",
             "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false"]
REMOTE = "https://example.invalid/acme/widgets.git"


class UrlValidationTests(unittest.TestCase):
    def test_accepts_https_ssh_and_scp_forms(self):
        for url in ("https://github.com/acme/widgets.git",
                    "https://git.example.com:8443/team/repo",
                    "ssh://git@github.com/acme/widgets.git",
                    "ssh://github.com:2222/acme/widgets",
                    "git@github.com:acme/widgets.git",
                    "github.com:acme/widgets"):
            self.assertEqual(clone.validated_url(url), url)

    def test_refuses_dangerous_or_local_forms(self):
        for url in ("file:///etc", "file://localhost/srv/repo", "ext::sh -c touch% /tmp/pwn",
                    "ext::sh", "-uupload", "--upload-pack=touch /tmp/x", "/srv/repo", "./repo",
                    "../repo", "C:/repo", "C:\\repo", "http://example.invalid/a/b",
                    "https://user:pw@example.invalid/a/b", "https://user@example.invalid/a/b",
                    "https://-oProxyCommand=x/a", "ssh://-oProxyCommand=x/a",
                    "-oProxyCommand=x:a", "git@-oProxyCommand=x:a", "git@github.com:-oProxyCommand=x",
                    "https://example.invalid/a b", "https://example.invalid/a\nb",
                    " https://example.invalid/a", "", None, 5, "x" * 3000,
                    "fd::17", "git://example.invalid/a"):
            with self.subTest(url=url):
                with self.assertRaises(clone.CloneError):
                    clone.validated_url(url)

    def test_suggested_name(self):
        self.assertEqual(clone.suggested_name("https://github.com/acme/widgets.git"), "widgets")
        self.assertEqual(clone.suggested_name("git@github.com:acme/widgets.git"), "widgets")
        self.assertEqual(clone.suggested_name("git@host:-bad"), "")


class BroadDirectoryTests(unittest.TestCase):
    def test_windows_first_level_system_dirs_are_broad(self):
        from pathlib import PureWindowsPath
        with mock.patch.object(clone.os, "name", "nt"):
            for raw in ("C:\\Users", "C:\\ProgramData", "C:\\PerfLogs", "D:\\Users"):
                with self.subTest(raw=raw):
                    self.assertTrue(clone._is_broad_directory(PureWindowsPath(raw)), raw)

    def test_nested_windows_project_dirs_are_not_broad(self):
        from pathlib import PureWindowsPath
        self.assertFalse(
            workspaces_api.is_windows_first_level_system_dir(PureWindowsPath("C:\\Users\\Public")))


@unittest.skipUnless(GIT, "git is not installed")
class CloneRepositoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name).resolve()
        self.state = base / "state"
        self.state.mkdir()
        self.projects = base / "projects"
        self.projects.mkdir()
        self.outside = base / "outside"
        self.outside.mkdir()
        self.origin = base / "origin.git"
        work = base / "seed"
        work.mkdir()
        self._git(work, "init", "-q")
        (work / "README.md").write_text("hello\n", encoding="utf-8")
        self._git(work, "add", "README.md")
        self._git(work, "commit", "-q", "-m", "seed")
        self._git(base, "clone", "-q", "--bare", str(work), str(self.origin))
        self.ctx = {"state_dir": self.state, "workspace_roots": (self.projects,)}
        patch = mock.patch.object(clone, "URL_TRANSPORT",
                                  lambda remote: str(self.origin) if remote == REMOTE else remote)
        patch.start()
        self.addCleanup(patch.stop)

    def tearDown(self):
        self.temp.cleanup()

    def _git(self, cwd, *argv):
        subprocess.run(["git", *GIT_IDENT, *argv], cwd=cwd, check=True,
                       capture_output=True, text=True)

    def _post(self, data, ctx=None):
        return clone.dispatch("POST", ["api", "git", "clone"], {}, data, ctx or self.ctx)

    def test_route_is_owned_by_git(self):
        self.assertEqual(plugin_runtime.route_owner(["api", "git", "clone"]), "git")

    def test_successful_clone_registers_recent_workspace(self):
        dest = self.projects / "widgets"
        status, payload = self._post({"url": REMOTE, "dest": str(dest), "confirmed": True})
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["cloned"], str(dest))
        self.assertEqual((dest / "README.md").read_text(encoding="utf-8"), "hello\n")
        listed = workspaces_api.dispatch("GET", ["api", "workspaces"], {}, {}, self.ctx)[1]
        self.assertIn(str(dest), [row["path"] for row in listed["recentDirectories"]])

    def test_empty_existing_directory_is_accepted(self):
        dest = self.projects / "widgets"
        dest.mkdir()
        status, payload = self._post({"url": REMOTE, "dest": str(dest), "confirmed": True})
        self.assertEqual(status, 200, payload)

    def test_confirmation_is_required(self):
        dest = self.projects / "widgets"
        for confirmed in (False, None, "true", 1):
            with self.subTest(confirmed=confirmed):
                status, payload = self._post({"url": REMOTE, "dest": str(dest), "confirmed": confirmed})
                self.assertEqual(status, 400, payload)
        self.assertEqual(self._post({"url": REMOTE, "dest": str(dest)})[0], 400)
        self.assertFalse(dest.exists())

    def test_disabled_plugin_refuses_before_any_subprocess(self):
        plugin_runtime.set_enabled(self.state, "git", False)
        with mock.patch.object(clone, "run_external") as runner:
            status, payload = self._post({"url": REMOTE, "dest": str(self.projects / "w"),
                                          "confirmed": True})
        self.assertEqual(status, 403, payload)
        runner.assert_not_called()

    def test_dangerous_url_never_reaches_subprocess(self):
        with mock.patch.object(clone, "run_external") as runner:
            for url in ("file://" + str(self.origin), str(self.origin), "--upload-pack=x", "ext::sh"):
                status, _ = self._post({"url": url, "dest": str(self.projects / "w"), "confirmed": True})
                self.assertEqual(status, 400, url)
        runner.assert_not_called()

    def test_argv_is_fixed_and_separated(self):
        captured = {}

        def fake(factory, argv, **kwargs):
            captured["argv"], captured["env"] = argv, kwargs["env"]
            Path(argv[-1]).mkdir()
            return subprocess.CompletedProcess(argv, 0, "", "")

        with mock.patch.object(clone, "URL_TRANSPORT", None), \
                mock.patch.object(clone, "run_external", side_effect=fake):
            status, _ = self._post({"url": REMOTE, "dest": str(self.projects / "w"), "confirmed": True})
        self.assertEqual(status, 200)
        self.assertEqual(captured["argv"], ["git", "-c", "protocol.ext.allow=never", "clone", "--",
                                            REMOTE, str(self.projects / "w")])
        self.assertEqual(captured["env"]["GIT_TERMINAL_PROMPT"], "0")

    def test_destination_constraints(self):
        (self.projects / "busy").mkdir()
        (self.projects / "busy" / "f").write_text("x", encoding="utf-8")
        (self.projects / "file").write_text("x", encoding="utf-8")
        link = self.projects / "link"
        kind = make_directory_boundary_link(link, self.outside)
        if kind == 'junction':
            self.addCleanup(remove_directory_junction, link)
        cases = {
            str(self.outside / "w"): 403,
            str(self.projects / "busy"): 409,
            str(self.projects / "file"): 409,
            str(self.projects / "link"): 400,
            str(self.projects / "link" / "w"): 403,
            str(self.projects / ".." / "outside" / "w"): 400,
            "projects/w": 400,
            str(self.projects / "missing" / "w"): 400,
            str(self.projects / "-w"): 400,
            str(self.projects / ".git"): 400,
            "/w": 400,
        }
        with mock.patch.object(clone, "run_external") as runner:
            for dest, expected in cases.items():
                with self.subTest(dest=dest):
                    status, payload = self._post({"url": REMOTE, "dest": dest, "confirmed": True})
                    self.assertEqual(status, expected, payload)
        runner.assert_not_called()
        self.assertFalse((self.outside / "w").exists())

    def test_root_pin_must_match_parent(self):
        dest = str(self.projects / "w")
        status, _ = self._post({"url": REMOTE, "dest": dest, "confirmed": True, "root": str(self.outside)})
        self.assertEqual(status, 403)
        status, _ = self._post({"url": REMOTE, "dest": dest, "confirmed": True, "root": str(self.projects)})
        self.assertEqual(status, 200)

    def test_request_shape(self):
        self.assertEqual(clone.dispatch("GET", ["api", "git", "clone"], {}, {}, self.ctx)[0], 405)
        self.assertIsNone(clone.dispatch("POST", ["api", "git", "other"], {}, {}, self.ctx))
        status, _ = self._post({"url": REMOTE, "dest": str(self.projects / "w"), "confirmed": True,
                                "upload_pack": "x"})
        self.assertEqual(status, 400)

    def test_failed_clone_does_not_echo_stderr(self):
        failed = subprocess.CompletedProcess([], 128, "", "fatal: /very/secret/path")
        with mock.patch.object(clone, "run_external", return_value=failed), redirect_stdout(io.StringIO()):
            status, payload = self._post({"url": REMOTE, "dest": str(self.projects / "w"), "confirmed": True})
        self.assertEqual(status, 409)
        self.assertNotIn("secret", payload["error"])

    def _cli(self, *argv):
        parser = argparse.ArgumentParser()
        parser.add_argument("--state", type=Path)
        commands = parser.add_subparsers(dest="command")
        operator_cli.add_parsers(commands)
        args = parser.parse_args(["--state", str(self.state), *argv])
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = operator_cli.execute_cli(args)
        return code, out.getvalue(), err.getvalue()

    def test_cli_clone_requires_confirmation_then_clones(self):
        dest = self.outside / "widgets"
        code, _, _ = self._cli("git", "clone", REMOTE, str(dest))
        self.assertNotEqual(code, 0)
        self.assertFalse(dest.exists())
        code, out, err = self._cli("git", "clone", REMOTE, str(dest), "--confirmed")
        self.assertEqual(code, 0, out + err)
        self.assertTrue((dest / "README.md").is_file())
        code, _, err = self._cli("git", "clone", REMOTE)
        self.assertEqual(code, 1)
        self.assertIn("requires <url> <dest>", err)

    def test_cli_session_verbs_still_validate(self):
        code, _, err = self._cli("git", "some-session", "push")
        self.assertEqual(code, 1)
        self.assertIn("status", err)


if __name__ == "__main__":
    unittest.main()
