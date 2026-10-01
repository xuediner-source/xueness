"""Packaging smoke tests: Dockerfile + compose secure defaults (no daemon build needed).

Validates reproducible one-command deployment surface without pulling images
or needing network:
- Dockerfile pins a python slim base, runs non-root, persists /data,
  healthchecks the loopback API, never bakes state/secrets.
- compose.yaml publishes only on host 127.0.0.1, uses a named volume,
  uses configured models, permits a host-level disable, and passes `docker compose config`.
- web.py bind logic defaults to loopback and refuses non-loopback binds
  unless XUENESS_ALLOW_REMOTE=1 is set explicitly.
"""
import os
import re
import shutil
import subprocess
import unittest
from pathlib import Path

from xueness import web

PROJECT = Path(web.__file__).resolve().parent.parent
DOCKERFILE = PROJECT / "Dockerfile"
COMPOSE = PROJECT / "compose.yaml"
IGNORE = PROJECT / ".dockerignore"


class PackagingFilesTests(unittest.TestCase):
    def test_files_exist(self):
        for path in (DOCKERFILE, COMPOSE, IGNORE):
            self.assertTrue(path.is_file(), path)

    def test_dockerfile_secure_defaults(self):
        text = DOCKERFILE.read_text(encoding="utf-8")
        self.assertRegex(text, r"(?m)^FROM python:3\.12-slim")
        self.assertIn("USER appuser", text)
        self.assertIn('VOLUME ["/data"]', text)
        self.assertIn("/api/health", text)
        self.assertIn("--host", text)
        self.assertIn("0.0.0.0", text)
        # Never bake state, secrets, or credentials into the image.
        for banned in ("XUENESS_API_KEY", "COPY .state", "COPY .web-runs",
                       "COPY tests", "ADD http", "apt-get install curl", "apk add curl"):
            self.assertNotIn(banned, text)

    def test_dockerignore_excludes_state(self):
        text = IGNORE.read_text(encoding="utf-8")
        for entry in (".state/", ".demo/", ".web-runs/", "*.pyc", ".git/"):
            self.assertIn(entry, text)

    def test_compose_loopback_only(self):
        text = COMPOSE.read_text(encoding="utf-8")
        # Host publish must be pinned to loopback; bare "8137:8137" or
        # "0.0.0.0:8137" would expose the UI to the LAN silently.
        self.assertIn("127.0.0.1:8137:8137", text)
        self.assertNotRegex(text, r'(?m)^\s*-\s*"0\.0\.0\.0:8137')
        self.assertNotRegex(text, r'(?m)^\s*-\s*"8137:8137"')
        self.assertIn("xueness-data:/data", text)
        self.assertIn("XUENESS_ALLOW_REAL", text)
        self.assertIn('${XUENESS_ALLOW_REAL:-1}', text)
        self.assertIn("/api/health", text)
        # No live credential may be committed in the compose file.
        self.assertNotRegex(text, r"sk-[A-Za-z0-9]")
        for line in text.splitlines():
            stripped = line.strip()
            if stripped.startswith("#"):
                continue
            self.assertNotIn("XUENESS_API_KEY:", stripped)

    def test_compose_config_valid(self):
        if shutil.which("docker") is None:
            self.skipTest("docker CLI not available")
        proc = subprocess.run(
            ["docker", "compose", "config"],
            cwd=PROJECT, capture_output=True, text=True, timeout=30)
        self.assertEqual(proc.returncode, 0, proc.stderr[:2000])
        self.assertIn("127.0.0.1", proc.stdout)
        self.assertIn("xueness-data", proc.stdout)


class FreshMachineDocsTests(unittest.TestCase):
    def test_no_false_oneliner_claim(self):
        text = (PROJECT / "README.md").read_text(encoding="utf-8")
        # Authorized source publication does not claim a tagged release or
        # anonymous access to the private repository. Never run remote scripts.
        self.assertIn("https://github.com/xuediner-source/xueness", text)
        self.assertIn("需要仓库访问权限", text)
        self.assertIn("尚未建立发行标签、签名或容器镜像", text)
        self.assertNotRegex(text, r"curl\b[^\n]*\|\s*(?:sh|bash)\b")
        self.assertIn("127.0.0.1:8137", text)


class BindHostTests(unittest.TestCase):
    def setUp(self):
        self._old_host = os.environ.get(web.HOST_ENV)
        self._old_remote = os.environ.get(web.ALLOW_REMOTE_ENV)
        os.environ.pop(web.HOST_ENV, None)
        os.environ.pop(web.ALLOW_REMOTE_ENV, None)

    def tearDown(self):
        if self._old_host is None:
            os.environ.pop(web.HOST_ENV, None)
        else:
            os.environ[web.HOST_ENV] = self._old_host
        if self._old_remote is None:
            os.environ.pop(web.ALLOW_REMOTE_ENV, None)
        else:
            os.environ[web.ALLOW_REMOTE_ENV] = self._old_remote

    def test_default_is_loopback(self):
        self.assertEqual(web.resolve_bind_host(), "127.0.0.1")
        self.assertEqual(web.resolve_bind_host("127.0.0.1"), "127.0.0.1")

    def test_non_loopback_refused_without_opt_in(self):
        with self.assertRaises(ValueError):
            web.resolve_bind_host("0.0.0.0")

    def test_non_loopback_allowed_with_explicit_flag(self):
        os.environ[web.ALLOW_REMOTE_ENV] = "1"
        self.assertEqual(web.resolve_bind_host("0.0.0.0"), "0.0.0.0")

    def test_create_server_still_loopback_by_default(self):
        import tempfile
        base = Path(tempfile.mkdtemp())
        proj = base / "proj"
        proj.mkdir(parents=True)
        ctx = web.build_context(base / "state", base / "runs", proj, csrf="t")
        server = web.create_server(0, ctx)
        try:
            self.assertEqual(server.server_address[0], "127.0.0.1")
        finally:
            server.server_close()


if __name__ == "__main__":
    unittest.main()
